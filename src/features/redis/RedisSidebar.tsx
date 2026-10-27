import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, Gauge, List, ListTree, Plus, RefreshCw, Search, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx, IconButton, Input, Select, Spinner } from "../../components/ui";
import { formatInt, formatTtl } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import type { RedisKey, RedisScanPage } from "../../lib/types";
import { type Session, useApp } from "../../store/app";
import { TypeBadge } from "./common";
import { NewKeyDialog } from "./NewKeyDialog";

type Node =
  | { kind: "folder"; path: string; label: string; depth: number; count: number; open: boolean }
  | { kind: "key"; k: RedisKey; label: string; depth: number };

function buildTree(keys: RedisKey[], expanded: Set<string>, sep = ":"): Node[] {
  interface F {
    children: Map<string, F>;
    keys: RedisKey[];
    count: number;
  }
  const root: F = { children: new Map(), keys: [], count: 0 };
  for (const k of keys) {
    const parts = k.key.split(sep);
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.get(parts[i]);
      if (!child) node.children.set(parts[i], (child = { children: new Map(), keys: [], count: 0 }));
      child.count++;
      node = child;
    }
    node.keys.push(k);
  }
  const out: Node[] = [];
  const collectFirst = (f: F): RedisKey | undefined => f.keys[0] ?? [...f.children.values()].map(collectFirst).find(Boolean);
  const walk = (f: F, prefix: string, depth: number) => {
    const folders = [...f.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, child] of folders) {
      const path = prefix + name + sep;
      // A namespace holding a single key reads better as the key itself.
      if (child.count === 1) {
        const only = child.keys[0] ?? collectFirst(child);
        if (only) {
          out.push({ kind: "key", k: only, label: only.key.slice(prefix.length), depth });
          continue;
        }
      }
      const open = expanded.has(path);
      out.push({ kind: "folder", path, label: name, depth, count: child.count, open });
      if (open) walk(child, path, depth + 1);
    }
    for (const k of [...f.keys].sort((a, b) => a.key.localeCompare(b.key)))
      out.push({ kind: "key", k, label: k.key.slice(prefix.length) || k.key, depth });
  };
  walk(root, "", 0);
  return out;
}

export function RedisSidebar({ session }: { session: Session }) {
  const openTab = useApp((s) => s.openTab);
  const switchDatabase = useApp((s) => s.switchDatabase);
  const toast = useApp((s) => s.toast);
  const [pattern, setPattern] = useState("");
  const [keyType, setKeyType] = useState("");
  const [keys, setKeys] = useState<RedisKey[]>([]);
  const [cursor, setCursor] = useState("0");
  const [done, setDone] = useState(false);
  const [dbSize, setDbSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"tree" | "list">(() => {
    try {
      return (localStorage.getItem("5db.redisMode") as "tree" | "list") || "tree";
    } catch {
      return "tree";
    }
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gen = useRef(0);
  const db = Number(session.database);

  const scan = useCallback(
    async (reset: boolean) => {
      const g = reset ? ++gen.current : gen.current;
      setLoading(true);
      try {
        const effective = pattern.trim() ? (/[*?[]/.test(pattern) ? pattern.trim() : `*${pattern.trim()}*`) : "*";
        const page = await rpc<RedisScanPage>("redis.scan", {
          connectionId: session.connectionId,
          db,
          cursor: reset ? "0" : cursor,
          pattern: effective,
          keyType: keyType || null,
          count: 1000,
        });
        if (g !== gen.current) return;
        setKeys((prev) => (reset ? page.keys : [...prev, ...page.keys.filter((k) => !prev.some((p) => p.key === k.key))]));
        setCursor(page.cursor);
        setDone(page.done);
        setDbSize(page.dbSize);
      } catch (e) {
        toast("error", errorMessage(e));
      } finally {
        if (g === gen.current) setLoading(false);
      }
    },
    [session.connectionId, db, cursor, pattern, keyType, toast],
  );

  useEffect(() => {
    if (session.status !== "ready") return;
    const t = setTimeout(() => void scan(true), pattern ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, keyType, session.keysVersion, session.status, db]);

  useEffect(() => {
    try {
      localStorage.setItem("5db.redisMode", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const nodes: Node[] = useMemo(
    () =>
      mode === "tree" && !pattern
        ? buildTree(keys, expanded)
        : [...keys].sort((a, b) => a.key.localeCompare(b.key)).map((k) => ({ kind: "key" as const, k, label: k.key, depth: 0 })),
    [keys, expanded, mode, pattern],
  );

  const v = useVirtualizer({ count: nodes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 26, overscan: 20 });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || done || loading) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) void scan(false);
  };

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId);
  const activeKey = activeTab?.kind === "redis-key" ? activeTab.key : null;
  const keyspace = session.redisInfo?.sections.keyspace ?? {};
  const dbCount = session.redisInfo?.databases ?? 16;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
        <Select
          className="h-7 flex-1 text-xs"
          value={db}
          onChange={(e) => void switchDatabase(session.id, e.target.value)}
          aria-label="Database"
        >
          {Array.from({ length: dbCount }, (_, i) => {
            const ks = keyspace[`db${i}`];
            const n = ks ? /keys=(\d+)/.exec(ks)?.[1] : null;
            return (
              <option key={i} value={i}>
                db{i}
                {n ? ` · ${formatInt(Number(n))} keys` : ""}
              </option>
            );
          })}
        </Select>
        <IconButton size="sm" label="New key" onClick={() => setNewOpen(true)}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton size="sm" label="Rescan" onClick={() => void scan(true)}>
          <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
        </IconButton>
      </div>
      <div className="flex shrink-0 gap-1 px-2 pb-1">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-faint" />
          <Input
            className="h-7 pr-6 pl-7 font-mono text-xs"
            placeholder="user:* or any text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          {pattern && (
            <button
              type="button"
              className="absolute top-2 right-2 text-faint hover:text-fg"
              onClick={() => setPattern("")}
              aria-label="Clear pattern"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <Select className="h-6 flex-1 py-0 text-xs" value={keyType} onChange={(e) => setKeyType(e.target.value)} aria-label="Key type">
          <option value="">All types</option>
          <option value="string">Strings</option>
          <option value="hash">Hashes</option>
          <option value="list">Lists</option>
          <option value="set">Sets</option>
          <option value="zset">Sorted sets</option>
          <option value="stream">Streams</option>
        </Select>
        <IconButton size="sm" label="Group by namespace" active={mode === "tree"} onClick={() => setMode("tree")}>
          <ListTree className="size-3.5" />
        </IconButton>
        <IconButton size="sm" label="Flat list" active={mode === "list"} onClick={() => setMode("list")}>
          <List className="size-3.5" />
        </IconButton>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto px-1.5">
        {keys.length === 0 && !loading ? (
          <p className="px-3 py-4 text-xs text-muted">
            {pattern || keyType ? "No key matches." : "This database is empty. Add a key with +."}
          </p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const n = nodes[vi.index];
              const style = { position: "absolute" as const, top: vi.start, left: 0, right: 0, height: 26, paddingLeft: 8 + n.depth * 14 };
              if (n.kind === "folder")
                return (
                  <button
                    type="button"
                    key={vi.key}
                    style={style}
                    className="flex items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-muted hover:bg-raised hover:text-fg"
                    onClick={() =>
                      setExpanded((s) => {
                        const next = new Set(s);
                        if (next.has(n.path)) next.delete(n.path);
                        else next.add(n.path);
                        return next;
                      })
                    }
                  >
                    {n.open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                    <Folder className="size-3.5 shrink-0 text-faint" />
                    <span className="truncate font-mono">{n.label}</span>
                    <span className="ml-auto font-mono text-[10px] text-faint">{formatInt(n.count)}</span>
                  </button>
                );
              return (
                <button
                  type="button"
                  key={vi.key}
                  style={style}
                  title={n.k.key}
                  onClick={() => openTab(session.id, { kind: "redis-key", title: n.k.key, key: n.k.key }, { preview: true })}
                  onDoubleClick={() => openTab(session.id, { kind: "redis-key", title: n.k.key, key: n.k.key })}
                  className={cx(
                    "flex items-center gap-2 rounded-md pr-2 text-left",
                    activeKey === n.k.key ? "bg-iris-soft" : "hover:bg-raised",
                  )}
                >
                  <TypeBadge type={n.k.type} />
                  <span className="truncate font-mono text-[12px]">{n.label}</span>
                  {n.k.ttlMs >= 0 && <span className="ml-auto shrink-0 font-mono text-[10px] text-warn">{formatTtl(n.k.ttlMs)}</span>}
                </button>
              );
            })}
          </div>
        )}
        {loading && (
          <div className="flex justify-center py-2">
            <Spinner className="size-3.5" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-1 text-[11px] text-faint">
        {formatInt(keys.length)} {done ? "" : "loaded "}of {formatInt(dbSize)} keys
        {!done && !loading && (
          <button type="button" className="ml-2 text-iris hover:underline" onClick={() => void scan(false)}>
            Load more
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-t border-line p-1.5">
        <button
          type="button"
          onClick={() => openTab(session.id, { kind: "redis-console", title: "Console" })}
          className="flex h-7 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-iris hover:bg-iris-soft"
        >
          <Terminal className="size-3.5" /> Console
        </button>
        <IconButton size="sm" label="Server info" onClick={() => openTab(session.id, { kind: "redis-info", title: "Server" })}>
          <Gauge className="size-3.5" />
        </IconButton>
      </div>
      <NewKeyDialog open={newOpen} onClose={() => setNewOpen(false)} session={session} />
    </div>
  );
}
