import {
  Activity,
  Clock,
  Eye,
  FileCode2,
  Gauge,
  Globe,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  ShieldAlert,
  Table2,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, cx, EmptyState, Kbd, MenuItem, Popover, Resizer, Spinner, useResizable } from "../../components/ui";
import { connectionSummary, ENV_META } from "../../lib/connections";
import { type Session, type Tab, useApp, useConnection } from "../../store/app";
import { ActivityTab, FunctionTab, HistoryTab } from "../pg/MiscTabs";
import { PgSidebar } from "../pg/PgSidebar";
import { QueryTab } from "../pg/QueryTab";
import { TableTab } from "../pg/TableTab";
import { ConsoleTab } from "../redis/ConsoleTab";
import { InfoTab } from "../redis/InfoTab";
import { KeyTab } from "../redis/KeyTab";
import { RedisSidebar } from "../redis/RedisSidebar";

function tabIcon(t: Tab) {
  switch (t.kind) {
    case "table":
      return t.objectKind === "view" ? Eye : t.objectKind === "matview" ? Layers : t.objectKind === "foreign" ? Globe : Table2;
    case "query":
      return FileCode2;
    case "function":
      return FileCode2;
    case "history":
      return Clock;
    case "activity":
      return Activity;
    case "redis-key":
      return KeyRound;
    case "redis-console":
      return Terminal;
    case "redis-info":
      return Gauge;
  }
}

export function Workspace({ session, visible }: { session: Session; visible: boolean }) {
  const conn = useConnection(session.connectionId);
  const openSession = useApp((s) => s.openSession);
  const [sideW, setSideW] = useResizable("sidebar", 264, 200, 480);
  const dragStart = useRef(0);
  useWorkspaceShortcuts(session, visible);

  if (!conn) return null;
  const env = ENV_META[conn.env] ?? ENV_META.local;

  return (
    <div className={cx("h-full min-w-0 flex-1 flex-col overflow-hidden", visible ? "flex" : "hidden")}>
      <div
        className={cx("h-[3px] shrink-0", conn.env === "prod" && "env-stripe-prod")}
        style={conn.env === "prod" ? undefined : { background: env.color, opacity: conn.env === "local" ? 0.5 : 1 }}
      />
      <div className="flex min-h-0 flex-1">
        <aside style={{ width: sideW }} className="flex shrink-0 flex-col bg-panel">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: conn.color }} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[14px] leading-tight font-semibold">{conn.name}</div>
              <div className="truncate font-mono text-[10.5px] text-faint">{connectionSummary(conn)}</div>
            </div>
            <span
              className={cx(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase",
                conn.env === "prod" && "text-white",
              )}
              style={
                conn.env === "prod"
                  ? { background: env.color }
                  : { color: env.color, background: `color-mix(in srgb, ${env.color} 14%, transparent)` }
              }
            >
              {conn.env === "prod" ? "prod" : env.label}
            </span>
          </div>
          {conn.readOnly && (
            <div className="flex items-center gap-1.5 border-b border-line bg-info/[0.07] px-3 py-1 text-[11px] text-info">
              <ShieldAlert className="size-3" /> Read-only session
            </div>
          )}
          <div className="min-h-0 flex-1">
            {session.status === "ready" ? (
              session.kind === "postgres" ? (
                <PgSidebar session={session} />
              ) : (
                <RedisSidebar session={session} />
              )
            ) : session.status === "connecting" ? (
              <div className="flex justify-center p-8">
                <Spinner />
              </div>
            ) : null}
          </div>
        </aside>
        <Resizer
          direction="x"
          onResize={(d, phase) => {
            if (phase === "start") dragStart.current = sideW;
            else setSideW(Math.max(200, Math.min(480, dragStart.current + d)));
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col bg-ink">
          {session.status === "error" ? (
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title={`Could not connect to ${conn.name}`}
              action={
                <Button variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={() => openSession(conn.id)}>
                  Try again
                </Button>
              }
            >
              <span className="selectable font-mono text-xs break-words">{session.error}</span>
            </EmptyState>
          ) : session.status === "connecting" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
              <Spinner className="size-5" />
              Connecting to {connectionSummary(conn)}…
            </div>
          ) : (
            <>
              <TabBar session={session} />
              <div className="relative min-h-0 flex-1">
                {session.tabs.map((t) => (
                  <div key={t.id} className={cx("absolute inset-0", t.id === session.activeTabId ? "block" : "hidden")}>
                    <TabContent session={session} tab={t} active={visible && t.id === session.activeTabId} />
                  </div>
                ))}
                {session.tabs.length === 0 && <NoTabs session={session} />}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function TabContent({ session, tab, active }: { session: Session; tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "table":
      return <TableTab session={session} tab={tab} active={active} />;
    case "query":
      return <QueryTab session={session} tab={tab} active={active} />;
    case "function":
      return <FunctionTab session={session} tab={tab} />;
    case "history":
      return <HistoryTab session={session} />;
    case "activity":
      return <ActivityTab session={session} active={active} />;
    case "redis-key":
      return <KeyTab key={tab.key} session={session} tab={tab} />;
    case "redis-console":
      return <ConsoleTab session={session} active={active} />;
    case "redis-info":
      return <InfoTab session={session} active={active} />;
  }
}

function NoTabs({ session }: { session: Session }) {
  const openTab = useApp((s) => s.openTab);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const tables = session.objects?.objects.length ?? 0;
  return (
    <EmptyState
      icon={<Table2 className="size-5" />}
      title={session.kind === "postgres" ? `${session.database} is open` : "Pick a key"}
      action={
        <div className="flex flex-col items-center gap-3">
          {session.kind === "postgres" && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => openTab(session.id, { kind: "query", title: "Query 1", sql: "" })}
              kbd="⌘T"
            >
              New query
            </Button>
          )}
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setPaletteOpen(true)}>
            Jump to anything with <Kbd>⌘K</Kbd>
          </button>
        </div>
      }
    >
      {session.kind === "postgres"
        ? `Choose one of ${tables} tables and views on the left, or write SQL.`
        : "Select a key on the left to see and edit its value, or open the console."}
    </EmptyState>
  );
}

function TabBar({ session }: { session: Session }) {
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.closeTab);
  const closeOthers = useApp((s) => s.closeOtherTabs);
  const pinTab = useApp((s) => s.pinTab);
  const openTab = useApp((s) => s.openTab);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [session.activeTabId]);

  const newTab = () =>
    session.kind === "postgres"
      ? openTab(session.id, { kind: "query", title: `Query ${session.tabs.filter((t) => t.kind === "query").length + 1}`, sql: "" })
      : openTab(session.id, { kind: "redis-console", title: "Console" });

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
      <div ref={scroller} className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
        {session.tabs.map((t) => {
          const Icon = tabIcon(t);
          const active = t.id === session.activeTabId;
          const preview = "preview" in t && t.preview;
          return (
            <div
              key={t.id}
              data-active={active}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(session.id, t.id);
                } else if (e.button === 0) setActiveTab(session.id, t.id);
              }}
              onDoubleClick={() => pinTab(session.id, t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: t.id });
              }}
              title={t.kind === "table" ? `${t.schema}.${t.name}` : t.title}
              className={cx(
                "group relative flex max-w-[220px] min-w-[110px] cursor-default items-center gap-1.5 border-r border-line pr-1 pl-3 text-[12.5px]",
                active ? "bg-ink text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-iris" />}
              <Icon className={cx("size-3.5 shrink-0", active ? "text-iris" : "text-faint")} />
              <span className={cx("min-w-0 flex-1 truncate", preview && "italic")}>{t.title}</span>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(session.id, t.id)}
                className={cx(
                  "flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-raised hover:text-fg",
                  !active && "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={newTab}
        title={session.kind === "postgres" ? "New query (⌘T)" : "Open console"}
        className="flex w-9 shrink-0 items-center justify-center border-l border-line text-muted hover:bg-raised hover:text-fg"
      >
        <Plus className="size-4" />
      </button>
      <div ref={anchor} className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      <Popover anchor={anchor.current} open={!!menu} onClose={() => setMenu(null)} className="w-48">
        {menu && (
          <>
            <MenuItem onClick={() => (closeTab(session.id, menu.id), setMenu(null))} kbd="⌘W">
              Close
            </MenuItem>
            <MenuItem onClick={() => (closeOthers(session.id, menu.id), setMenu(null))}>Close others</MenuItem>
            <MenuItem onClick={() => (pinTab(session.id, menu.id), setMenu(null))}>Keep open</MenuItem>
          </>
        )}
      </Popover>
    </div>
  );
}

function useWorkspaceShortcuts(session: Session, visible: boolean) {
  const ref = useRef(session);
  ref.current = session;
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const s = ref.current;
      const st = useApp.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.ctrlKey && e.key === "Tab") e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        if (s.kind === "postgres")
          st.openTab(s.id, { kind: "query", title: `Query ${s.tabs.filter((t) => t.kind === "query").length + 1}`, sql: "" });
        else st.openTab(s.id, { kind: "redis-console", title: "Console" });
      } else if (k === "w") {
        e.preventDefault();
        if (s.activeTabId) st.closeTab(s.id, s.activeTabId);
      } else if (/^[1-9]$/.test(k)) {
        const t = s.tabs[k === "9" ? s.tabs.length - 1 : Number(k) - 1];
        if (t) {
          e.preventDefault();
          st.setActiveTab(s.id, t.id);
        }
      } else if ((e.shiftKey && (k === "]" || k === "}")) || (e.ctrlKey && e.key === "Tab" && !e.shiftKey)) {
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const t = s.tabs[(i + 1) % s.tabs.length];
        if (t) {
          e.preventDefault();
          st.setActiveTab(s.id, t.id);
        }
      } else if ((e.shiftKey && (k === "[" || k === "{")) || (e.ctrlKey && e.key === "Tab" && e.shiftKey)) {
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const t = s.tabs[(i - 1 + s.tabs.length) % s.tabs.length];
        if (t) {
          e.preventDefault();
          st.setActiveTab(s.id, t.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);
}
