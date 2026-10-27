import { useCallback, useEffect, useState } from "react";
import { Clock, RefreshCw, Search, Trash2 } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Input, Spinner, Toggle, cx } from "../../components/ui";
import { formatDuration } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import { useApp, type Session, type Tab } from "../../store/app";
import { HistoryRow, notifyHistory, useHistory } from "./LibraryPanel";
import { SqlEditor } from "./LazySqlEditor";

export function HistoryTab({ session }: { session: Session }) {
  const [search, setSearch] = useState("");
  const { items, loading, reload } = useHistory(session.connectionId, search, 1000);
  const openTab = useApp((s) => s.openTab);
  const confirm = useApp((s) => s.confirm);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const shown = onlyErrors ? items.filter((h) => h.error) : items;
  const open = (sql: string, autorun: boolean) => openTab(session.id, { kind: "query", title: autorun ? "Re-run" : "From history", sql, autorun });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h2 className="font-display text-[15px] font-semibold">Query history</h2>
        <div className="relative w-80">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input autoFocus className="h-7 pl-8 text-xs" placeholder="Search the SQL of every query you ran" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Toggle checked={onlyErrors} onChange={setOnlyErrors} label={<span className="text-xs">Only failed</span>} />
        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            disabled={!items.length}
            onClick={async () => {
              if (!(await confirm({ title: "Clear query history?", body: "Every recorded query for this connection is removed. Saved queries are kept.", confirmLabel: "Clear history", danger: true }))) return;
              await rpc("history.clear", { connectionId: session.connectionId });
              notifyHistory();
            }}
          >
            Clear
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Clock className="size-5" />} title={search ? "No query matches" : "No queries yet"}>
            Everything you run in the SQL editor is recorded here with its duration and row count.
          </EmptyState>
        ) : (
          <div className="mx-auto max-w-5xl">
            {shown.map((h) => (
              <HistoryRow
                key={h.id}
                h={h}
                onUse={() => open(h.sql, false)}
                onRun={() => open(h.sql, true)}
                onDelete={async () => {
                  await rpc("history.delete", { id: h.id });
                  void reload();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ActivityRow {
  pid: number;
  user: string | null;
  database: string | null;
  application: string | null;
  clientAddr: string | null;
  state: string | null;
  backendStart: string | null;
  queryAgeSec: number | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string | null;
  isSelf: boolean;
}

export function ActivityTab({ session, active }: { session: Session; active: boolean }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [hideIdle, setHideIdle] = useState(false);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);
  const load = useCallback(async () => {
    try {
      setRows(await rpc<ActivityRow[]>("pg.activity", { connectionId: session.connectionId, database: session.database }));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [session.connectionId, session.database, toast]);
  useEffect(() => {
    void load();
    if (!auto || !active) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, auto, active]);

  const signal = async (pid: number, terminate: boolean) => {
    if (terminate && !(await confirm({ title: `Terminate backend ${pid}?`, body: "The client connection is closed and its open transaction rolled back.", confirmLabel: "Terminate", danger: true }))) return;
    try {
      const ok = await rpc<boolean>("pg.signal", { connectionId: session.connectionId, database: session.database, pid, terminate });
      toast(ok ? "ok" : "error", ok ? `${terminate ? "Terminated" : "Cancelled"} ${pid}` : `Could not signal ${pid}`);
      void load();
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const shown = (rows ?? []).filter((r) => !hideIdle || r.state !== "idle");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
        <h2 className="font-display text-[15px] font-semibold">Server activity</h2>
        <span className="text-xs text-muted">{rows ? `${rows.length} client connections` : ""}</span>
        <Toggle checked={hideIdle} onChange={setHideIdle} label={<span className="text-xs">Hide idle</span>} />
        <Toggle checked={auto} onChange={setAuto} label={<span className="text-xs">Refresh every 2s</span>} />
        <IconButton label="Refresh now" className="ml-auto" onClick={load}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-left text-2xs tracking-wider text-faint uppercase">
              {["PID", "State", "User", "Database", "Application", "Client", "Running for", "Waiting on", "Query", ""].map((h) => (
                <th key={h} className="border-b border-line px-3 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.pid} className="border-b border-line/60 align-top hover:bg-raised/50">
                <td className="px-3 py-2 font-mono tabular">{r.pid}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.state === "active" ? "ok" : r.state?.startsWith("idle in") ? "warn" : "neutral"}>{r.state ?? "—"}</Badge>
                  {r.isSelf && <span className="ml-1 text-[10px] text-iris">this app</span>}
                </td>
                <td className="px-3 py-2">{r.user}</td>
                <td className="px-3 py-2 font-mono">{r.database}</td>
                <td className="px-3 py-2">{r.application || <span className="text-faint">—</span>}</td>
                <td className="px-3 py-2 font-mono">{r.clientAddr ?? "local"}</td>
                <td className={cx("px-3 py-2 font-mono tabular", (r.queryAgeSec ?? 0) > 30 && r.state === "active" && "text-warn")}>
                  {r.queryAgeSec != null && r.state === "active" ? formatDuration(r.queryAgeSec * 1000) : "—"}
                </td>
                <td className="px-3 py-2 text-muted">{r.waitEvent ? `${r.waitEventType}: ${r.waitEvent}` : "—"}</td>
                <td className="max-w-[420px] px-3 py-2">
                  <pre className="line-clamp-3 font-mono text-[11px] whitespace-pre-wrap text-muted">{r.query}</pre>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {!r.isSelf && (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => signal(r.pid, false)} disabled={r.state !== "active"}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => signal(r.pid, true)}>
                        Terminate
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FunctionTab({ session, tab }: { session: Session; tab: Extract<Tab, { kind: "function" }> }) {
  const [def, setDef] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openTab = useApp((s) => s.openTab);
  useEffect(() => {
    rpc<string>("pg.functionDef", { connectionId: session.connectionId, database: session.database, oid: tab.oid })
      .then(setDef)
      .catch((e) => setErr(errorMessage(e)));
  }, [session.connectionId, session.database, tab.oid]);
  if (err) return <div className="p-6 text-sm text-danger">{err}</div>;
  if (def == null)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-xs text-muted">
          {tab.schema}.{tab.name}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openTab(session.id, { kind: "query", title: `Edit ${tab.name}`, sql: def })}>
          Open in editor
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-panel">
        <SqlEditor className="h-full" initialValue={def} readOnly />
      </div>
    </div>
  );
}
