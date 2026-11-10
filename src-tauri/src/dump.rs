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
use tokio::process::{Child, Command};

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

/// Looks for one binary and returns the newest it finds, rather than the first.
/// Machines commonly carry several: Debian puts a version-dispatching wrapper
/// on PATH that answers for the oldest installed cluster while the newer
/// binaries sit in /usr/lib/postgresql/N/bin, and taking the first hit there
/// would refuse a job the machine is perfectly able to do.
pub fn find_tool(name: &str) -> Option<Tool> {
    let file = exe(name);
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra_dirs());

    let mut best: Option<Tool> = None;
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let candidate = dir.join(&file);
        // The same binary reached through two directories is one candidate.
        let key = candidate.canonicalize().unwrap_or_else(|_| candidate.clone());
        if !candidate.is_file() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if let Some(t) = probe(&candidate, name)
            && best.as_ref().is_none_or(|b| t.major > b.major)
        {
            best = Some(t);
        }
    }
    best
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

/// The archive format.
///
/// Custom is a single compressed file and the sensible default. Directory is
/// the only one pg_dump can write with several workers at once, which is what
/// a large database needs. Plain is readable SQL that any psql can apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Custom,
    Directory,
    Plain,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Custom => "dump",
            // A directory, not a file; the suffix only keeps it recognisable.
            Format::Directory => "dumpdir",
            Format::Plain => "sql",
        }
    }

    /// Whether `pg_dump` can split the work across workers in this format.
    pub fn parallel(self) -> bool {
        self == Format::Directory
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
    /// How many tables to dump at once. Only the directory format can do this;
    /// anything above one opens that many connections plus one.
    #[serde(default)]
    pub jobs: u32,
}

impl DumpOptions {
    /// `pg_dump` refuses `--jobs` outside the directory format, and its own
    /// message does not say what to do about it.
    pub fn check(&self) -> AppResult<()> {
        if self.jobs > 1 && !self.format.parallel() {
            return Err(AppError::msg(
                "A parallel backup has to be written as a directory. Pick the directory format, or set the workers back to one.",
            ));
        }
        Ok(())
    }
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
        Format::Directory => "--format=directory".into(),
        Format::Plain => "--format=plain".into(),
    });
    if o.format.parallel() && o.jobs > 1 {
        a.push("--jobs".into());
        a.push(o.jobs.to_string());
    }
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
    /// Empty every schema the backup brings before restoring it. Destructive,
    /// so the frontend asks before setting it.
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

/// `clean` is deliberately absent from here. pg_restore's own `--clean` drops
/// only what the archive lists, one object at a time and without CASCADE, so
/// anything on the target the backup does not know about — a foreign key added
/// by a later migration is enough — stops the whole restore. The schemas are
/// emptied beforehand instead; see `Listing` and `script_args`.
pub fn restore_args(database: &str, source: &Path, o: &RestoreOptions, plain: bool) -> Vec<String> {
    if plain {
        // A plain dump is SQL, so psql applies it.
        let mut a = vec![
            "--dbname".into(),
            database.to_string(),
            "--no-password".into(),
            "--no-psqlrc".into(),
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

/// pg_restore writing the archive out as SQL instead of applying it, for psql
/// to run behind statements of ours (`apply_args`). It is the only way to put
/// anything inside the restore's own transaction: pg_restore has no hook for
/// it. `--single-transaction` matters even though nothing is connected — it
/// makes the script end in COMMIT, and only a script that was written to the
/// end has one, so an archive that breaks off halfway rolls everything back.
pub fn script_args(source: &Path, o: &RestoreOptions) -> Vec<String> {
    let mut a = vec![
        "--file".into(),
        "-".into(),
        "--single-transaction".into(),
        "--verbose".into(),
        "--exit-on-error".into(),
    ];
    if o.no_owner {
        a.push("--no-owner".into());
        a.push("--no-privileges".into());
    }
    a.push(source.display().to_string());
    a
}

/// psql running `first`, then whatever arrives on stdin, in one session. `first`
/// opens the transaction the script then finds itself in; its own BEGIN earns a
/// warning and nothing else.
pub fn apply_args(database: &str, first: &str) -> Vec<String> {
    vec![
        "--dbname".into(),
        database.to_string(),
        "--no-password".into(),
        "--no-psqlrc".into(),
        "--quiet".into(),
        "--set".into(),
        "ON_ERROR_STOP=1".into(),
        "--command".into(),
        first.to_string(),
        "--file".into(),
        "-".into(),
    ]
}

// ---------------------------------------------------------------------------
// What an archive holds
// ---------------------------------------------------------------------------

/// What `pg_restore --list` says about an archive, as far as replacing a
/// target needs to know.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Listing {
    /// Every schema the archive puts something into.
    pub schemas: Vec<String>,
    /// Whether it defines anything, or only carries rows for tables that are
    /// expected to exist already.
    pub has_structure: bool,
}

/// Every word pg_dump uses in an entry's kind. A listing line is
/// `id; oid oid KIND SCHEMA NAME OWNER` with nothing to tell a two-word kind
/// from a kind and a schema, so the kind is taken to be the leading run of
/// these. Without the list a schema called `PROD` would read as part of it.
const KIND_WORDS: &[&str] = &[
    "ACCESS",
    "ACL",
    "AGGREGATE",
    "ATTACH",
    "BLOB",
    "BLOBS",
    "BY",
    "CAST",
    "CHECK",
    "CLASS",
    "COLLATION",
    "COMMENT",
    "CONFIGURATION",
    "CONSTRAINT",
    "CONVERSION",
    "DATA",
    "DATABASE",
    "DEFAULT",
    "DICTIONARY",
    "DOMAIN",
    "ENCODING",
    "EVENT",
    "EXTENSION",
    "FAMILY",
    "FK",
    "FOREIGN",
    "FUNCTION",
    "IN",
    "INDEX",
    "LABEL",
    "LANGUAGE",
    "LARGE",
    "MAPPING",
    "MATERIALIZED",
    "METADATA",
    "METHOD",
    "OBJECT",
    "OBJECTS",
    "OPERATOR",
    "OWNED",
    "PARSER",
    "POLICY",
    "PROCEDURAL",
    "PROCEDURE",
    "PROPERTIES",
    "PUBLICATION",
    "ROW",
    "RULE",
    "SCHEMA",
    "SEARCH",
    "SEARCHPATH",
    "SECURITY",
    "SEQUENCE",
    "SERVER",
    "SET",
    "SHELL",
    "STATISTICS",
    "STDSTRINGS",
    "SUBSCRIPTION",
    "TABLE",
    "TABLES",
    "TEMPLATE",
    "TEXT",
    "TRANSFORM",
    "TRIGGER",
    "TYPE",
    "USER",
    "VIEW",
    "WRAPPER",
];

/// Kinds that create something, as opposed to filling it.
const STRUCTURE: &[&str] = &[
    "SCHEMA",
    "TABLE",
    "VIEW",
    "MATERIALIZED VIEW",
    "SEQUENCE",
    "TYPE",
    "FUNCTION",
    "EXTENSION",
];

pub fn read_listing(text: &str) -> Listing {
    let mut out = Listing::default();
    for line in text.lines() {
        // Comments start with a semicolon; an entry starts with its id.
        let Some((id, rest)) = line.split_once("; ") else {
            continue;
        };
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let mut words = rest.split(' ').skip(2).peekable();
        let mut kind: Vec<&str> = Vec::new();
        while let Some(w) = words.next_if(|w| KIND_WORDS.contains(w)) {
            kind.push(w);
        }
        let kind = kind.join(" ");
        if STRUCTURE.contains(&kind.as_str()) {
            out.has_structure = true;
        }
        let schema = match (kind.as_str(), words.next()) {
            // A schema's own entry names it where an object's name goes.
            ("SCHEMA", Some("-")) => words.next(),
            (_, Some("-")) | (_, None) => None,
            (_, s) => s,
        };
        if let Some(s) = schema
            && !s.is_empty()
            && !out.schemas.iter().any(|known| known == s)
        {
            out.schemas.push(s.to_string());
        }
    }
    out
}

/// Reads an archive's table of contents. Only an archive has one: a plain SQL
/// dump is a script, and nothing short of parsing it says what it touches.
pub async fn list_archive(tool: &Tool, source: &Path) -> AppResult<Listing> {
    let out = Command::new(&tool.path)
        .arg("--list")
        .arg(source)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| AppError::msg(format!("Could not run {}: {e}", tool.path)))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::msg(format!(
            "pg_restore could not read {}: {}",
            source.display(),
            said.trim()
        )));
    }
    Ok(read_listing(&String::from_utf8_lossy(&out.stdout)))
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

/// One process of a job. A job is usually one; a replacing restore is two, with
/// each one's stdout becoming the next one's stdin.
pub struct Stage {
    pub tool: Tool,
    pub args: Vec<String>,
}

impl Stage {
    pub fn new(tool: &Tool, args: Vec<String>) -> Self {
        Self {
            tool: tool.clone(),
            args,
        }
    }
}

/// The part of a log worth quoting when a job fails: from the first error on,
/// since everything here stops at the first one and what follows it is the
/// detail, the hint and the statement. The last lines alone would often be
/// another process complaining that its pipe closed.
fn last_words(log: &[String]) -> String {
    let from = log
        .iter()
        .position(|l| l.contains("ERROR:") || l.contains("FATAL:") || l.contains("error:"))
        .unwrap_or(log.len().saturating_sub(4));
    log[from..].iter().take(6).cloned().collect::<Vec<_>>().join("\n")
}

/// Waits for every stage and says what went wrong, if anything did. When more
/// than one failed the last is the one reported: a stage that dies takes the
/// ones feeding it down with a broken pipe, never the other way round.
async fn wait_all(kind: &str, children: &mut [Child]) -> (JobState, Option<String>) {
    let mut failure = None;
    for child in children.iter_mut() {
        match child.wait().await {
            Ok(s) if s.success() => {}
            Ok(s) => {
                let code = s.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
                failure = Some(format!("{kind} exited with status {code}"));
            }
            Err(e) => failure = Some(e.to_string()),
        }
    }
    match failure {
        None => (JobState::Done, None),
        some => (JobState::Failed, some),
    }
}

/// Spawns the stages and streams their stderr into the job record. Returns the
/// job id straight away; the frontend polls for the rest.
pub async fn spawn(
    jobs: Arc<Jobs>,
    kind: &'static str,
    stages: Vec<Stage>,
    env: Vec<(String, String)>,
    file: Option<String>,
    watch_file: bool,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();

    let mut children: Vec<Child> = Vec::new();
    let mut feed: Option<Stdio> = None;
    let last = stages.len().saturating_sub(1);
    for (i, stage) in stages.iter().enumerate() {
        let could_not = |e: std::io::Error| AppError::msg(format!("Could not run {}: {e}", stage.tool.path));
        // Scoped to the iteration on purpose: a Command keeps the pipe end it
        // was given, and while this process holds one the stage upstream never
        // learns that its reader has gone.
        let mut cmd = Command::new(&stage.tool.path);
        cmd.args(&stage.args)
            .envs(env.iter().cloned())
            .stdin(feed.take().unwrap_or_else(Stdio::null))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(could_not)?;
        if i < last {
            let out = child
                .stdout
                .take()
                .ok_or_else(|| AppError::msg("A stage has no output to pass on."))?;
            feed = Some(out.try_into().map_err(could_not)?);
        }
        children.push(child);
    }

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

    let job_id = id.clone();
    let watched = file.clone();

    // Every stage's stderr, because that is where all of these tools talk.
    let mut readers = Vec::new();
    for child in children.iter_mut() {
        if let Some(err) = child.stderr.take() {
            let jobs2 = jobs.clone();
            let id2 = job_id.clone();
            readers.push(tokio::spawn(async move {
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
            }));
        }
    }
    // The last stdout is drained and dropped: nothing reads it, and a tool
    // blocked on a full pipe would never finish.
    if let Some(out) = children.last_mut().and_then(|c| c.stdout.take()) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while (lines.next_line().await).unwrap_or(None).is_some() {}
        });
    }

    tokio::spawn(async move {
        // While it runs, report how large the output has grown.
        let ticker = if watch_file {
            watched.clone().map(|path| {
                let jobs3 = jobs.clone();
                let id3 = job_id.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        let size = output_size(Path::new(&path));
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
            outcome = wait_all(kind, &mut children) => outcome,
            _ = &mut cancel_rx => (JobState::Cancelled, None),
        };
        if outcome.0 == JobState::Cancelled {
            for child in children.iter_mut() {
                let _ = child.kill().await;
            }
        }

        // A process can be gone before its last lines have been read, and
        // those are the ones that say why.
        for reader in readers {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader).await;
        }

        // Walked, not stat-ed: a directory's own metadata reports the size of
        // the inode, not of what is inside it.
        let size = watched.as_ref().map(|p| output_size(Path::new(p)));
        jobs.with(|m| {
            if let Some(j) = m.get_mut(&job_id) {
                j.state = outcome.0;
                j.finished_ms = Some(j.started.elapsed().as_secs_f64() * 1000.0);
                if let Some(b) = size {
                    j.bytes = b;
                }
                if let Some(e) = outcome.1 {
                    // The tool's own words say far more than an exit code.
                    let said = last_words(&j.log);
                    j.error = Some(if said.is_empty() { e } else { format!("{e}\n{said}") });
                }
            }
        });
        if let Some(t) = ticker {
            t.abort();
        }
    });

    Ok(id)
}

/// How large the output is so far, whether it is one file or a directory of
/// them, so the panel can report progress for either format.
pub fn output_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => output_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
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
            jobs: 0,
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
    fn workers_are_only_requested_in_the_format_that_supports_them() {
        let mut o = opts(Content::All, Format::Directory);
        o.jobs = 4;
        let a = dump_args("shop", Path::new("/tmp/out"), &o);
        assert!(a.contains(&"--format=directory".to_string()));
        assert!(a.contains(&"--jobs".to_string()) && a.contains(&"4".to_string()));
        assert!(o.check().is_ok());

        // pg_dump rejects --jobs outside the directory format, so the options
        // are refused before a command is built at all.
        let mut o = opts(Content::All, Format::Custom);
        o.jobs = 4;
        let err = o.check().expect_err("parallel custom must be refused");
        assert!(err.message.contains("directory"), "{}", err.message);
        assert!(!dump_args("shop", Path::new("/tmp/out"), &o).contains(&"--jobs".to_string()));
    }

    #[test]
    fn one_worker_is_the_same_as_no_worker_flag() {
        let mut o = opts(Content::All, Format::Directory);
        o.jobs = 1;
        assert!(!dump_args("shop", Path::new("/tmp/out"), &o).contains(&"--jobs".to_string()));
        assert!(o.check().is_ok());
    }

    #[test]
    fn a_directory_dump_is_measured_by_walking_it() {
        let root = std::env::temp_dir().join(format!(
            "5db-size-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.dat"), vec![0u8; 1000]).unwrap();
        std::fs::write(root.join("nested/b.dat"), vec![0u8; 2345]).unwrap();
        assert_eq!(output_size(&root), 3345, "every file under the directory counts");

        let file = root.join("a.dat");
        assert_eq!(output_size(&file), 1000, "a single-file dump still works");
        assert_eq!(
            output_size(&root.join("missing")),
            0,
            "nothing yet written is zero, not an error"
        );
        let _ = std::fs::remove_dir_all(&root);
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
    fn replacing_never_reaches_for_pg_restores_own_clean() {
        // --clean drops the archive's objects one at a time without CASCADE,
        // so one foreign key the backup has never heard of fails the restore.
        let o = RestoreOptions {
            clean: true,
            no_owner: true,
            single_transaction: true,
            jobs: 0,
        };
        for args in [
            restore_args("shop", Path::new("/x"), &o, false),
            script_args(Path::new("/x"), &o),
        ] {
            assert!(!args.contains(&"--clean".to_string()), "{args:?}");
        }
    }

    #[test]
    fn the_script_ends_in_a_commit_only_pg_restore_can_write() {
        let o = RestoreOptions {
            clean: true,
            no_owner: false,
            single_transaction: true,
            jobs: 0,
        };
        let a = script_args(Path::new("/tmp/x.dump"), &o);
        assert_eq!(&a[..2], ["--file", "-"], "the script goes to stdout, for psql");
        assert!(
            a.contains(&"--single-transaction".to_string()),
            "without it the script has no COMMIT, and a truncated one would be applied as far as it got"
        );
        assert!(
            !a.contains(&"--dbname".to_string()),
            "it must not connect and apply the archive itself"
        );
        assert!(!a.contains(&"--no-owner".to_string()));

        let a = apply_args("shop", "BEGIN; DROP SCHEMA \"public\" CASCADE");
        let first = a.iter().position(|x| x == "--command").unwrap();
        let stdin = a.iter().position(|x| x == "--file").unwrap();
        assert!(
            first < stdin,
            "the emptying has to run before the script, in the same session"
        );
        assert_eq!(a[stdin + 1], "-");
        assert!(a.contains(&"ON_ERROR_STOP=1".to_string()));
        assert!(a.contains(&"--no-psqlrc".to_string()));
    }

    const LISTING: &str = "\
;
; Archive created at 2026-11-10 19:25:01 -03
;     dbname: shop
;
; Selected TOC Entries:
;
7; 2615 16517 SCHEMA - analytics fivedb
2; 3079 16385 EXTENSION - pgcrypto 
3630; 0 0 COMMENT - EXTENSION pgcrypto 
949; 1247 16423 TYPE public order_status fivedb
283; 1259 16518 TABLE analytics daily_visits fivedb
3631; 0 0 COMMENT public TABLE customers fivedb
3632; 0 0 SEQUENCE OWNED BY public customers_id_seq fivedb
282; 1259 16506 MATERIALIZED VIEW public sales_by_status fivedb
3623; 0 16518 TABLE DATA analytics daily_visits fivedb
3635; 0 0 SEQUENCE SET public customers_id_seq fivedb
3466; 2606 16486 FK CONSTRAINT public order_items order_items_order_id_fkey fivedb
3625; 0 16506 MATERIALIZED VIEW DATA public sales_by_status fivedb
";

    #[test]
    fn a_listing_names_the_schemas_an_archive_fills() {
        let l = read_listing(LISTING);
        assert_eq!(l.schemas, ["analytics", "public"]);
        assert!(l.has_structure);
    }

    #[test]
    fn a_schema_is_not_mistaken_for_part_of_the_kind() {
        // Kinds are upper-case words and so is this schema. Nor is the table
        // called `public` a schema, or the object a comment is about.
        let l = read_listing(
            "5; 1259 1 TABLE PROD public fivedb\n6; 0 1 TABLE DATA PROD public fivedb\n7; 0 0 COMMENT - SCHEMA other fivedb\n",
        );
        assert_eq!(l.schemas, ["PROD"]);
    }

    #[test]
    fn a_data_only_archive_is_recognised_as_having_no_structure() {
        let l = read_listing(
            "3600; 0 0 ENCODING - ENCODING \n3601; 0 0 STDSTRINGS - STDSTRINGS \n3602; 0 0 SEARCHPATH - SEARCHPATH \n\
             3615; 0 16434 TABLE DATA public customers fivedb\n3635; 0 0 SEQUENCE SET public customers_id_seq fivedb\n",
        );
        assert!(
            !l.has_structure,
            "emptying the target for this one would leave the rows nowhere to go"
        );
        assert_eq!(l.schemas, ["public"]);
    }

    #[test]
    fn a_failure_is_quoted_from_its_first_error() {
        let log: Vec<String> = [
            "pg_restore: creating TABLE \"public.orders\"",
            "psql:<stdin>:40: ERROR:  relation \"orders\" already exists",
            "DETAIL:  something",
            "pg_restore: creating TABLE \"public.products\"",
            "pg_restore: error: could not write to output file: Broken pipe",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let said = last_words(&log);
        assert!(said.starts_with("psql:<stdin>:40: ERROR:"), "{said}");

        // Nothing marked as an error: fall back to the end of the log.
        let quiet: Vec<String> = (0..10).map(|i| format!("line {i}")).collect();
        assert_eq!(last_words(&quiet), "line 6\nline 7\nline 8\nline 9");
    }

    /// Writes a script that answers `--version` like the real thing.
    #[cfg(unix)]
    fn fake_tool(dir: &Path, name: &str, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho '{name} (PostgreSQL) {version}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn the_newest_tool_wins_even_when_an_older_one_comes_first_on_path() {
        let root = std::env::temp_dir().join(format!(
            "5db-tools-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        // Debian's shape: a wrapper answering for the older version ahead of the
        // newer binaries. The numbers are far beyond any real release so that a
        // PostgreSQL actually installed on this machine cannot win instead.
        fake_tool(&root.join("usr-bin"), "pg_dump", "90.1");
        fake_tool(&root.join("pg-new"), "pg_dump", "91.2");

        let old_path = std::env::var("PATH").unwrap_or_default();
        let probe_path = format!("{}:{}", root.join("usr-bin").display(), root.join("pg-new").display());
        unsafe { std::env::set_var("PATH", &probe_path) };
        let found = find_tool("pg_dump");
        unsafe { std::env::set_var("PATH", old_path) };
        let _ = std::fs::remove_dir_all(&root);

        let found = found.expect("the fake tools should have been found");
        assert_eq!(
            found.major, 91,
            "the first hit on PATH was older; the newest has to win"
        );
        assert_eq!(found.version, "91.2");
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
