//! Copying a database onto another server in one go: back it up to a folder of
//! its own, restore that, check that what arrived is what was sent, collect
//! the statistics a restore leaves out, and only then delete the backup.
//!
//! It is one job with a step for each of those, so there is one thing to watch
//! and one thing to cancel.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;

use crate::dump::{self, Content, DumpOptions, Format, JobState, Jobs, RestoreOptions, Stage, StepState, Tool};
use crate::error::{AppError, AppResult};
use crate::pg;
use crate::store::ConnectionConfig;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Empty every schema the source has before restoring it.
    #[serde(default)]
    pub replace: bool,
    /// Restore in one transaction, so a failure leaves the target as it was.
    /// The price is a restore that cannot use the workers.
    #[serde(default = "yes")]
    pub single_transaction: bool,
    #[serde(default = "yes")]
    pub no_owner: bool,
    /// Tables backed up at once, and restored at once when that is possible.
    #[serde(default = "four")]
    pub jobs: u32,
}

fn yes() -> bool {
    true
}

fn four() -> u32 {
    4
}

/// One end of a transfer, with the config already pointed at its tunnel.
pub struct Endpoint {
    pub cfg: ConnectionConfig,
    pub database: String,
    pub major: u32,
}

pub struct Plan {
    pub source: Endpoint,
    pub target: Endpoint,
    pub pg_dump: Tool,
    pub options: Options,
    /// A folder made for this transfer and holding nothing else, which is what
    /// makes it safe to delete whole. See `scratch`.
    pub scratch: PathBuf,
}

impl Plan {
    /// Where the backup goes. Named after the database so that one which is
    /// kept can be told apart from the next.
    pub fn archive(&self) -> PathBuf {
        let name: String = self
            .source
            .database
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.scratch.join(format!("{name}.dumpdir"))
    }
}

/// Makes the folder a transfer keeps its backup in. Closed to everyone else,
/// since for a while it holds a whole database in a directory that may be
/// shared.
pub fn scratch(base: &Path) -> AppResult<PathBuf> {
    let dir = base.join(format!("5db-transfer-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|e| {
        AppError::msg(format!(
            "Could not make a folder for the backup in {}: {e}",
            base.display()
        ))
    })?;
    Ok(dir)
}

/// The backup a transfer takes. A folder, because that is the one format
/// several workers can write and read, and `--snapshot` so that it sees the
/// source exactly as the transaction the rows are counted in does.
pub fn dump_args(database: &str, archive: &Path, o: &Options, snapshot: &str) -> Vec<String> {
    let mut args = dump::dump_args(
        database,
        archive,
        &DumpOptions {
            content: Content::All,
            format: Format::Directory,
            schemas: Vec::new(),
            no_owner: o.no_owner,
            jobs: o.jobs,
        },
    );
    args.push("--snapshot".into());
    args.push(snapshot.to_string());
    args
}

// ---------------------------------------------------------------------------
// Checking what arrived
// ---------------------------------------------------------------------------

/// A table and how many rows it held when the backup was taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counted {
    pub schema: String,
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mismatch {
    pub schema: String,
    pub table: String,
    pub source: i64,
    /// `None` when the table never arrived.
    pub target: Option<i64>,
}

/// The tables that do not hold on the target what they held on the source.
/// `found` is the target's count for each of `source`, in the same order.
pub fn compare(source: &[Counted], found: &[Option<i64>]) -> Vec<Mismatch> {
    source
        .iter()
        .zip(found)
        .filter(|(s, f)| **f != Some(s.rows))
        .map(|(s, f)| Mismatch {
            schema: s.schema.clone(),
            table: s.table.clone(),
            source: s.rows,
            target: *f,
        })
        .collect()
}

/// 1234567 as "1,234,567".
fn grouped(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i > 0 && v < 10.0 {
        format!("{v:.1} {}", UNITS[i])
    } else {
        format!("{v:.0} {}", UNITS[i])
    }
}

fn tables(n: usize) -> String {
    if n == 1 {
        "1 table".into()
    } else {
        format!("{} tables", grouped(n as i64))
    }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/// In the order they happen, which is the order they are shown in.
pub const STEPS: [&str; 5] = ["dump", "restore", "verify", "analyze", "cleanup"];

/// Why a transfer stopped short.
enum Halt {
    Cancelled,
    Failed(String),
}

fn failed(e: AppError) -> Halt {
    Halt::Failed(e.message)
}

/// How far a transfer got, which is what decides the fate of its backup.
#[derive(Default)]
struct Reached {
    /// The backup is whole.
    dumped: bool,
    /// The target holds what the backup was taken from.
    verified: bool,
}

/// Starts the transfer and returns its job id; the frontend polls for the rest.
pub fn start(jobs: Arc<Jobs>, plan: Plan) -> String {
    let archive = plan.archive();
    let (id, mut cancel) = jobs.open("transfer", Some(archive.display().to_string()), &STEPS);
    let job_id = id.clone();
    tokio::spawn(async move {
        let id = job_id.as_str();
        let mut reached = Reached::default();
        let halt = run(&jobs, id, &plan, &archive, &mut cancel, &mut reached).await.err();
        jobs.settle(
            id,
            match halt {
                Some(Halt::Cancelled) => StepState::Skipped,
                _ => StepState::Failed,
            },
        );

        // The backup outlives the transfer in exactly one case: it is whole,
        // and nothing has shown yet that the target has what is in it.
        let mut leftover = None;
        if reached.verified || !reached.dumped {
            jobs.step(id, "cleanup", StepState::Running, None);
            let size = dump::output_size(&plan.scratch);
            match remove(&plan.scratch).await {
                Ok(()) => {
                    let said = if reached.verified {
                        format!("freed {}", human(size))
                    } else {
                        "the unfinished backup was removed".into()
                    };
                    jobs.step(id, "cleanup", StepState::Done, Some(said));
                    jobs.update(id, |j| j.file = None);
                }
                Err(e) => {
                    let said = format!("Could not delete the backup at {}: {e}", plan.scratch.display());
                    jobs.step(id, "cleanup", StepState::Failed, Some(said.clone()));
                    leftover = Some(said);
                }
            }
        } else {
            jobs.step(
                id,
                "cleanup",
                StepState::Skipped,
                Some("kept, so the restore can be tried again without backing up twice".into()),
            );
        }

        let (state, error) = match (halt, leftover) {
            (Some(Halt::Cancelled), _) => (JobState::Cancelled, None),
            (Some(Halt::Failed(e)), _) => (JobState::Failed, Some(e)),
            (None, Some(e)) => (JobState::Failed, Some(e)),
            (None, None) => (JobState::Done, None),
        };
        jobs.finish(id, state, error);
    });
    id
}

/// Deletes the folder, more than once if need be. A backup that was stopped
/// can have a worker still closing its file, and a folder that is being
/// written to cannot be removed in one pass.
async fn remove(dir: &Path) -> std::io::Result<()> {
    let mut last = Ok(());
    for _ in 0..5 {
        last = match tokio::fs::remove_dir_all(dir).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
        if last.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    last
}

async fn run(
    jobs: &Arc<Jobs>,
    id: &str,
    plan: &Plan,
    archive: &Path,
    cancel: &mut watch::Receiver<bool>,
    reached: &mut Reached,
) -> Result<(), Halt> {
    let source = back_up(jobs, id, plan, archive, cancel).await?;
    reached.dumped = true;
    restore(jobs, id, plan, archive, cancel).await?;
    verify(jobs, id, plan, &source, cancel).await?;
    reached.verified = true;
    analyze(jobs, id, plan, cancel).await
}

/// Backs the source up and, alongside, counts the rows the backup carries.
///
/// The counting happens in the transaction whose snapshot pg_dump is given, so
/// the two describe the same instant. The transaction then stays open for as
/// long as the dump runs: pg_dump's workers adopt the snapshot one by one as
/// they start, and it is only there to adopt while its owner holds it.
async fn back_up(
    jobs: &Arc<Jobs>,
    id: &str,
    plan: &Plan,
    archive: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Vec<Counted>, Halt> {
    jobs.step(id, "dump", StepState::Running, None);
    let source = &plan.source;
    let snapshot = pg::Snapshot::open(&source.cfg, &source.database)
        .await
        .map_err(failed)?;
    let args = dump_args(&source.database, archive, &plan.options, &snapshot.name);
    let children = dump::launch(&[Stage::new(&plan.pg_dump, args)], &dump::env_for(&source.cfg)).map_err(failed)?;
    let ticker = dump::watch_size(jobs.clone(), id.to_string(), archive.to_path_buf());

    // Neither half is any use without the other, so whichever stops short
    // stops the other with it.
    let (stop, stopped) = watch::channel(false);
    let (mut for_dump, mut for_count) = (stopped.clone(), stopped);
    let dumping = async {
        let out = dump::drive(jobs, id, "dump", children, &mut for_dump).await;
        if out.0 != JobState::Done {
            let _ = stop.send(true);
        }
        out
    };
    let counting = async {
        let out = tokio::select! {
            out = count_source(jobs, id, &snapshot) => out.map(Some),
            _ = dump::cancelled(&mut for_count) => {
                snapshot.interrupt().await;
                Ok(None)
            }
        };
        if out.is_err() {
            let _ = stop.send(true);
        }
        out
    };
    let both = async { tokio::join!(dumping, counting) };
    tokio::pin!(both);
    let (dumped, counted) = tokio::select! {
        out = &mut both => out,
        _ = dump::cancelled(cancel) => {
            let _ = stop.send(true);
            both.await
        }
    };
    ticker.abort();
    jobs.update(id, |j| j.bytes = dump::output_size(archive));

    if *cancel.borrow() {
        return Err(Halt::Cancelled);
    }
    // The dump's own failure first: when it is what went wrong, the count was
    // merely interrupted by it.
    if let (JobState::Failed, e) = dumped {
        return Err(Halt::Failed(e.unwrap_or_else(|| "The backup failed.".into())));
    }
    let counted = counted
        .map_err(failed)?
        .ok_or_else(|| Halt::Failed("The backup was stopped before it finished.".into()))?;
    if dumped.0 != JobState::Done {
        return Err(Halt::Failed("The backup was stopped before it finished.".into()));
    }

    let rows: i64 = counted.iter().map(|c| c.rows).sum();
    jobs.step(
        id,
        "dump",
        StepState::Done,
        Some(format!("{}, {} rows", tables(counted.len()), grouped(rows))),
    );
    Ok(counted)
}

async fn count_source(jobs: &Arc<Jobs>, id: &str, snapshot: &pg::Snapshot) -> AppResult<Vec<Counted>> {
    let found = pg::dumped_tables(snapshot.client()).await?;
    let mut out = Vec::with_capacity(found.len());
    for (i, (schema, table)) in found.iter().enumerate() {
        let said = format!("counting what it carries, table {} of {}", i + 1, found.len());
        jobs.step(id, "dump", StepState::Running, Some(said));
        let rows = pg::count_rows(snapshot.client(), schema, table)
            .await?
            .ok_or_else(|| AppError::msg(format!("{schema}.{table} was dropped while it was being backed up.")))?;
        out.push(Counted {
            schema: schema.clone(),
            table: table.clone(),
            rows,
        });
    }
    jobs.step(
        id,
        "dump",
        StepState::Running,
        Some(format!("{} counted", tables(out.len()))),
    );
    Ok(out)
}

async fn restore(
    jobs: &Arc<Jobs>,
    id: &str,
    plan: &Plan,
    archive: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), Halt> {
    jobs.step(id, "restore", StepState::Running, None);
    let target = &plan.target;
    let options = RestoreOptions {
        clean: plan.options.replace,
        no_owner: plan.options.no_owner,
        single_transaction: plan.options.single_transaction,
        jobs: plan.options.jobs,
    };
    let restore = dump::prepare_restore(&target.cfg, &target.database, target.major, archive, &options, false)
        .await
        .map_err(failed)?;
    let said = (!restore.replaced.is_empty()).then(|| format!("replacing what was in {}", restore.replaced.join(", ")));
    jobs.step(id, "restore", StepState::Running, said);
    let children = dump::launch(&restore.stages, &dump::env_for(&target.cfg)).map_err(failed)?;
    match dump::drive(jobs, id, "restore", children, cancel).await {
        (JobState::Done, _) => {
            jobs.step(id, "restore", StepState::Done, None);
            Ok(())
        }
        (JobState::Cancelled, _) => Err(Halt::Cancelled),
        (_, e) => Err(Halt::Failed(e.unwrap_or_else(|| "The restore failed.".into()))),
    }
}

/// Counts on the target every table that was counted on the source. What is
/// compared is the number of rows in each, which catches a table that did not
/// arrive, arrived short or landed on top of something; it does not read the
/// rows themselves.
async fn verify(
    jobs: &Arc<Jobs>,
    id: &str,
    plan: &Plan,
    source: &[Counted],
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), Halt> {
    jobs.step(id, "verify", StepState::Running, None);
    let target = &plan.target;
    let counting = async {
        let conn = pg::connect(&target.cfg, &target.database).await?;
        conn.client
            .batch_execute(&format!("{}; SET row_security = off", pg::OPENING))
            .await?;
        let mut found = Vec::with_capacity(source.len());
        for (i, t) in source.iter().enumerate() {
            let said = format!("table {} of {}", i + 1, source.len());
            jobs.step(id, "verify", StepState::Running, Some(said));
            found.push(pg::count_rows(&conn.client, &t.schema, &t.table).await?);
        }
        AppResult::Ok(found)
    };
    let found = tokio::select! {
        found = counting => found.map_err(failed)?,
        _ = dump::cancelled(cancel) => return Err(Halt::Cancelled),
    };

    let wrong = compare(source, &found);
    let rows: i64 = source.iter().map(|c| c.rows).sum();
    jobs.update(id, |j| {
        j.report = Some(json!({ "tables": source.len(), "rows": rows, "mismatches": wrong }));
    });
    if wrong.is_empty() {
        let said = format!("{}, {} rows, all of them there", tables(source.len()), grouped(rows));
        jobs.step(id, "verify", StepState::Done, Some(said));
        return Ok(());
    }
    let said = format!("{} of {} differ", grouped(wrong.len() as i64), tables(source.len()));
    jobs.step(id, "verify", StepState::Failed, Some(said));
    Err(Halt::Failed(format!(
        "{} on the target {} not hold what the backup was taken from.",
        tables(wrong.len()),
        if wrong.len() == 1 { "does" } else { "do" }
    )))
}

async fn analyze(jobs: &Arc<Jobs>, id: &str, plan: &Plan, cancel: &mut watch::Receiver<bool>) -> Result<(), Halt> {
    jobs.step(id, "analyze", StepState::Running, None);
    let target = &plan.target;
    let out = tokio::select! {
        out = pg::analyze(&target.cfg, &target.database) => out,
        _ = dump::cancelled(cancel) => return Err(Halt::Cancelled),
    };
    match out {
        Ok(v) => {
            let n = v["tables"].as_u64().unwrap_or(0) as usize;
            jobs.step(id, "analyze", StepState::Done, Some(tables(n)));
            Ok(())
        }
        Err(e) => Err(Halt::Failed(format!(
            "The copy arrived and every table matches, but collecting statistics failed: {}",
            e.message
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counted(table: &str, rows: i64) -> Counted {
        Counted {
            schema: "public".into(),
            table: table.into(),
            rows,
        }
    }

    #[test]
    fn a_copy_that_matches_has_nothing_to_report() {
        let source = [counted("orders", 20_000), counted("empty", 0)];
        assert!(compare(&source, &[Some(20_000), Some(0)]).is_empty());
    }

    #[test]
    fn a_table_that_arrived_short_or_not_at_all_is_named() {
        let source = [counted("orders", 20_000), counted("customers", 500), counted("gone", 7)];
        let wrong = compare(&source, &[Some(19_999), Some(500), None]);
        assert_eq!(
            wrong,
            vec![
                Mismatch {
                    schema: "public".into(),
                    table: "orders".into(),
                    source: 20_000,
                    target: Some(19_999)
                },
                Mismatch {
                    schema: "public".into(),
                    table: "gone".into(),
                    source: 7,
                    target: None
                },
            ]
        );
    }

    #[test]
    fn an_empty_table_that_never_arrived_is_still_a_mismatch() {
        // Nothing and zero rows are not the same thing: the application that
        // goes looking for the table will tell them apart at once.
        let wrong = compare(&[counted("audit", 0)], &[None]);
        assert_eq!(wrong.len(), 1);
    }

    #[test]
    fn the_backup_is_a_folder_taken_from_the_counted_snapshot() {
        let o = Options {
            replace: false,
            single_transaction: true,
            no_owner: true,
            jobs: 4,
        };
        let a = dump_args("shop", Path::new("/tmp/x/shop.dumpdir"), &o, "00000003-0000001B-1");
        assert!(a.contains(&"--format=directory".to_string()));
        assert!(a.windows(2).any(|w| w == ["--jobs", "4"]));
        assert!(a.windows(2).any(|w| w == ["--snapshot", "00000003-0000001B-1"]));
    }

    #[test]
    fn numbers_are_grouped_and_sizes_scaled() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(human(512), "512 B");
        assert_eq!(human(1536), "1.5 KB");
        assert_eq!(human(795_000_000), "758 MB");
        assert_eq!(tables(1), "1 table");
        assert_eq!(tables(59), "59 tables");
    }
}
