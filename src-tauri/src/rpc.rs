//! Single RPC surface shared by the Tauri command and the dev HTTP bridge.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::pg::{self, PgSession};
use crate::rds::{self, RedisSession};
use crate::ssh::{self, Tunnel};
use crate::store::{ConnectionConfig, NewHistory, SavedQuery, Store};

pub struct AppState {
    pub store: Store,
    pg: RwLock<HashMap<String, Arc<PgSession>>>,
    redis: RwLock<HashMap<String, Arc<RedisSession>>>,
    tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// Serialises session creation so parallel first requests share one connect.
    connecting: Mutex<()>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        Ok(AppState {
            store: Store::open(&data_dir)?,
            pg: RwLock::new(HashMap::new()),
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
        if let Some(t) = tunnels.get(&cfg.id) {
            if !t.is_closed() {
                return Ok(ssh::rewrite(&cfg, t));
            }
        }
        let t = Arc::new(ssh::open(&cfg).await?);
        let out = ssh::rewrite(&cfg, &t);
        tunnels.insert(cfg.id.clone(), t);
        Ok(out)
    }

    async fn pg(&self, connection_id: &str, database: Option<&str>) -> AppResult<Arc<PgSession>> {
        let cfg = self.store.get_connection(connection_id)?;
        if cfg.kind != "postgres" {
            return Err(AppError::msg("This connection is not a Postgres connection."));
        }
        let db = database.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| cfg.database.clone());
        let key = format!("{connection_id}\u{0}{db}");
        if let Some(s) = self.pg.read().await.get(&key) {
            if !s.is_closed() {
                return Ok(s.clone());
            }
        }
        let _guard = self.connecting.lock().await;
        if let Some(s) = self.pg.read().await.get(&key) {
            if !s.is_closed() {
                return Ok(s.clone());
            }
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

    async fn disconnect(&self, connection_id: &str) {
        let prefix = format!("{connection_id}\u{0}");
        self.pg.write().await.retain(|k, _| !k.starts_with(&prefix));
        self.redis.write().await.retain(|k, _| !k.starts_with(&prefix));
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
            let tunnel = if cfg.ssh_enabled { Some(ssh::open(&cfg).await?) } else { None };
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
            pg::table_structure(&*state.pg(&t.connection_id, t.database.as_deref()).await?, &t.schema, &t.table).await
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
            pg::signal_backend(&*state.pg(&t.connection_id, t.database.as_deref()).await?, pid, terminate).await
        }
        "pg.functionDef" => {
            let t: PgTarget = p(&params)?;
            let oid: i64 = p(&params["oid"])?;
            pg::function_definition(&*state.pg(&t.connection_id, t.database.as_deref()).await?, oid).await
        }
        "pg.exportCsv" => {
            let t: TableTarget = p(&params)?;
            let path: String = p(&params["path"])?;
            pg::export_csv(&*state.pg(&t.connection_id, t.database.as_deref()).await?, &t.schema, &t.table, &path).await
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
            state.store.clear_history(params.get("connectionId").and_then(Value::as_str))?;
            Ok(Value::Null)
        }
        "saved.list" => Ok(json!(state.store.list_saved(params.get("connectionId").and_then(Value::as_str))?)),
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
            tokio::fs::write(&path, contents).await?;
            Ok(Value::Null)
        }

        other => Err(AppError::msg(format!("Unknown method \"{other}\"."))),
    }
}
