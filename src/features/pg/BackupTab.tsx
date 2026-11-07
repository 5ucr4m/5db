import { AlertTriangle, Archive, CheckCircle2, Download, FolderOpen, Plus, Square, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, cx, Field, Input, Segmented, Select, Spinner, Toggle } from "../../components/ui";
import { ENV_META } from "../../lib/connections";
import { pickSavePath } from "../../lib/export";
import { formatBytes, formatDuration } from "../../lib/format";
import { errorMessage, isTauri, rpc } from "../../lib/rpc";
import { type Session, useApp, useConnection } from "../../store/app";

interface Tool {
  name: string;
  path: string;
  version: string;
  major: number;
}

interface Tools {
  pgDump: Tool | null;
  pgRestore: Tool | null;
  psql: Tool | null;
}

interface Job {
  id: string;
  kind: "dump" | "restore";
  state: "running" | "done" | "failed" | "cancelled";
  log: string[];
  error: string | null;
  elapsedMs: number;
  bytes: number;
  file: string | null;
}

type Content = "all" | "structure" | "data";
type Format = "custom" | "directory" | "plain";

export function BackupTab({ session, active }: { session: Session; active: boolean }) {
  const conn = useConnection(session.connectionId);
  const connections = useApp((s) => s.connections);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);

  const [tools, setTools] = useState<Tools | null>(null);
  const [content, setContent] = useState<Content>("all");
  const [format, setFormat] = useState<Format>("custom");
  const [noOwner, setNoOwner] = useState(true);
  // Only the directory format can be written by several workers at once.
  const [jobs, setJobs] = useState(4);

  const [restoreFile, setRestoreFile] = useState("");
  const [targetId, setTargetId] = useState("");
  // A server holds many databases, and restoring into a fresh one is the usual
  // shape of a migration, so the database is picked separately.
  const [targetDb, setTargetDb] = useState("");
  const [targetDbs, setTargetDbs] = useState<{ name: string }[] | null>(null);
  const [newDbName, setNewDbName] = useState("");
  const [creatingDb, setCreatingDb] = useState(false);
  const [clean, setClean] = useState(false);
  const [oneTransaction, setOneTransaction] = useState(true);

  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rpc<Tools>("dump.tools")
      .then(setTools)
      .catch(() => setTools({ pgDump: null, pgRestore: null, psql: null }));
  }, []);

  // A job is polled only while its panel is on screen; nothing runs otherwise.
  useEffect(() => {
    if (!active || !job || job.state !== "running") return;
    const id = setInterval(async () => {
      try {
        setJob(await rpc<Job>("dump.status", { id: job.id }));
      } catch {
        // The job stopped being tracked; the last state we have stands.
      }
    }, 500);
    return () => clearInterval(id);
  }, [active, job]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log.length]);

  const targets = connections.filter((c) => c.kind === "postgres");
  const target = targets.find((c) => c.id === targetId);
  const running = job?.state === "running";

  const backup = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const ext = format === "custom" ? "dump" : format === "directory" ? "dumpdir" : "sql";
    const path = await pickSavePath(`${session.database}-${stamp}.${ext}`, ext);
    if (!path || path === "download") {
      if (path === "download") toast("info", "Backups are only available in the installed app.");
      return;
    }
    setBusy(true);
    try {
      const started = await rpc<{ id: string; tool: string; version: string }>("dump.start", {
        connectionId: session.connectionId,
        database: session.database,
        path,
        options: { content, format, noOwner, jobs: format === "directory" ? jobs : 1 },
      });
      toast("info", `Backing up with pg_dump ${started.version}`);
      setJob(await rpc<Job>("dump.status", { id: started.id }));
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [content, format, jobs, noOwner, session.connectionId, session.database, toast]);

  // A backup is one file, unless it was written in the directory format.
  // The databases that actually exist on the chosen server.
  const loadTargetDbs = useCallback(
    async (id: string) => {
      setTargetDbs(null);
      const picked = targets.find((c) => c.id === id);
      setTargetDb(picked?.database ?? "");
      if (!id) return;
      try {
        setTargetDbs(await rpc<{ name: string }[]>("pg.databases", { connectionId: id }));
      } catch (e) {
        // Without a listing the field still accepts a name typed by hand.
        toast("error", errorMessage(e));
        setTargetDbs([]);
      }
    },
    [targets, toast],
  );

  const createTargetDb = async () => {
    const name = newDbName.trim();
    if (!name || !targetId) return;
    setCreatingDb(true);
    try {
      await rpc("pg.createDatabase", { connectionId: targetId, name });
      toast("ok", `Created ${name}`);
      setNewDbName("");
      await loadTargetDbs(targetId);
      setTargetDb(name);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setCreatingDb(false);
    }
  };

  const pickRestoreSource = async (directory: boolean) => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      directory,
      title: directory ? "Choose a backup folder to restore" : "Choose a backup file to restore",
      ...(directory ? {} : { filters: [{ name: "Backup", extensions: ["dump", "sql", "backup"] }] }),
    });
    if (typeof path === "string") setRestoreFile(path);
  };

  const restore = useCallback(async () => {
    if (!restoreFile || !target || !targetDb) return;
    const env = ENV_META[target.env] ?? ENV_META.local;
    const plain = restoreFile.endsWith(".sql");
    const ok = await confirm({
      title: `Restore into ${target.name}?`,
      body:
        `${restoreFile.split("/").pop()} will be applied to ${targetDb} on ${target.host}, which is marked ${env.label}.` +
        (clean ? "\n\nEvery object the backup contains will be dropped there first." : "") +
        "\n\nThis cannot be undone.",
      confirmLabel: clean ? "Drop and restore" : "Restore",
      danger: target.env === "prod" || clean,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const started = await rpc<{ id: string; version: string; database: string }>("restore.start", {
        connectionId: target.id,
        database: targetDb,
        path: restoreFile,
        plain,
        options: { clean, noOwner, singleTransaction: oneTransaction },
      });
      toast("info", `Restoring into ${started.database}`);
      setJob(await rpc<Job>("dump.status", { id: started.id }));
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [clean, confirm, noOwner, oneTransaction, restoreFile, target, targetDb, toast]);

  const cancel = async () => {
    if (!job) return;
    try {
      await rpc("dump.cancel", { id: job.id });
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  if (!tools) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const missing = !tools.pgDump || !tools.pgRestore;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Archive className="size-4 text-iris" />
        <h2 className="font-display text-[15px] font-semibold">Backup and restore</h2>
        <span className="text-xs text-muted">
          {session.database} on {conn?.name}
        </span>
        {tools.pgDump && (
          <span className="ml-auto" title={tools.pgDump.path}>
            <Badge className="gap-1 font-mono normal-case">pg_dump {tools.pgDump.version}</Badge>
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {missing && (
          <div className="selectable m-4 flex gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              <div className="font-medium text-fg">The PostgreSQL client tools were not found</div>
              <p className="mt-1 text-muted">
                A backup that can be trusted for a migration has to come from <code className="font-mono">pg_dump</code>, which is not
                bundled with 5db. Install it and reopen this tab.
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-sunken p-2 font-mono text-xs text-fg">
                macOS brew install libpq{"\n"}
                Debian sudo apt install postgresql-client{"\n"}
                Windows installer from postgresql.org
              </pre>
            </div>
          </div>
        )}

        <section className="border-b border-line p-4">
          <div className="flex items-baseline gap-2">
            <Download className="size-3.5 text-muted" />
            <h3 className="text-sm font-semibold">Back this database up</h3>
          </div>

          <div className="mt-3 grid max-w-3xl gap-3 md:grid-cols-2">
            <Field label="What to include">
              <Segmented
                size="md"
                value={content}
                onChange={(v) => setContent(v as Content)}
                options={[
                  { value: "all", label: "Everything" },
                  { value: "structure", label: "Structure" },
                  { value: "data", label: "Data" },
                ]}
              />
            </Field>
            <Field
              label="Format"
              hint={
                format === "custom"
                  ? "One compressed file. A restore can pick and choose what to replay."
                  : format === "directory"
                    ? "A folder of files, and the only format several workers can write at once."
                    : "Plain SQL you can read and apply with psql anywhere."
              }
            >
              <Segmented
                size="md"
                value={format}
                onChange={(v) => setFormat(v as Format)}
                options={[
                  { value: "custom", label: "Archive" },
                  { value: "directory", label: "Folder" },
                  { value: "plain", label: "SQL" },
                ]}
              />
            </Field>
          </div>

          {format === "directory" && (
            <Field
              className="mt-3 max-w-md"
              label="Workers"
              hint={`Dumps ${jobs} tables at once. It opens ${jobs + 1} connections and is worth matching to the server's cores, not yours.`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={16}
                  value={jobs}
                  onChange={(e) => setJobs(Number(e.target.value))}
                  className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-iris"
                  aria-label="Workers"
                />
                <span className="w-6 text-right font-mono text-sm text-fg tabular">{jobs}</span>
              </div>
            </Field>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Toggle
              checked={noOwner}
              onChange={setNoOwner}
              label={
                <span>
                  Leave owners and grants out <span className="text-muted">— what a move to a server with different roles needs</span>
                </span>
              }
            />
          </div>

          <Button
            className="mt-4"
            variant="primary"
            icon={<Download className="size-3.5" />}
            onClick={backup}
            disabled={missing || running || busy || !isTauri}
          >
            Choose a file and back up
          </Button>
        </section>

        <section className="p-4">
          <div className="flex items-baseline gap-2">
            <Upload className="size-3.5 text-muted" />
            <h3 className="text-sm font-semibold">Restore onto another server</h3>
          </div>

          <div className="mt-3 grid max-w-3xl gap-3">
            <Field label="Backup file">
              <div className="flex gap-2">
                <input
                  className="h-8 flex-1 rounded-md border border-line bg-sunken px-2.5 font-mono text-xs text-fg outline-none placeholder:text-faint focus:border-iris"
                  value={restoreFile}
                  placeholder="A .dump or .sql file, or a backup folder"
                  onChange={(e) => setRestoreFile(e.target.value)}
                />
                {isTauri && (
                  <>
                    <Button size="sm" className="h-8" icon={<FolderOpen className="size-3.5" />} onClick={() => pickRestoreSource(false)}>
                      File
                    </Button>
                    <Button size="sm" className="h-8" icon={<FolderOpen className="size-3.5" />} onClick={() => pickRestoreSource(true)}>
                      Folder
                    </Button>
                  </>
                )}
              </div>
            </Field>

            <Field label="Restore into" hint="Any saved PostgreSQL connection, including one on another server.">
              <Select
                value={targetId}
                onChange={(e) => {
                  setTargetId(e.target.value);
                  void loadTargetDbs(e.target.value);
                }}
              >
                <option value="">Pick a connection…</option>
                {targets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.host} ({ENV_META[c.env]?.label ?? c.env})
                  </option>
                ))}
              </Select>
            </Field>

            {target && (
              <Field
                label="Database on that server"
                hint="A restore replays into one database. Make a new one when the backup should not land on top of anything."
              >
                <div className="flex gap-2">
                  <Select className="flex-1" value={targetDb} onChange={(e) => setTargetDb(e.target.value)} disabled={!targetDbs}>
                    {!targetDbs ? (
                      <option value="">Reading the server…</option>
                    ) : (
                      <>
                        <option value="">Pick a database…</option>
                        {targetDbs.map((d) => (
                          <option key={d.name} value={d.name}>
                            {d.name}
                          </option>
                        ))}
                      </>
                    )}
                  </Select>
                </div>
                <div className="mt-2 flex gap-2">
                  <Input
                    mono
                    className="h-8 flex-1 text-xs"
                    value={newDbName}
                    placeholder="or create one: neoprop_novo"
                    onChange={(e) => setNewDbName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newDbName.trim()) void createTargetDb();
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-8"
                    icon={<Plus className="size-3.5" />}
                    onClick={createTargetDb}
                    loading={creatingDb}
                    disabled={!newDbName.trim()}
                  >
                    Create
                  </Button>
                </div>
              </Field>
            )}

            <div className="flex flex-wrap items-center gap-5">
              <Toggle
                checked={oneTransaction}
                onChange={(v) => setOneTransaction(v)}
                label={
                  <span>
                    All or nothing <span className="text-muted">— a failure leaves the target untouched</span>
                  </span>
                }
              />
              <Toggle
                checked={clean}
                onChange={setClean}
                label={
                  <span className={clean ? "text-danger" : undefined}>
                    Drop existing objects first <span className="text-muted">— destructive</span>
                  </span>
                }
              />
            </div>
          </div>

          {target?.env === "prod" && (
            <div className="mt-3 flex max-w-3xl items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2 text-sm text-danger">
              <AlertTriangle className="size-4 shrink-0" />
              {target.name} is marked production.
            </div>
          )}

          <Button
            className="mt-4"
            variant={target?.env === "prod" || clean ? "danger" : "secondary"}
            icon={<Upload className="size-3.5" />}
            onClick={restore}
            disabled={missing || running || busy || !restoreFile || !target || !targetDb}
          >
            Restore
          </Button>
        </section>

        {job && (
          <section className="border-t border-line">
            <div className="flex items-center gap-3 px-4 py-2.5">
              {job.state === "running" ? (
                <Spinner className="size-4" />
              ) : job.state === "done" ? (
                <CheckCircle2 className="size-4 text-ok" />
              ) : (
                <AlertTriangle className={cx("size-4", job.state === "cancelled" ? "text-muted" : "text-danger")} />
              )}
              <span className="text-sm font-medium">
                {job.kind === "dump" ? "Backup" : "Restore"}{" "}
                {job.state === "running" ? "running" : job.state === "done" ? "finished" : job.state}
              </span>
              <span className="font-mono text-xs text-faint tabular">
                {formatDuration(job.elapsedMs)}
                {job.kind === "dump" && job.bytes > 0 && ` · ${formatBytes(job.bytes)}`}
              </span>
              {job.state === "running" && (
                <Button size="sm" variant="ghost" icon={<Square className="size-3 fill-current" />} onClick={cancel}>
                  Cancel
                </Button>
              )}
              {job.state === "done" && job.kind === "dump" && job.file && (
                <span className="truncate font-mono text-xs text-muted" title={job.file}>
                  {job.file}
                </span>
              )}
            </div>

            {job.error && (
              <div className="selectable mx-4 mb-3 rounded-lg border border-danger/25 bg-danger/[0.06] p-3 text-sm whitespace-pre-wrap text-fg">
                {job.error}
              </div>
            )}

            {job.log.length > 0 && (
              <div ref={logRef} className="selectable max-h-64 overflow-auto border-t border-line bg-sunken px-4 py-2">
                {job.log.map((line, i) => (
                  <div key={`${i}-${line.slice(0, 24)}`} className="font-mono text-[11px] leading-relaxed text-muted">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
