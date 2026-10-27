import { Eraser } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx, IconButton } from "../../components/ui";
import { formatDuration } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import { type Session, useApp } from "../../store/app";
import { useHistory } from "../pg/LibraryPanel";
import { formatReply, isWriteCommand } from "./common";

interface Entry {
  id: number;
  line: string;
  output: string;
  error: boolean;
  ms: number;
}

export function ConsoleTab({ session, active }: { session: Session; active: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const bumpKeys = useApp((s) => s.bumpKeys);
  const { items: history, reload } = useHistory(session.connectionId, "", 200);
  const past = history.filter((h) => h.kind === "redis").map((h) => h.sql);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const submit = async () => {
    const text = line.trim();
    if (!text || busy) return;
    if (/^clear$/i.test(text)) {
      setEntries([]);
      setLine("");
      return;
    }
    setBusy(true);
    setLine("");
    setCursor(-1);
    const started = performance.now();
    try {
      const r = await rpc<{ value: unknown; durationMs: number }>("redis.console", {
        connectionId: session.connectionId,
        db: Number(session.database),
        line: text,
      });
      setEntries((e) => [...e, { id: Date.now(), line: text, output: formatReply(r.value), error: false, ms: r.durationMs }]);
      if (isWriteCommand(text)) bumpKeys(session.id);
    } catch (e) {
      setEntries((prev) => [
        ...prev,
        { id: Date.now(), line: text, output: `(error) ${errorMessage(e)}`, error: true, ms: performance.now() - started },
      ]);
    } finally {
      setBusy(false);
      void reload();
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-sunken font-mono text-[12.5px]"
      onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 font-sans text-xs text-muted">
        <span>
          Connected to <b className="font-semibold text-fg">db{session.database}</b>. ↑ ↓ walk through your history.{" "}
          <span className="font-mono">clear</span> empties the screen.
        </span>
        <IconButton size="sm" className="ml-auto" label="Clear screen" onClick={() => setEntries([])}>
          <Eraser className="size-3.5" />
        </IconButton>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto px-4 py-3">
        {entries.length === 0 && <div className="text-faint">Try PING, INFO memory, HGETALL user:1 or SCAN 0 MATCH session:* COUNT 20</div>}
        {entries.map((e) => (
          <div key={e.id} className="mb-3">
            <div className="flex items-baseline gap-2">
              <span className="text-iris">›</span>
              <span className="text-fg">{e.line}</span>
              <span className="ml-auto text-[10.5px] text-faint">{formatDuration(e.ms)}</span>
            </div>
            <pre className={cx("mt-0.5 pl-4 whitespace-pre-wrap", e.error ? "text-danger" : "text-muted")}>{e.output}</pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className={cx("text-iris", busy && "animate-pulse")}>›</span>
        <input
          ref={inputRef}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent text-fg outline-none placeholder:text-faint"
          placeholder="Type a Redis command"
          value={line}
          onChange={(e) => {
            setLine(e.target.value);
            setCursor(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && past.length) {
              e.preventDefault();
              const next = Math.min(past.length - 1, cursor + 1);
              setCursor(next);
              setLine(past[next]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = cursor - 1;
              setCursor(Math.max(-1, next));
              setLine(next >= 0 ? past[next] : "");
            } else if (e.key === "l" && e.ctrlKey) {
              e.preventDefault();
              setEntries([]);
            }
          }}
        />
      </form>
    </div>
  );
}
