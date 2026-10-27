import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Eye,
  FileCode2,
  Globe,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cx, IconButton, Input, MenuItem, MenuLabel, Popover, Spinner } from "../../components/ui";
import { copyText } from "../../lib/export";
import { formatBytes } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import { qualified } from "../../lib/sql";
import type { ObjectKind, PgFunction, PgObject } from "../../lib/types";
import { type Session, useApp } from "../../store/app";

type Item =
  | { type: "schema"; schema: string; count: number; collapsed: boolean }
  | { type: "object"; o: PgObject }
  | { type: "fnheader"; schema: string; count: number; collapsed: boolean }
  | { type: "fn"; f: PgFunction };

const kindIcon: Record<ObjectKind, typeof Table2> = { table: Table2, view: Eye, matview: Layers, foreign: Globe };

const compact = (n: number | null) => {
  if (n == null) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
};

export function PgSidebar({ session }: { session: Session }) {
  const openTab = useApp((s) => s.openTab);
  const refreshObjects = useApp((s) => s.refreshObjects);
  const switchDatabase = useApp((s) => s.switchDatabase);
  const toast = useApp((s) => s.toast);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dbOpen, setDbOpen] = useState(false);
  const [databases, setDatabases] = useState<{ name: string; sizeBytes: number }[] | null>(null);
  const dbRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; o: PgObject } | null>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId);
  const activeKey =
    activeTab?.kind === "table" ? `${activeTab.schema}.${activeTab.name}` : activeTab?.kind === "function" ? `fn:${activeTab.oid}` : null;

  const items = useMemo<Item[]>(() => {
    const objs = session.objects;
    if (!objs) return [];
    const q = filter.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Item[] = [];
    const multi = objs.schemas.length > 1;
    for (const schema of objs.schemas) {
      const list = objs.objects.filter((o) => o.schema === schema && (match(o.name) || match(`${o.schema}.${o.name}`)));
      const fns = objs.functions.filter((f) => f.schema === schema && match(f.name));
      if (!list.length && !fns.length && (q || !multi)) continue;
      const isCollapsed = !q && (collapsed[schema] ?? (multi && schema !== "public" && objs.schemas.includes("public")));
      if (multi || objs.schemas.length === 1) out.push({ type: "schema", schema, count: list.length, collapsed: isCollapsed });
      if (isCollapsed) continue;
      for (const o of list) out.push({ type: "object", o });
      if (fns.length) {
        const fk = `fn:${schema}`;
        const fnCollapsed = !q && (collapsed[fk] ?? true);
        out.push({ type: "fnheader", schema, count: fns.length, collapsed: fnCollapsed });
        if (!fnCollapsed) for (const f of fns) out.push({ type: "fn", f });
      }
    }
    return out;
  }, [session.objects, filter, collapsed]);

  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].type === "schema" ? 30 : 26),
    overscan: 20,
  });

  const openObject = (o: PgObject, preview: boolean) =>
    openTab(session.id, { kind: "table", title: o.name, schema: o.schema, name: o.name, objectKind: o.kind }, { preview });

  const loadDatabases = async () => {
    setDbOpen((v) => !v);
    try {
      setDatabases(await rpc("pg.databases", { connectionId: session.connectionId, database: session.database }));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const totalObjects = session.objects?.objects.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          ref={dbRef}
          onClick={loadDatabases}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium hover:bg-raised"
          title="Switch database"
        >
          <Database className="size-3.5 shrink-0 text-iris" />
          <span className="truncate">{session.database}</span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-faint" />
        </button>
        <IconButton size="sm" label="Reload schema" onClick={() => refreshObjects(session.id)}>
          <RefreshCw className={cx("size-3.5", session.objectsLoading && "animate-spin")} />
        </IconButton>
      </div>
      <Popover anchor={dbRef.current} open={dbOpen} onClose={() => setDbOpen(false)} className="max-h-80 w-64 overflow-auto">
        <MenuLabel>Databases</MenuLabel>
        {!databases ? (
          <div className="flex justify-center p-3">
            <Spinner />
          </div>
        ) : (
          databases.map((d) => (
            <MenuItem
              key={d.name}
              active={d.name === session.database}
              icon={<Database className="size-3.5" />}
              onClick={() => {
                setDbOpen(false);
                void switchDatabase(session.id, d.name);
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">{d.name}</span>
                <span className="font-mono text-[10px] text-faint">{formatBytes(d.sizeBytes)}</span>
              </span>
            </MenuItem>
          ))
        )}
      </Popover>

      <div className="relative shrink-0 px-2 pb-2">
        <Search className="pointer-events-none absolute top-2 left-4 size-3.5 text-faint" />
        <Input
          className="h-7 pr-6 pl-7 text-xs"
          placeholder={totalObjects ? `Filter ${totalObjects} objects` : "Filter objects"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = items.find((i) => i.type === "object") as Extract<Item, { type: "object" }> | undefined;
              if (first) openObject(first.o, false);
            }
            if (e.key === "Escape") setFilter("");
          }}
        />
        {filter && (
          <button
            type="button"
            className="absolute top-2 right-4 text-faint hover:text-fg"
            onClick={() => setFilter("")}
            aria-label="Clear filter"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {!session.objects ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">{filter ? `Nothing matches “${filter}”.` : "This database has no tables yet."}</p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const it = items[vi.index];
              const style = { position: "absolute" as const, top: vi.start, left: 0, right: 0, height: vi.size };
              if (it.type === "schema")
                return (
                  <button
                    type="button"
                    key={vi.key}
                    style={style}
                    onClick={() => setCollapsed((c) => ({ ...c, [it.schema]: !it.collapsed }))}
                    className="flex items-center gap-1 px-1.5 pt-2 text-2xs font-semibold tracking-[0.12em] text-faint uppercase hover:text-muted"
                  >
                    {it.collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                    {it.schema}
                    <span className="ml-auto font-mono tracking-normal">{it.count}</span>
                  </button>
                );
              if (it.type === "fnheader")
                return (
                  <button
                    type="button"
                    key={vi.key}
                    style={style}
                    onClick={() => setCollapsed((c) => ({ ...c, [`fn:${it.schema}`]: !it.collapsed }))}
                    className="flex items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-raised"
                  >
                    {it.collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                    <FileCode2 className="size-3.5" />
                    Functions
                    <span className="ml-auto font-mono text-[10px] text-faint">{it.count}</span>
                  </button>
                );
              if (it.type === "fn") {
                const key = `fn:${it.f.oid}`;
                return (
                  <button
                    type="button"
                    key={vi.key}
                    style={style}
                    title={`${it.f.name}(${it.f.args}) → ${it.f.returns}`}
                    onClick={() =>
                      openTab(
                        session.id,
                        { kind: "function", title: it.f.name, schema: it.f.schema, name: it.f.name, oid: it.f.oid },
                        { preview: true },
                      )
                    }
                    className={cx(
                      "flex items-center gap-2 rounded-md pr-2 pl-7 text-left font-mono text-[12px]",
                      activeKey === key ? "bg-iris-soft text-iris" : "text-muted hover:bg-raised hover:text-fg",
                    )}
                  >
                    <span className="truncate">{it.f.name}</span>
                    <span className="truncate text-[10px] text-faint">({it.f.args})</span>
                  </button>
                );
              }
              const o = it.o;
              const Icon = kindIcon[o.kind];
              const key = `${o.schema}.${o.name}`;
              return (
                <button
                  type="button"
                  key={vi.key}
                  style={style}
                  title={o.comment ?? `${o.schema}.${o.name}`}
                  onClick={() => openObject(o, true)}
                  onDoubleClick={() => openObject(o, false)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, o });
                  }}
                  className={cx(
                    "group flex items-center gap-2 rounded-md px-2 text-left text-[13px]",
                    activeKey === key ? "bg-iris-soft text-fg" : "text-fg/90 hover:bg-raised",
                  )}
                >
                  <Icon
                    className={cx("size-3.5 shrink-0", activeKey === key ? "text-iris" : o.kind === "table" ? "text-faint" : "text-info")}
                  />
                  <span className="truncate">{o.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint tabular">{compact(o.rowEstimate)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-t border-line p-1.5">
        <button
          type="button"
          onClick={() =>
            openTab(session.id, { kind: "query", title: `Query ${session.tabs.filter((t) => t.kind === "query").length + 1}`, sql: "" })
          }
          className="flex h-7 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-iris hover:bg-iris-soft"
        >
          <Plus className="size-3.5" /> New query <span className="ml-auto font-mono text-[10px] text-faint">⌘T</span>
        </button>
        <IconButton size="sm" label="Query history" onClick={() => openTab(session.id, { kind: "history", title: "History" })}>
          <Clock className="size-3.5" />
        </IconButton>
        <IconButton size="sm" label="Server activity" onClick={() => openTab(session.id, { kind: "activity", title: "Activity" })}>
          <Activity className="size-3.5" />
        </IconButton>
      </div>

      <div ref={menuAnchor} className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      <Popover anchor={menuAnchor.current} open={!!menu} onClose={() => setMenu(null)} className="w-56">
        {menu && (
          <>
            <MenuLabel>
              {menu.o.schema}.{menu.o.name}
            </MenuLabel>
            <MenuItem onClick={() => (setMenu(null), openObject(menu.o, false))}>Open</MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                openTab(session.id, {
                  kind: "table",
                  title: menu.o.name,
                  schema: menu.o.schema,
                  name: menu.o.name,
                  objectKind: menu.o.kind,
                  view: "structure",
                });
              }}
            >
              Open structure
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                openTab(session.id, {
                  kind: "query",
                  title: `Query · ${menu.o.name}`,
                  sql: `SELECT *\nFROM ${qualified(menu.o.schema, menu.o.name)}\nLIMIT 100;`,
                });
              }}
            >
              New query on this table
            </MenuItem>
            <MenuItem onClick={() => (setMenu(null), void copyText(qualified(menu.o.schema, menu.o.name)), toast("ok", "Copied name"))}>
              Copy qualified name
            </MenuItem>
          </>
        )}
      </Popover>
    </div>
  );
}
