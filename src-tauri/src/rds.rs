//! Redis sessions: key browsing with SCAN, typed value reads, raw commands and
//! server info. Mutations are expressed by the frontend as plain commands.

use std::time::{Duration, Instant};

use redis::Value as RV;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::error::{AppError, AppResult};
use crate::store::ConnectionConfig;

pub struct RedisSession {
    pub conn: ConnectionManager,
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn url(cfg: &ConnectionConfig, db: i64) -> String {
    let scheme = if cfg.tls { "rediss" } else { "redis" };
    let auth = match (cfg.user.is_empty(), cfg.password.is_empty()) {
        (true, true) => String::new(),
        (true, false) => format!(":{}@", enc(&cfg.password)),
        (false, true) => format!("{}@", enc(&cfg.user)),
        (false, false) => format!("{}:{}@", enc(&cfg.user), enc(&cfg.password)),
    };
    let host = if cfg.host.is_empty() { "127.0.0.1" } else { &cfg.host };
    let port = if cfg.port == 0 { 6379 } else { cfg.port };
    // Managed Redis often uses self-signed certs; match the Postgres "prefer" stance.
    let insecure = if cfg.tls { "#insecure" } else { "" };
    format!("{scheme}://{auth}{host}:{port}/{db}{insecure}")
}

pub async fn connect(cfg: &ConnectionConfig, db: i64) -> AppResult<RedisSession> {
    let client = redis::Client::open(url(cfg, db))?;
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(8)))
        .set_response_timeout(Some(Duration::from_secs(30)))
        .set_number_of_retries(2);
    let conn = tokio::time::timeout(
        Duration::from_secs(10),
        client.get_connection_manager_with_config(config),
    )
    .await
    .map_err(|_| AppError::msg("Timed out after 10s while connecting. Check host, port and firewall."))??;
    Ok(RedisSession { conn })
}

pub async fn test_connection(cfg: &ConnectionConfig) -> AppResult<Value> {
    let started = Instant::now();
    let s = connect(cfg, cfg.redis_db).await?;
    let mut c = s.conn.clone();
    let pong: String = redis::cmd("PING").query_async(&mut c).await?;
    let latency = started.elapsed().as_secs_f64() * 1000.0;
    let info: String = redis::cmd("INFO")
        .arg("server")
        .query_async(&mut c)
        .await
        .unwrap_or_default();
    let version = info
        .lines()
        .find_map(|l| {
            l.strip_prefix("redis_version:")
                .or_else(|| l.strip_prefix("valkey_version:"))
        })
        .unwrap_or("unknown")
        .trim()
        .to_string();
    Ok(json!({ "pong": pong, "version": version, "latencyMs": latency }))
}

/// Converts a reply to JSON. Binary data that is not UTF-8 is shown lossily.
pub fn to_json(v: RV) -> Value {
    match v {
        RV::Nil => Value::Null,
        RV::Int(i) => json!(i),
        RV::BulkString(b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
        RV::Array(items) | RV::Set(items) => Value::Array(items.into_iter().map(to_json).collect()),
        RV::SimpleString(s) => Value::String(s),
        RV::Okay => Value::String("OK".into()),
        RV::Map(pairs) => {
            let mut m = Map::new();
            for (k, v) in pairs {
                let key = match to_json(k) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                m.insert(key, to_json(v));
            }
            Value::Object(m)
        }
        RV::Attribute { data, .. } => to_json(*data),
        RV::Double(d) => json!(d),
        RV::Boolean(b) => json!(b),
        RV::VerbatimString { text, .. } => Value::String(text),
        RV::BigNumber(n) => Value::String(n.to_string()),
        RV::Push { data, .. } => Value::Array(data.into_iter().map(to_json).collect()),
        RV::ServerError(e) => json!({ "error": e.to_string() }),
        other => Value::String(format!("{other:?}")),
    }
}

fn s(v: &RV) -> String {
    match v {
        RV::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        RV::SimpleString(s) => s.clone(),
        RV::Int(i) => i.to_string(),
        RV::Double(d) => d.to_string(),
        RV::Okay => "OK".into(),
        RV::Nil => String::new(),
        other => to_json(other.clone()).to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub key_type: Option<String>,
    #[serde(default = "default_count")]
    pub count: usize,
}

fn default_count() -> usize {
    500
}

/// One SCAN round trip can return few keys on sparse matches, so keep going
/// until `count` keys were collected or ~400ms have passed.
pub async fn scan(sess: &RedisSession, req: ScanRequest) -> AppResult<Value> {
    let mut c = sess.conn.clone();
    let started = Instant::now();
    let mut cursor = if req.cursor.is_empty() {
        "0".to_string()
    } else {
        req.cursor.clone()
    };
    let pattern = req
        .pattern
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "*".into());
    let mut keys: Vec<String> = Vec::new();
    loop {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(&cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(req.count.max(100));
        if let Some(t) = req.key_type.as_ref().filter(|t| !t.is_empty()) {
            cmd.arg("TYPE").arg(t);
        }
        let (next, batch): (String, Vec<String>) = cmd.query_async(&mut c).await?;
        keys.extend(batch);
        cursor = next;
        if cursor == "0" || keys.len() >= req.count || started.elapsed() > Duration::from_millis(400) {
            break;
        }
    }

    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("TYPE").arg(k).cmd("PTTL").arg(k);
    }
    let meta: Vec<RV> = if keys.is_empty() {
        vec![]
    } else {
        pipe.query_async(&mut c).await?
    };
    let items: Vec<Value> = keys
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let t = meta.get(i * 2).map(s).unwrap_or_default();
            let ttl = match meta.get(i * 2 + 1) {
                Some(RV::Int(n)) => *n,
                _ => -1,
            };
            json!({ "key": k, "type": t, "ttlMs": ttl })
        })
        .collect();
    let dbsize: i64 = redis::cmd("DBSIZE").query_async(&mut c).await.unwrap_or(0);
    Ok(json!({ "cursor": cursor, "keys": items, "dbSize": dbsize, "done": cursor == "0" }))
}

const PREVIEW: isize = 1000;

pub async fn get_key(sess: &RedisSession, key: &str) -> AppResult<Value> {
    let mut c = sess.conn.clone();
    let (t, ttl): (String, i64) = redis::pipe()
        .cmd("TYPE")
        .arg(key)
        .cmd("PTTL")
        .arg(key)
        .query_async(&mut c)
        .await?;
    if t == "none" {
        return Err(AppError::msg(format!(
            "Key \"{key}\" does not exist anymore. It may have expired."
        )));
    }
    let memory: Option<i64> = redis::cmd("MEMORY")
        .arg("USAGE")
        .arg(key)
        .query_async(&mut c)
        .await
        .ok();
    let encoding: Option<String> = redis::cmd("OBJECT")
        .arg("ENCODING")
        .arg(key)
        .query_async(&mut c)
        .await
        .ok();

    let (length, value): (i64, Value) = match t.as_str() {
        "string" => {
            let len: i64 = redis::cmd("STRLEN").arg(key).query_async(&mut c).await?;
            let v: RV = redis::cmd("GETRANGE")
                .arg(key)
                .arg(0)
                .arg(1_048_575)
                .query_async(&mut c)
                .await?;
            (len, json!(s(&v)))
        }
        "hash" => {
            let len: i64 = redis::cmd("HLEN").arg(key).query_async(&mut c).await?;
            let mut fields = Vec::new();
            let mut cursor = "0".to_string();
            loop {
                let (next, batch): (String, Vec<RV>) = redis::cmd("HSCAN")
                    .arg(key)
                    .arg(&cursor)
                    .arg("COUNT")
                    .arg(500)
                    .query_async(&mut c)
                    .await?;
                for pair in batch.chunks(2) {
                    if pair.len() == 2 {
                        fields.push(json!({ "field": s(&pair[0]), "value": s(&pair[1]) }));
                    }
                }
                cursor = next;
                if cursor == "0" || fields.len() as isize >= PREVIEW {
                    break;
                }
            }
            (len, Value::Array(fields))
        }
        "list" => {
            let len: i64 = redis::cmd("LLEN").arg(key).query_async(&mut c).await?;
            let items: Vec<RV> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(PREVIEW - 1)
                .query_async(&mut c)
                .await?;
            (len, Value::Array(items.iter().map(|v| json!(s(v))).collect()))
        }
        "set" => {
            let len: i64 = redis::cmd("SCARD").arg(key).query_async(&mut c).await?;
            let mut members = Vec::new();
            let mut cursor = "0".to_string();
            loop {
                let (next, batch): (String, Vec<RV>) = redis::cmd("SSCAN")
                    .arg(key)
                    .arg(&cursor)
                    .arg("COUNT")
                    .arg(500)
                    .query_async(&mut c)
                    .await?;
                members.extend(batch.iter().map(|v| json!(s(v))));
                cursor = next;
                if cursor == "0" || members.len() as isize >= PREVIEW {
                    break;
                }
            }
            (len, Value::Array(members))
        }
        "zset" => {
            let len: i64 = redis::cmd("ZCARD").arg(key).query_async(&mut c).await?;
            let items: Vec<RV> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(PREVIEW - 1)
                .arg("WITHSCORES")
                .query_async(&mut c)
                .await?;
            let mut out = Vec::new();
            // RESP2 returns a flat array; RESP3 returns pairs.
            if items.iter().all(|i| matches!(i, RV::Array(_))) {
                for i in &items {
                    if let RV::Array(p) = i {
                        out.push(json!({ "member": s(&p[0]), "score": s(&p[1]) }));
                    }
                }
            } else {
                for pair in items.chunks(2) {
                    if pair.len() == 2 {
                        out.push(json!({ "member": s(&pair[0]), "score": s(&pair[1]) }));
                    }
                }
            }
            (len, Value::Array(out))
        }
        "stream" => {
            let len: i64 = redis::cmd("XLEN").arg(key).query_async(&mut c).await?;
            let entries: Vec<RV> = redis::cmd("XREVRANGE")
                .arg(key)
                .arg("+")
                .arg("-")
                .arg("COUNT")
                .arg(500)
                .query_async(&mut c)
                .await?;
            let mut out = Vec::new();
            for e in entries {
                if let RV::Array(parts) = e
                    && parts.len() == 2
                {
                    let id = s(&parts[0]);
                    let mut fields = Map::new();
                    match &parts[1] {
                        RV::Array(kv) => {
                            for pair in kv.chunks(2) {
                                if pair.len() == 2 {
                                    fields.insert(s(&pair[0]), json!(s(&pair[1])));
                                }
                            }
                        }
                        RV::Map(kv) => {
                            for (k, v) in kv {
                                fields.insert(s(k), json!(s(v)));
                            }
                        }
                        _ => {}
                    }
                    out.push(json!({ "id": id, "fields": fields }));
                }
            }
            (len, Value::Array(out))
        }
        "ReJSON-RL" => {
            let v: RV = redis::cmd("JSON.GET").arg(key).query_async(&mut c).await?;
            (1, json!(s(&v)))
        }
        _ => (0, Value::Null),
    };
    Ok(json!({
        "key": key,
        "type": t,
        "ttlMs": ttl,
        "length": length,
        "memoryBytes": memory,
        "encoding": encoding,
        "value": value,
        "truncated": matches!(t.as_str(), "hash" | "list" | "set" | "zset") && length > PREVIEW as i64
            || (t == "stream" && length > 500)
            || (t == "string" && length > 1_048_576),
    }))
}

/// Runs a command given as argv; used for every mutation the UI performs.
pub async fn command(sess: &RedisSession, args: Vec<String>) -> AppResult<Value> {
    if args.is_empty() {
        return Err(AppError::msg("Type a command, for example: GET mykey"));
    }
    let mut c = sess.conn.clone();
    let mut cmd = redis::cmd(&args[0]);
    for a in &args[1..] {
        cmd.arg(a);
    }
    let started = Instant::now();
    let v: RV = cmd.query_async(&mut c).await?;
    Ok(json!({ "value": to_json(v), "durationMs": started.elapsed().as_secs_f64() * 1000.0 }))
}

/// Console entry point: splits a command line with shell-like quoting.
pub async fn command_line(sess: &RedisSession, line: &str) -> AppResult<Value> {
    let args = shell_words::split(line).map_err(|e| AppError::msg(format!("Could not parse the command: {e}")))?;
    let first = args.first().map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    if matches!(first.as_str(), "SUBSCRIBE" | "PSUBSCRIBE" | "MONITOR" | "SSUBSCRIBE") {
        return Err(AppError::msg(format!(
            "{first} streams forever and is not supported in the console."
        )));
    }
    command(sess, args).await
}

pub async fn info(sess: &RedisSession) -> AppResult<Value> {
    let mut c = sess.conn.clone();
    let raw: String = match redis::cmd("INFO").arg("everything").query_async(&mut c).await {
        Ok(raw) => raw,
        // Older servers do not know "everything".
        Err(_) => redis::cmd("INFO").query_async(&mut c).await?,
    };
    let mut sections = Map::new();
    let mut current = "general".to_string();
    for line in raw.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("# ") {
            current = name.to_lowercase();
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let sec = sections
                .entry(current.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(m) = sec {
                m.insert(k.to_string(), json!(v));
            }
        }
    }
    let databases: i64 = match redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<Vec<String>>(&mut c)
        .await
    {
        Ok(v) if v.len() == 2 => v[1].parse().unwrap_or(16),
        _ => 16,
    };
    Ok(json!({ "sections": sections, "databases": databases }))
}
