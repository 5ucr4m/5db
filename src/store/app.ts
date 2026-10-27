import { create } from "zustand";
import { uid } from "../lib/format";
import { errorMessage, rpc } from "../lib/rpc";
import type { ConnectionConfig, Filter, ObjectKind, PgObjects, PgServerInfo, RedisInfo } from "../lib/types";

export type Tab =
  | {
      id: string;
      kind: "table";
      title: string;
      schema: string;
      name: string;
      objectKind: ObjectKind;
      preview?: boolean;
      initialFilters?: Filter[];
      view?: "data" | "structure" | "ddl";
    }
  | { id: string; kind: "query"; title: string; sql?: string; savedId?: string; autorun?: boolean }
  | { id: string; kind: "function"; title: string; schema: string; name: string; oid: number; preview?: boolean }
  | { id: string; kind: "activity"; title: string }
  | { id: string; kind: "history"; title: string }
  | { id: string; kind: "redis-key"; title: string; key: string; preview?: boolean }
  | { id: string; kind: "redis-console"; title: string }
  | { id: string; kind: "redis-info"; title: string };

type TabInput = Tab extends infer T ? (T extends Tab ? Omit<T, "id"> : never) : never;

export interface CompletionTable {
  schema: string;
  table: string;
  columns: string[];
}

export interface Session {
  id: string;
  connectionId: string;
  kind: "postgres" | "redis";
  /** Postgres database name, or the Redis db index as a string. */
  database: string;
  status: "connecting" | "ready" | "error";
  error?: string;
  pgInfo?: PgServerInfo;
  redisInfo?: RedisInfo;
  objects?: PgObjects;
  objectsLoading?: boolean;
  completion?: CompletionTable[];
  tabs: Tab[];
  activeTabId: string | null;
  /** Bumps whenever the Redis key list should reload. */
  keysVersion: number;
}

export interface Toast {
  id: string;
  kind: "ok" | "error" | "info";
  message: string;
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export type Theme = "system" | "light" | "dark";

interface AppStore {
  connections: ConnectionConfig[];
  connectionsLoaded: boolean;
  sessions: Session[];
  activeSessionId: string | null;
  toasts: Toast[];
  confirmRequest: ConfirmRequest | null;
  paletteOpen: boolean;
  theme: Theme;

  loadConnections(): Promise<void>;
  saveConnection(c: ConnectionConfig): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  reorderConnections(ids: string[]): Promise<void>;

  openSession(connectionId: string): Promise<void>;
  closeSession(id: string): void;
  setActiveSession(id: string | null): void;
  switchDatabase(sessionId: string, database: string): Promise<void>;
  refreshObjects(sessionId: string): Promise<void>;
  bumpKeys(sessionId: string): void;

  openTab(sessionId: string, tab: TabInput, opts?: { preview?: boolean }): string;
  closeTab(sessionId: string, tabId: string): void;
  closeOtherTabs(sessionId: string, tabId: string): void;
  setActiveTab(sessionId: string, tabId: string): void;
  updateTab(sessionId: string, tabId: string, patch: Partial<Tab>): void;
  pinTab(sessionId: string, tabId: string): void;

  toast(kind: Toast["kind"], message: string): void;
  dismissToast(id: string): void;
  confirm(req: Omit<ConfirmRequest, "resolve">): Promise<boolean>;
  resolveConfirm(ok: boolean): void;
  setPaletteOpen(open: boolean): void;
  setTheme(t: Theme): void;
}

export const sessionFor = (sessions: Session[], id: string | null) => sessions.find((s) => s.id === id);

function tabKey(t: TabInput | Tab): string | null {
  switch (t.kind) {
    case "table":
      return `table:${t.schema}.${t.name}`;
    case "function":
      return `fn:${t.oid}`;
    case "redis-key":
      return `key:${t.key}`;
    case "activity":
    case "history":
    case "redis-console":
    case "redis-info":
      return t.kind;
    default:
      return null;
  }
}

function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export const useApp = create<AppStore>((set, get) => {
  const patchSession = (id: string, patch: Partial<Session> | ((s: Session) => Partial<Session>)) =>
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id === id ? { ...s, ...(typeof patch === "function" ? patch(s) : patch) } : s)),
    }));

  const connectSession = async (session: Session) => {
    patchSession(session.id, { status: "connecting", error: undefined });
    try {
      if (session.kind === "postgres") {
        const info = await rpc<PgServerInfo>("pg.connect", { connectionId: session.connectionId, database: session.database });
        patchSession(session.id, { status: "ready", pgInfo: info, database: info.database });
        await get().refreshObjects(session.id);
      } else {
        const info = await rpc<RedisInfo>("redis.connect", { connectionId: session.connectionId, db: Number(session.database) });
        patchSession(session.id, (s) => ({
          status: "ready",
          redisInfo: info,
          tabs: s.tabs.length ? s.tabs : [{ id: uid(), kind: "redis-console", title: "Console" }],
        }));
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === session.id && !s.activeTabId ? { ...s, activeTabId: s.tabs[0]?.id ?? null } : s)),
        }));
      }
    } catch (e) {
      patchSession(session.id, { status: "error", error: errorMessage(e) });
    }
  };

  return {
    connections: [],
    connectionsLoaded: false,
    sessions: [],
    activeSessionId: null,
    toasts: [],
    confirmRequest: null,
    paletteOpen: false,
    theme:
      ((() => {
        try {
          return localStorage.getItem("5db.theme");
        } catch {
          return null;
        }
      })() as Theme) || "system",

    async loadConnections() {
      try {
        const list = await rpc<ConnectionConfig[]>("connections.list");
        set({ connections: list, connectionsLoaded: true });
      } catch (e) {
        set({ connectionsLoaded: true });
        get().toast("error", errorMessage(e));
      }
    },
    async saveConnection(c) {
      const saved = await rpc<ConnectionConfig>("connections.save", c as unknown as Record<string, unknown>);
      set((st) => {
        const exists = st.connections.some((x) => x.id === saved.id);
        return { connections: exists ? st.connections.map((x) => (x.id === saved.id ? saved : x)) : [...st.connections, saved] };
      });
      // An edited connection reconnects with its new settings.
      const open = get().sessions.find((s) => s.connectionId === saved.id);
      if (open) void connectSession({ ...open, database: saved.kind === "redis" ? String(saved.redisDb) : saved.database });
      return saved;
    },
    async deleteConnection(id) {
      await rpc("connections.delete", { id });
      set((st) => ({
        connections: st.connections.filter((c) => c.id !== id),
        sessions: st.sessions.filter((s) => s.connectionId !== id),
        activeSessionId: st.sessions.find((s) => s.id === st.activeSessionId)?.connectionId === id ? null : st.activeSessionId,
      }));
    },
    async reorderConnections(ids) {
      set((st) => ({ connections: ids.map((id) => st.connections.find((c) => c.id === id)!).filter(Boolean) }));
      await rpc("connections.reorder", { ids });
    },

    async openSession(connectionId) {
      const existing = get().sessions.find((s) => s.connectionId === connectionId);
      if (existing) {
        set({ activeSessionId: existing.id });
        if (existing.status === "error") void connectSession(existing);
        return;
      }
      const conn = get().connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const session: Session = {
        id: uid(),
        connectionId,
        kind: conn.kind,
        database: conn.kind === "redis" ? String(conn.redisDb ?? 0) : conn.database,
        status: "connecting",
        tabs: [],
        activeTabId: null,
        keysVersion: 0,
      };
      set((st) => ({ sessions: [...st.sessions, session], activeSessionId: session.id }));
      set((st) => ({
        connections: st.connections.map((c) => (c.id === connectionId ? { ...c, lastUsedAt: new Date().toISOString() } : c)),
      }));
      await connectSession(session);
    },
    closeSession(id) {
      const s = get().sessions.find((x) => x.id === id);
      if (s) void rpc("connections.disconnect", { id: s.connectionId }).catch(() => {});
      set((st) => {
        const idx = st.sessions.findIndex((x) => x.id === id);
        const sessions = st.sessions.filter((x) => x.id !== id);
        const activeSessionId = st.activeSessionId === id ? (sessions[Math.min(idx, sessions.length - 1)]?.id ?? null) : st.activeSessionId;
        return { sessions, activeSessionId };
      });
    },
    setActiveSession(id) {
      set({ activeSessionId: id });
    },
    async switchDatabase(sessionId, database) {
      const s = get().sessions.find((x) => x.id === sessionId);
      if (!s || s.database === database) return;
      // Tabs belong to a database; start clean in the new one.
      const next: Session = {
        ...s,
        database,
        tabs: s.kind === "redis" ? s.tabs.filter((t) => t.kind !== "redis-key") : [],
        activeTabId: null,
        objects: undefined,
        completion: undefined,
        keysVersion: s.keysVersion + 1,
      };
      if (s.kind === "redis") next.activeTabId = next.tabs[0]?.id ?? null;
      patchSession(sessionId, next);
      await connectSession(next);
    },
    async refreshObjects(sessionId) {
      const s = get().sessions.find((x) => x.id === sessionId);
      if (!s || s.kind !== "postgres") return;
      patchSession(sessionId, { objectsLoading: true });
      try {
        const params = { connectionId: s.connectionId, database: s.database };
        const [objects, completion] = await Promise.all([
          rpc<PgObjects>("pg.objects", params),
          rpc<CompletionTable[]>("pg.completion", params),
        ]);
        patchSession(sessionId, { objects, completion, objectsLoading: false });
      } catch (e) {
        patchSession(sessionId, { objectsLoading: false });
        get().toast("error", errorMessage(e));
      }
    },
    bumpKeys(sessionId) {
      patchSession(sessionId, (s) => ({ keysVersion: s.keysVersion + 1 }));
    },

    openTab(sessionId, input, opts) {
      const s = get().sessions.find((x) => x.id === sessionId);
      if (!s) return "";
      const key = tabKey(input);
      const existing = key ? s.tabs.find((t) => tabKey(t) === key) : undefined;
      if (existing) {
        const patch: Partial<Tab> = { ...(input as Partial<Tab>) };
        if (!opts?.preview) (patch as { preview?: boolean }).preview = false;
        else delete (patch as { preview?: boolean }).preview;
        patchSession(sessionId, {
          tabs: s.tabs.map((t) => (t.id === existing.id ? ({ ...t, ...patch } as Tab) : t)),
          activeTabId: existing.id,
        });
        return existing.id;
      }
      const tab = { ...input, id: uid(), ...(opts?.preview ? { preview: true } : {}) } as Tab;
      // A preview tab is replaced by the next preview, like a file browser.
      const previewIdx = opts?.preview ? s.tabs.findIndex((t) => "preview" in t && t.preview) : -1;
      let tabs: Tab[];
      if (previewIdx >= 0) {
        tabs = [...s.tabs];
        tabs[previewIdx] = tab;
      } else {
        const activeIdx = s.tabs.findIndex((t) => t.id === s.activeTabId);
        tabs = [...s.tabs];
        tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab);
      }
      patchSession(sessionId, { tabs, activeTabId: tab.id });
      return tab.id;
    },
    closeTab(sessionId, tabId) {
      patchSession(sessionId, (s) => {
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        const tabs = s.tabs.filter((t) => t.id !== tabId);
        const activeTabId = s.activeTabId === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId;
        return { tabs, activeTabId };
      });
    },
    closeOtherTabs(sessionId, tabId) {
      patchSession(sessionId, (s) => ({ tabs: s.tabs.filter((t) => t.id === tabId), activeTabId: tabId }));
    },
    setActiveTab(sessionId, tabId) {
      patchSession(sessionId, { activeTabId: tabId });
    },
    updateTab(sessionId, tabId, patch) {
      patchSession(sessionId, (s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as Tab) : t)) }));
    },
    pinTab(sessionId, tabId) {
      patchSession(sessionId, (s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId && "preview" in t && t.preview ? ({ ...t, preview: false } as Tab) : t)),
      }));
    },

    toast(kind, message) {
      const id = uid();
      set((st) => ({ toasts: [...st.toasts.slice(-3), { id, kind, message }] }));
      setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3000);
    },
    dismissToast(id) {
      set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
    },
    confirm(req) {
      return new Promise<boolean>((resolve) => set({ confirmRequest: { ...req, resolve } }));
    },
    resolveConfirm(ok) {
      get().confirmRequest?.resolve(ok);
      set({ confirmRequest: null });
    },
    setPaletteOpen(open) {
      set({ paletteOpen: open });
    },
    setTheme(t) {
      try {
        localStorage.setItem("5db.theme", t);
      } catch {
        /* storage may be unavailable */
      }
      applyTheme(t);
      set({ theme: t });
    },
  };
});

if (typeof window !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (useApp.getState().theme === "system") applyTheme("system");
  });
}

export function useActiveSession(): Session | undefined {
  return useApp((st) => st.sessions.find((s) => s.id === st.activeSessionId));
}

export function useConnection(id: string | undefined): ConnectionConfig | undefined {
  return useApp((st) => st.connections.find((c) => c.id === id));
}
