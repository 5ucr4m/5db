//! Local persistence (SQLite): saved connections, query history, saved queries
//! and small UI settings. Lives in the app data directory.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::secrets::{Backend, Vault};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    /// "postgres" | "redis"
    pub kind: String,
    pub color: String,
    /// "local" | "dev" | "staging" | "prod"
    pub env: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    /// Postgres: "disable" | "prefer" | "require" | "verify-ca" | "verify-full"
    pub ssl_mode: String,
    /// PEM bundle used to verify the server certificate, for Postgres
    /// verify-ca/verify-full and for Redis TLS. Empty uses the system store,
    /// which is what managed providers with a public CA need.
    pub ssl_root_cert: String,
    /// Redis: logical database index.
    pub redis_db: i64,
    /// Redis: connect with TLS (rediss://).
    pub tls: bool,
    /// Redis: accept any server certificate. Off by default; turning it on
    /// makes the connection vulnerable to interception.
    pub tls_insecure: bool,
    pub read_only: bool,
    /// Cancel any statement that runs longer than this, in milliseconds.
    /// 0 leaves the server default (no limit) in place.
    pub statement_timeout_ms: i64,
    /// Tunnel the connection through an SSH server.
    pub ssh_enabled: bool,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub ssh_password: String,
    /// Private key file; when set it is used instead of the password.
    pub ssh_key_path: String,
    pub ssh_passphrase: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub database: String,
    pub kind: String,
    pub sql: String,
    pub executed_at: String,
    pub duration_ms: f64,
    pub rows: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistory {
    pub connection_id: String,
    pub database: String,
    pub kind: String,
    pub sql: String,
    pub duration_ms: f64,
    pub rows: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

pub struct Store {
    db: Mutex<Connection>,
    vault: Vault,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Store {
    pub fn open(dir: &Path) -> AppResult<Self> {
        Store::open_with(dir, Vault::open())
    }

    pub fn open_with(dir: &Path, vault: Vault) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("5db.sqlite3");
        let db = Connection::open(&path)?;
        // Passwords live in this file; keep it private to the user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS connections (
               id TEXT PRIMARY KEY,
               position INTEGER NOT NULL DEFAULT 0,
               data TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS history (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               connection_id TEXT NOT NULL,
               database TEXT NOT NULL DEFAULT '',
               kind TEXT NOT NULL,
               sql TEXT NOT NULL,
               executed_at TEXT NOT NULL,
               duration_ms REAL NOT NULL DEFAULT 0,
               rows INTEGER,
               error TEXT
             );
             CREATE INDEX IF NOT EXISTS history_conn_idx ON history(connection_id, executed_at DESC);
             CREATE TABLE IF NOT EXISTS saved_queries (
               id TEXT PRIMARY KEY,
               connection_id TEXT,
               name TEXT NOT NULL,
               sql TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;
        let store = Store {
            db: Mutex::new(db),
            vault,
        };
        store.migrate_secrets()?;
        Ok(store)
    }

    /// Which store the connection secrets are in.
    pub fn secrets_backend(&self) -> Backend {
        self.vault.backend()
    }

    /// Moves any secret still sitting in the SQLite file into the keychain.
    /// Runs once per upgrade; afterwards there is nothing left to move.
    fn migrate_secrets(&self) -> AppResult<()> {
        if self.vault.backend() != Backend::Keychain {
            return Ok(());
        }
        let stale: Vec<ConnectionConfig> = self
            .read_rows()?
            .into_iter()
            .filter(|c| self.vault.needs_migration(c))
            .collect();
        if stale.is_empty() {
            return Ok(());
        }
        for c in &stale {
            self.write_row(c)?;
        }
        eprintln!(
            "5db: moved the secrets of {} connection(s) into the keychain.",
            stale.len()
        );
        Ok(())
    }

    /// The rows exactly as stored, secrets not filled in.
    fn read_rows(&self) -> AppResult<Vec<ConnectionConfig>> {
        let db = self.conn();
        let mut stmt = db.prepare("SELECT data FROM connections ORDER BY position, rowid")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(c) = serde_json::from_str::<ConnectionConfig>(&row?) {
                out.push(c);
            }
        }
        Ok(out)
    }

    /// The single place a connection is written, so no path can leak a secret
    /// into the file by going around the vault.
    fn write_row(&self, c: &ConnectionConfig) -> AppResult<()> {
        let row = self.vault.store(c);
        let db = self.conn();
        let position: i64 = db.query_row(
            "SELECT COALESCE((SELECT position FROM connections WHERE id = ?1), (SELECT COALESCE(MAX(position), 0) + 1 FROM connections))",
            [&c.id],
            |r| r.get(0),
        )?;
        db.execute(
            "INSERT INTO connections (id, position, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![c.id, position, serde_json::to_string(&row)?],
        )?;
        Ok(())
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---- connections -----------------------------------------------------

    pub fn list_connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        let mut out = self.read_rows()?;
        for c in &mut out {
            self.vault.load(c);
        }
        Ok(out)
    }

    pub fn get_connection(&self, id: &str) -> AppResult<ConnectionConfig> {
        let db = self.conn();
        let data: Option<String> = db
            .query_row("SELECT data FROM connections WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        let data = data.ok_or_else(|| AppError::msg("This connection no longer exists. It may have been deleted."))?;
        drop(db);
        let mut c: ConnectionConfig = serde_json::from_str(&data)?;
        self.vault.load(&mut c);
        Ok(c)
    }

    pub fn save_connection(&self, mut c: ConnectionConfig) -> AppResult<ConnectionConfig> {
        let ts = now();
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        if c.created_at.is_none() {
            c.created_at = Some(ts.clone());
        }
        c.updated_at = Some(ts);
        self.write_row(&c)?;
        Ok(c)
    }

    pub fn touch_connection(&self, id: &str) -> AppResult<()> {
        if let Ok(mut c) = self.get_connection(id) {
            c.last_used_at = Some(now());
            self.write_row(&c)?;
        }
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        self.vault.forget(id);
        let db = self.conn();
        db.execute("DELETE FROM connections WHERE id = ?1", [id])?;
        db.execute("DELETE FROM history WHERE connection_id = ?1", [id])?;
        db.execute("DELETE FROM saved_queries WHERE connection_id = ?1", [id])?;
        Ok(())
    }

    pub fn reorder_connections(&self, ids: &[String]) -> AppResult<()> {
        let db = self.conn();
        for (i, id) in ids.iter().enumerate() {
            db.execute(
                "UPDATE connections SET position = ?2 WHERE id = ?1",
                params![id, i as i64],
            )?;
        }
        Ok(())
    }

    // ---- history ---------------------------------------------------------

    pub fn add_history(&self, h: NewHistory) -> AppResult<HistoryEntry> {
        let ts = now();
        let db = self.conn();
        db.execute(
            "INSERT INTO history (connection_id, database, kind, sql, executed_at, duration_ms, rows, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                h.connection_id,
                h.database,
                h.kind,
                h.sql,
                ts,
                h.duration_ms,
                h.rows,
                h.error
            ],
        )?;
        let id = db.last_insert_rowid();
        // Keep the log bounded per connection.
        db.execute(
            "DELETE FROM history WHERE connection_id = ?1 AND id NOT IN
               (SELECT id FROM history WHERE connection_id = ?1 ORDER BY id DESC LIMIT 5000)",
            [&h.connection_id],
        )?;
        Ok(HistoryEntry {
            id,
            connection_id: h.connection_id,
            database: h.database,
            kind: h.kind,
            sql: h.sql,
            executed_at: ts,
            duration_ms: h.duration_ms,
            rows: h.rows,
            error: h.error,
        })
    }

    pub fn list_history(
        &self,
        connection_id: Option<&str>,
        search: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<HistoryEntry>> {
        let db = self.conn();
        let pattern = search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
        let mut stmt = db.prepare(
            "SELECT id, connection_id, database, kind, sql, executed_at, duration_ms, rows, error FROM history
             WHERE (?1 IS NULL OR connection_id = ?1) AND (?2 IS NULL OR sql LIKE ?2)
             ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![connection_id, pattern, limit], |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                database: r.get(2)?,
                kind: r.get(3)?,
                sql: r.get(4)?,
                executed_at: r.get(5)?,
                duration_ms: r.get(6)?,
                rows: r.get(7)?,
                error: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn delete_history(&self, id: i64) -> AppResult<()> {
        self.conn().execute("DELETE FROM history WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn clear_history(&self, connection_id: Option<&str>) -> AppResult<()> {
        self.conn().execute(
            "DELETE FROM history WHERE (?1 IS NULL OR connection_id = ?1)",
            params![connection_id],
        )?;
        Ok(())
    }

    // ---- saved queries ---------------------------------------------------

    pub fn list_saved(&self, connection_id: Option<&str>) -> AppResult<Vec<SavedQuery>> {
        let db = self.conn();
        let mut stmt = db.prepare(
            "SELECT id, connection_id, name, sql, created_at, updated_at FROM saved_queries
             WHERE (?1 IS NULL OR connection_id IS NULL OR connection_id = ?1) ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![connection_id], |r| {
            Ok(SavedQuery {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                name: r.get(2)?,
                sql: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_query(&self, mut q: SavedQuery) -> AppResult<SavedQuery> {
        let ts = now();
        if q.id.is_empty() {
            q.id = uuid::Uuid::new_v4().to_string();
            q.created_at = Some(ts.clone());
        }
        q.updated_at = Some(ts.clone());
        self.conn().execute(
            "INSERT INTO saved_queries (id, connection_id, name, sql, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, sql = excluded.sql,
               connection_id = excluded.connection_id, updated_at = excluded.updated_at",
            params![
                q.id,
                q.connection_id,
                q.name,
                q.sql,
                q.created_at.clone().unwrap_or(ts.clone()),
                ts
            ],
        )?;
        Ok(q)
    }

    pub fn delete_saved(&self, id: &str) -> AppResult<()> {
        self.conn().execute("DELETE FROM saved_queries WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- settings --------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> AppResult<Option<serde_json::Value>> {
        let v: Option<String> = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }
}
