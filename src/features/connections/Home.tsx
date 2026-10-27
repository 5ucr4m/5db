import { Copy, Database, MoreHorizontal, Pencil, Plus, Search, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cx, Input, Kbd, MenuItem, MenuSeparator, Popover, Spinner } from "../../components/ui";
import { connectionSummary, ENV_META, monogram } from "../../lib/connections";
import { relativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/rpc";
import type { ConnectionConfig } from "../../lib/types";
import { useApp } from "../../store/app";
import { ConnectionForm } from "./ConnectionForm";

export function Home() {
  const connections = useApp((s) => s.connections);
  const loaded = useApp((s) => s.connectionsLoaded);
  const sessions = useApp((s) => s.sessions);
  const openSession = useApp((s) => s.openSession);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter((c) => `${c.name} ${c.host} ${c.database} ${c.env} ${c.kind}`.toLowerCase().includes(q));
  }, [connections, query]);

  const recent = useMemo(
    () =>
      [...connections]
        .filter((c) => c.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
        .slice(0, 3),
    [connections],
  );

  const openForm = (c: ConnectionConfig | null) => {
    setEditing(c);
    setFormOpen(true);
  };

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-end justify-between gap-6 border-b border-line px-10 pt-10 pb-6">
        <div>
          <h1 className="font-display text-[34px] leading-none font-bold tracking-tight">
            5db<span className="text-iris">.</span>
          </h1>
          <p className="mt-2 text-sm text-muted">
            {connections.length
              ? `${connections.length} saved connection${connections.length === 1 ? "" : "s"} · Postgres and Redis`
              : "A calm place for your Postgres and Redis data."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 0 && (
            <div className="relative w-64">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-faint" />
              <Input placeholder="Find a connection" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openForm(null)} kbd="⌘N">
            New connection
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-10 py-8">
        {connections.length === 0 ? (
          <FirstRun onCreate={() => openForm(null)} />
        ) : (
          <>
            {recent.length > 0 && !query && (
              <section className="mb-8">
                <h2 className="mb-3 text-2xs font-semibold tracking-[0.14em] text-faint uppercase">Jump back in</h2>
                <div className="flex flex-wrap gap-2">
                  {recent.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => openSession(c.id)}
                      className="flex items-center gap-2 rounded-full border border-line bg-panel py-1 pr-3 pl-1 text-sm transition-colors hover:border-iris-line hover:bg-iris-soft"
                    >
                      <span
                        className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                        style={{ background: c.color }}
                      >
                        {monogram(c.name)}
                      </span>
                      {c.name}
                      <span className="text-xs text-faint">{relativeTime(c.lastUsedAt)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <h2 className="mb-3 text-2xs font-semibold tracking-[0.14em] text-faint uppercase">All connections</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
              {filtered.map((c) => (
                <ConnectionCard
                  key={c.id}
                  c={c}
                  connected={sessions.some((s) => s.connectionId === c.id && s.status === "ready")}
                  connecting={sessions.some((s) => s.connectionId === c.id && s.status === "connecting")}
                  onOpen={() => openSession(c.id)}
                  onEdit={() => openForm(c)}
                  onDuplicate={() => openForm({ ...c, id: "", name: `${c.name} copy`, createdAt: undefined, lastUsedAt: undefined })}
                />
              ))}
              <button
                type="button"
                onClick={() => openForm(null)}
                className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-iris hover:text-iris"
              >
                <Plus className="size-5" />
                Add connection
              </button>
            </div>
            {filtered.length === 0 && <p className="mt-6 text-sm text-muted">No connection matches “{query}”.</p>}
          </>
        )}
      </div>

      <ConnectionForm open={formOpen} initial={editing} onClose={() => setFormOpen(false)} />
      <NewConnectionShortcut onTrigger={() => openForm(null)} />
    </div>
  );
}

function NewConnectionShortcut({ onTrigger }: { onTrigger: () => void }) {
  useGlobalKey((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      onTrigger();
    }
  });
  return null;
}

function useGlobalKey(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

function ConnectionCard({
  c,
  connected,
  connecting,
  onOpen,
  onEdit,
  onDuplicate,
}: {
  c: ConnectionConfig;
  connected: boolean;
  connecting: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const deleteConnection = useApp((s) => s.deleteConnection);
  const confirm = useApp((s) => s.confirm);
  const toast = useApp((s) => s.toast);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const env = ENV_META[c.env] ?? ENV_META.local;

  const remove = async () => {
    setMenuOpen(false);
    const ok = await confirm({
      title: `Delete “${c.name}”?`,
      body: "The saved connection, its query history and saved queries are removed from this computer. Your database is not touched.",
      confirmLabel: "Delete connection",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteConnection(c.id);
      toast("ok", `Deleted “${c.name}”`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="group relative flex min-h-[132px] cursor-default flex-col overflow-hidden rounded-xl border border-line bg-panel p-4 pl-5 text-left transition-all hover:-translate-y-px hover:border-line-strong hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
    >
      <span
        className={cx("absolute inset-y-0 left-0 w-1", c.env === "prod" && "env-stripe-prod")}
        style={c.env === "prod" ? undefined : { background: env.color }}
      />
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-lg font-display text-sm font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
          style={{ background: c.color }}
        >
          {monogram(c.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[15px] font-semibold">{c.name}</span>
            {connecting ? (
              <Spinner className="size-3" />
            ) : (
              connected && <span className="size-1.5 shrink-0 rounded-full bg-ok" title="Connected" />
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{connectionSummary(c)}</div>
        </div>
        <button
          type="button"
          ref={moreRef}
          aria-label="Connection actions"
          className="rounded-md p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-fg focus:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      <div className="mt-auto flex items-center gap-2 overflow-hidden pt-4 text-xs whitespace-nowrap text-muted">
        <span className="inline-flex items-center gap-1">
          {c.kind === "postgres" ? <Database className="size-3.5" /> : <Zap className="size-3.5" />}
          {c.kind === "postgres" ? "PostgreSQL" : "Redis"}
        </span>
        <span className="text-faint">·</span>
        <span style={{ color: env.color }} className="font-medium">
          {env.label}
        </span>
        {c.readOnly && (
          <>
            <span className="text-faint">·</span>
            <span>read-only</span>
          </>
        )}
        <span className="ml-auto truncate pl-2 text-faint">{c.lastUsedAt ? relativeTime(c.lastUsedAt) : "never opened"}</span>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Popover anchor={moreRef.current} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" className="w-44">
          <MenuItem icon={<Pencil className="size-3.5" />} onClick={() => (setMenuOpen(false), onEdit())}>
            Edit
          </MenuItem>
          <MenuItem icon={<Copy className="size-3.5" />} onClick={() => (setMenuOpen(false), onDuplicate())}>
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 className="size-3.5" />} onClick={remove}>
            Delete
          </MenuItem>
        </Popover>
      </div>
    </div>
  );
}

function FirstRun({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto mt-[6vh] grid max-w-4xl grid-cols-[1.1fr_1fr] items-center gap-12">
      <div>
        <h2 className="font-display text-[40px] leading-[1.05] font-bold tracking-tight text-balance">
          Your tables, keys and queries. <span className="text-iris">In one quiet window.</span>
        </h2>
        <p className="mt-4 max-w-md text-[15px] text-muted">
          Save a connection once and reopen it in a click. Browse tables, filter and sort without writing SQL, edit rows safely, and keep
          every query you run.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
            Add your first connection
          </Button>
          <span className="text-xs text-faint">
            or press <Kbd>⌘N</Kbd>
          </span>
        </div>
      </div>
      <FakeGridArt />
    </div>
  );
}

/** A small static vignette of the grid, so the first screen shows what the app is. */
function FakeGridArt() {
  const rows = [
    ["1", "Ana Silva", "BR", "true", "2026-10-26"],
    ["2", "Bruno Souza", "US", "false", "2026-10-25"],
    ["3", "Carla Costa", "PT", "false", "NULL"],
    ["4", "Diego Lima", "AR", "true", "2026-10-21"],
    ["5", "Elisa Rocha", "DE", "false", "2026-10-19"],
  ];
  const heads: [string, string, string][] = [
    ["#", "id", "text-t-num"],
    ["Aa", "name", "text-muted"],
    ["Aa", "country", "text-muted"],
    ["◐", "is_vip", "text-t-bool"],
    ["◷", "created", "text-t-time"],
  ];
  return (
    <div
      aria-hidden
      className="relative rotate-[-1.5deg] overflow-hidden rounded-xl border border-line bg-panel font-mono text-[11px] shadow-[0_30px_60px_-30px_rgb(80_50_200/0.55)]"
    >
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 font-sans text-xs">
        <span className="size-2 rounded-full bg-iris" />
        <span className="font-semibold">customers</span>
        <span className="ml-auto rounded bg-iris-soft px-1.5 py-0.5 text-[10px] text-iris">sorted by created ↓</span>
      </div>
      <div className="grid grid-cols-[34px_1fr_1.6fr_1fr_1fr_1.4fr] border-b border-line font-sans">
        <span />
        {heads.map(([g, n, col]) => (
          <span key={n} className="flex items-center gap-1 border-l border-line px-2 py-1.5 font-semibold">
            <span className={cx("font-mono text-[9px]", col)}>{g}</span>
            {n}
          </span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={i} className={cx("grid grid-cols-[34px_1fr_1.6fr_1fr_1fr_1.4fr]", i === 1 && "bg-iris-soft")}>
          <span className="py-1.5 pr-2 text-right text-faint">{i + 1}</span>
          {r.map((v, j) => (
            <span
              key={j}
              className={cx(
                "truncate border-l border-line/50 px-2 py-1.5",
                j === 0 && "text-right text-t-num",
                j === 3 && (v === "true" ? "text-ok" : "text-muted"),
                j === 4 && (v === "NULL" ? "text-faint" : "text-t-time"),
              )}
            >
              {v}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
