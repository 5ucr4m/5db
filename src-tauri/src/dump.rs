//! Backing a database up and restoring it somewhere else.
//!
//! The work is done by the PostgreSQL command line tools, which is the only way
//! to be sure a migration carries everything: extensions, sequence positions,
//! composite types, partitions, privileges. They are not bundled, so they are
//! discovered on the machine and their version is checked against the server
//! before anything runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::store::ConnectionConfig;

// ---------------------------------------------------------------------------
// Finding the tools
// ---------------------------------------------------------------------------

/// One of the PostgreSQL binaries, where it is and what version it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub path: String,
    /// As printed by `--version`, e.g. "18.6".
    pub version: String,
    pub major: u32,
}

/// Directories worth looking in beyond PATH. Covers the ways people actually
/// get these binaries: Homebrew's libpq keg (which is not linked into PATH),
/// a versioned Homebrew postgresql, Postgres.app, and the EDB installer.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let globs: &[&str] = if cfg!(target_os = "windows") {
        &[r"C:\Program Files\PostgreSQL\*\bin"]
    } else if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/homebrew/opt/postgresql@*/bin",
            "/usr/local/opt/postgresql@*/bin",
            "/Applications/Postgres.app/Contents/Versions/*/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
    } else {
        &["/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin", "/usr/local/pgsql/bin"]
    };
    for pattern in globs {
        match pattern.split_once('*') {
            // A literal directory.
            None => dirs.push(PathBuf::from(pattern)),
            // One wildcard segment: list the parent and keep what matches.
            Some((head, tail)) => {
                let head = Path::new(head);
                let (parent, prefix) = match head.file_name() {
                    Some(p) if !head.to_string_lossy().ends_with('/') => (
                        head.parent().unwrap_or(head).to_path_buf(),
                        p.to_string_lossy().to_string(),
                    ),
                    _ => (head.to_path_buf(), String::new()),
                };
                let Ok(entries) = std::fs::read_dir(&parent) else {
                    continue;
                };
                let mut matches: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&prefix)))
                    .map(|p| PathBuf::from(format!("{}{}", p.display(), tail)))
                    .collect();
                // Newest first, so a machine with several versions offers the
                // one most likely to read a modern server.
                matches.sort();
                matches.reverse();
                dirs.append(&mut matches);
            }
        }
    }
    dirs
}

fn exe(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Runs `--version` and reads the major out of it. `None` when the path is not
/// a working binary, which is the common case for a stale directory.
fn probe(path: &Path, name: &str) -> Option<Tool> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // "pg_dump (PostgreSQL) 18.6" / "psql (PostgreSQL) 17.2 (Homebrew)"
    let version = text
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let major: u32 = version.split(['.', 'b', 'r']).next()?.parse().ok()?;
    Some(Tool {
        name: name.to_string(),
        path: path.display().to_string(),
        version: version.to_string(),
        major,
    })
}

/// Looks for one binary on PATH first, then in the known install locations.
pub fn find_tool(name: &str) -> Option<Tool> {
    let file = exe(name);
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(&file);
            if candidate.is_file()
                && let Some(t) = probe(&candidate, name)
            {
                return Some(t);
            }
        }
    }
    for dir in extra_dirs() {
        let candidate = dir.join(&file);
        if candidate.is_file()
            && let Some(t) = probe(&candidate, name)
        {
            return Some(t);
        }
    }
    None
}

/// What the frontend needs to decide whether the pg_dump engine is usable.
pub fn tools() -> Value {
    let find = |n: &str| {
        find_tool(n).map(|t| json!({ "name": t.name, "path": t.path, "version": t.version, "major": t.major }))
    };
    json!({
        "pgDump": find("pg_dump"),
        "pgRestore": find("pg_restore"),
        "psql": find("psql"),
    })
}

/// `pg_dump` refuses a server newer than itself, and the message it prints is
/// not obvious. Say it plainly, and say where to get a newer one.
pub fn check_version(tool: &Tool, server_major: u32) -> AppResult<()> {
    if tool.major >= server_major {
        return Ok(());
    }
    Err(AppError::msg(format!(
        "{} is version {} and the server is {}. A dump has to be taken with tools at least as new as the server. \
         Install PostgreSQL {} client tools and pick them again.",
        tool.name, tool.version, server_major, server_major
    )))
}

// ---------------------------------------------------------------------------
// What to run
// ---------------------------------------------------------------------------

/// How much of the database the dump carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Content {
    /// Structure and rows.
    All,
    /// `--schema-only`: everything but the rows.
    Structure,
    /// `--data-only`: the rows, for a server whose structure already exists.
    Data,
}

/// The archive format. Custom is the one worth defaulting to: compressed, and
/// `pg_restore` can replay it selectively and in parallel. Plain is readable
/// SQL that any psql can apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Custom,
    Plain,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Custom => "dump",
            Format::Plain => "sql",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpOptions {
    pub content: Content,
    pub format: Format,
    /// Only these schemas; empty means every schema the user can read.
    #[serde(default)]
    pub schemas: Vec<String>,
    /// Leave ownership and grants out, which is what a move to a server with
    /// different roles needs.
    #[serde(default = "yes")]
    pub no_owner: bool,
}

fn yes() -> bool {
    true
}

/// Connection details as environment, never as arguments: a password on the
/// command line is visible to every process on the machine.
fn pg_env(cfg: &ConnectionConfig) -> Vec<(String, String)> {
    let mut env = vec![
        (
            "PGHOST".into(),
            if cfg.host.is_empty() {
                "localhost".into()
            } else {
                cfg.host.clone()
            },
        ),
        (
            "PGPORT".into(),
            (if cfg.port == 0 { 5432 } else { cfg.port }).to_string(),
        ),
        (
            "PGUSER".into(),
            if cfg.user.is_empty() {
                "postgres".into()
            } else {
                cfg.user.clone()
            },
        ),
        // Never prompt: a child process waiting on a terminal would hang forever.
        ("PGCONNECT_TIMEOUT".into(), "15".into()),
    ];
    if !cfg.password.is_empty() {
        env.push(("PGPASSWORD".into(), cfg.password.clone()));
    }
    let mode = match cfg.ssl_mode.as_str() {
        "" => "prefer",
        m => m,
    };
    env.push(("PGSSLMODE".into(), mode.to_string()));
    if !cfg.ssl_root_cert.is_empty() {
        env.push(("PGSSLROOTCERT".into(), cfg.ssl_root_cert.clone()));
    }
    env
}

pub fn dump_args(database: &str, target: &Path, o: &DumpOptions) -> Vec<String> {
    let mut a = vec![
        "--dbname".into(),
        database.to_string(),
        "--file".into(),
        target.display().to_string(),
        "--verbose".into(),
        "--no-password".into(),
    ];
    a.push(match o.format {
        Format::Custom => "--format=custom".into(),
        Format::Plain => "--format=plain".into(),
    });
    match o.content {
        Content::All => {}
        Content::Structure => a.push("--schema-only".into()),
        Content::Data => a.push("--data-only".into()),
    }
    if o.no_owner {
        a.push("--no-owner".into());
        a.push("--no-privileges".into());
    }
    for s in &o.schemas {
        a.push("--schema".into());
        a.push(s.clone());
    }
    a
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    /// Drop each object before recreating it. Destructive, so the frontend
    /// asks before setting it.
    #[serde(default)]
    pub clean: bool,
    #[serde(default = "yes")]
    pub no_owner: bool,
    /// Apply everything in one transaction, so a failure leaves nothing behind.
    #[serde(default = "yes")]
    pub single_transaction: bool,
    /// Only with a custom-format archive, and never with a single transaction.
    #[serde(default)]
    pub jobs: u32,
}

pub fn restore_args(database: &str, source: &Path, o: &RestoreOptions, plain: bool) -> Vec<String> {
    if plain {
        // A plain dump is SQL, so psql applies it.
        let mut a = vec![
            "--dbname".into(),
            database.to_string(),
            "--no-password".into(),
            "--file".into(),
            source.display().to_string(),
            // Without this psql reports the failure and carries on, which on a
            // restore means a half-migrated database that looks like a success.
            "--set".into(),
            "ON_ERROR_STOP=1".into(),
        ];
        if o.single_transaction {
            a.push("--single-transaction".into());
        }
        return a;
    }
    let mut a = vec![
        "--dbname".into(),
        database.to_string(),
        "--no-password".into(),
        "--verbose".into(),
        "--exit-on-error".into(),
    ];
    if o.clean {
        a.push("--clean".into());
        a.push("--if-exists".into());
    }
    if o.no_owner {
        a.push("--no-owner".into());
        a.push("--no-privileges".into());
    }
    // Parallel restore opens several connections, which a single transaction
    // cannot span; the frontend keeps them mutually exclusive too.
    if o.single_transaction {
        a.push("--single-transaction".into());
    } else if o.jobs > 1 {
        a.push("--jobs".into());
        a.push(o.jobs.to_string());
    }
    a.push(source.display().to_string());
    a
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// A dump or restore in flight. The frontend polls it, the same way the
/// notification panel polls its channel, because the RPC surface has no way to
/// push.
pub struct Job {
    pub kind: &'static str,
    pub state: JobState,
    /// What the tool printed, newest last. Capped so a long restore cannot
    /// grow without end.
    pub log: Vec<String>,
    pub error: Option<String>,
    pub started: std::time::Instant,
    pub finished_ms: Option<f64>,
    /// For a dump, how large the file is so far.
    pub bytes: u64,
    pub file: Option<String>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

const LOG_CAPACITY: usize = 500;

impl Job {
    pub fn to_json(&self, id: &str) -> Value {
        json!({
            "id": id,
            "kind": self.kind,
            "state": self.state,
            "log": self.log,
            "error": self.error,
            "elapsedMs": self.finished_ms.unwrap_or_else(|| self.started.elapsed().as_secs_f64() * 1000.0),
            "bytes": self.bytes,
            "file": self.file,
        })
    }
}

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Job>>);

impl Jobs {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, Job>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.with(|m| m.get(id).map(|j| j.to_json(id)))
    }

    pub fn cancel(&self, id: &str) -> AppResult<()> {
        self.with(|m| {
            let job = m
                .get_mut(id)
                .ok_or_else(|| AppError::msg("That job is no longer running."))?;
            if let Some(tx) = job.cancel.take() {
                let _ = tx.send(());
            }
            Ok(())
        })
    }

    /// Drops everything that finished a while ago, so a long session does not
    /// accumulate job records.
    pub fn sweep(&self) {
        self.with(|m| m.retain(|_, j| j.state == JobState::Running || j.started.elapsed().as_secs() < 3600));
    }
}

/// Spawns the tool and streams its stderr into the job record. Returns the job
/// id straight away; the frontend polls for the rest.
#[allow(clippy::too_many_arguments)]
pub async fn spawn(
    jobs: Arc<Jobs>,
    kind: &'static str,
    tool: &Tool,
    args: Vec<String>,
    env: Vec<(String, String)>,
    file: Option<String>,
    watch_file: bool,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();

    let mut cmd = Command::new(&tool.path);
    cmd.args(&args)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not run {}: {e}", tool.path)))?;

    jobs.sweep();
    jobs.with(|m| {
        m.insert(
            id.clone(),
            Job {
                kind,
                state: JobState::Running,
                log: Vec::new(),
                error: None,
                started: std::time::Instant::now(),
                finished_ms: None,
                bytes: 0,
                file: file.clone(),
                cancel: Some(cancel_tx),
            },
        )
    });

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let job_id = id.clone();
    let watched = file.clone();

    tokio::spawn(async move {
        let push = |line: String| {
            jobs.with(|m| {
                if let Some(j) = m.get_mut(&job_id) {
                    if j.log.len() >= LOG_CAPACITY {
                        j.log.remove(0);
                    }
                    j.log.push(line);
                }
            });
        };

        // Both streams, because psql writes its errors to stderr but pg_dump
        // in plain format can write the archive to stdout.
        if let Some(err) = stderr {
            let jobs2 = jobs.clone();
            let id2 = job_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    jobs2.with(|m| {
                        if let Some(j) = m.get_mut(&id2) {
                            if j.log.len() >= LOG_CAPACITY {
                                j.log.remove(0);
                            }
                            j.log.push(line);
                        }
                    });
                }
            });
        }
        if let Some(out) = stdout {
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while (lines.next_line().await).unwrap_or(None).is_some() {}
            });
        }

        // While it runs, report how large the output has grown.
        let ticker = if watch_file {
            watched.clone().map(|path| {
                let jobs3 = jobs.clone();
                let id3 = job_id.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        let still_running = jobs3.with(|m| {
                            if let Some(j) = m.get_mut(&id3) {
                                j.bytes = size;
                                j.state == JobState::Running
                            } else {
                                false
                            }
                        });
                        if !still_running {
                            break;
                        }
                    }
                })
            })
        } else {
            None
        };

        let outcome = tokio::select! {
            status = child.wait() => match status {
                Ok(s) if s.success() => (JobState::Done, None),
                Ok(s) => (JobState::Failed, Some(format!("{kind} exited with status {}", s.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())))),
                Err(e) => (JobState::Failed, Some(e.to_string())),
            },
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                (JobState::Cancelled, None)
            }
        };

        let size = watched
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len());
        jobs.with(|m| {
            if let Some(j) = m.get_mut(&job_id) {
                j.state = outcome.0;
                j.finished_ms = Some(j.started.elapsed().as_secs_f64() * 1000.0);
                if let Some(b) = size {
                    j.bytes = b;
                }
                if let Some(e) = outcome.1 {
                    // The tool's own last words say far more than an exit code.
                    let tail = j.log.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join("\n");
                    j.error = Some(if tail.is_empty() { e } else { format!("{e}\n{tail}") });
                }
            }
        });
        let _ = push;
        if let Some(t) = ticker {
            t.abort();
        }
    });

    Ok(id)
}

/// Everything a dump or restore needs from the connection, resolved.
pub fn env_for(cfg: &ConnectionConfig) -> Vec<(String, String)> {
    pg_env(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(content: Content, format: Format) -> DumpOptions {
        DumpOptions {
            content,
            format,
            schemas: vec![],
            no_owner: true,
        }
    }

    #[test]
    fn dump_arguments_match_the_chosen_content_and_format() {
        let a = dump_args("shop", Path::new("/tmp/x.dump"), &opts(Content::All, Format::Custom));
        assert!(a.contains(&"--format=custom".to_string()));
        assert!(!a.contains(&"--schema-only".to_string()));
        assert!(!a.contains(&"--data-only".to_string()));

        let a = dump_args(
            "shop",
            Path::new("/tmp/x.sql"),
            &opts(Content::Structure, Format::Plain),
        );
        assert!(a.contains(&"--format=plain".to_string()));
        assert!(a.contains(&"--schema-only".to_string()));

        let a = dump_args("shop", Path::new("/tmp/x.dump"), &opts(Content::Data, Format::Custom));
        assert!(a.contains(&"--data-only".to_string()));
    }

    #[test]
    fn a_password_is_never_an_argument() {
        let mut cfg = ConnectionConfig {
            host: "db.example.com".into(),
            port: 5433,
            user: "alice".into(),
            password: "s3cret".into(),
            ssl_mode: "verify-full".into(),
            ..Default::default()
        };
        cfg.ssl_root_cert = "/etc/ssl/ca.pem".into();
        let args = dump_args("shop", Path::new("/tmp/x.dump"), &opts(Content::All, Format::Custom));
        assert!(!args.iter().any(|a| a.contains("s3cret")));

        let env: HashMap<_, _> = pg_env(&cfg).into_iter().collect();
        assert_eq!(env.get("PGPASSWORD").map(String::as_str), Some("s3cret"));
        assert_eq!(env.get("PGHOST").map(String::as_str), Some("db.example.com"));
        assert_eq!(env.get("PGPORT").map(String::as_str), Some("5433"));
        assert_eq!(env.get("PGSSLMODE").map(String::as_str), Some("verify-full"));
        assert_eq!(env.get("PGSSLROOTCERT").map(String::as_str), Some("/etc/ssl/ca.pem"));
    }

    #[test]
    fn an_empty_password_is_left_out_rather_than_set_empty() {
        let cfg = ConnectionConfig {
            host: "localhost".into(),
            ..Default::default()
        };
        let env: HashMap<_, _> = pg_env(&cfg).into_iter().collect();
        assert!(!env.contains_key("PGPASSWORD"));
    }

    #[test]
    fn restore_never_combines_a_single_transaction_with_parallel_jobs() {
        let o = RestoreOptions {
            clean: false,
            no_owner: true,
            single_transaction: true,
            jobs: 4,
        };
        let a = restore_args("shop", Path::new("/tmp/x.dump"), &o, false);
        assert!(a.contains(&"--single-transaction".to_string()));
        assert!(!a.contains(&"--jobs".to_string()));

        let o = RestoreOptions {
            single_transaction: false,
            ..o
        };
        let a = restore_args("shop", Path::new("/tmp/x.dump"), &o, false);
        assert!(a.contains(&"--jobs".to_string()));
    }

    #[test]
    fn a_plain_restore_stops_at_the_first_error() {
        let o = RestoreOptions {
            clean: false,
            no_owner: true,
            single_transaction: true,
            jobs: 0,
        };
        let a = restore_args("shop", Path::new("/tmp/x.sql"), &o, true);
        assert!(
            a.contains(&"ON_ERROR_STOP=1".to_string()),
            "a half-applied restore must not look like a success"
        );
        assert!(a.contains(&"--single-transaction".to_string()));
    }

    #[test]
    fn cleaning_is_only_requested_when_asked_for() {
        let o = RestoreOptions {
            clean: false,
            no_owner: true,
            single_transaction: false,
            jobs: 0,
        };
        assert!(!restore_args("shop", Path::new("/x"), &o, false).contains(&"--clean".to_string()));
        let o = RestoreOptions { clean: true, ..o };
        let a = restore_args("shop", Path::new("/x"), &o, false);
        assert!(a.contains(&"--clean".to_string()) && a.contains(&"--if-exists".to_string()));
    }

    #[test]
    fn the_version_guard_only_blocks_tools_older_than_the_server() {
        let t = |major| Tool {
            name: "pg_dump".into(),
            path: "/x/pg_dump".into(),
            version: format!("{major}.0"),
            major,
        };
        assert!(check_version(&t(18), 17).is_ok(), "newer tools read older servers");
        assert!(check_version(&t(17), 17).is_ok());
        let err = check_version(&t(15), 17).expect_err("older tools must be refused");
        assert!(err.message.contains("15") && err.message.contains("17"));
    }
}
