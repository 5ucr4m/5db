import { AlertTriangle, ArrowRightLeft, CheckCircle2, Circle, FolderOpen, Minus, XCircle } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, cx, Field, Spinner, Toggle } from "../../components/ui";
import { ENV_META } from "../../lib/connections";
import { formatBytes, formatDuration } from "../../lib/format";
import { errorMessage, isTauri, rpc } from "../../lib/rpc";
import { describeMismatch, type Job, keptBackup, type Step, stepLabel } from "../../lib/transfer";
import { type Session, useApp, useConnection } from "../../store/app";
import { NO_TARGET, type Target, TargetPicker } from "./TargetPicker";

/**
 * The whole move in one go: back up, restore, compare, collect statistics,
 * delete the backup. The backend runs it as a single job, so all this does is
 * say where it lands and how careful to be.
 */
export function TransferForm({ session, disabled, onStarted }: { session: Session; disabled: boolean; onStarted: (job: Job) => void }) {
  const conn = useConnection(session.connectionId);
  const connections = useApp((s) => s.connections);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);

  const [target, setTarget] = useState<Target>(NO_TARGET);
  const [workers, setWorkers] = useState(4);
  const [replace, setReplace] = useState(false);
  const [oneTransaction, setOneTransaction] = useState(true);
  const [noOwner, setNoOwner] = useState(true);
  // Empty means the system's temporary folder.
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);

  const into = connections.find((c) => c.id === target.connectionId);
  const itself = target.connectionId === session.connectionId && target.database === session.database;

  const pickFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: true, title: "Choose where the backup is kept while it is copied" });
    if (typeof path === "string") setFolder(path);
  };

  const start = useCallback(async () => {
    if (!into || !target.database) return;
    const env = ENV_META[into.env] ?? ENV_META.local;
    const ok = await confirm({
      title: `Copy ${session.database} to ${into.name}?`,
      body:
        `${session.database} on ${conn?.name ?? "this server"} will be copied into ${target.database} on ${into.host}, which is marked ${env.label}.` +
        (replace ? "\n\nEvery schema it brings is emptied there first, including whatever is in it that the source does not have." : "") +
        "\n\nThis cannot be undone.",
      confirmLabel: replace ? "Replace and copy" : "Copy",
      danger: into.env === "prod" || replace,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const started = await rpc<{ id: string; version: string }>("transfer.start", {
        source: { connectionId: session.connectionId, database: session.database },
        target,
        folder,
        options: { replace, singleTransaction: oneTransaction, noOwner, jobs: workers },
      });
      toast("info", `Copying with pg_dump ${started.version}`);
      onStarted(await rpc<Job>("dump.status", { id: started.id }));
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    confirm,
    conn?.name,
    folder,
    into,
    noOwner,
    onStarted,
    oneTransaction,
    replace,
    session.connectionId,
    session.database,
    target,
    toast,
    workers,
  ]);

  return (
    <section aria-label="Copy this database to another server" className="border-b border-line p-4">
      <div className="flex items-baseline gap-2">
        <ArrowRightLeft className="size-3.5 text-muted" />
        <h3 className="text-sm font-semibold">Copy this database to another server</h3>
      </div>
      <p className="mt-1.5 max-w-3xl text-sm text-muted">
        Backs it up, restores the backup, and counts every table on both sides — against the source as it was at the instant of the backup,
        so it can stay in use meanwhile. The backup is deleted once the two agree, and kept if they do not.
      </p>

      <div className="mt-3 grid max-w-3xl gap-3">
        <TargetPicker label="Copy into" value={target} onChange={setTarget} disabled={disabled || busy} />

        <Field
          className="max-w-md"
          label="Workers"
          hint={
            oneTransaction
              ? `Backs up ${workers} tables at once over ${workers + 1} connections. The restore is one transaction, so it runs on one.`
              : `Backs up and restores ${workers} tables at once. Worth matching to the servers' cores, not yours.`
          }
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={16}
              value={workers}
              onChange={(e) => setWorkers(Number(e.target.value))}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-iris"
              aria-label="Workers"
            />
            <span className="w-6 text-right font-mono text-sm text-fg tabular">{workers}</span>
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Toggle
            checked={oneTransaction}
            onChange={setOneTransaction}
            label={
              <span>
                All or nothing <span className="text-muted">— a failed restore leaves the target untouched</span>
              </span>
            }
          />
          <Toggle
            checked={replace}
            onChange={setReplace}
            label={
              <span className={replace ? "text-danger" : undefined}>
                Replace what is there <span className="text-muted">— empties every schema this database has</span>
              </span>
            }
          />
          <Toggle
            checked={noOwner}
            onChange={setNoOwner}
            label={
              <span>
                Leave owners and grants out <span className="text-muted">— for a server with different roles</span>
              </span>
            }
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="truncate" title={folder || undefined}>
            The backup is kept in {folder ? <span className="font-mono text-fg">{folder}</span> : "the system's temporary folder"} while it
            is copied.
          </span>
          {isTauri && (
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={pickFolder}>
              {folder ? "Change" : "Choose another"}
            </Button>
          )}
          {folder && (
            <Button size="sm" variant="ghost" onClick={() => setFolder("")}>
              Use the default
            </Button>
          )}
        </div>
      </div>

      {into?.env === "prod" && (
        <div className="mt-3 flex max-w-3xl items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2 text-sm text-danger">
          <AlertTriangle className="size-4 shrink-0" />
          {into.name} is marked production.
        </div>
      )}
      {itself && <p className="mt-3 text-sm text-warn">That is the database being copied. Pick another database, or another server.</p>}

      <Button
        className="mt-4"
        variant={into?.env === "prod" || replace ? "danger" : "primary"}
        icon={<ArrowRightLeft className="size-3.5" />}
        onClick={start}
        loading={busy}
        disabled={disabled || !into || !target.database || itself}
      >
        {into && target.database ? `Copy to ${target.database} on ${into.name}` : "Copy"}
      </Button>
    </section>
  );
}

function StepIcon({ state }: { state: Step["state"] }) {
  if (state === "running") return <Spinner className="size-3.5" />;
  if (state === "done") return <CheckCircle2 className="size-3.5 text-ok" />;
  if (state === "failed") return <XCircle className="size-3.5 text-danger" />;
  if (state === "skipped") return <Minus className="size-3.5 text-faint" />;
  return <Circle className="size-3.5 text-faint" />;
}

/** The steps of a transfer, each saying what it did or how far along it is. */
export function TransferSteps({ job }: { job: Job }) {
  const wrong = job.report?.mismatches ?? [];

  return (
    <div className="mx-4 mb-3">
      <ol className="selectable rounded-lg border border-line bg-raised">
        {job.steps.map((s) => (
          <li key={s.key} className="flex items-baseline gap-2.5 border-b border-line px-3 py-2 last:border-b-0">
            <span className="translate-y-0.5">
              <StepIcon state={s.state} />
            </span>
            <span className={cx("shrink-0 text-sm", s.state === "pending" || s.state === "skipped" ? "text-muted" : "text-fg")}>
              {stepLabel(s.key)}
            </span>
            <span
              className={cx("min-w-0 flex-1 truncate text-xs", s.state === "failed" ? "text-danger" : "text-muted")}
              title={s.detail ?? ""}
            >
              {s.key === "dump" && job.bytes > 0 && `${formatBytes(job.bytes)}${s.detail ? " · " : ""}`}
              {s.detail}
            </span>
            {s.ms != null && <span className="shrink-0 font-mono text-xs text-faint tabular">{formatDuration(s.ms)}</span>}
          </li>
        ))}
      </ol>

      {wrong.length > 0 && (
        <div className="selectable mt-3 rounded-lg border border-danger/25 bg-danger/[0.06] p-3">
          <p className="text-sm text-fg">
            These tables do not hold on the target what the backup was taken from. The target has been left as the restore made it, and the
            backup has been kept.
          </p>
          <ul className="mt-2 max-h-48 overflow-auto">
            {wrong.map((m) => (
              <li key={`${m.schema}.${m.table}`} className="flex gap-2 py-0.5 text-xs">
                <span className="shrink-0 font-mono text-fg">
                  {m.schema}.{m.table}
                </span>
                <span className="text-muted">{describeMismatch(m)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Where the backup of a transfer that stopped short is, and the way back in. Shown after the reason it stopped. */
export function KeptBackup({ job, onRestoreByHand }: { job: Job; onRestoreByHand: (path: string) => void }) {
  const kept = keptBackup(job);
  if (!kept) return null;
  return (
    <div className="selectable mx-4 mb-3 flex items-center gap-3 rounded-lg border border-line bg-raised p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">The backup was finished before this stopped, so it has been kept.</p>
        <p className="mt-0.5 truncate font-mono text-xs text-muted" title={kept}>
          {kept}
        </p>
      </div>
      <Button size="sm" onClick={() => onRestoreByHand(kept)}>
        Restore it by hand
      </Button>
    </div>
  );
}
