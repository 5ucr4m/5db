import {
  Activity,
  Bookmark,
  Clock,
  Database,
  Download,
  Eye,
  FileCode2,
  Home,
  KeyRound,
  Layers,
  Moon,
  Plus,
  Search,
  Table2,
  Terminal,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx, Kbd } from "../../components/ui";
import { rpc } from "../../lib/rpc";
import type { SavedQuery } from "../../lib/types";
import { checkForUpdate } from "../../lib/updater";
import { useApp } from "../../store/app";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: ReactNode;
  run: () => void;
}

/** Subsequence match with a bonus for word starts and contiguous runs. */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 || /[\s._:/-]/.test(t[direct - 1]) ? 200 : 0);
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    // Jumps are only allowed onto word starts, so "ord" does not match "shop production".
    const wordStart = found === 0 || /[\s._:/(-]/.test(t[found - 1]);
    if (ti > 0 && found > ti && !wordStart) return -1;
    run = found === ti ? run + 1 : 0;
    s += 10 + run * 5 - (found - ti);
    ti = found + 1;
  }
  return s;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeSessionId);
  const connections = useApp((s) => s.connections);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const session = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useApp.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    if (session)
      rpc<SavedQuery[]>("saved.list", { connectionId: session.connectionId })
        .then(setSaved)
        .catch(() => setSaved([]));
  }, [open, session]);

  const items = useMemo<Item[]>(() => {
    const st = useApp.getState();
    const out: Item[] = [];
    if (session?.kind === "postgres") {
      const sid = session.id;
      out.push({
        id: "new-query",
        label: "New SQL query",
        group: "Actions",
        icon: <Plus className="size-4" />,
        hint: "⌘T",
        run: () => st.openTab(sid, { kind: "query", title: `Query ${session.tabs.filter((t) => t.kind === "query").length + 1}`, sql: "" }),
      });
      out.push({
        id: "history",
        label: "Query history",
        group: "Actions",
        icon: <Clock className="size-4" />,
        run: () => st.openTab(sid, { kind: "history", title: "History" }),
      });
      out.push({
        id: "activity",
        label: "Server activity",
        group: "Actions",
        icon: <Activity className="size-4" />,
        run: () => st.openTab(sid, { kind: "activity", title: "Activity" }),
      });
      for (const o of session.objects?.objects ?? []) {
        const Icon = o.kind === "view" ? Eye : o.kind === "matview" ? Layers : Table2;
        out.push({
          id: `t:${o.schema}.${o.name}`,
          label: o.schema === "public" ? o.name : `${o.schema}.${o.name}`,
          hint: o.kind === "table" ? undefined : o.kind,
          group: "Tables and views",
          icon: <Icon className="size-4" />,
          run: () => st.openTab(sid, { kind: "table", title: o.name, schema: o.schema, name: o.name, objectKind: o.kind }),
        });
      }
      for (const f of session.objects?.functions ?? [])
        out.push({
          id: `f:${f.oid}`,
          label: `${f.name}(${f.args})`,
          group: "Functions",
          icon: <FileCode2 className="size-4" />,
          run: () => st.openTab(sid, { kind: "function", title: f.name, schema: f.schema, name: f.name, oid: f.oid }),
        });
      for (const sq of saved)
        out.push({
          id: `s:${sq.id}`,
          label: sq.name,
          group: "Saved queries",
          icon: <Bookmark className="size-4" />,
          run: () => st.openTab(sid, { kind: "query", title: sq.name, sql: sq.sql, savedId: sq.id }),
        });
    }
    if (session?.kind === "redis") {
      const sid = session.id;
      out.push({
        id: "console",
        label: "Redis console",
        group: "Actions",
        icon: <Terminal className="size-4" />,
        run: () => st.openTab(sid, { kind: "redis-console", title: "Console" }),
      });
      out.push({
        id: "info",
        label: "Server info",
        group: "Actions",
        icon: <Activity className="size-4" />,
        run: () => st.openTab(sid, { kind: "redis-info", title: "Server" }),
      });
      if (q.trim() && !q.includes(" "))
        out.push({
          id: "open-key",
          label: `Open key “${q.trim()}”`,
          group: "Actions",
          icon: <KeyRound className="size-4" />,
          run: () => st.openTab(sid, { kind: "redis-key", title: q.trim(), key: q.trim() }),
        });
    }
    for (const c of connections)
      out.push({
        id: `c:${c.id}`,
        label: c.name,
        hint: c.env,
        group: "Connections",
        icon: c.kind === "postgres" ? <Database className="size-4" /> : <Zap className="size-4" />,
        run: () => void st.openSession(c.id),
      });
    out.push({
      id: "home",
      label: "All connections",
      group: "App",
      icon: <Home className="size-4" />,
      run: () => st.setActiveSession(null),
    });
    out.push({
      id: "theme",
      label: `Switch theme (now ${st.theme})`,
      group: "App",
      icon: <Moon className="size-4" />,
      run: () => st.setTheme(st.theme === "dark" ? "light" : st.theme === "light" ? "system" : "dark"),
    });
    out.push({
      id: "update",
      label: "Check for updates",
      group: "App",
      icon: <Download className="size-4" />,
      run: () => void checkForUpdate({ silent: false }),
    });
    return out;
  }, [session, saved, connections, q]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items.filter((i) => i.group !== "Functions").slice(0, 60);
    return items
      .map((i) => ({ i, s: score(i.label, query) }))
      .filter((x) => x.s > 0 || x.i.id === "open-key")
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.i);
  }, [items, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  if (!open) return null;
  const choose = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    it.run();
  };

  let lastGroup = "";
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[14vh] animate-fade-in"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-[600px] max-w-[calc(100vw-32px)] animate-slide-up overflow-hidden rounded-xl bg-panel shadow-[var(--shadow-pop)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-faint" />
          <input
            autoFocus
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              session?.kind === "postgres"
                ? "Jump to a table, saved query or action"
                : session?.kind === "redis"
                  ? "Type a key name or an action"
                  : "Open a connection"
            }
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(filtered[idx]);
              } else if (e.key === "Escape") setOpen(false);
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-auto p-1.5">
          {filtered.length === 0 && <div className="p-6 text-center text-sm text-muted">Nothing matches “{q}”.</div>}
          {filtered.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-2xs font-semibold tracking-wider text-faint uppercase">{header}</div>}
                <button
                  type="button"
                  data-idx={i}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => choose(it)}
                  className={cx(
                    "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm",
                    i === idx ? "bg-iris text-on-iris" : "text-fg",
                  )}
                >
                  <span className={i === idx ? "text-on-iris" : "text-muted"}>{it.icon}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className={cx("text-xs", i === idx ? "text-on-iris/80" : "text-faint")}>{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
