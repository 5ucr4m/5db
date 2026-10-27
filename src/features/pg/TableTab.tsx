import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  Copy,
  Download,
  Filter as FilterIcon,
  FilterX,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataGrid,
  DEFAULT_CELL,
  type GridColumn,
  type GridContextAction,
  type RowState,
  type Selection,
  selectedRowIndexes,
} from "../../components/grid/DataGrid";
import {
  Button,
  cx,
  IconButton,
  Input,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Modal,
  Popover,
  Resizer,
  Segmented,
  Select,
  Spinner,
  useResizable,
} from "../../components/ui";
import { copyText, pickSavePath, saveText, toCsv, toJson } from "../../lib/export";
import { formatDuration, formatInt, typeFamily, uid } from "../../lib/format";
import { errorMessage, isTauri, rpc } from "../../lib/rpc";
import { generateDdl, insertStatements, literal, qualified, quoteIdent } from "../../lib/sql";
import type { Cell, Filter, RowsPage, SortSpec, TableStructure } from "../../lib/types";
import { type Session, type Tab, useApp, useConnection } from "../../store/app";
import { FilterBar, newFilter, opArity } from "./FilterBar";
import { SqlEditor } from "./LazySqlEditor";
import { ExportMenu } from "./ResultsPanel";
import { RowInspector } from "./RowInspector";
import { StructureView } from "./StructureView";

type TableTabT = Extract<Tab, { kind: "table" }>;

interface RowKey {
  pk?: Record<string, Cell>;
  ctid?: string;
}

interface Staged {
  updates: Map<string, { key: RowKey; values: Record<string, Cell> }>;
  inserts: { id: string; values: Record<string, Cell | undefined> }[];
  deletes: Map<string, RowKey>;
}

const emptyStaged = (): Staged => ({ updates: new Map(), inserts: [], deletes: new Map() });

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const PAGE_SIZES = [100, 500, 1000, 5000];

export function TableTab({ session, tab, active }: { session: Session; tab: TableTabT; active: boolean }) {
  const conn = useConnection(session.connectionId);
  const openTab = useApp((s) => s.openTab);
  const updateTab = useApp((s) => s.updateTab);
  const pinTab = useApp((s) => s.pinTab);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);
  const refreshObjects = useApp((s) => s.refreshObjects);

  const view = tab.view ?? "data";
  const [filters, setFilters] = useState<Filter[]>(tab.initialFilters ?? []);
  const [matchMode, setMatchMode] = useState<"and" | "or">("and");
  const [rawWhere, setRawWhere] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => {
    try {
      return Number(localStorage.getItem("5db.pageSize")) || 500;
    } catch {
      return 500;
    }
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [data, setData] = useState<RowsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [staged, setStaged] = useState<Staged>(emptyStaged);
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspW, setInspW] = useResizable("inspector", 340, 260, 640);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [focusFilterId, setFocusFilterId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragStart = useRef(0);
  const reqId = useRef(0);

  // FK filters arriving for an already-open tab replace the current ones.
  useEffect(() => {
    if (tab.initialFilters) {
      setFilters(tab.initialFilters);
      setPage(0);
    }
  }, [tab.initialFilters]);

  const effectiveFilters = useMemo(
    () => filters.filter((f) => f.enabled && f.column && (opArity(f.op) === 0 || (f.value ?? "").trim() !== "")),
    [filters],
  );
  const query = useDebounced(
    JSON.stringify({
      f: effectiveFilters.map(({ column, op, value, value2 }) => ({ column, op, value, value2: opArity(op) === 2 ? value2 : undefined })),
      m: matchMode,
      w: rawWhere.trim(),
      s: search.trim(),
    }),
    280,
  );
  useEffect(() => {
    setPage(0);
  }, [query, sort]);

  const loadStructure = useCallback(async () => {
    try {
      setStructure(
        await rpc<TableStructure>("pg.structure", {
          connectionId: session.connectionId,
          database: session.database,
          schema: tab.schema,
          table: tab.name,
        }),
      );
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [session.connectionId, session.database, tab.schema, tab.name, toast]);

  useEffect(() => {
    void loadStructure();
  }, [loadStructure, reloadToken]);

  useEffect(() => {
    if (view !== "data") return;
    const id = ++reqId.current;
    const q = JSON.parse(query);
    setLoading(true);
    rpc<RowsPage>("pg.rows", {
      connectionId: session.connectionId,
      database: session.database,
      schema: tab.schema,
      table: tab.name,
      filters: q.f,
      matchMode: q.m,
      rawWhere: q.w || null,
      search: q.s || null,
      sort,
      limit: pageSize,
      offset: page * pageSize,
    })
      .then((r) => {
        if (id !== reqId.current) return;
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setError(errorMessage(e));
      })
      .finally(() => id === reqId.current && setLoading(false));
  }, [session.connectionId, session.database, tab.schema, tab.name, query, sort, page, pageSize, reloadToken, view]);

  const columns = data?.columns ?? structure?.columns ?? [];
  const fkMap = useMemo(() => {
    const m = new Map<string, { schema: string; table: string; column: string }>();
    for (const fk of structure?.foreignKeys ?? [])
      fk.columns.forEach((c, i) => {
        m.set(c, { schema: fk.refSchema, table: fk.refTable, column: fk.refColumns[i] });
      });
    return m;
  }, [structure]);
  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        family: typeFamily(c.dataType, c.category),
        isPk: c.isPk,
        fk: fkMap.get(c.name),
        nullable: c.nullable,
        readOnly: c.generated,
      })),
    [columns, fkMap],
  );
  const pkCols = useMemo(() => columns.map((c, i) => (c.isPk ? i : -1)).filter((i) => i >= 0), [columns]);
  const editable = !!data?.editable && !conn?.readOnly && (pkCols.length > 0 || data.rowIds.some((r) => r != null));

  const rowKey = useCallback(
    (r: number): { id: string; key: RowKey } | null => {
      if (!data) return null;
      if (pkCols.length) {
        const pk: Record<string, Cell> = {};
        for (const i of pkCols) pk[columns[i].name] = data.rows[r][i];
        return { id: JSON.stringify(pk), key: { pk } };
      }
      const ctid = data.rowIds[r];
      return ctid ? { id: `ctid:${ctid}`, key: { ctid } } : null;
    },
    [data, pkCols, columns],
  );

  // ----- staged edits overlay --------------------------------------------
  const baseCount = data?.rows.length ?? 0;
  const { displayRows, rowStates, editedCells } = useMemo(() => {
    const rows: Cell[][] = [];
    const states: RowState[] = [];
    const edited = new Set<string>();
    if (data) {
      data.rows.forEach((row, r) => {
        const k = rowKey(r);
        const upd = k ? staged.updates.get(k.id) : undefined;
        if (upd) {
          const copy = [...row];
          columns.forEach((c, ci) => {
            if (c.name in upd.values) {
              copy[ci] = upd.values[c.name];
              edited.add(`${r}:${ci}`);
            }
          });
          rows.push(copy);
        } else rows.push(row);
        states.push(k && staged.deletes.has(k.id) ? "deleted" : undefined);
      });
    }
    staged.inserts.forEach((ins, i) => {
      const r = baseCount + i;
      rows.push(
        columns.map((c, ci) => {
          const v = ins.values[c.name];
          if (v !== undefined) edited.add(`${r}:${ci}`);
          return v === undefined ? DEFAULT_CELL : v;
        }),
      );
      states.push("inserted");
    });
    return { displayRows: rows, rowStates: states, editedCells: edited };
  }, [data, staged, columns, rowKey, baseCount]);

  const pending = staged.updates.size + staged.inserts.length + staged.deletes.size;

  const onEdit = useCallback(
    (r: number, c: number, value: Cell) => {
      const col = columns[c].name;
      setStaged((s) => {
        if (r >= baseCount) {
          const inserts = s.inserts.map((ins, i) => (i === r - baseCount ? { ...ins, values: { ...ins.values, [col]: value } } : ins));
          return { ...s, inserts };
        }
        const k = rowKey(r);
        if (!k) return s;
        const updates = new Map(s.updates);
        const existing = updates.get(k.id) ?? { key: k.key, values: {} };
        const values = { ...existing.values };
        if (data && data.rows[r][c] === value) delete values[col];
        else values[col] = value;
        if (Object.keys(values).length) updates.set(k.id, { key: k.key, values });
        else updates.delete(k.id);
        return { ...s, updates };
      });
    },
    [columns, baseCount, rowKey, data],
  );

  const deleteRows = useCallback(
    (rows: number[]) => {
      if (!editable) return;
      setStaged((s) => {
        const deletes = new Map(s.deletes);
        const dropInserts = new Set(rows.filter((r) => r >= baseCount).map((r) => r - baseCount));
        for (const r of rows) {
          if (r >= baseCount) continue;
          const k = rowKey(r);
          if (k) deletes.set(k.id, k.key);
        }
        return { ...s, deletes, inserts: s.inserts.filter((_, i) => !dropInserts.has(i)) };
      });
    },
    [editable, baseCount, rowKey],
  );

  const restoreRows = (rows: number[]) =>
    setStaged((s) => {
      const deletes = new Map(s.deletes);
      const updates = new Map(s.updates);
      for (const r of rows) {
        const k = r < baseCount ? rowKey(r) : null;
        if (k) {
          deletes.delete(k.id);
          updates.delete(k.id);
        }
      }
      return { ...s, deletes, updates };
    });

  const [reveal, setReveal] = useState<{ row: number; token: number } | undefined>();
  const addRow = () => {
    if (!editable) return;
    const row = baseCount + staged.inserts.length;
    setStaged((s) => ({ ...s, inserts: [...s.inserts, { id: uid(), values: {} }] }));
    setReveal({ row, token: Date.now() });
  };

  const discard = () => setStaged(emptyStaged());

  const changes = () => [
    ...[...staged.deletes.values()].map((key) => ({ kind: "delete", key })),
    ...[...staged.updates.values()].map((u) => ({ kind: "update", key: u.key, values: u.values })),
    ...staged.inserts.map((ins) => ({
      kind: "insert",
      values: Object.fromEntries(Object.entries(ins.values).filter(([, v]) => v !== undefined)),
    })),
  ];

  const previewSql = () => {
    const rel = qualified(tab.schema, tab.name);
    const where = (k: RowKey) =>
      k.pk
        ? Object.entries(k.pk)
            .map(([c, v]) => (v == null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${literal(v)}`))
            .join(" AND ")
        : `ctid = '${k.ctid}'`;
    const lines = ["BEGIN;"];
    for (const k of staged.deletes.values()) lines.push(`DELETE FROM ${rel} WHERE ${where(k)};`);
    for (const u of staged.updates.values())
      lines.push(
        `UPDATE ${rel} SET ${Object.entries(u.values)
          .map(([c, v]) => `${quoteIdent(c)} = ${literal(v)}`)
          .join(", ")} WHERE ${where(u.key)};`,
      );
    for (const ins of staged.inserts) {
      const entries = Object.entries(ins.values).filter(([, v]) => v !== undefined) as [string, Cell][];
      lines.push(
        entries.length
          ? `INSERT INTO ${rel} (${entries.map(([c]) => quoteIdent(c)).join(", ")}) VALUES (${entries.map(([, v]) => literal(v)).join(", ")});`
          : `INSERT INTO ${rel} DEFAULT VALUES;`,
      );
    }
    lines.push("COMMIT;");
    return lines.join("\n");
  };

  const save = async () => {
    if (!pending || saving) return;
    if (conn?.env === "prod") {
      const ok = await confirm({
        title: "Save changes to production?",
        body: `${pending} change${pending === 1 ? "" : "s"} will be written to ${tab.schema}.${tab.name} on “${conn.name}” in one transaction.`,
        confirmLabel: "Save to production",
        danger: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await rpc("pg.apply", {
        connectionId: session.connectionId,
        database: session.database,
        schema: tab.schema,
        table: tab.name,
        changes: changes(),
      });
      toast("ok", `Saved ${pending} change${pending === 1 ? "" : "s"} to ${tab.name}`);
      setStaged(emptyStaged());
      setReloadToken((t) => t + 1);
      pinTab(session.id, tab.id);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    if (pending) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        body: `Reloading drops ${pending} staged change${pending === 1 ? "" : "s"}.`,
        confirmLabel: "Discard and reload",
        danger: true,
      });
      if (!ok) return;
      discard();
    }
    setReloadToken((t) => t + 1);
  };

  const toggleSort = (column: string, additive: boolean) => {
    setSort((prev) => {
      const cur = prev.find((s) => s.column === column);
      const next: SortSpec | null = !cur ? { column, desc: false } : !cur.desc ? { column, desc: true } : null;
      const others = additive ? prev.filter((s) => s.column !== column) : [];
      if (!next) return others;
      if (additive) {
        const idx = prev.findIndex((s) => s.column === column);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = next;
          return copy;
        }
        return [...others, next];
      }
      return [next];
    });
  };

  const openFk = useCallback(
    (col: GridColumn, value: string) => {
      if (!col.fk) return;
      openTab(session.id, {
        kind: "table",
        title: col.fk.table,
        schema: col.fk.schema,
        name: col.fk.table,
        objectKind: "table",
        initialFilters: [{ id: uid(), column: col.fk.column, op: "eq", value, enabled: true }],
      });
    },
    [openTab, session.id],
  );

  const addQuickFilter = (column: string, value: Cell, negate = false) => {
    const f: Filter =
      value == null
        ? { id: uid(), column, op: negate ? "not_null" : "is_null", enabled: true }
        : { id: uid(), column, op: negate ? "neq" : "eq", value, enabled: true };
    setFilters((prev) => [...prev, f]);
  };

  const contextActions = (s: Selection, r: number, c: number): GridContextAction[] => {
    const rows = selectedRowIndexes(s);
    const col = gridColumns[c];
    const v = displayRows[r]?.[c];
    const isDeleted = rowStates[r] === "deleted";
    const realValue = v === DEFAULT_CELL ? null : v;
    const names = columns.map((x) => x.name);
    const actions: GridContextAction[] = [
      { label: "Copy value", icon: <Clipboard className="size-3.5" />, kbd: "⌘C", run: () => void copyText(realValue ?? "") },
      {
        label: "Copy row as JSON",
        icon: <Copy className="size-3.5" />,
        run: () =>
          void copyText(
            toJson(
              names,
              rows.map((i) => displayRows[i]),
            ),
          ),
      },
      {
        label: "Copy row as INSERT",
        icon: <Copy className="size-3.5" />,
        run: () =>
          void copyText(
            insertStatements(
              qualified(tab.schema, tab.name),
              names,
              rows.map((i) => displayRows[i]),
            ),
          ),
      },
      {
        label:
          realValue == null
            ? `Filter: ${col.name} is NULL`
            : `Filter: ${col.name} = ${realValue.length > 24 ? realValue.slice(0, 24) + "…" : realValue}`,
        icon: <FilterIcon className="size-3.5" />,
        separatorBefore: true,
        run: () => addQuickFilter(col.name, realValue),
      },
      { label: `Exclude this value`, icon: <FilterX className="size-3.5" />, run: () => addQuickFilter(col.name, realValue, true) },
    ];
    if (col.fk && realValue != null)
      actions.push({ label: `Open ${col.fk.table} row`, icon: <ChevronRight className="size-3.5" />, run: () => openFk(col, realValue) });
    if (editable) {
      if (col.nullable && !col.readOnly && !isDeleted)
        actions.push({ label: "Set NULL", separatorBefore: true, run: () => onEdit(r, c, null) });
      actions.push({
        label: "Show row details",
        icon: <PanelRight className="size-3.5" />,
        kbd: "⌘I",
        separatorBefore: !col.nullable,
        run: () => setInspectorOpen(true),
      });
      if (isDeleted) actions.push({ label: "Restore row", icon: <RotateCcw className="size-3.5" />, run: () => restoreRows(rows) });
      else
        actions.push({
          label: rows.length > 1 ? `Delete ${rows.length} rows` : "Delete row",
          icon: <Trash2 className="size-3.5" />,
          kbd: "⌘⌫",
          danger: true,
          run: () => deleteRows(rows),
        });
    }
    return actions;
  };

  // ----- shortcuts --------------------------------------------------------
  const handlers = useRef({ save, reload, addRow });
  handlers.current = { save, reload, addRow };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void handlers.current.save();
      } else if (k === "r") {
        e.preventDefault();
        void handlers.current.reload();
      } else if (k === "f" && !e.shiftKey) {
        e.preventDefault();
        updateTab(session.id, tab.id, { view: "data" });
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        const f = newFilter(columns[0]);
        setFilters((prev) => [...prev, f]);
        setFocusFilterId(f.id);
      } else if (k === "i") {
        e.preventDefault();
        setInspectorOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, columns, session.id, tab.id, updateTab]);

  // Any edit pins a preview tab so it is not replaced by browsing.
  useEffect(() => {
    if (pending) pinTab(session.id, tab.id);
  }, [pending, pinTab, session.id, tab.id]);

  const exportTable = async () => {
    const name = `${tab.schema}.${tab.name}.csv`;
    try {
      if (isTauri) {
        const path = await pickSavePath(name, "csv");
        if (!path || path === "download") return;
        const r = await rpc<{ bytes: number }>("pg.exportCsv", {
          connectionId: session.connectionId,
          database: session.database,
          schema: tab.schema,
          table: tab.name,
          path,
        });
        toast("ok", `Exported ${tab.name} (${formatInt(r.bytes)} bytes)`);
      } else {
        const all = await rpc<RowsPage>("pg.rows", {
          connectionId: session.connectionId,
          database: session.database,
          schema: tab.schema,
          table: tab.name,
          limit: 100000,
          count: false,
        });
        await saveText(
          name,
          "csv",
          toCsv(
            all.columns.map((c) => c.name),
            all.rows,
          ),
        );
        toast("ok", `Exported ${formatInt(all.rows.length)} rows`);
      }
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const tableAction = async (kind: "truncate" | "drop" | "refresh") => {
    const rel = qualified(tab.schema, tab.name);
    const objectWord =
      tab.objectKind === "view"
        ? "VIEW"
        : tab.objectKind === "matview"
          ? "MATERIALIZED VIEW"
          : tab.objectKind === "foreign"
            ? "FOREIGN TABLE"
            : "TABLE";
    const sql =
      kind === "truncate" ? `TRUNCATE ${rel}` : kind === "drop" ? `DROP ${objectWord} ${rel}` : `REFRESH MATERIALIZED VIEW ${rel}`;
    if (kind !== "refresh") {
      const ok = await confirm({
        title: kind === "truncate" ? `Empty ${tab.name}?` : `Drop ${tab.name}?`,
        body: `${sql};\n\n${kind === "truncate" ? "Every row is removed." : "The object and its data are removed."} This cannot be undone.`,
        confirmLabel: kind === "truncate" ? "Truncate" : "Drop",
        danger: true,
      });
      if (!ok) return;
    }
    const r = await rpc<{ error: { message: string } | null }>("pg.execute", {
      connectionId: session.connectionId,
      database: session.database,
      sql,
    });
    if (r.error) toast("error", r.error.message);
    else {
      toast("ok", kind === "truncate" ? `Truncated ${tab.name}` : kind === "drop" ? `Dropped ${tab.name}` : `Refreshed ${tab.name}`);
      void refreshObjects(session.id);
      if (kind !== "drop") setReloadToken((t) => t + 1);
    }
  };

  const focusRow = sel ? sel.focus.r : null;
  const total = data?.total ?? null;
  const pageCount = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const filterCount = effectiveFilters.length + (rawWhere.trim() ? 1 : 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
        <Segmented
          size="sm"
          value={view}
          onChange={(v) => updateTab(session.id, tab.id, { view: v })}
          options={[
            { value: "data", label: "Data" },
            { value: "structure", label: "Structure" },
            { value: "ddl", label: "DDL" },
          ]}
        />
        {view === "data" && (
          <>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-faint" />
              <Input
                ref={searchRef}
                className="h-7 pr-6 pl-7 text-xs"
                placeholder="Search every column  ⌘F"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="absolute top-1.5 right-1.5 text-faint hover:text-fg"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              variant={filterCount ? "subtle" : "ghost"}
              icon={<FilterIcon className="size-3.5" />}
              onClick={() => {
                if (!filters.length) {
                  const f = newFilter(columns[0]);
                  setFilters([f]);
                  setFocusFilterId(f.id);
                }
              }}
              title="Add a filter (⇧⌘F)"
            >
              {filterCount ? `${filterCount} filter${filterCount > 1 ? "s" : ""}` : "Filter"}
            </Button>
            {sort.map((s) => (
              <button
                type="button"
                key={s.column}
                className="flex h-6 items-center gap-1 rounded-md border border-iris-line bg-iris-soft px-1.5 font-mono text-[11px] text-iris"
                onClick={() => toggleSort(s.column, true)}
                title="Click to flip or remove. Shift-click headers to sort by more columns."
              >
                {s.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                {s.column}
                <X
                  className="size-3 opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSort((prev) => prev.filter((x) => x.column !== s.column));
                  }}
                />
              </button>
            ))}
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {view === "data" && editable && (
            <>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={addRow}>
                Row
              </Button>
              {sel && (
                <IconButton label="Delete selected rows (⌘⌫)" onClick={() => deleteRows(selectedRowIndexes(sel))}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </>
          )}
          {view === "data" && data && (
            <ExportMenu
              columns={columns.map((c) => c.name)}
              rows={displayRows.filter((_, i) => rowStates[i] !== "inserted")}
              baseName={tab.name}
              tableName={qualified(tab.schema, tab.name)}
            />
          )}
          <IconButton label="Reload (⌘R)" onClick={reload}>
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
          </IconButton>
          {view === "data" && (
            <IconButton label="Row details (⌘I)" active={inspectorOpen} onClick={() => setInspectorOpen((v) => !v)}>
              <PanelRight className="size-3.5" />
            </IconButton>
          )}
          <IconButton ref={moreRef} label="More table actions" onClick={() => setMoreOpen((v) => !v)}>
            <span className="text-base leading-none">⋯</span>
          </IconButton>
          <Popover anchor={moreRef.current} open={moreOpen} onClose={() => setMoreOpen(false)} align="end" className="w-60">
            <MenuLabel>
              {tab.schema}.{tab.name}
            </MenuLabel>
            <MenuItem
              onClick={() => {
                setMoreOpen(false);
                openTab(session.id, {
                  kind: "query",
                  title: `Query · ${tab.name}`,
                  sql: `SELECT *\nFROM ${qualified(tab.schema, tab.name)}\nLIMIT 100;`,
                });
              }}
            >
              New query on this table
            </MenuItem>
            <MenuItem icon={<Download className="size-3.5" />} onClick={() => (setMoreOpen(false), void exportTable())}>
              Export entire table as CSV
            </MenuItem>
            <MenuItem onClick={() => (setMoreOpen(false), void copyText(qualified(tab.schema, tab.name)), toast("ok", "Copied name"))}>
              Copy qualified name
            </MenuItem>
            {tab.objectKind === "matview" && (
              <MenuItem onClick={() => (setMoreOpen(false), void tableAction("refresh"))}>Refresh materialized view</MenuItem>
            )}
            {!conn?.readOnly && (
              <>
                <MenuSeparator />
                {tab.objectKind === "table" && (
                  <MenuItem danger onClick={() => (setMoreOpen(false), void tableAction("truncate"))}>
                    Truncate…
                  </MenuItem>
                )}
                <MenuItem danger onClick={() => (setMoreOpen(false), void tableAction("drop"))}>
                  Drop…
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>

      {view === "data" && (
        <FilterBar
          columns={columns}
          filters={filters}
          onChange={setFilters}
          matchMode={matchMode}
          onMatchMode={setMatchMode}
          rawWhere={rawWhere}
          onRawWhere={setRawWhere}
          rawOpen={rawOpen}
          onRawOpen={setRawOpen}
          focusId={focusFilterId}
        />
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {view === "data" &&
            (error ? (
              <div className="selectable m-4 rounded-lg border border-danger/30 bg-danger/[0.06] p-4 text-sm">
                <div className="font-medium">The rows could not be loaded</div>
                <div className="mt-1 font-mono text-xs text-muted">{error}</div>
                <div className="mt-2 text-xs text-muted">Check the filter values: they are compared using the column type.</div>
              </div>
            ) : !data ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <DataGrid
                columns={gridColumns}
                rows={displayRows}
                rowNumberOffset={page * pageSize}
                rowStates={rowStates}
                editedCells={editedCells}
                sort={sort}
                onSort={toggleSort}
                editable={editable}
                onEdit={onEdit}
                onOpenFk={openFk}
                onSelectionChange={setSel}
                contextActions={contextActions}
                onDeleteRows={deleteRows}
                resetKey={`${tab.schema}.${tab.name}`}
                reveal={reveal}
                emptyState={
                  <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted">
                    {filterCount || search ? (
                      <>
                        <span>No rows match these filters.</span>
                        <button
                          type="button"
                          className="pointer-events-auto text-iris hover:underline"
                          onClick={() => (setFilters([]), setRawWhere(""), setSearch(""))}
                        >
                          Clear filters
                        </button>
                      </>
                    ) : (
                      <span>This {tab.objectKind === "table" ? "table" : "view"} has no rows yet.</span>
                    )}
                  </div>
                }
              />
            ))}
          {view === "data" && loading && data && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-iris" />
          )}
          {view === "structure" &&
            (structure ? (
              <StructureView
                s={structure}
                onOpenTable={(schema, name) => openTab(session.id, { kind: "table", title: name, schema, name, objectKind: "table" })}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ))}
          {view === "ddl" && structure && (
            <DdlView ddl={generateDdl(structure)} sessionId={session.id} name={tab.name} completion={session.completion} />
          )}
        </div>
        {view === "data" && inspectorOpen && (
          <>
            <Resizer
              direction="x"
              onResize={(d, phase) => {
                if (phase === "start") dragStart.current = inspW;
                else setInspW(Math.max(260, Math.min(640, dragStart.current - d)));
              }}
            />
            <div style={{ width: inspW }} className="shrink-0">
              <RowInspector
                columns={gridColumns}
                row={focusRow != null ? (displayRows[focusRow] ?? null) : null}
                rowLabel={
                  focusRow != null ? (rowStates[focusRow] === "inserted" ? "New row" : `Row ${page * pageSize + focusRow + 1}`) : ""
                }
                editable={editable && focusRow != null && rowStates[focusRow] !== "deleted"}
                onEdit={(c, v) => focusRow != null && onEdit(focusRow, c, v)}
                onOpenFk={openFk}
                onClose={() => setInspectorOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {/* Pending changes */}
      {pending > 0 && (
        <div className="flex h-11 shrink-0 animate-slide-up items-center gap-3 border-t border-warn/30 bg-warn/[0.08] px-3 text-sm">
          <span className="size-2 rounded-full bg-warn" />
          <span className="font-medium">
            {pending} unsaved change{pending === 1 ? "" : "s"}
          </span>
          <span className="text-xs text-muted">
            {[
              staged.updates.size && `${staged.updates.size} edited`,
              staged.inserts.length && `${staged.inserts.length} new`,
              staged.deletes.size && `${staged.deletes.size} deleted`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={discard}>
              Discard
            </Button>
            <Button size="sm" onClick={() => setPreviewOpen(true)}>
              Review SQL
            </Button>
            <Button size="sm" variant="primary" loading={saving} onClick={save} kbd="⌘S">
              Save changes
            </Button>
          </div>
        </div>
      )}

      {/* Status bar */}
      {view === "data" && (
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-xs text-muted">
          <span className="tabular">
            {data && total != null
              ? total === 0
                ? "0 rows"
                : `${formatInt(page * pageSize + 1)}–${formatInt(page * pageSize + data.rows.length)} of ${data.totalEstimated ? "~" : ""}${formatInt(total)}`
              : "—"}
          </span>
          {data && <span className="text-faint tabular">{formatDuration(data.durationMs)}</span>}
          {!editable && data && (
            <span className="text-faint">
              {conn?.readOnly ? "Read-only connection" : !data.editable ? "Read-only view" : "No primary key: edits disabled"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Select
              className="h-6 w-[108px] py-0 text-xs"
              value={pageSize}
              onChange={(e) => {
                const n = Number(e.target.value);
                setPageSize(n);
                setPage(0);
                try {
                  localStorage.setItem("5db.pageSize", String(n));
                } catch {
                  /* ignore */
                }
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <IconButton size="sm" label="First page" disabled={page === 0} onClick={() => setPage(0)}>
              <ChevronsLeft className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Previous page" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="size-3.5" />
            </IconButton>
            <span className="min-w-[70px] text-center tabular">
              {page + 1} / {pageCount != null ? formatInt(pageCount) : "?"}
            </span>
            <IconButton
              size="sm"
              label="Next page"
              disabled={!data || (pageCount != null ? page + 1 >= pageCount : data.rows.length < pageSize)}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-3.5" />
            </IconButton>
            <IconButton
              size="sm"
              label="Last page"
              disabled={pageCount == null || page + 1 >= pageCount}
              onClick={() => pageCount && setPage(pageCount - 1)}
            >
              <ChevronsRight className="size-3.5" />
            </IconButton>
          </div>
        </div>
      )}

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Changes to be saved"
        width={720}
        footer={
          <>
            <span className="mr-auto text-xs text-muted">Runs as one transaction with typed, parameterised values.</span>
            <Button onClick={() => setPreviewOpen(false)}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                setPreviewOpen(false);
                void save();
              }}
            >
              Save changes
            </Button>
          </>
        }
      >
        <pre className="selectable max-h-[50vh] overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs whitespace-pre-wrap">
          {previewOpen ? previewSql() : ""}
        </pre>
      </Modal>
    </div>
  );
}

function DdlView({
  ddl,
  sessionId,
  name,
  completion,
}: {
  ddl: string;
  sessionId: string;
  name: string;
  completion: Session["completion"];
}) {
  const openTab = useApp((s) => s.openTab);
  const toast = useApp((s) => s.toast);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
        <span className="text-xs text-muted">Generated from the catalog. Review before running elsewhere.</span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={<Clipboard className="size-3.5" />}
            onClick={() => (void copyText(ddl), toast("ok", "Copied DDL"))}
          >
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openTab(sessionId, { kind: "query", title: `DDL · ${name}`, sql: ddl })}>
            Open in editor
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-panel">
        <SqlEditor key={ddl} className="h-full" initialValue={ddl} readOnly completion={completion} />
      </div>
    </div>
  );
}
