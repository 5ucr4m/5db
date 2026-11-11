//! Single RPC surface shared by the Tauri command and the dev HTTP bridge.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::dump::{self, Jobs};
use crate::error::{AppError, AppResult};
use crate::pg::{self, Listener, PgSession};
use crate::rds::{self, RedisSession};
use crate::ssh::{self, Tunnel};
use crate::store::{ConnectionConfig, NewHistory, SavedQuery, Store};
use crate::transfer;

/// The destination of a file write comes from the frontend, which gets it from
/// the native save dialog. Validate it anyway, so that a compromised frontend
/// cannot turn this into an arbitrary write: absolute paths only, no traversal,
/// an existing directory, and never inside the directory holding the
/// credential store.
fn write_target(state: &AppState, path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(AppError::msg("Refusing to write to a path that is not absolute."));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::msg("Refusing to write to a path containing \"..\"."));
    }
    let name = p
        .file_name()
        .ok_or_else(|| AppError::msg("That destination has no file name."))?;
    let dir = p
        .parent()
        .ok_or_else(|| AppError::msg("That destination has no directory."))?
        .canonicalize()
        .map_err(|_| AppError::msg("That destination directory does not exist."))?;
    if let Ok(data) = state.data_dir.canonicalize()
        && dir.starts_with(&data)
    {
        return Err(AppError::msg("Refusing to write inside 5db's own data directory."));
    }
    Ok(dir.join(name))
}

/// A folder something is about to be written into, held to the same rules as
/// a file's destination.
fn write_dir(state: &AppState, dir: &Path) -> AppResult<PathBuf> {
    let probe = write_target(state, &dir.join("5db").to_string_lossy())?;
    Ok(probe.parent().unwrap_or(dir).to_path_buf())
}

/// A connection marked read-only is a promise the driver keeps on every
/// session it opens. pg_restore and psql open their own, where nothing keeps
/// it, so it is kept here.
fn writable(cfg: &ConnectionConfig) -> AppResult<()> {
    if cfg.read_only {
        return Err(AppError::msg(format!(
            "{} is marked read-only, so nothing is restored into it. Turn that off on the connection first.",
            cfg.name
        )));
    }
    Ok(())
}

/// Whether two saved connections reach the same server, as far as what was
/// typed into them can tell.
fn same_server(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    let host = |c: &ConnectionConfig| {
        if c.host.is_empty() {
            "localhost".to_string()
        } else {
            c.host.to_ascii_lowercase()
        }
    };
    let port = |c: &ConnectionConfig| if c.port == 0 { 5432 } else { c.port };
    let via = |c: &ConnectionConfig| c.ssh_enabled.then(|| (c.ssh_host.to_ascii_lowercase(), c.ssh_port));
    host(a) == host(b) && port(a) == port(b) && via(a) == via(b)
}

pub struct AppState {
    pub store: Store,
    data_dir: PathBuf,
    pg: RwLock<HashMap<String, Arc<PgSession>>>,
    /// One notification connection per (connection, database), opened lazily
    /// the first time a channel is listened to.
    listeners: RwLock<HashMap<String, Arc<Listener>>>,
    /// Dumps and restores in flight; the frontend polls them by id.
    jobs: Arc<Jobs>,
    redis: RwLock<HashMap<String, Arc<RedisSession>>>,
    tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// Serialises session creation so parallel first requests share one connect.
    connecting: Mutex<()>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        AppState::new_with(data_dir, crate::secrets::Vault::open())
    }

    /// Used by the tests, which choose the secret store explicitly rather than
    /// through the environment, so running them in parallel cannot race.
    pub fn new_with(data_dir: PathBuf, vault: crate::secrets::Vault) -> AppResult<Self> {
        let store = Store::open_with(&data_dir, vault)?;
        Ok(AppState {
            store,
            data_dir,
            pg: RwLock::new(HashMap::new()),
            listeners: RwLock::new(HashMap::new()),
            jobs: Arc::new(Jobs::default()),
            redis: RwLock::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            connecting: Mutex::new(()),
        })
    }

    /// The config the drivers should use: unchanged, or pointed at the SSH tunnel.
    async fn effective(&self, cfg: ConnectionConfig) -> AppResult<ConnectionConfig> {
        if !cfg.ssh_enabled {
            return Ok(cfg);
        }
        let mut tunnels = self.tunnels.lock().await;
        if let Some(t) = tunnels.get(&cfg.id)
            && !t.is_closed()
        {
            return Ok(ssh::rewrite(&cfg, t));
        }
        let t = Arc::new(ssh::open(&cfg).await?);
        let out = ssh::rewrite(&cfg, &t);
        tunnels.insert(cfg.id.clone(), t);
        Ok(out)
    }

    /// The listener for a session, opened on first use. Keyed like the session
    /// itself, so switching database gets its own.
    async fn listener(&self, connection_id: &str, database: Option<&str>) -> AppResult<Arc<Listener>> {
        let session = self.pg(connection_id, database).await?;
        let key = format!("{}/{}", session.cfg.id, session.database);
        if let Some(l) = self.listeners.read().await.get(&key)
            && !l.is_closed()
        {
            return Ok(l.clone());
        }
        let cfg = self.effective(self.store.get_connection(connection_id)?).await?;
        let listener = Listener::open(&cfg, &session.database).await?;
        self.listeners.write().await.insert(key, listener.clone());
        Ok(listener)
    }

    /// The listener if there already is one. Polling must not open a connection
    /// just because a panel is on screen.
    async fn peek_listener(&self, connection_id: &str, database: Option<&str>) -> Option<Arc<Listener>> {
        let session = self.pg(connection_id, database).await.ok()?;
        let key = format!("{}/{}", session.cfg.id, session.database);
        self.listeners
            .read()
            .await
            .get(&key)
            .cloned()
            .filter(|l| !l.is_closed())
    }

    async fn pg(&self, connection_id: &str, database: Option<&str>) -> AppResult<Arc<PgSession>> {
        let cfg = self.store.get_connection(connection_id)?;
        if cfg.kind != "postgres" {
            return Err(AppError::msg("This connection is not a Postgres connection."));
        }
        let db = database
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| cfg.database.clone());
        let key = format!("{connection_id}\u{0}{db}");
        if let Some(s) = self.pg.read().await.get(&key)
            && !s.is_closed()
        {
            return Ok(s.clone());
        }
        let _guard = self.connecting.lock().await;
        if let Some(s) = self.pg.read().await.get(&key)
            && !s.is_closed()
        {
            return Ok(s.clone());
        }
        let cfg = self.effective(cfg).await?;
        let session = Arc::new(PgSession::open(cfg, db).await?);
        self.pg.write().await.insert(key, session.clone());
        Ok(session)
    }

    async fn redis(&self, connection_id: &str, db: Option<i64>) -> AppResult<Arc<RedisSession>> {
        let cfg = self.store.get_connection(connection_id)?;
        if cfg.kind != "redis" {
            return Err(AppError::msg("This connection is not a Redis connection."));
        }
        let db = db.unwrap_or(cfg.redis_db);
        let key = format!("{connection_id}\u{0}{db}");
        if let Some(s) = self.redis.read().await.get(&key) {
            return Ok(s.clone());
        }
        let _guard = self.connecting.lock().await;
        if let Some(s) = self.redis.read().await.get(&key) {
            return Ok(s.clone());
        }
        let cfg = self.effective(cfg).await?;
        let session = Arc::new(rds::connect(&cfg, db).await?);
        self.redis.write().await.insert(key, session.clone());
        Ok(session)
    }

    /// The major version of the server behind a connection, which decides
    /// whether the installed tools are new enough to dump it.
    async fn server_major(&self, connection_id: &str, database: Option<&str>) -> AppResult<u32> {
        let s = self.pg(connection_id, database).await?;
        let row = s.main.client.query_one("SHOW server_version_num", &[]).await?;
        let num: String = row.get(0);
        let n: u32 = num
            .parse()
            .map_err(|_| AppError::msg(format!("The server reported an unreadable version: {num}")))?;
        Ok(n / 10_000)
    }

    async fn disconnect(&self, connection_id: &str) {
        let prefix = format!("{connection_id}\u{0}");
        self.pg.write().await.retain(|k, _| !k.starts_with(&prefix));
        self.redis.write().await.retain(|k, _| !k.starts_with(&prefix));
        // Listeners are keyed by id and database, so a slash rather than a NUL.
        let listen_prefix = format!("{connection_id}/");
        self.listeners
            .write()
            .await
            .retain(|k, _| !k.starts_with(&listen_prefix));
        self.tunnels.lock().await.remove(connection_id);
    }
}

fn p<T: DeserializeOwned>(params: &Value) -> AppResult<T> {
    Ok(serde_json::from_value(params.clone())?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PgTarget {
    connection_id: String,
    #[serde(default)]
    database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableTarget {
    connection_id: String,
    #[serde(default)]
    database: Option<String>,
    schema: String,
    table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisTarget {
    connection_id: String,
    #[serde(default)]
    db: Option<i64>,
}

fn count_rows(result: &Value) -> Option<i64> {
    let sets = result.get("results")?.as_array()?;
    let last = sets.last()?;
    if last.get("kind")?.as_str()? == "rows" {
        Some(last.get("rows")?.as_array()?.len() as i64)
    } else {
        last.get("affected")?.as_i64()
    }
}

pub async fn dispatch(state: &AppState, method: &str, params: Value) -> AppResult<Value> {
    match method {
        // ---- saved connections -----------------------------------------
        "connections.list" => Ok(json!(state.store.list_connections()?)),
        "connections.save" => {
            let cfg: ConnectionConfig = p(&params)?;
            if cfg.name.trim().is_empty() {
                return Err(AppError::msg("Give the connection a name."));
            }
            state.disconnect(&cfg.id).await;
            Ok(json!(state.store.save_connection(cfg)?))
        }
        "connections.delete" => {
            let id: String = p(&params["id"])?;
            state.disconnect(&id).await;
            state.store.delete_connection(&id)?;
            Ok(Value::Null)
        }
        "connections.reorder" => {
            let ids: Vec<String> = p(&params["ids"])?;
            state.store.reorder_connections(&ids)?;
            Ok(Value::Null)
        }
        "connections.test" => {
            let cfg: ConnectionConfig = p(&params)?;
            // A throwaway tunnel, closed when the test finishes.
            let tunnel = if cfg.ssh_enabled {
                Some(ssh::open(&cfg).await?)
            } else {
                None
            };
            let target = match &tunnel {
                Some(t) => ssh::rewrite(&cfg, t),
                None => cfg,
            };
            let mut result = match target.kind.as_str() {
                "redis" => rds::test_connection(&target).await,
                _ => pg::test_connection(&target).await,
            }?;
            result["viaSsh"] = json!(tunnel.is_some());
            Ok(result)
        }
        "connections.disconnect" => {
            let id: String = p(&params["id"])?;
            state.disconnect(&id).await;
            Ok(Value::Null)
        }

        // ---- postgres --------------------------------------------------
        "pg.connect" => {
            let t: PgTarget = p(&params)?;
            let s = state.pg(&t.connection_id, t.database.as_deref()).await?;
            state.store.touch_connection(&t.connection_id)?;
            pg::server_info(&s).await
        }
        "pg.databases" => {
            let t: PgTarget = p(&params)?;
            pg::list_databases(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.capabilities" => {
            let t: PgTarget = p(&params)?;
            pg::capabilities(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.analyze" => {
            let t: PgTarget = p(&params)?;
            let session = state.pg(&t.connection_id, t.database.as_deref()).await?;
            let database = t.database.clone().unwrap_or_else(|| session.database.clone());
            let cfg = state.effective(state.store.get_connection(&t.connection_id)?).await?;
            pg::analyze(&cfg, &database).await
        }
        "pg.createDatabase" => {
            let t: PgTarget = p(&params)?;
            let name: String = p(&params["name"])?;
            let template = params["template"].as_str().unwrap_or_default().to_string();
            let encoding = params["encoding"].as_str().unwrap_or_default().to_string();
            let s = state.pg(&t.connection_id, t.database.as_deref()).await?;
            pg::create_database(&s, &name, &template, &encoding).await
        }
        "pg.objects" => {
            let t: PgTarget = p(&params)?;
            pg::list_objects(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.completion" => {
            let t: PgTarget = p(&params)?;
            pg::completion_schema(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.structure" => {
            let t: TableTarget = p(&params)?;
            pg::table_structure(
                &*state.pg(&t.connection_id, t.database.as_deref()).await?,
                &t.schema,
                &t.table,
            )
            .await
        }
        "pg.rows" => {
            let t: PgTarget = p(&params)?;
            let req: pg::FetchRequest = p(&params)?;
            pg::fetch_rows(&*state.pg(&t.connection_id, t.database.as_deref()).await?, req).await
        }
        "pg.apply" => {
            let t: TableTarget = p(&params)?;
            let changes: Vec<pg::Change> = p(&params["changes"])?;
            let s = state.pg(&t.connection_id, t.database.as_deref()).await?;
            pg::apply_changes(&s, &t.schema, &t.table, changes).await
        }
        "pg.execute" => {
            let t: PgTarget = p(&params)?;
            let sql: String = p(&params["sql"])?;
            let max_rows: usize = params.get("maxRows").and_then(Value::as_u64).unwrap_or(50_000) as usize;
            let record = params.get("record").and_then(Value::as_bool).unwrap_or(true);
            let s = state.pg(&t.connection_id, t.database.as_deref()).await?;
            let result = pg::execute(&s, &sql, max_rows).await?;
            if record {
                let entry = state.store.add_history(NewHistory {
                    connection_id: t.connection_id,
                    database: s.database.clone(),
                    kind: "sql".into(),
                    sql,
                    duration_ms: result["durationMs"].as_f64().unwrap_or(0.0),
                    rows: count_rows(&result),
                    error: result["error"]["message"].as_str().map(str::to_string),
                })?;
                let mut result = result;
                result["history"] = json!(entry);
                return Ok(result);
            }
            Ok(result)
        }
        "pg.cancel" => {
            let t: PgTarget = p(&params)?;
            pg::cancel(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.activity" => {
            let t: PgTarget = p(&params)?;
            pg::activity(&*state.pg(&t.connection_id, t.database.as_deref()).await?).await
        }
        "pg.signal" => {
            let t: PgTarget = p(&params)?;
            let pid: i32 = p(&params["pid"])?;
            let terminate = params.get("terminate").and_then(Value::as_bool).unwrap_or(false);
            pg::signal_backend(
                &*state.pg(&t.connection_id, t.database.as_deref()).await?,
                pid,
                terminate,
            )
            .await
        }
        "pg.functionDef" => {
            let t: PgTarget = p(&params)?;
            let oid: i64 = p(&params["oid"])?;
            pg::function_definition(&*state.pg(&t.connection_id, t.database.as_deref()).await?, oid).await
        }
        "pg.exportCsv" => {
            let t: TableTarget = p(&params)?;
            let path: String = p(&params["path"])?;
            let target = write_target(state, &path)?;
            pg::export_csv(
                &*state.pg(&t.connection_id, t.database.as_deref()).await?,
                &t.schema,
                &t.table,
                &target.to_string_lossy(),
            )
            .await
        }

        "pg.listen" => {
            let t: PgTarget = p(&params)?;
            let channel: String = p(&params["channel"])?;
            let l = state.listener(&t.connection_id, t.database.as_deref()).await?;
            l.listen(&channel).await?;
            Ok(l.drain())
        }
        "pg.unlisten" => {
            let t: PgTarget = p(&params)?;
            let channel: String = p(&params["channel"])?;
            let l = state.listener(&t.connection_id, t.database.as_deref()).await?;
            l.unlisten(&channel).await?;
            Ok(l.drain())
        }
        "pg.notify" => {
            let t: PgTarget = p(&params)?;
            let channel: String = p(&params["channel"])?;
            let payload: String = params["payload"].as_str().unwrap_or_default().to_string();
            let session = state.pg(&t.connection_id, t.database.as_deref()).await?;
            pg::notify(&session, &channel, &payload).await?;
            // Not drained here: the notification is still in flight, and the
            // panel's next poll is what picks it up.
            Ok(Value::Null)
        }
        "pg.notifications" => {
            let t: PgTarget = p(&params)?;
            // Polled while the panel is open, so an absent listener is not an
            // error: it just means nothing has been listened to yet.
            match state.peek_listener(&t.connection_id, t.database.as_deref()).await {
                Some(l) => Ok(l.drain()),
                None => Ok(json!({ "notices": [], "channels": [] })),
            }
        }

        // ---- backup and restore ----------------------------------------
        "dump.tools" => Ok(dump::tools()),
        "dump.start" => {
            let t: PgTarget = p(&params)?;
            let options: dump::DumpOptions = p(&params["options"])?;
            options.check()?;
            let path: String = p(&params["path"])?;
            let target = write_target(state, &path)?;

            let tool = dump::find_tool("pg_dump")
                .ok_or_else(|| AppError::msg("pg_dump was not found on this machine. Install the PostgreSQL client tools, or pick the built-in engine."))?;
            dump::check_version(
                &tool,
                state.server_major(&t.connection_id, t.database.as_deref()).await?,
            )?;

            let session = state.pg(&t.connection_id, t.database.as_deref()).await?;
            let database = session.database.clone();
            // The effective config, so a tunnelled connection is dumped
            // through its tunnel like every other session.
            let cfg = state.effective(state.store.get_connection(&t.connection_id)?).await?;
            let args = dump::dump_args(&database, &target, &options);
            let id = dump::spawn(
                state.jobs.clone(),
                "dump",
                vec![dump::Stage::new(&tool, args)],
                dump::env_for(&cfg),
                Some(target.display().to_string()),
                true,
            )
            .await?;
            Ok(json!({ "id": id, "tool": tool.path, "version": tool.version, "file": target.display().to_string() }))
        }
        "restore.start" => {
            let source: String = p(&params["path"])?;
            let source = std::path::PathBuf::from(&source);
            // A directory-format backup is a folder, not a file.
            if !source.exists() {
                return Err(AppError::msg(format!("There is nothing at {}.", source.display())));
            }
            let connection_id: String = p(&params["connectionId"])?;
            let database: Option<String> = params["database"].as_str().map(str::to_string);
            let options: dump::RestoreOptions = p(&params["options"])?;
            let plain = params["plain"].as_bool().unwrap_or(false);

            let cfg = state.store.get_connection(&connection_id)?;
            writable(&cfg)?;
            let major = state.server_major(&connection_id, database.as_deref()).await?;
            let session = state.pg(&connection_id, database.as_deref()).await?;
            let target_db = session.database.clone();
            let cfg = state.effective(cfg).await?;

            let restore = dump::prepare_restore(&cfg, &target_db, major, &source, &options, plain).await?;
            let id = dump::spawn(
                state.jobs.clone(),
                "restore",
                restore.stages,
                dump::env_for(&cfg),
                Some(source.display().to_string()),
                false,
            )
            .await?;
            Ok(
                json!({ "id": id, "tool": restore.tool.path, "version": restore.tool.version,
                       "database": target_db, "replaced": restore.replaced }),
            )
        }
        "transfer.start" => {
            let from: PgTarget = p(&params["source"])?;
            let to: PgTarget = p(&params["target"])?;
            let options: transfer::Options = p(&params["options"])?;

            let from_cfg = state.store.get_connection(&from.connection_id)?;
            let to_cfg = state.store.get_connection(&to.connection_id)?;
            writable(&to_cfg)?;
            let source_db = state
                .pg(&from.connection_id, from.database.as_deref())
                .await?
                .database
                .clone();
            let target_db = state
                .pg(&to.connection_id, to.database.as_deref())
                .await?
                .database
                .clone();
            if source_db == target_db && same_server(&from_cfg, &to_cfg) {
                return Err(AppError::msg(
                    "That is the database being copied. Pick another database, or another server.",
                ));
            }

            // Everything that can be refused is refused now, not after a
            // backup that may have taken an hour.
            let source_major = state.server_major(&from.connection_id, Some(&source_db)).await?;
            let target_major = state.server_major(&to.connection_id, Some(&target_db)).await?;
            let pg_dump = dump::need("pg_dump", source_major)?;
            dump::need("pg_restore", target_major)?;
            if options.replace && options.single_transaction {
                dump::need("psql", target_major)?;
            }
            let source_cfg = state.effective(from_cfg).await?;
            let target_cfg = state.effective(to_cfg).await?;
            if !options.replace {
                let held = pg::user_relations(&target_cfg, &target_db).await?;
                if held > 0 {
                    return Err(AppError::msg(format!(
                        "{target_db} already holds {held} tables, views or sequences, and a copy that replaces nothing would stop at the first one. Turn on replacing, or pick an empty database."
                    )));
                }
            }

            let base = match params["folder"].as_str().filter(|f| !f.is_empty()) {
                Some(folder) => PathBuf::from(folder),
                None => std::env::temp_dir(),
            };
            let plan = transfer::Plan {
                source: transfer::Endpoint {
                    cfg: source_cfg,
                    database: source_db,
                    major: source_major,
                },
                target: transfer::Endpoint {
                    cfg: target_cfg,
                    database: target_db.clone(),
                    major: target_major,
                },
                options,
                scratch: transfer::scratch(&write_dir(state, &base)?)?,
                pg_dump: pg_dump.clone(),
            };
            let file = plan.archive().display().to_string();
            let id = transfer::start(state.jobs.clone(), plan);
            Ok(json!({ "id": id, "tool": pg_dump.path, "version": pg_dump.version,
                       "database": target_db, "file": file }))
        }
        "dump.status" => {
            let id: String = p(&params["id"])?;
            state
                .jobs
                .get(&id)
                .ok_or_else(|| AppError::msg("That job is no longer being tracked."))
        }
        "dump.cancel" => {
            let id: String = p(&params["id"])?;
            state.jobs.cancel(&id)?;
            Ok(Value::Null)
        }

        // ---- redis -----------------------------------------------------
        "redis.connect" => {
            let t: RedisTarget = p(&params)?;
            let s = state.redis(&t.connection_id, t.db).await?;
            state.store.touch_connection(&t.connection_id)?;
            rds::info(&s).await
        }
        "redis.info" => {
            let t: RedisTarget = p(&params)?;
            rds::info(&*state.redis(&t.connection_id, t.db).await?).await
        }
        "redis.scan" => {
            let t: RedisTarget = p(&params)?;
            let req: rds::ScanRequest = p(&params)?;
            rds::scan(&*state.redis(&t.connection_id, t.db).await?, req).await
        }
        "redis.get" => {
            let t: RedisTarget = p(&params)?;
            let key: String = p(&params["key"])?;
            rds::get_key(&*state.redis(&t.connection_id, t.db).await?, &key).await
        }
        "redis.command" => {
            let t: RedisTarget = p(&params)?;
            let args: Vec<String> = p(&params["args"])?;
            rds::command(&*state.redis(&t.connection_id, t.db).await?, args).await
        }
        "redis.console" => {
            let t: RedisTarget = p(&params)?;
            let line: String = p(&params["line"])?;
            let s = state.redis(&t.connection_id, t.db).await?;
            let started = std::time::Instant::now();
            let result = rds::command_line(&s, &line).await;
            let entry = state.store.add_history(NewHistory {
                connection_id: t.connection_id,
                database: t.db.map(|d| d.to_string()).unwrap_or_default(),
                kind: "redis".into(),
                sql: line,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                rows: None,
                error: result.as_ref().err().map(|e| e.message.clone()),
            })?;
            let mut v = result?;
            v["history"] = json!(entry);
            Ok(v)
        }

        // ---- history & saved queries ----------------------------------
        "history.list" => {
            let connection_id = params.get("connectionId").and_then(Value::as_str);
            let search = params.get("search").and_then(Value::as_str);
            let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(500);
            Ok(json!(state.store.list_history(connection_id, search, limit)?))
        }
        "history.delete" => {
            state.store.delete_history(p(&params["id"])?)?;
            Ok(Value::Null)
        }
        "history.clear" => {
            state
                .store
                .clear_history(params.get("connectionId").and_then(Value::as_str))?;
            Ok(Value::Null)
        }
        "saved.list" => Ok(json!(
            state
                .store
                .list_saved(params.get("connectionId").and_then(Value::as_str))?
        )),
        "saved.save" => {
            let q: SavedQuery = p(&params)?;
            if q.name.trim().is_empty() {
                return Err(AppError::msg("Give the query a name."));
            }
            Ok(json!(state.store.save_query(q)?))
        }
        "saved.delete" => {
            let id: String = p(&params["id"])?;
            state.store.delete_saved(&id)?;
            Ok(Value::Null)
        }

        // ---- settings & files -----------------------------------------
        "settings.get" => {
            let key: String = p(&params["key"])?;
            Ok(state.store.get_setting(&key)?.unwrap_or(Value::Null))
        }
        "settings.set" => {
            let key: String = p(&params["key"])?;
            state.store.set_setting(&key, &params["value"])?;
            Ok(Value::Null)
        }
        "fs.writeText" => {
            let path: String = p(&params["path"])?;
            let contents: String = p(&params["contents"])?;
            tokio::fs::write(write_target(state, &path)?, contents).await?;
            Ok(Value::Null)
        }

        other => Err(AppError::msg(format!("Unknown method \"{other}\"."))),
    }
}
