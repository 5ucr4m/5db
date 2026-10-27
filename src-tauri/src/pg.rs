//! Postgres sessions, introspection, table browsing, editing and SQL execution.
//!
//! Every value crosses the bridge as text (`col::text`), which is exactly what a
//! viewer needs: lossless for every type, including user enums, arrays and ranges.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, pin_mut};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_postgres::types::ToSql;
use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use crate::error::{AppError, AppResult};
use crate::store::ConnectionConfig;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

pub struct PgConn {
    pub client: Client,
    pub closed: Arc<AtomicBool>,
}

impl PgConn {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed) || self.client.is_closed()
    }
}

/// One logical session = one (connection, database) pair. Browsing runs on a
/// shared pipelined client; the SQL editor and staged edits each get their own
/// client so `BEGIN` in the editor never leaks into grid reads or edits.
pub struct PgSession {
    pub cfg: ConnectionConfig,
    pub database: String,
    pub main: PgConn,
    pub editor: Mutex<Option<PgConn>>,
    pub editor_cancel: std::sync::Mutex<Option<CancelToken>>,
    /// True from the moment an editor execution is requested until it returns.
    pub editor_running: AtomicUsize,
    /// Set by `cancel`; an execution that has not reached the server yet aborts.
    pub cancel_requested: AtomicBool,
    pub writer: Mutex<Option<PgConn>>,
}

/// Splits a PEM bundle into its certificates; a CA file often holds a chain.
pub fn read_pem_certs(path: &str) -> AppResult<Vec<Vec<u8>>> {
    let pem = std::fs::read_to_string(path)
        .map_err(|e| AppError::msg(format!("Could not read the root certificate at {path}: {e}")))?;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    let mut out = Vec::new();
    let mut rest = pem.as_str();
    while let Some(i) = rest.find(BEGIN) {
        let after = &rest[i..];
        let end = after
            .find("-----END CERTIFICATE-----")
            .map(|e| e + "-----END CERTIFICATE-----".len())
            .unwrap_or(after.len());
        out.push(after.as_bytes()[..end].to_vec());
        rest = &after[end..];
    }
    if out.is_empty() {
        return Err(AppError::msg(format!("{path} holds no PEM certificate.")));
    }
    Ok(out)
}

fn tls_connector(cfg: &ConnectionConfig) -> AppResult<MakeTlsConnector> {
    // Mirrors libpq: `require` encrypts without checking who is on the other
    // end, `verify-ca` checks the chain, `verify-full` also checks the hostname.
    let verify_chain = matches!(cfg.ssl_mode.as_str(), "verify-ca" | "verify-full");
    let mut builder = native_tls::TlsConnector::builder();
    builder
        .danger_accept_invalid_certs(!verify_chain)
        .danger_accept_invalid_hostnames(cfg.ssl_mode != "verify-full");
    if !cfg.ssl_root_cert.is_empty() {
        for der in read_pem_certs(&cfg.ssl_root_cert)? {
            builder.add_root_certificate(native_tls::Certificate::from_pem(&der)?);
        }
    }
    Ok(MakeTlsConnector::new(builder.build()?))
}

pub async fn connect(cfg: &ConnectionConfig, database: &str) -> AppResult<PgConn> {
    let mut pc = tokio_postgres::Config::new();
    pc.host(if cfg.host.is_empty() { "localhost" } else { &cfg.host })
        .port(if cfg.port == 0 { 5432 } else { cfg.port })
        .user(if cfg.user.is_empty() { "postgres" } else { &cfg.user })
        .dbname(if database.is_empty() { "postgres" } else { database })
        .application_name("5db")
        .connect_timeout(Duration::from_secs(10))
        .keepalives(true)
        .ssl_mode(match cfg.ssl_mode.as_str() {
            "disable" => tokio_postgres::config::SslMode::Disable,
            "require" | "verify-ca" | "verify-full" => tokio_postgres::config::SslMode::Require,
            _ => tokio_postgres::config::SslMode::Prefer,
        });
    if !cfg.password.is_empty() {
        pc.password(&cfg.password);
    }
    let tls = tls_connector(cfg)?;
    let (client, connection) = tokio::time::timeout(Duration::from_secs(12), pc.connect(tls))
        .await
        .map_err(|_| AppError::msg("Timed out after 12s while connecting. Check host, port and firewall."))??;
    let closed = Arc::new(AtomicBool::new(false));
    let flag = closed.clone();
    tokio::spawn(async move {
        let _ = connection.await;
        flag.store(true, Ordering::Relaxed);
    });
    if cfg.read_only {
        client.batch_execute("SET default_transaction_read_only = on").await?;
    }
    if cfg.statement_timeout_ms > 0 {
        // Integer-only interpolation: the value never comes from free text.
        client
            .batch_execute(&format!("SET statement_timeout = {}", cfg.statement_timeout_ms))
            .await?;
    }
    Ok(PgConn { client, closed })
}

impl PgSession {
    pub async fn open(cfg: ConnectionConfig, database: String) -> AppResult<Self> {
        let main = connect(&cfg, &database).await?;
        Ok(PgSession {
            cfg,
            database,
            main,
            editor: Mutex::new(None),
            editor_cancel: std::sync::Mutex::new(None),
            editor_running: AtomicUsize::new(0),
            cancel_requested: AtomicBool::new(false),
            writer: Mutex::new(None),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.main.is_closed()
    }

    fn c(&self) -> &Client {
        &self.main.client
    }
}

pub async fn test_connection(cfg: &ConnectionConfig) -> AppResult<Value> {
    let started = Instant::now();
    let conn = connect(cfg, &cfg.database).await?;
    let row = conn
        .client
        .query_one(
            "SELECT version(), current_user::text, current_database()::text, inet_server_addr()::text",
            &[],
        )
        .await?;
    Ok(json!({
        "version": row.get::<_, String>(0),
        "user": row.get::<_, String>(1),
        "database": row.get::<_, String>(2),
        "serverAddr": row.get::<_, Option<String>>(3),
        "latencyMs": started.elapsed().as_secs_f64() * 1000.0,
    }))
}

// ---------------------------------------------------------------------------
// Identifiers & small helpers
// ---------------------------------------------------------------------------

pub fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

const USER_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'";

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

pub async fn server_info(s: &PgSession) -> AppResult<Value> {
    let row = s
        .c()
        .query_one(
            "SELECT version(), current_setting('server_version'), current_user::text, current_database()::text,
                    pg_database_size(current_database()), current_setting('default_transaction_read_only')",
            &[],
        )
        .await?;
    Ok(json!({
        "version": row.get::<_, String>(0),
        "serverVersion": row.get::<_, String>(1),
        "user": row.get::<_, String>(2),
        "database": row.get::<_, String>(3),
        "sizeBytes": row.get::<_, i64>(4),
        "readOnly": row.get::<_, String>(5) == "on",
    }))
}

pub async fn list_databases(s: &PgSession) -> AppResult<Value> {
    let rows = s
        .c()
        .query(
            "SELECT datname::text, pg_database_size(datname) FROM pg_database
             WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT')
             ORDER BY datname",
            &[],
        )
        .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| json!({ "name": r.get::<_, String>(0), "sizeBytes": r.get::<_, i64>(1) }))
            .collect(),
    ))
}

pub async fn list_objects(s: &PgSession) -> AppResult<Value> {
    let c = s.c();
    let schemas_sql = format!(
        "SELECT n.nspname::text FROM pg_namespace n WHERE {USER_SCHEMAS} ORDER BY n.nspname = 'public' DESC, n.nspname"
    );
    let rel_sql = format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, c.reltuples::float8,
                CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid) END,
                obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','f','p') AND {USER_SCHEMAS} AND NOT c.relispartition
         ORDER BY n.nspname, c.relname"
    );
    let fn_sql = format!(
        "SELECT n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid),
                COALESCE(pg_get_function_result(p.oid), ''), p.prokind::text, p.oid::int8
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE {USER_SCHEMAS}
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         ORDER BY n.nspname, p.proname"
    );
    let (schemas, rels, fns) = tokio::try_join!(
        c.query(&schemas_sql, &[]),
        c.query(&rel_sql, &[]),
        c.query(&fn_sql, &[])
    )?;
    let objects: Vec<Value> = rels
        .iter()
        .map(|r| {
            let kind = match r.get::<_, String>(2).as_str() {
                "r" | "p" => "table",
                "v" => "view",
                "m" => "matview",
                "f" => "foreign",
                _ => "table",
            };
            let est: f64 = r.get(3);
            json!({
                "schema": r.get::<_, String>(0),
                "name": r.get::<_, String>(1),
                "kind": kind,
                "rowEstimate": if est < 0.0 { Value::Null } else { json!(est as i64) },
                "sizeBytes": r.get::<_, Option<i64>>(4),
                "comment": r.get::<_, Option<String>>(5),
            })
        })
        .collect();
    let functions: Vec<Value> = fns
        .iter()
        .map(|r| {
            json!({
                "schema": r.get::<_, String>(0),
                "name": r.get::<_, String>(1),
                "args": r.get::<_, String>(2),
                "returns": r.get::<_, String>(3),
                "kind": match r.get::<_, String>(4).as_str() { "p" => "procedure", "a" => "aggregate", "w" => "window", _ => "function" },
                "oid": r.get::<_, i64>(5),
            })
        })
        .collect();
    Ok(json!({
        "schemas": schemas.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>(),
        "objects": objects,
        "functions": functions,
    }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub cast_type: String,
    pub category: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    pub position: i32,
    pub is_pk: bool,
    pub identity: bool,
    pub generated: bool,
    pub enum_values: Option<Vec<String>>,
}

pub async fn columns(s: &PgSession, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    columns_on(s.c(), schema, table).await
}

async fn columns_on(c: &Client, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let rows = c
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), format_type(a.atttypid, a.atttypmod),
                    t.typcategory::text, NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                    col_description(a.attrelid, a.attnum), a.attnum::int4,
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
                    a.attidentity <> '', a.attgenerated <> '',
                    (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e
                      WHERE e.enumtypid = COALESCE(NULLIF(t.typbasetype, 0), t.oid))
             FROM pg_attribute a
             JOIN pg_type t ON t.oid = a.atttypid
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = ($1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&qualified(schema, table)],
        )
        .await?;
    if rows.is_empty() {
        return Err(AppError::msg(format!(
            "Table {schema}.{table} has no columns or does not exist."
        )));
    }
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: r.get(0),
            data_type: r.get(1),
            cast_type: r.get(2),
            category: r.get(3),
            nullable: r.get(4),
            default: r.get(5),
            comment: r.get(6),
            position: r.get(7),
            is_pk: r.get(8),
            identity: r.get(9),
            generated: r.get(10),
            enum_values: r.get(11),
        })
        .collect())
}

pub async fn table_structure(s: &PgSession, schema: &str, table: &str) -> AppResult<Value> {
    let c = s.c();
    let rel = qualified(schema, table);
    let rp: [&(dyn ToSql + Sync); 1] = [&rel];
    let cols = columns(s, schema, table);
    let info = c.query_one(
        "SELECT c.relkind::text, c.reltuples::float8, pg_total_relation_size(c.oid), pg_relation_size(c.oid),
                obj_description(c.oid, 'pg_class'),
                CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END,
                pg_get_userbyid(c.relowner)::text
         FROM pg_class c WHERE c.oid = ($1::text)::regclass",
        &rp,
    );
    let fks = c.query(
        "SELECT con.conname::text, array_agg(a.attname::text ORDER BY k.ord), fn.nspname::text, fc.relname::text,
                array_agg(fa.attname::text ORDER BY k.ord), pg_get_constraintdef(con.oid)
         FROM pg_constraint con
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         JOIN pg_class fc ON fc.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.refnum
         WHERE con.contype = 'f' AND con.conrelid = ($1::text)::regclass
         GROUP BY con.oid, con.conname, fn.nspname, fc.relname
         ORDER BY con.conname",
        &rp,
    );
    let refs = c.query(
        "SELECT con.conname::text, n.nspname::text, cl.relname::text,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
                pg_get_constraintdef(con.oid)
         FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
         WHERE con.contype = 'f' AND con.confrelid = ($1::text)::regclass
         ORDER BY n.nspname, cl.relname",
        &rp,
    );
    let indexes = c.query(
        "SELECT i.relname::text, pg_get_indexdef(ix.indexrelid), ix.indisunique, ix.indisprimary,
                pg_relation_size(ix.indexrelid), am.amname::text
         FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
         WHERE ix.indrelid = ($1::text)::regclass ORDER BY ix.indisprimary DESC, i.relname",
        &rp,
    );
    let constraints = c.query(
        "SELECT conname::text, contype::text, pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = ($1::text)::regclass ORDER BY contype, conname",
        &rp,
    );
    let triggers = c.query(
        "SELECT tgname::text, pg_get_triggerdef(oid, true), tgenabled <> 'D' FROM pg_trigger
         WHERE tgrelid = ($1::text)::regclass AND NOT tgisinternal ORDER BY tgname",
        &rp,
    );
    let (cols, info, fks, refs, indexes, constraints, triggers) = tokio::try_join!(
        cols,
        async { info.await.map_err(AppError::from) },
        async { fks.await.map_err(AppError::from) },
        async { refs.await.map_err(AppError::from) },
        async { indexes.await.map_err(AppError::from) },
        async { constraints.await.map_err(AppError::from) },
        async { triggers.await.map_err(AppError::from) }
    )?;

    let est: f64 = info.get(1);
    Ok(json!({
        "schema": schema,
        "name": table,
        "kind": match info.get::<_, String>(0).as_str() { "v" => "view", "m" => "matview", "f" => "foreign", _ => "table" },
        "rowEstimate": if est < 0.0 { Value::Null } else { json!(est as i64) },
        "totalBytes": info.get::<_, i64>(2),
        "tableBytes": info.get::<_, i64>(3),
        "comment": info.get::<_, Option<String>>(4),
        "viewDefinition": info.get::<_, Option<String>>(5),
        "owner": info.get::<_, String>(6),
        "columns": cols,
        "foreignKeys": fks.iter().map(|r| json!({
            "name": r.get::<_, String>(0),
            "columns": r.get::<_, Vec<String>>(1),
            "refSchema": r.get::<_, String>(2),
            "refTable": r.get::<_, String>(3),
            "refColumns": r.get::<_, Vec<String>>(4),
            "definition": r.get::<_, String>(5),
        })).collect::<Vec<_>>(),
        "referencedBy": refs.iter().map(|r| json!({
            "name": r.get::<_, String>(0),
            "schema": r.get::<_, String>(1),
            "table": r.get::<_, String>(2),
            "columns": r.get::<_, Option<Vec<String>>>(3).unwrap_or_default(),
            "definition": r.get::<_, String>(4),
        })).collect::<Vec<_>>(),
        "indexes": indexes.iter().map(|r| json!({
            "name": r.get::<_, String>(0),
            "definition": r.get::<_, String>(1),
            "unique": r.get::<_, bool>(2),
            "primary": r.get::<_, bool>(3),
            "sizeBytes": r.get::<_, i64>(4),
            "method": r.get::<_, String>(5),
        })).collect::<Vec<_>>(),
        "constraints": constraints.iter().map(|r| json!({
            "name": r.get::<_, String>(0),
            "type": match r.get::<_, String>(1).as_str() { "p" => "primary key", "f" => "foreign key", "u" => "unique", "c" => "check", "x" => "exclusion", "t" => "trigger", _ => "other" },
            "definition": r.get::<_, String>(2),
        })).collect::<Vec<_>>(),
        "triggers": triggers.iter().map(|r| json!({
            "name": r.get::<_, String>(0),
            "definition": r.get::<_, String>(1),
            "enabled": r.get::<_, bool>(2),
        })).collect::<Vec<_>>(),
    }))
}

pub async fn function_definition(s: &PgSession, oid: i64) -> AppResult<Value> {
    let row = s
        .c()
        .query_one("SELECT pg_get_functiondef($1::int8::oid)", &[&oid])
        .await?;
    Ok(json!(row.get::<_, String>(0)))
}

/// Table → columns map for editor autocompletion.
pub async fn completion_schema(s: &PgSession) -> AppResult<Value> {
    let sql = format!(
        "SELECT n.nspname::text, c.relname::text, array_agg(a.attname::text ORDER BY a.attnum)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE c.relkind IN ('r','v','m','f','p') AND {USER_SCHEMAS}
         GROUP BY n.nspname, c.relname"
    );
    let rows = s.c().query(&sql, &[]).await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| json!({ "schema": r.get::<_, String>(0), "table": r.get::<_, String>(1), "columns": r.get::<_, Vec<String>>(2) }))
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Browsing rows: filters, sorting, paging
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub value2: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// "and" | "or"
    #[serde(default)]
    pub match_mode: Option<String>,
    #[serde(default)]
    pub raw_where: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: Vec<Sort>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "yes")]
    pub count: bool,
}

fn default_limit() -> i64 {
    500
}

struct WhereBuilder<'a> {
    cols: &'a HashMap<&'a str, &'a ColumnInfo>,
    params: Vec<Box<dyn ToSql + Sync + Send>>,
}

impl<'a> WhereBuilder<'a> {
    fn bind(&mut self, v: impl ToSql + Sync + Send + 'static) -> String {
        self.params.push(Box::new(v));
        format!("${}", self.params.len())
    }

    fn condition(&mut self, f: &Filter) -> AppResult<String> {
        let col = self
            .cols
            .get(f.column.as_str())
            .ok_or_else(|| AppError::msg(format!("Unknown column \"{}\" in filter.", f.column)))?;
        let ident = format!("t.{}", quote_ident(&col.name));
        let cast = &col.cast_type;
        let val = f.value.clone().unwrap_or_default();
        let typed = |b: &mut Self, v: String| -> String { format!("{}::text::{}", b.bind(v), cast) };
        Ok(match f.op.as_str() {
            "eq" => format!("{ident} = {}", typed(self, val)),
            "neq" => format!("{ident} IS DISTINCT FROM {}", typed(self, val)),
            "lt" => format!("{ident} < {}", typed(self, val)),
            "lte" => format!("{ident} <= {}", typed(self, val)),
            "gt" => format!("{ident} > {}", typed(self, val)),
            "gte" => format!("{ident} >= {}", typed(self, val)),
            "contains" => format!(
                "{ident}::text ILIKE {} ESCAPE '\\'",
                self.bind(format!("%{}%", like_escape(&val)))
            ),
            "not_contains" => format!(
                "({ident} IS NULL OR {ident}::text NOT ILIKE {} ESCAPE '\\')",
                self.bind(format!("%{}%", like_escape(&val)))
            ),
            "starts_with" => format!(
                "{ident}::text ILIKE {} ESCAPE '\\'",
                self.bind(format!("{}%", like_escape(&val)))
            ),
            "ends_with" => format!(
                "{ident}::text ILIKE {} ESCAPE '\\'",
                self.bind(format!("%{}", like_escape(&val)))
            ),
            "regex" => format!("{ident}::text ~* {}", self.bind(val)),
            "is_null" => format!("{ident} IS NULL"),
            "not_null" => format!("{ident} IS NOT NULL"),
            "is_empty" => format!("({ident} IS NULL OR {ident}::text = '')"),
            "is_true" => format!("{ident} IS TRUE"),
            "is_false" => format!("{ident} IS FALSE"),
            "in" | "not_in" => {
                let items: Vec<String> = val
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                let p = self.bind(items);
                let expr = format!("{ident} = ANY({p}::text[]::{cast}[])");
                if f.op == "in" { expr } else { format!("NOT ({expr})") }
            }
            "between" => {
                let lo = typed(self, val);
                let hi = typed(self, f.value2.clone().unwrap_or_default());
                format!("{ident} BETWEEN {lo} AND {hi}")
            }
            other => return Err(AppError::msg(format!("Unsupported filter operator \"{other}\"."))),
        })
    }
}

pub async fn fetch_rows(s: &PgSession, req: FetchRequest) -> AppResult<Value> {
    let started = Instant::now();
    let c = s.c();
    let cols = columns(s, &req.schema, &req.table).await?;
    let by_name: HashMap<&str, &ColumnInfo> = cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let rel = qualified(&req.schema, &req.table);

    let kind_row = c
        .query_one(
            "SELECT c.relkind::text FROM pg_class c WHERE c.oid = ($1::text)::regclass",
            &[&rel],
        )
        .await?;
    let relkind: String = kind_row.get(0);
    let has_ctid = matches!(relkind.as_str(), "r" | "p" | "m");

    let mut wb = WhereBuilder {
        cols: &by_name,
        params: Vec::new(),
    };
    let mut conds: Vec<String> = Vec::new();
    for f in req.filters.iter().filter(|f| f.enabled) {
        conds.push(wb.condition(f)?);
    }
    let joiner = if req.match_mode.as_deref() == Some("or") {
        " OR "
    } else {
        " AND "
    };
    let mut clauses: Vec<String> = Vec::new();
    if !conds.is_empty() {
        clauses.push(format!("({})", conds.join(joiner)));
    }
    if let Some(raw) = req.raw_where.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        clauses.push(format!("({raw})"));
    }
    if let Some(q) = req.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let p = wb.bind(format!("%{}%", like_escape(q)));
        clauses.push(format!("(t.*)::text ILIKE {p} ESCAPE '\\'"));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let mut order: Vec<String> = Vec::new();
    for srt in &req.sort {
        let col = by_name
            .get(srt.column.as_str())
            .ok_or_else(|| AppError::msg(format!("Unknown column \"{}\" in sort.", srt.column)))?;
        order.push(format!(
            "t.{} {}",
            quote_ident(&col.name),
            if srt.desc { "DESC NULLS LAST" } else { "ASC NULLS FIRST" }
        ));
    }
    if order.is_empty() {
        // Stable paging: primary key order when available, else physical order.
        let pk: Vec<String> = cols
            .iter()
            .filter(|c| c.is_pk)
            .map(|c| format!("t.{}", quote_ident(&c.name)))
            .collect();
        if !pk.is_empty() {
            order = pk;
        } else if has_ctid {
            order.push("t.ctid".into());
        }
    }
    let order_sql = if order.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order.join(", "))
    };

    let select_list: Vec<String> = cols
        .iter()
        .map(|c| format!("t.{}::text", quote_ident(&c.name)))
        .collect();
    let rowid = if has_ctid { "t.ctid::text" } else { "NULL::text" };
    let limit = req.limit.clamp(1, 100_000);
    let offset = req.offset.max(0);
    let data_sql = format!(
        "SELECT {rowid}, {} FROM {rel} AS t{where_sql}{order_sql} LIMIT {limit} OFFSET {offset}",
        select_list.join(", ")
    );
    let params: Vec<&(dyn ToSql + Sync)> = wb.params.iter().map(|p| p.as_ref() as &(dyn ToSql + Sync)).collect();

    let filtered = !clauses.is_empty();
    let count_fut = async {
        if !req.count {
            return Ok::<_, AppError>((None, false));
        }
        if !filtered {
            // Large unfiltered tables: the planner estimate is instant and good enough.
            let est: f64 = c
                .query_one(
                    "SELECT reltuples::float8 FROM pg_class WHERE oid = ($1::text)::regclass",
                    &[&rel],
                )
                .await?
                .get(0);
            if est > 500_000.0 {
                return Ok((Some(est as i64), true));
            }
        }
        let count_sql = format!("SELECT count(*) FROM {rel} AS t{where_sql}");
        let n: i64 = c.query_one(&count_sql, &params).await?.get(0);
        Ok((Some(n), false))
    };
    let data_fut = async { c.query(&data_sql, &params).await.map_err(AppError::from) };
    let (rows, (total, estimated)) = tokio::try_join!(data_fut, count_fut)?;

    let mut row_ids: Vec<Option<String>> = Vec::with_capacity(rows.len());
    let mut out: Vec<Vec<Option<String>>> = Vec::with_capacity(rows.len());
    for r in &rows {
        row_ids.push(r.get(0));
        out.push((1..=cols.len()).map(|i| r.get::<_, Option<String>>(i)).collect());
    }
    Ok(json!({
        "columns": cols,
        "rows": out,
        "rowIds": row_ids,
        "total": total,
        "totalEstimated": estimated,
        "editable": relkind == "r" || relkind == "p" || relkind == "f",
        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
        "sql": data_sql,
    }))
}

// ---------------------------------------------------------------------------
// Editing: staged changes applied in one transaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Change {
    #[serde(rename = "update")]
    Update {
        key: RowKey,
        values: HashMap<String, Option<String>>,
    },
    #[serde(rename = "insert")]
    Insert { values: HashMap<String, Option<String>> },
    #[serde(rename = "delete")]
    Delete { key: RowKey },
}

/// Identifies a row: primary key column values, or the physical ctid when the
/// table has no primary key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowKey {
    #[serde(default)]
    pub pk: Option<HashMap<String, Option<String>>>,
    #[serde(default)]
    pub ctid: Option<String>,
}

async fn writer_conn<'a>(s: &'a PgSession) -> AppResult<tokio::sync::MutexGuard<'a, Option<PgConn>>> {
    let mut guard = s.writer.lock().await;
    if guard.as_ref().map(|c| c.is_closed()).unwrap_or(true) {
        *guard = Some(connect(&s.cfg, &s.database).await?);
    }
    Ok(guard)
}

/// Pushes a value onto the parameter list and returns its `$n` placeholder.
type Bind<'a> = &'a mut dyn FnMut(Option<String>, &mut Vec<Option<String>>) -> String;

pub async fn apply_changes(s: &PgSession, schema: &str, table: &str, changes: Vec<Change>) -> AppResult<Value> {
    let mut guard = writer_conn(s).await?;
    let conn = guard.as_mut().unwrap();
    let cols = columns_on(&conn.client, schema, table).await?;
    let by_name: HashMap<&str, &ColumnInfo> = cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let rel = qualified(schema, table);

    let col = |name: &str| -> AppResult<&ColumnInfo> {
        by_name
            .get(name)
            .copied()
            .ok_or_else(|| AppError::msg(format!("Unknown column \"{name}\".")))
    };

    let tx = conn.client.transaction().await?;
    let mut affected: Vec<u64> = Vec::new();
    for (idx, change) in changes.iter().enumerate() {
        let mut params: Vec<Option<String>> = Vec::new();
        let mut bind = |v: Option<String>, params: &mut Vec<Option<String>>| {
            params.push(v);
            format!("${}", params.len())
        };
        let key_sql = |key: &RowKey, params: &mut Vec<Option<String>>, bind: Bind<'_>| -> AppResult<String> {
            if let Some(pk) = key.pk.as_ref().filter(|m| !m.is_empty()) {
                let mut parts = Vec::new();
                for (k, v) in pk {
                    let c = col(k)?;
                    match v {
                        Some(v) => {
                            let p = bind(Some(v.clone()), params);
                            parts.push(format!("{} = {p}::text::{}", quote_ident(&c.name), c.cast_type))
                        }
                        None => parts.push(format!("{} IS NULL", quote_ident(&c.name))),
                    }
                }
                Ok(parts.join(" AND "))
            } else if let Some(ctid) = &key.ctid {
                let p = bind(Some(ctid.clone()), params);
                Ok(format!("ctid = {p}::text::tid"))
            } else {
                Err(AppError::msg("Cannot identify the row: no primary key or ctid."))
            }
        };
        let sql = match change {
            Change::Update { key, values } => {
                let mut sets = Vec::new();
                for (k, v) in values {
                    let c = col(k)?;
                    let p = bind(v.clone(), &mut params);
                    sets.push(format!("{} = {p}::text::{}", quote_ident(&c.name), c.cast_type));
                }
                if sets.is_empty() {
                    continue;
                }
                let w = key_sql(key, &mut params, &mut bind)?;
                format!("UPDATE {rel} SET {} WHERE {w}", sets.join(", "))
            }
            Change::Insert { values } => {
                if values.is_empty() {
                    format!("INSERT INTO {rel} DEFAULT VALUES")
                } else {
                    let mut names = Vec::new();
                    let mut vals = Vec::new();
                    for (k, v) in values {
                        let c = col(k)?;
                        names.push(quote_ident(&c.name));
                        let p = bind(v.clone(), &mut params);
                        vals.push(format!("{p}::text::{}", c.cast_type));
                    }
                    format!("INSERT INTO {rel} ({}) VALUES ({})", names.join(", "), vals.join(", "))
                }
            }
            Change::Delete { key } => {
                let w = key_sql(key, &mut params, &mut bind)?;
                format!("DELETE FROM {rel} WHERE {w}")
            }
        };
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
        match tx.execute(&sql, &refs).await {
            Ok(n) => {
                if n > 1 && !matches!(change, Change::Insert { .. }) {
                    return Err(AppError::msg(format!(
                        "Change #{} would affect {n} rows instead of one. Nothing was saved.",
                        idx + 1
                    )));
                }
                affected.push(n)
            }
            Err(e) => {
                let mut err = AppError::from(e);
                err.message = format!("Change #{} failed: {}. Nothing was saved.", idx + 1, err.message);
                return Err(err);
            }
        }
    }
    tx.commit().await?;
    Ok(json!({ "affected": affected }))
}

// ---------------------------------------------------------------------------
// SQL editor
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    /// "rows" for statements returning a result, "command" otherwise.
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: Option<u64>,
    pub truncated: bool,
}

async fn editor_conn<'a>(s: &'a PgSession) -> AppResult<tokio::sync::MutexGuard<'a, Option<PgConn>>> {
    let mut guard = s.editor.lock().await;
    if guard.as_ref().map(|c| c.is_closed()).unwrap_or(true) {
        let conn = connect(&s.cfg, &s.database).await?;
        *s.editor_cancel.lock().unwrap() = Some(conn.client.cancel_token());
        *guard = Some(conn);
    }
    Ok(guard)
}

struct RunningGuard<'a>(&'a AtomicUsize);
impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn cancelled_error() -> AppError {
    AppError {
        message: "canceling statement due to user request".into(),
        code: Some("57014".into()),
        ..Default::default()
    }
}

pub async fn execute(s: &PgSession, sql: &str, max_rows: usize) -> AppResult<Value> {
    let started = Instant::now();
    s.cancel_requested.store(false, Ordering::SeqCst);
    s.editor_running.fetch_add(1, Ordering::SeqCst);
    let _running = RunningGuard(&s.editor_running);
    let guard = editor_conn(s).await?;
    if s.cancel_requested.load(Ordering::SeqCst) {
        return Ok(
            json!({ "results": [], "error": cancelled_error(), "durationMs": started.elapsed().as_secs_f64() * 1000.0 }),
        );
    }
    let client = &guard.as_ref().unwrap().client;
    let max_rows = max_rows.clamp(1, 1_000_000);

    // Column types are only available through the extended protocol; parsing a
    // single statement is cheap and lets the grid render types for SELECTs.
    let types: Option<Vec<String>> = match client.prepare(sql).await {
        Ok(stmt) => Some(stmt.columns().iter().map(|c| c.type_().name().to_string()).collect()),
        Err(_) => None,
    };

    let mut results: Vec<ResultSet> = Vec::new();
    let mut current: Option<ResultSet> = None;
    let mut error: Option<AppError> = None;
    let mut cancelled_for_cap = false;

    let stream = client.simple_query_raw(sql).await;
    match stream {
        Err(e) => error = Some(e.into()),
        Ok(stream) => {
            pin_mut!(stream);
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(SimpleQueryMessage::RowDescription(cols)) => {
                        current = Some(ResultSet {
                            kind: "rows",
                            columns: cols.iter().map(|c| c.name().to_string()).collect(),
                            column_types: Vec::new(),
                            rows: Vec::new(),
                            affected: None,
                            truncated: false,
                        });
                    }
                    Ok(SimpleQueryMessage::Row(row)) => {
                        if let Some(rs) = current.as_mut() {
                            if rs.rows.len() < max_rows {
                                rs.rows
                                    .push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                            } else if !rs.truncated {
                                rs.truncated = true;
                                // Stop the server from streaming rows we will discard.
                                if let Some(tok) = s.editor_cancel.lock().unwrap().clone()
                                    && let Ok(tls) = tls_connector(&s.cfg)
                                {
                                    cancelled_for_cap = true;
                                    tokio::spawn(async move {
                                        let _ = tok.cancel_query(tls).await;
                                    });
                                }
                            }
                        }
                    }
                    Ok(SimpleQueryMessage::CommandComplete(n)) => match current.take() {
                        Some(mut rs) => {
                            rs.affected = Some(n);
                            results.push(rs);
                        }
                        None => results.push(ResultSet {
                            kind: "command",
                            columns: vec![],
                            column_types: vec![],
                            rows: vec![],
                            affected: Some(n),
                            truncated: false,
                        }),
                    },
                    Ok(_) => {}
                    Err(e) => {
                        let err = AppError::from(e);
                        let was_cap_cancel = cancelled_for_cap && err.code.as_deref() == Some("57014");
                        if let Some(rs) = current.take() {
                            results.push(rs);
                        }
                        if !was_cap_cancel {
                            error = Some(err);
                        }
                        break;
                    }
                }
            }
        }
    }
    if let Some(rs) = current.take() {
        results.push(rs);
    }
    if let Some(types) = types
        && results.len() == 1
        && results[0].columns.len() == types.len()
    {
        results[0].column_types = types;
    }
    Ok(json!({
        "results": results,
        "error": error,
        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
    }))
}

/// Cancels the editor's running statement. The request can race the statement
/// reaching the server (connection still opening, query not yet sent), so it is
/// re-sent while the execution is still in flight.
pub async fn cancel(s: &PgSession) -> AppResult<Value> {
    if s.editor_running.load(Ordering::SeqCst) == 0 {
        return Ok(json!(false));
    }
    s.cancel_requested.store(true, Ordering::SeqCst);
    for _ in 0..25 {
        let token = s.editor_cancel.lock().unwrap().clone();
        if let Some(tok) = token {
            tok.cancel_query(tls_connector(&s.cfg)?).await?;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        if s.editor_running.load(Ordering::SeqCst) == 0 {
            break;
        }
    }
    Ok(json!(true))
}

// ---------------------------------------------------------------------------
// Server activity & maintenance
// ---------------------------------------------------------------------------

pub async fn activity(s: &PgSession) -> AppResult<Value> {
    let rows = s
        .c()
        .query(
            "SELECT pid, usename::text, datname::text, application_name, client_addr::text, state,
                    to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS'),
                    EXTRACT(EPOCH FROM (now() - query_start))::float8, wait_event_type, wait_event, query,
                    pid = pg_backend_pid()
             FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY query_start NULLS LAST",
            &[],
        )
        .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "pid": r.get::<_, i32>(0),
                    "user": r.get::<_, Option<String>>(1),
                    "database": r.get::<_, Option<String>>(2),
                    "application": r.get::<_, Option<String>>(3),
                    "clientAddr": r.get::<_, Option<String>>(4),
                    "state": r.get::<_, Option<String>>(5),
                    "backendStart": r.get::<_, Option<String>>(6),
                    "queryAgeSec": r.get::<_, Option<f64>>(7),
                    "waitEventType": r.get::<_, Option<String>>(8),
                    "waitEvent": r.get::<_, Option<String>>(9),
                    "query": r.get::<_, Option<String>>(10),
                    "isSelf": r.get::<_, bool>(11),
                })
            })
            .collect(),
    ))
}

pub async fn signal_backend(s: &PgSession, pid: i32, terminate: bool) -> AppResult<Value> {
    let f = if terminate {
        "pg_terminate_backend"
    } else {
        "pg_cancel_backend"
    };
    let ok: bool = s.c().query_one(&format!("SELECT {f}($1)"), &[&pid]).await?.get(0);
    Ok(json!(ok))
}

/// Streams a table (or filtered view of it) to a CSV file with COPY.
pub async fn export_csv(s: &PgSession, schema: &str, table: &str, path: &str) -> AppResult<Value> {
    use tokio::io::AsyncWriteExt;
    let sql = format!(
        "COPY (SELECT * FROM {}) TO STDOUT WITH (FORMAT csv, HEADER true)",
        qualified(schema, table)
    );
    let stream = s.c().copy_out(sql.as_str()).await?;
    pin_mut!(stream);
    let mut file = tokio::fs::File::create(path).await?;
    let mut bytes: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        bytes += chunk.len() as u64;
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(json!({ "bytes": bytes }))
}
