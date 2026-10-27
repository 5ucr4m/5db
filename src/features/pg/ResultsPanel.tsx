import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clipboard, Download, Scissors, Table2 } from "lucide-react";
import { DataGrid, type GridColumn } from "../../components/grid/DataGrid";
import { Button, EmptyState, MenuItem, MenuLabel, MenuSeparator, Popover, Spinner, cx } from "../../components/ui";
import { copyText, saveText, toCsv, toJson, toMarkdown, toTsv } from "../../lib/export";
import { formatDuration, formatInt, typeFamily } from "../../lib/format";
import { insertStatements } from "../../lib/sql";
import type { Cell, ExecuteResult, ResultSet } from "../../lib/types";
import { useApp } from "../../store/app";

export function resultColumns(rs: ResultSet): GridColumn[] {
  return rs.columns.map((name, i) => {
    const type = rs.columnTypes[i] ?? "text";
    return { name, type, family: rs.columnTypes.length ? typeFamily(type) : "other" };
  });
}

export function ExportMenu({ columns, rows, baseName, tableName }: { columns: string[]; rows: Cell[][]; baseName: string; tableName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const toast = useApp((s) => s.toast);
  const save = async (ext: string, contents: string) => {
    setOpen(false);
    try {
      const path = await saveText(`${baseName}.${ext}`, ext, contents);
      if (path) toast("ok", `Exported ${formatInt(rows.length)} rows to ${path.split("/").pop()}`);
    } catch (e) {
      toast("error", String(e));
    }
  };
  const copy = async (text: string, what: string) => {
    setOpen(false);
    await copyText(text);
    toast("ok", `Copied ${formatInt(rows.length)} rows as ${what}`);
  };
  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => setOpen((v) => !v)} disabled={!columns.length}>
        Export
      </Button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} align="end" className="w-56">
        <MenuLabel>Save {formatInt(rows.length)} rows as</MenuLabel>
        <MenuItem onClick={() => save("csv", toCsv(columns, rows))}>CSV</MenuItem>
        <MenuItem onClick={() => save("json", toJson(columns, rows))}>JSON</MenuItem>
        <MenuItem onClick={() => save("md", toMarkdown(columns, rows))}>Markdown table</MenuItem>
        <MenuItem onClick={() => save("sql", insertStatements(tableName ?? "my_table", columns, rows))}>SQL INSERT statements</MenuItem>
        <MenuSeparator />
        <MenuLabel>Copy to clipboard</MenuLabel>
        <MenuItem icon={<Clipboard className="size-3.5" />} onClick={() => copy(toTsv(columns, rows), "TSV")}>
          Spreadsheet (TSV)
        </MenuItem>
        <MenuItem icon={<Clipboard className="size-3.5" />} onClick={() => copy(toJson(columns, rows), "JSON")}>
          JSON
        </MenuItem>
        <MenuItem icon={<Clipboard className="size-3.5" />} onClick={() => copy(toMarkdown(columns, rows), "Markdown")}>
          Markdown
        </MenuItem>
      </Popover>
    </>
  );
}

export function ResultsPanel({
  result,
  running,
  elapsedMs,
  onJumpToError,
}: {
  result: ExecuteResult | null;
  running: boolean;
  elapsedMs: number;
  onJumpToError?: () => void;
}) {
  const [active, setActive] = useState(0);
  const sets = result?.results ?? [];
  const rowSets = sets.filter((s) => s.kind === "rows");
  const idx = Math.min(active, Math.max(0, sets.length - 1));
  const current = sets[idx];
  const columns = useMemo(() => (current && current.kind === "rows" ? resultColumns(current) : []), [current]);

  if (running && !result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
        <Spinner className="size-5" />
        Running · <span className="tabular">{formatDuration(elapsedMs)}</span>
      </div>
    );
  }
  if (!result) {
    return (
      <EmptyState icon={<Table2 className="size-5" />} title="Run a query to see results">
        <span>
          <b className="font-semibold text-fg">⌘↵</b> runs the statement under the cursor or the selection.{" "}
          <b className="font-semibold text-fg">⇧⌘↵</b> runs everything.
        </span>
      </EmptyState>
    );
  }

  const isPlan = current?.kind === "rows" && current.columns.length === 1 && current.columns[0] === "QUERY PLAN";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        {sets.map((s, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={cx(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
              i === idx ? "bg-iris-soft text-iris" : "text-muted hover:bg-raised hover:text-fg",
            )}
          >
            {s.kind === "rows" ? <Table2 className="size-3" /> : <CheckCircle2 className="size-3" />}
            {s.kind === "rows" ? `${formatInt(s.rows.length)} row${s.rows.length === 1 ? "" : "s"}` : `${formatInt(s.affected ?? 0)} affected`}
            {s.truncated && <Scissors className="size-3 text-warn" />}
          </button>
        ))}
        {result.error && (
          <span className="flex h-6 items-center gap-1.5 rounded-md bg-danger/10 px-2 text-xs font-medium text-danger">
            <AlertTriangle className="size-3" /> Error
          </span>
        )}
        <span className="ml-auto pr-1 text-xs text-faint tabular">
          {running ? `Running · ${formatDuration(elapsedMs)}` : formatDuration(result.durationMs)}
        </span>
        {current?.kind === "rows" && <ExportMenu columns={current.columns} rows={current.rows} baseName="query-result" />}
      </div>

      {result.error && (
        <div className="selectable shrink-0 border-b border-danger/25 bg-danger/[0.06] px-4 py-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-fg">{result.error.message}</div>
              {result.error.detail && <div className="mt-1 text-muted">{result.error.detail}</div>}
              {result.error.hint && <div className="mt-1 text-muted">Hint: {result.error.hint}</div>}
              <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] text-faint">
                {result.error.code && <span>SQLSTATE {result.error.code}</span>}
                {result.error.position != null && onJumpToError && (
                  <button className="font-sans font-medium text-iris hover:underline" onClick={onJumpToError}>
                    Show in editor
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {current?.truncated && (
        <div className="shrink-0 border-b border-warn/25 bg-warn/[0.07] px-4 py-1.5 text-xs text-warn">
          Showing the first {formatInt(current.rows.length)} rows. Add a LIMIT, or export the table to get everything.
        </div>
      )}

      <div className="min-h-0 flex-1">
        {current?.kind === "rows" ? (
          isPlan ? (
            <pre className="selectable h-full overflow-auto p-4 font-mono text-xs leading-relaxed text-fg">
              {current.rows.map((r) => r[0]).join("\n")}
            </pre>
          ) : (
            <DataGrid
              columns={columns}
              rows={current.rows}
              resetKey={`${result.durationMs}:${idx}`}
              emptyState={<div className="flex h-full items-center justify-center text-sm text-muted">The query returned no rows.</div>}
              contextActions={(sel, r, c) => [
                { label: "Copy value", run: () => void copyText(current.rows[r][c] ?? "") },
                {
                  label: "Copy row as JSON",
                  run: () => void copyText(JSON.stringify(Object.fromEntries(current.columns.map((n, i) => [n, current.rows[r][i]])), null, 2)),
                },
                {
                  label: "Copy selection with headers",
                  run: () => {
                    const r0 = Math.min(sel.anchor.r, sel.focus.r), r1 = Math.max(sel.anchor.r, sel.focus.r);
                    void copyText(toTsv(current.columns, current.rows.slice(r0, r1 + 1)));
                  },
                },
              ]}
            />
          )
        ) : current ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-sm">
            <CheckCircle2 className="size-6 text-ok" />
            <div className="font-medium">Statement completed</div>
            <div className="text-muted">
              {formatInt(current.affected ?? 0)} row{current.affected === 1 ? "" : "s"} affected
              {rowSets.length === 0 && sets.length > 1 ? ` · ${sets.length} statements` : ""}
            </div>
          </div>
        ) : (
          !result.error && <div className="flex h-full items-center justify-center text-sm text-muted">Nothing to run.</div>
        )}
      </div>
    </div>
  );
}
