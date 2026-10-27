import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpRight, KeyRound, Link2 } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyText, toTsv } from "../../lib/export";
import { familyColor, familyGlyph, type TypeFamily } from "../../lib/format";
import type { Cell, SortSpec } from "../../lib/types";
import { cx, Popover } from "../ui";

export interface GridColumn {
  name: string;
  type: string;
  family: TypeFamily;
  isPk?: boolean;
  fk?: { schema: string; table: string; column: string };
  nullable?: boolean;
  readOnly?: boolean;
}

export type RowState = "deleted" | "inserted" | undefined;

/** Placeholder for a new row's column that will take its database default. */
export const DEFAULT_CELL = "\u0000default";

export interface GridContextAction {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

export interface Selection {
  anchor: { r: number; c: number };
  focus: { r: number; c: number };
  /** Whole rows were selected through the row gutter. */
  rowMode: boolean;
}

interface DataGridProps {
  columns: GridColumn[];
  rows: Cell[][];
  rowNumberOffset?: number;
  rowStates?: RowState[];
  editedCells?: Set<string>;
  sort?: SortSpec[];
  onSort?: (column: string, additive: boolean) => void;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  onOpenFk?: (col: GridColumn, value: string) => void;
  onSelectionChange?: (sel: Selection | null) => void;
  contextActions?: (sel: Selection, row: number, col: number) => GridContextAction[];
  onDeleteRows?: (rows: number[]) => void;
  emptyState?: ReactNode;
  /** Changing this resets column widths and scroll (new result shape). */
  resetKey?: string;
  /** Scrolls to and selects this row whenever `token` changes. */
  reveal?: { row: number; token: number };
}

const ROW_H = 28;
const HEAD_H = 34;
const CHAR_W = 7.3;

function measureWidths(columns: GridColumn[], rows: Cell[][]): number[] {
  const sample = rows.length > 80 ? rows.slice(0, 80) : rows;
  return columns.map((col, ci) => {
    // Header: glyph + name + key/link icons + sort marker + padding.
    const header = 16 + col.name.length * 7.2 + (col.isPk ? 16 : 0) + (col.fk ? 16 : 0) + 34;
    let max = 0;
    for (const r of sample) {
      const v = r[ci];
      const len = v == null ? 4 : Math.min(v.length, 60);
      if (len > max) max = len;
    }
    return Math.round(Math.min(380, Math.max(72, header, max * CHAR_W + 22)));
  });
}

export function selectedRowIndexes(sel: Selection | null): number[] {
  if (!sel) return [];
  const lo = Math.min(sel.anchor.r, sel.focus.r);
  const hi = Math.max(sel.anchor.r, sel.focus.r);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function displayValue(v: string, family: TypeFamily): string {
  const s = v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (family === "bool") return v === "t" || v === "true" ? "true" : v === "f" || v === "false" ? "false" : s;
  return s.replace(/\r?\n/g, " ↵ ");
}

const CellView = memo(function CellView({ value, column }: { value: Cell; column: GridColumn }) {
  if (value == null)
    return <span className="rounded-[3px] bg-sunken px-1 py-px text-[10px] font-semibold tracking-wider text-faint">NULL</span>;
  if (column.family === "bool") {
    const on = value === "t" || value === "true";
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={cx("size-1.5 rounded-full", on ? "bg-ok" : "bg-danger/80")} />
        <span className={on ? "text-fg" : "text-muted"}>{on ? "true" : "false"}</span>
      </span>
    );
  }
  if (value === DEFAULT_CELL)
    return <span className="rounded-[3px] bg-iris-soft px-1 py-px text-[10px] font-semibold tracking-wider text-iris">DEFAULT</span>;
  if (value === "") return <span className="text-faint italic">empty</span>;
  const color = column.family === "text" || column.family === "other" ? "text-fg" : familyColor[column.family];
  return <span className={color}>{displayValue(value, column.family)}</span>;
});

export function DataGrid({
  columns,
  rows,
  rowNumberOffset = 0,
  rowStates,
  editedCells,
  sort = [],
  onSort,
  editable,
  onEdit,
  onOpenFk,
  onSelectionChange,
  contextActions,
  onDeleteRows,
  emptyState,
  resetKey,
  reveal,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => measureWidths(columns, rows));
  const [sel, setSel] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; initial: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; r: number; c: number } | null>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Remeasure when the shape changes (different query / table).
  const shapeKey = resetKey ?? columns.map((c) => c.name).join("\u0001");
  const lastShape = useRef(shapeKey);
  useLayoutEffect(() => {
    if (lastShape.current !== shapeKey) {
      lastShape.current = shapeKey;
      setWidths(measureWidths(columns, rows));
      setSel(null);
      setEditing(null);
      scrollRef.current?.scrollTo({ top: 0, left: 0 });
    } else if (widths.length !== columns.length) {
      setWidths(measureWidths(columns, rows));
    }
  }, [shapeKey, columns, rows, widths.length]);

  useEffect(() => {
    onSelectionChange?.(sel);
  }, [sel, onSelectionChange]);

  const gutterW = Math.max(44, String(rowNumberOffset + rows.length).length * 8 + 22);

  const rowV = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    overscan: 4,
  });
  useEffect(() => {
    colV.measure();
  }, [widths, colV]);

  useEffect(() => {
    if (!reveal || reveal.row >= rows.length) return;
    const c = Math.max(
      0,
      columns.findIndex((col) => !col.readOnly && !col.isPk),
    );
    setSel({ anchor: { r: reveal.row, c }, focus: { r: reveal.row, c }, rowMode: false });
    rowV.scrollToIndex(reveal.row, { align: "center" });
    colV.scrollToIndex(c, { align: "auto" });
    scrollRef.current?.focus({ preventScroll: true });
    // Only react to new tokens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);

  const totalW = colV.getTotalSize() + gutterW;
  const vRows = rowV.getVirtualItems();
  const vCols = colV.getVirtualItems();

  const inSel = useCallback(
    (r: number, c: number) => {
      if (!sel) return false;
      const r0 = Math.min(sel.anchor.r, sel.focus.r),
        r1 = Math.max(sel.anchor.r, sel.focus.r);
      if (r < r0 || r > r1) return false;
      if (sel.rowMode) return true;
      const c0 = Math.min(sel.anchor.c, sel.focus.c),
        c1 = Math.max(sel.anchor.c, sel.focus.c);
      return c >= c0 && c <= c1;
    },
    [sel],
  );

  const scrollIntoView = (r: number, c: number) => {
    rowV.scrollToIndex(r, { align: "auto" });
    colV.scrollToIndex(c, { align: "auto" });
  };

  const canEdit = (c: number, r: number) => !!editable && !!onEdit && !columns[c]?.readOnly && rowStates?.[r] !== "deleted";

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!canEdit(c, r)) return;
    const current = rows[r]?.[c];
    setEditing({ r, c, initial: initial ?? (current === DEFAULT_CELL ? "" : (current ?? "")) });
  };

  const copySelection = (withHeaders: boolean) => {
    if (!sel) return;
    const r0 = Math.min(sel.anchor.r, sel.focus.r),
      r1 = Math.max(sel.anchor.r, sel.focus.r);
    const c0 = sel.rowMode ? 0 : Math.min(sel.anchor.c, sel.focus.c);
    const c1 = sel.rowMode ? columns.length - 1 : Math.max(sel.anchor.c, sel.focus.c);
    const slice = rows.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1));
    const single = r0 === r1 && c0 === c1;
    void copyText(
      single && !withHeaders ? (slice[0][0] ?? "") : toTsv(withHeaders ? columns.slice(c0, c1 + 1).map((c) => c.name) : null, slice),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection(e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (rows.length) setSel({ anchor: { r: 0, c: 0 }, focus: { r: rows.length - 1, c: columns.length - 1 }, rowMode: true });
      return;
    }
    if (!sel) {
      if (e.key.startsWith("Arrow") && rows.length) {
        e.preventDefault();
        setSel({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 }, rowMode: false });
      }
      return;
    }
    const { focus } = sel;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const r = Math.max(0, Math.min(rows.length - 1, focus.r + dr));
      const c = Math.max(0, Math.min(columns.length - 1, focus.c + dc));
      if (e.shiftKey) setSel({ ...sel, focus: { r, c } });
      else setSel({ anchor: { r, c }, focus: { r, c }, rowMode: false });
      scrollIntoView(r, c);
    };
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 2);
    switch (e.key) {
      case "ArrowDown":
        return move(mod ? rows.length : 1, 0);
      case "ArrowUp":
        return move(mod ? -rows.length : -1, 0);
      case "ArrowRight":
        return move(0, mod ? columns.length : 1);
      case "ArrowLeft":
        return move(0, mod ? -columns.length : -1);
      case "PageDown":
        return move(page, 0);
      case "PageUp":
        return move(-page, 0);
      case "Home":
        return move(0, -columns.length);
      case "End":
        return move(0, columns.length);
      case "Tab":
        return move(0, e.shiftKey ? -1 : 1);
      case "Enter":
      case "F2":
        e.preventDefault();
        startEdit(focus.r, focus.c);
        return;
      case "Escape":
        setSel(null);
        return;
      case "Backspace":
      case "Delete":
        if (mod || sel.rowMode) {
          e.preventDefault();
          onDeleteRows?.(selectedRowIndexes(sel));
        } else if (canEdit(focus.c, focus.r) && columns[focus.c].nullable) {
          e.preventDefault();
          onEdit!(focus.r, focus.c, null);
        }
        return;
    }
    // Typing starts an edit with the typed character, like a spreadsheet.
    if (e.key.length === 1 && !mod && !e.altKey && canEdit(focus.c, focus.r)) {
      e.preventDefault();
      startEdit(focus.r, focus.c, e.key);
    }
  };

  const onCellMouseDown = (e: React.MouseEvent, r: number, c: number) => {
    if (e.button === 2) {
      if (!inSel(r, c)) setSel({ anchor: { r, c }, focus: { r, c }, rowMode: false });
      return;
    }
    scrollRef.current?.focus({ preventScroll: true });
    if (e.shiftKey && sel) setSel({ ...sel, focus: { r, c } });
    else setSel({ anchor: { r, c }, focus: { r, c }, rowMode: false });
    dragging.current = true;
    const up = () => {
      dragging.current = false;
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mouseup", up);
  };

  const onCellEnter = (r: number, c: number) => {
    if (dragging.current) setSel((s) => (s ? { ...s, focus: { r, c } } : s));
  };

  const onGutterMouseDown = (e: React.MouseEvent, r: number) => {
    scrollRef.current?.focus({ preventScroll: true });
    const last = columns.length - 1;
    if (e.shiftKey && sel) setSel({ anchor: { r: sel.anchor.r, c: 0 }, focus: { r, c: last }, rowMode: true });
    else setSel({ anchor: { r, c: 0 }, focus: { r, c: last }, rowMode: true });
  };

  const resizeCol = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    const move = (ev: PointerEvent) =>
      setWidths((w) => w.map((x, j) => (j === i ? Math.max(48, Math.min(1200, startW + ev.clientX - startX)) : x)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const autoFit = (i: number) => {
    const col = columns[i];
    let max = col.name.length + 5;
    for (const r of rows) {
      const v = r[i];
      const len = v == null ? 4 : Math.min(v.length, 140);
      if (len > max) max = len;
    }
    setWidths((w) => w.map((x, j) => (j === i ? Math.round(Math.min(1000, max * CHAR_W + 22)) : x)));
  };

  const sortIndex = (name: string) => sort.findIndex((s) => s.column === name);
  const menuActions = menu && sel && contextActions ? contextActions(sel, menu.r, menu.c) : [];

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="h-full w-full overflow-auto font-mono text-[12px] outline-none"
        style={{ contain: "strict" }}
      >
        <div style={{ width: totalW, height: rowV.getTotalSize() + HEAD_H, position: "relative" }}>
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-line bg-panel" style={{ height: HEAD_H, width: totalW }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-panel" style={{ width: gutterW }} />
            <div className="relative h-full flex-1">
              {vCols.map((vc) => {
                const col = columns[vc.index];
                const si = sortIndex(col.name);
                const s = si >= 0 ? sort[si] : null;
                return (
                  <div
                    key={vc.key}
                    className={cx(
                      "group absolute top-0 flex h-full items-center gap-1.5 border-r border-line px-2 font-sans text-xs",
                      onSort && "hover:bg-raised",
                    )}
                    style={{ left: vc.start, width: vc.size }}
                    title={`${col.name} · ${col.type}${col.fk ? ` → ${col.fk.table}.${col.fk.column}` : ""}`}
                    onClick={(e) => onSort?.(col.name, e.shiftKey)}
                    onDoubleClick={() => autoFit(vc.index)}
                  >
                    <span className={cx("w-4 shrink-0 text-center font-mono text-[10px] font-semibold", familyColor[col.family])}>
                      {familyGlyph[col.family]}
                    </span>
                    <span className="min-w-0 truncate font-semibold text-fg">{col.name}</span>
                    {col.isPk && <KeyRound className="size-3 shrink-0 text-warn" />}
                    {col.fk && <Link2 className="size-3 shrink-0 text-info" />}
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      {s && (
                        <span className="flex items-center text-iris">
                          {s.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                          {sort.length > 1 && <span className="text-[10px] font-bold">{si + 1}</span>}
                        </span>
                      )}
                    </span>
                    <div
                      className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-iris/50"
                      onPointerDown={(e) => resizeCol(vc.index, e)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        autoFit(vc.index);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rows */}
          {vRows.map((vr) => {
            const r = vr.index;
            const row = rows[r];
            const state = rowStates?.[r];
            const rowSelected = !!sel && sel.rowMode && inSel(r, 0);
            return (
              <div
                key={vr.key}
                className={cx(
                  "absolute left-0 flex border-b border-line/60",
                  r % 2 === 1 && "bg-[var(--row-alt)]",
                  state === "inserted" && "!bg-ok/[0.07]",
                  state === "deleted" && "!bg-danger/[0.08] text-faint line-through decoration-danger/60",
                )}
                style={{ top: vr.start + HEAD_H, height: ROW_H, width: totalW }}
              >
                <div
                  className={cx(
                    "sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-panel pr-2 text-[11px] tabular text-faint",
                    rowSelected && "!bg-iris-soft !text-iris",
                    state === "inserted" && "!text-ok",
                    state === "deleted" && "!text-danger",
                  )}
                  style={{ width: gutterW }}
                  onMouseDown={(e) => onGutterMouseDown(e, r)}
                >
                  {state === "inserted" ? "+" : rowNumberOffset + r + 1}
                </div>
                <div className="relative h-full flex-1">
                  {vCols.map((vc) => {
                    const c = vc.index;
                    const col = columns[c];
                    const v = row[c];
                    const selected = inSel(r, c);
                    const isFocus = sel && sel.focus.r === r && sel.focus.c === c;
                    const edited = editedCells?.has(`${r}:${c}`);
                    return (
                      <div
                        key={vc.key}
                        className={cx(
                          "group/cell absolute top-0 flex h-full items-center overflow-hidden border-r border-line/40 px-2 whitespace-nowrap",
                          col.family === "num" && "justify-end tabular",
                          edited && "!bg-warn/15",
                          isFocus && "z-[1] shadow-[inset_0_0_0_1.5px_var(--iris)]",
                        )}
                        style={{ left: vc.start, width: vc.size, background: selected && !edited ? "var(--selection)" : undefined }}
                        onMouseDown={(e) => onCellMouseDown(e, r, c)}
                        onMouseEnter={() => onCellEnter(r, c)}
                        onDoubleClick={() => startEdit(r, c)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, r, c });
                        }}
                      >
                        <span className="min-w-0 truncate">
                          <CellView value={v} column={col} />
                        </span>
                        {col.fk && v != null && onOpenFk && (
                          <button
                            type="button"
                            className="ml-1 hidden shrink-0 rounded p-0.5 text-info hover:bg-info/15 group-hover/cell:inline-flex"
                            title={`Open ${col.fk.table} where ${col.fk.column} = ${v}`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => onOpenFk(col, v)}
                          >
                            <ArrowUpRight className="size-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {editing && (
          <CellEditor
            key={`${editing.r}:${editing.c}`}
            initial={editing.initial}
            column={columns[editing.c]}
            style={(() => {
              const vc = colV.getVirtualItems().find((x) => x.index === editing.c);
              const left = (vc?.start ?? 0) + gutterW;
              return { top: editing.r * ROW_H + HEAD_H, left, width: Math.max(vc?.size ?? 160, 220) };
            })()}
            onCancel={() => {
              setEditing(null);
              scrollRef.current?.focus({ preventScroll: true });
            }}
            onCommit={(value, advance) => {
              const { r, c } = editing;
              if (value !== rows[r][c]) onEdit?.(r, c, value);
              setEditing(null);
              scrollRef.current?.focus({ preventScroll: true });
              if (advance) {
                const nr = Math.min(rows.length - 1, r + (advance === "down" ? 1 : 0));
                const nc = Math.min(columns.length - 1, c + (advance === "right" ? 1 : 0));
                setSel({ anchor: { r: nr, c: nc }, focus: { r: nr, c: nc }, rowMode: false });
              }
            }}
          />
        )}
      </div>

      {rows.length === 0 && emptyState && <div className="pointer-events-none absolute inset-x-0 top-[34px] bottom-0">{emptyState}</div>}

      <div ref={menuAnchor} className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      <Popover anchor={menuAnchor.current} open={!!menu && menuActions.length > 0} onClose={() => setMenu(null)} className="w-60">
        {menuActions.map((a, i) => (
          <div key={i}>
            {a.separatorBefore && <div className="my-1 h-px bg-line" />}
            <button
              type="button"
              className={cx(
                "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
                a.danger ? "text-danger hover:bg-danger/10" : "hover:bg-iris-soft",
              )}
              onClick={() => {
                setMenu(null);
                a.run();
              }}
            >
              <span className="flex size-4 items-center justify-center text-muted">{a.icon}</span>
              <span className="flex-1 truncate">{a.label}</span>
              {a.kbd && <span className="font-mono text-[10px] text-faint">{a.kbd}</span>}
            </button>
          </div>
        ))}
      </Popover>
    </div>
  );
}

function CellEditor({
  initial,
  column,
  style,
  onCommit,
  onCancel,
}: {
  initial: string;
  column: GridColumn;
  style: React.CSSProperties;
  onCommit: (value: Cell, advance?: "down" | "right") => void;
  onCancel: () => void;
}) {
  const multiline = initial.includes("\n") || initial.length > 60 || column.family === "json";
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter" && !(multiline && e.shiftKey)) {
      e.preventDefault();
      onCommit(value, "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      onCommit(value, "right");
    }
  };
  const common = {
    ref,
    value,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setValue(e.target.value),
    onKeyDown,
    onBlur: () => onCommit(value),
    className: "w-full resize-none bg-raised px-2 font-mono text-[12px] text-fg outline-none",
  };
  return (
    <div className="absolute z-30 rounded-md shadow-[0_0_0_2px_var(--iris),var(--shadow-pop)]" style={style}>
      {multiline ? (
        <textarea {...common} rows={6} className={common.className + " py-1.5"} />
      ) : (
        <input {...common} className={common.className + " h-[28px]"} />
      )}
      <div className="flex items-center justify-between bg-panel px-2 py-1 font-sans text-[10px] text-faint">
        <span>{multiline ? "⇧↵ new line · ↵ save" : "↵ save · ⇥ next"} · esc cancel</span>
        {column.nullable && (
          <button
            type="button"
            className="rounded px-1 font-semibold text-iris hover:bg-iris-soft"
            onMouseDown={(e) => {
              e.preventDefault();
              onCommit(null);
            }}
          >
            Set NULL
          </button>
        )}
      </div>
    </div>
  );
}
