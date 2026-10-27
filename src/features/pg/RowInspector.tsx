import { useEffect, useState } from "react";
import { ArrowUpRight, Braces, KeyRound, X } from "lucide-react";
import { DEFAULT_CELL, type GridColumn } from "../../components/grid/DataGrid";
import { IconButton, cx } from "../../components/ui";
import { familyColor, familyGlyph, tryPrettyJson } from "../../lib/format";
import type { Cell } from "../../lib/types";

function FieldEditor({
  col,
  value,
  editable,
  onCommit,
}: {
  col: GridColumn;
  value: Cell;
  editable: boolean;
  onCommit: (v: Cell) => void;
}) {
  const isDefault = value === DEFAULT_CELL;
  const [pretty, setPretty] = useState(col.family === "json");
  const shown = value == null || isDefault ? "" : pretty ? (tryPrettyJson(value) ?? value) : value;
  const [draft, setDraft] = useState(shown);
  useEffect(() => {
    setDraft(shown);
  }, [shown]);
  const rows = Math.min(14, Math.max(1, draft.split("\n").length, Math.ceil(draft.length / 42)));

  const commit = () => {
    if (!editable) return;
    if (draft === shown) return;
    if (pretty && value != null && tryPrettyJson(draft) != null && JSON.stringify(JSON.parse(draft)) === JSON.stringify(JSON.parse(value))) return;
    onCommit(draft);
  };

  return (
    <div className="relative">
      <textarea
        value={draft}
        readOnly={!editable}
        spellCheck={false}
        rows={rows}
        placeholder={value == null ? "NULL" : isDefault ? "DEFAULT" : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
          if (e.key === "Escape") {
            setDraft(shown);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        className={cx(
          "w-full resize-none rounded-md border border-transparent bg-sunken px-2 py-1.5 font-mono text-[12px] text-fg outline-none placeholder:text-[10px] placeholder:font-semibold placeholder:tracking-wider placeholder:text-faint",
          editable && "hover:border-line focus:border-iris focus:bg-raised",
          col.family === "num" && "tabular",
        )}
      />
      {col.family === "json" && value != null && !isDefault && (
        <button
          className={cx("absolute top-1 right-1 rounded p-0.5", pretty ? "text-iris" : "text-faint hover:text-fg")}
          title={pretty ? "Show raw" : "Pretty print"}
          onClick={() => setPretty((v) => !v)}
        >
          <Braces className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function RowInspector({
  columns,
  row,
  rowLabel,
  editable,
  onEdit,
  onOpenFk,
  onClose,
}: {
  columns: GridColumn[];
  row: Cell[] | null;
  rowLabel: string;
  editable: boolean;
  onEdit: (col: number, value: Cell) => void;
  onOpenFk: (col: GridColumn, value: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-semibold">{row ? rowLabel : "Row details"}</span>
        <IconButton size="sm" label="Close row details" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {!row ? (
        <p className="p-4 text-center text-xs text-muted">Select a row to see every field. Edits here are staged like edits in the grid.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {columns.map((col, i) => (
            <div key={col.name} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs">
                <span className={cx("w-4 text-center font-mono text-[10px] font-semibold", familyColor[col.family])}>{familyGlyph[col.family]}</span>
                <span className="font-medium">{col.name}</span>
                {col.isPk && <KeyRound className="size-3 text-warn" />}
                <span className="truncate font-mono text-[10.5px] text-faint">{col.type}</span>
                {col.fk && row[i] != null && (
                  <button className="ml-auto flex items-center gap-0.5 text-[11px] text-info hover:underline" onClick={() => onOpenFk(col, row[i]!)}>
                    {col.fk.table} <ArrowUpRight className="size-3" />
                  </button>
                )}
              </div>
              <FieldEditor col={col} value={row[i]} editable={editable && !col.readOnly} onCommit={(v) => onEdit(i, v)} />
              {editable && col.nullable && row[i] != null && row[i] !== DEFAULT_CELL && (
                <button className="mt-0.5 text-[10.5px] text-faint hover:text-iris" onClick={() => onEdit(i, null)}>
                  Set NULL
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
