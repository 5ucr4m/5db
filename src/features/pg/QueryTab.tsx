import { Bookmark, Gauge, Library, Play, PlayCircle, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, Input, Modal, Resizer, useResizable } from "../../components/ui";
import { errorMessage, rpc } from "../../lib/rpc";
import { destructiveReason } from "../../lib/sql";
import type { ExecuteResult, SavedQuery } from "../../lib/types";
import { type Session, type Tab, useApp, useConnection } from "../../store/app";
import { SqlEditor, type SqlEditorHandle } from "./LazySqlEditor";
import { LibraryPanel, notifyHistory } from "./LibraryPanel";
import { ResultsPanel } from "./ResultsPanel";

type QueryTabT = Extract<Tab, { kind: "query" }>;

export function QueryTab({ session, tab, active }: { session: Session; tab: QueryTabT; active: boolean }) {
  const conn = useConnection(session.connectionId);
  const updateTab = useApp((s) => s.updateTab);
  const confirm = useApp((s) => s.confirm);
  const toast = useApp((s) => s.toast);
  const refreshObjects = useApp((s) => s.refreshObjects);
  const editor = useRef<SqlEditorHandle>(null);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastRun, setLastRun] = useState<{ text: string; offset: number } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(() => {
    try {
      return localStorage.getItem("5db.library") !== "0";
    } catch {
      return true;
    }
  });
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [editorH, setEditorH] = useResizable("query-editor", 260, 120, 900);
  const [libW, setLibW] = useResizable("query-library", 300, 220, 560);
  const dragStart = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem("5db.library", libraryOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [libraryOpen]);

  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    const t = setInterval(() => setElapsed(performance.now() - started), 100);
    return () => clearInterval(t);
  }, [running]);

  const persist = (sql: string) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => updateTab(session.id, tab.id, { sql }), 300);
  };

  const execute = useCallback(
    async (text: string, offset: number) => {
      if (!text.trim() || running) return;
      if (conn?.env === "prod") {
        const reason = destructiveReason(text);
        if (reason) {
          const ok = await confirm({
            title: "Run on production?",
            body: `This statement ${reason} on “${conn.name}”.\n\n${text.trim().slice(0, 400)}`,
            confirmLabel: "Run on production",
            danger: true,
          });
          if (!ok) return;
        }
      }
      editor.current?.clearError();
      setRunning(true);
      setElapsed(0);
      setLastRun({ text, offset });
      try {
        const r = await rpc<ExecuteResult>("pg.execute", { connectionId: session.connectionId, database: session.database, sql: text });
        setResult(r);
        if (r.error?.position != null && offset >= 0) {
          const from = offset + r.error.position - 1;
          const rest = text.slice(r.error.position - 1);
          const len = Math.max(1, /^[^\s,;()]*/.exec(rest)?.[0].length ?? 1);
          editor.current?.markError(from, from + len);
        }
        // Schema changes should show up in the sidebar right away.
        if (!r.error && /\b(CREATE|DROP|ALTER|RENAME)\b/i.test(text)) void refreshObjects(session.id);
      } catch (e) {
        setResult({ results: [], error: { message: errorMessage(e) }, durationMs: 0 });
      } finally {
        setRunning(false);
        notifyHistory();
      }
    },
    [conn, confirm, running, session.connectionId, session.database, session.id, refreshObjects],
  );

  const runCurrent = () => {
    const r = editor.current?.getRunnable();
    if (r) void execute(r.text, r.offset);
  };
  const runAll = () => void execute(editor.current?.getValue() ?? "", 0);
  const explain = () => {
    const r = editor.current?.getRunnable();
    if (r?.text.trim()) void execute(`EXPLAIN (VERBOSE) ${r.text.trim().replace(/;\s*$/, "")}`, -1_000_000);
  };
  const cancel = async () => {
    try {
      await rpc("pg.cancel", { connectionId: session.connectionId, database: session.database });
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const save = async (name?: string) => {
    const sql = editor.current?.getValue() ?? "";
    if (!sql.trim()) return;
    if (!tab.savedId && !name) {
      setSaveName(tab.title.startsWith("Query") ? "" : tab.title);
      setSaveOpen(true);
      return;
    }
    try {
      const q = await rpc<SavedQuery>("saved.save", {
        id: tab.savedId ?? "",
        name: name ?? tab.title,
        sql,
        connectionId: session.connectionId,
      });
      updateTab(session.id, tab.id, { savedId: q.id, title: q.name, sql });
      notifyHistory();
      toast("ok", `Saved “${q.name}”`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  // Autorun (e.g. "Run again" from history) once the editor exists.
  useEffect(() => {
    if (tab.autorun && tab.sql) {
      updateTab(session.id, tab.id, { autorun: false });
      void execute(tab.sql, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.autorun]);

  useEffect(() => {
    if (active) setTimeout(() => editor.current?.focus(), 0);
  }, [active]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
          {running ? (
            <Button size="sm" variant="danger" icon={<Square className="size-3 fill-current" />} onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Play className="size-3.5 fill-current" />} onClick={runCurrent} kbd="⌘↵">
              Run
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<PlayCircle className="size-3.5" />}
            onClick={runAll}
            disabled={running}
            title="Run every statement (⇧⌘↵)"
          >
            Run all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Gauge className="size-3.5" />}
            onClick={explain}
            disabled={running}
            title="Show the query plan"
          >
            Explain
          </Button>
          <div className="mx-1 h-4 w-px bg-line" />
          <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={() => save()} title="Save query (⌘S)">
            {tab.savedId ? "Save" : "Save as…"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[11px] text-faint">{session.database}</span>
            <IconButton
              label={libraryOpen ? "Hide history and saved queries" : "Show history and saved queries"}
              active={libraryOpen}
              onClick={() => setLibraryOpen((v) => !v)}
            >
              <Library className="size-4" />
            </IconButton>
          </div>
        </div>
        <div style={{ height: editorH }} className="shrink-0 overflow-hidden bg-panel">
          <SqlEditor
            ref={editor}
            className="h-full"
            initialValue={tab.sql ?? ""}
            completion={session.completion}
            placeholder="SELECT * FROM customers WHERE created_at > now() - interval '7 days';"
            onChange={persist}
            onRun={runCurrent}
            onRunAll={runAll}
            onSave={() => save()}
          />
        </div>
        <Resizer
          direction="y"
          onResize={(d, phase) => {
            if (phase === "start") dragStart.current = editorH;
            else setEditorH(Math.max(120, Math.min(900, dragStart.current + d)));
          }}
        />
        <div className="min-h-0 flex-1">
          <ResultsPanel
            result={result}
            running={running}
            elapsedMs={elapsed}
            onJumpToError={
              lastRun && lastRun.offset >= 0 && result?.error?.position != null
                ? () => {
                    const from = lastRun.offset + result.error!.position! - 1;
                    editor.current?.markError(from, from + 1);
                    editor.current?.focus();
                  }
                : undefined
            }
          />
        </div>
      </div>
      {libraryOpen && (
        <>
          <Resizer
            direction="x"
            onResize={(d, phase) => {
              if (phase === "start") dragStart.current = libW;
              else setLibW(Math.max(220, Math.min(560, dragStart.current - d)));
            }}
          />
          <div style={{ width: libW }} className="shrink-0">
            <LibraryPanel
              connectionId={session.connectionId}
              onUse={(sql, saved) => {
                editor.current?.setValue(sql);
                persist(sql);
                if (saved) updateTab(session.id, tab.id, { savedId: saved.id, title: saved.name });
                editor.current?.focus();
              }}
              onRun={(sql) => {
                editor.current?.setValue(sql);
                persist(sql);
                void execute(sql, 0);
              }}
            />
          </div>
        </>
      )}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save query"
        width={400}
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!saveName.trim()}
              onClick={() => {
                setSaveOpen(false);
                void save(saveName.trim());
              }}
            >
              Save query
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!saveName.trim()) return;
            setSaveOpen(false);
            void save(saveName.trim());
          }}
        >
          <Input autoFocus placeholder="Monthly revenue by status" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <p className="mt-2 text-xs text-muted">
            Saved queries live with this connection and show up in the library and the command palette.
          </p>
        </form>
      </Modal>
    </div>
  );
}
