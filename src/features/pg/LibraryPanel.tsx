import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bookmark, Clock, Play, Search, Trash2 } from "lucide-react";
import { IconButton, Input, Segmented, cx } from "../../components/ui";
import { clockTime, formatDuration, formatInt } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import type { HistoryEntry, SavedQuery } from "../../lib/types";
import { useApp } from "../../store/app";

export const HISTORY_EVENT = "5db:history-changed";
export const notifyHistory = () => window.dispatchEvent(new Event(HISTORY_EVENT));

export function useHistory(connectionId: string, search: string, limit = 300) {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setItems(await rpc<HistoryEntry[]>("history.list", { connectionId, search, limit }));
    } finally {
      setLoading(false);
    }
  }, [connectionId, search, limit]);
  useEffect(() => {
    const t = setTimeout(load, search ? 150 : 0);
    window.addEventListener(HISTORY_EVENT, load);
    return () => {
      clearTimeout(t);
      window.removeEventListener(HISTORY_EVENT, load);
    };
  }, [load, search]);
  return { items, loading, reload: load };
}

export function useSaved(connectionId: string) {
  const [items, setItems] = useState<SavedQuery[]>([]);
  const load = useCallback(async () => setItems(await rpc<SavedQuery[]>("saved.list", { connectionId })), [connectionId]);
  useEffect(() => {
    void load();
    window.addEventListener(HISTORY_EVENT, load);
    return () => window.removeEventListener(HISTORY_EVENT, load);
  }, [load]);
  return { items, reload: load };
}

export function HistoryRow({
  h,
  onUse,
  onRun,
  onDelete,
  compact,
}: {
  h: HistoryEntry;
  onUse: () => void;
  onRun: () => void;
  onDelete: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className="group relative cursor-default border-b border-line px-3 py-2 hover:bg-raised"
      onClick={onUse}
      onDoubleClick={onRun}
      title="Click to open in the editor · double-click to run"
    >
      <pre className={cx("overflow-hidden font-mono text-[11.5px] leading-snug whitespace-pre-wrap text-fg", compact ? "line-clamp-3" : "line-clamp-4")}>
        {h.sql.trim()}
      </pre>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-faint">
        <span>{clockTime(h.executedAt)}</span>
        <span>·</span>
        <span className="tabular">{formatDuration(h.durationMs)}</span>
        {h.error ? (
          <span className="flex min-w-0 items-center gap-1 text-danger">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="truncate">{h.error}</span>
          </span>
        ) : (
          h.rows != null && <span className="tabular">· {formatInt(h.rows)} {h.rows === 1 ? "row" : "rows"}</span>
        )}
        {!compact && h.database && <span className="ml-auto font-mono">{h.database}</span>}
      </div>
      <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 rounded-md bg-panel shadow-sm ring-1 ring-line group-hover:flex">
        <IconButton size="sm" label="Run again" onClick={(e) => (e.stopPropagation(), onRun())}>
          <Play className="size-3" />
        </IconButton>
        <IconButton size="sm" label="Remove from history" onClick={(e) => (e.stopPropagation(), onDelete())}>
          <Trash2 className="size-3" />
        </IconButton>
      </div>
    </div>
  );
}

export function LibraryPanel({
  connectionId,
  onUse,
  onRun,
}: {
  connectionId: string;
  onUse: (sql: string, saved?: SavedQuery) => void;
  onRun: (sql: string) => void;
}) {
  const [mode, setMode] = useState<"history" | "saved">("history");
  const [search, setSearch] = useState("");
  const history = useHistory(connectionId, search);
  const saved = useSaved(connectionId);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);

  const savedFiltered = saved.items.filter((q) => !search || `${q.name} ${q.sql}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-2">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "history", label: <span className="flex items-center gap-1"><Clock className="size-3" />History</span> },
            { value: "saved", label: <span className="flex items-center gap-1"><Bookmark className="size-3" />Saved · {saved.items.length}</span> },
          ]}
        />
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-faint" />
          <Input className="h-7 pl-7 text-xs" placeholder={mode === "history" ? "Search history" : "Search saved queries"} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "history" ? (
          history.items.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">{search ? "No query matches." : "Queries you run appear here, newest first."}</p>
          ) : (
            history.items.map((h) => (
              <HistoryRow
                key={h.id}
                h={h}
                compact
                onUse={() => onUse(h.sql)}
                onRun={() => onRun(h.sql)}
                onDelete={async () => {
                  await rpc("history.delete", { id: h.id });
                  void history.reload();
                }}
              />
            ))
          )
        ) : savedFiltered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted">{search ? "No saved query matches." : "Press ⌘S in the editor to save a query with a name."}</p>
        ) : (
          savedFiltered.map((q) => (
            <div
              key={q.id}
              className="group relative border-b border-line px-3 py-2 hover:bg-raised"
              onClick={() => onUse(q.sql, q)}
              onDoubleClick={() => onRun(q.sql)}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Bookmark className="size-3 text-iris" />
                <span className="truncate">{q.name}</span>
              </div>
              <pre className="mt-1 line-clamp-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{q.sql.trim()}</pre>
              <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 rounded-md bg-panel shadow-sm ring-1 ring-line group-hover:flex">
                <IconButton size="sm" label="Run" onClick={(e) => (e.stopPropagation(), onRun(q.sql))}>
                  <Play className="size-3" />
                </IconButton>
                <IconButton
                  size="sm"
                  label="Delete saved query"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await confirm({ title: `Delete “${q.name}”?`, confirmLabel: "Delete", danger: true }))) return;
                    try {
                      await rpc("saved.delete", { id: q.id });
                      void saved.reload();
                    } catch (err) {
                      toast("error", errorMessage(err));
                    }
                  }}
                >
                  <Trash2 className="size-3" />
                </IconButton>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
