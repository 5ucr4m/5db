import { Code2, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, cx, IconButton, Input, Segmented, Select } from "../../components/ui";
import { familyColor, familyGlyph, type TypeFamily, typeFamily, uid } from "../../lib/format";
import type { ColumnInfo, Filter, FilterOp } from "../../lib/types";

const OPS: { op: FilterOp; label: string; families?: TypeFamily[]; arity: 0 | 1 | 2 }[] = [
  { op: "eq", label: "=", arity: 1 },
  { op: "neq", label: "≠", arity: 1 },
  { op: "contains", label: "contains", arity: 1 },
  { op: "not_contains", label: "does not contain", arity: 1 },
  { op: "starts_with", label: "starts with", arity: 1 },
  { op: "ends_with", label: "ends with", arity: 1 },
  { op: "gt", label: ">", arity: 1, families: ["num", "time", "text", "uuid", "enum", "other"] },
  { op: "gte", label: "≥", arity: 1, families: ["num", "time", "text", "uuid", "enum", "other"] },
  { op: "lt", label: "<", arity: 1, families: ["num", "time", "text", "uuid", "enum", "other"] },
  { op: "lte", label: "≤", arity: 1, families: ["num", "time", "text", "uuid", "enum", "other"] },
  { op: "between", label: "between", arity: 2, families: ["num", "time", "text", "other"] },
  { op: "in", label: "is one of", arity: 1 },
  { op: "not_in", label: "is not one of", arity: 1 },
  { op: "regex", label: "matches regex", arity: 1 },
  { op: "is_true", label: "is true", arity: 0, families: ["bool"] },
  { op: "is_false", label: "is false", arity: 0, families: ["bool"] },
  { op: "is_null", label: "is NULL", arity: 0 },
  { op: "not_null", label: "is not NULL", arity: 0 },
  { op: "is_empty", label: "is empty or NULL", arity: 0, families: ["text", "json", "array", "other"] },
];

export const opArity = (op: FilterOp) => OPS.find((o) => o.op === op)?.arity ?? 1;
export const opLabel = (op: FilterOp) => OPS.find((o) => o.op === op)?.label ?? op;

export function defaultOp(col: ColumnInfo | undefined): FilterOp {
  const fam = col ? typeFamily(col.dataType, col.category) : "text";
  if (fam === "bool") return "is_true";
  if (fam === "text" || fam === "json" || fam === "other" || fam === "array") return "contains";
  return "eq";
}

export function newFilter(col: ColumnInfo | undefined): Filter {
  return { id: uid(), column: col?.name ?? "", op: defaultOp(col), value: "", enabled: true };
}

export function FilterBar({
  columns,
  filters,
  onChange,
  matchMode,
  onMatchMode,
  rawWhere,
  onRawWhere,
  rawOpen,
  onRawOpen,
  focusId,
}: {
  columns: ColumnInfo[];
  filters: Filter[];
  onChange: (f: Filter[]) => void;
  matchMode: "and" | "or";
  onMatchMode: (m: "and" | "or") => void;
  rawWhere: string;
  onRawWhere: (s: string) => void;
  rawOpen: boolean;
  onRawOpen: (v: boolean) => void;
  focusId?: string | null;
}) {
  const update = (id: string, patch: Partial<Filter>) => onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (id: string) => onChange(filters.filter((f) => f.id !== id));
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (focusId) setTimeout(() => refs.current[focusId]?.focus(), 0);
  }, [focusId]);

  if (!filters.length && !rawOpen) return null;

  return (
    <div className="shrink-0 animate-fade-in border-b border-line bg-panel px-3 py-2">
      <div className="flex flex-col gap-1.5">
        {filters.map((f, i) => {
          const col = columns.find((c) => c.name === f.column);
          const fam = col ? typeFamily(col.dataType, col.category) : "other";
          const ops = OPS.filter((o) => !o.families || o.families.includes(fam));
          const arity = opArity(f.op);
          const enumList = col?.enumValues;
          return (
            <div key={f.id} className={cx("flex items-center gap-1.5", !f.enabled && "opacity-50")}>
              <span className="w-12 shrink-0 text-right text-2xs font-semibold tracking-wider text-faint uppercase">
                {i === 0 ? "where" : matchMode}
              </span>
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--iris)]"
                checked={f.enabled}
                title={f.enabled ? "Disable this filter" : "Enable this filter"}
                onChange={(e) => update(f.id, { enabled: e.target.checked })}
              />
              <div className="relative w-48 shrink-0">
                <span
                  className={cx(
                    "pointer-events-none absolute top-[7px] left-2 w-4 text-center font-mono text-[10px] font-semibold",
                    familyColor[fam],
                  )}
                >
                  {familyGlyph[fam]}
                </span>
                <Select
                  className="h-7 pl-7 text-xs"
                  value={f.column}
                  onChange={(e) => {
                    const nc = columns.find((c) => c.name === e.target.value);
                    const nf = nc ? typeFamily(nc.dataType, nc.category) : "other";
                    const stillValid = OPS.some((o) => o.op === f.op && (!o.families || o.families.includes(nf)));
                    // An untouched filter follows the new column's natural operator.
                    const keep = stillValid && ((f.value ?? "") !== "" || opArity(f.op) === 0);
                    update(f.id, { column: e.target.value, op: keep && nf !== "bool" ? f.op : defaultOp(nc) });
                  }}
                >
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Select className="h-7 w-40 shrink-0 text-xs" value={f.op} onChange={(e) => update(f.id, { op: e.target.value as FilterOp })}>
                {ops.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {arity >= 1 &&
                (enumList && (f.op === "eq" || f.op === "neq") ? (
                  <Select
                    className="h-7 min-w-0 flex-1 font-mono text-xs"
                    value={f.value ?? ""}
                    onChange={(e) => update(f.id, { value: e.target.value })}
                  >
                    <option value="" disabled>
                      choose a value
                    </option>
                    {enumList.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    ref={(el) => {
                      refs.current[f.id] = el;
                    }}
                    mono
                    className="h-7 min-w-0 flex-1"
                    placeholder={
                      f.op === "in" || f.op === "not_in"
                        ? "comma separated: a, b, c"
                        : fam === "time"
                          ? "2026-01-31 or 2026-01-31 18:30"
                          : fam === "num"
                            ? "42"
                            : "value"
                    }
                    value={f.value ?? ""}
                    onChange={(e) => update(f.id, { value: e.target.value })}
                  />
                ))}
              {arity === 2 && (
                <>
                  <span className="text-xs text-faint">and</span>
                  <Input
                    mono
                    className="h-7 min-w-0 flex-1"
                    value={f.value2 ?? ""}
                    onChange={(e) => update(f.id, { value2: e.target.value })}
                  />
                </>
              )}
              {arity === 0 && <div className="flex-1" />}
              <IconButton size="sm" label="Remove filter" onClick={() => remove(f.id)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          );
        })}

        {rawOpen && (
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-right text-2xs font-semibold tracking-wider text-faint uppercase">
              {filters.length ? "and" : "where"}
            </span>
            <Code2 className="size-3.5 shrink-0 text-iris" />
            <Input
              mono
              autoFocus={!filters.length}
              className="h-7 flex-1"
              placeholder="raw SQL condition, e.g. created_at > now() - interval '1 day'"
              value={rawWhere}
              onChange={(e) => onRawWhere(e.target.value)}
            />
            <IconButton size="sm" label="Remove SQL condition" onClick={() => (onRawWhere(""), onRawOpen(false))}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}

        <div className="flex items-center gap-2 pl-[54px]">
          <Button
            size="sm"
            variant="subtle"
            icon={<Plus className="size-3.5" />}
            onClick={() => onChange([...filters, newFilter(columns[0])])}
          >
            Add filter
          </Button>
          {!rawOpen && (
            <Button size="sm" variant="ghost" icon={<Code2 className="size-3.5" />} onClick={() => onRawOpen(true)}>
              SQL condition
            </Button>
          )}
          {filters.length > 1 && (
            <div className="ml-2 flex items-center gap-2 text-xs text-muted">
              Match
              <Segmented
                size="sm"
                value={matchMode}
                onChange={onMatchMode}
                options={[
                  { value: "and", label: "all" },
                  { value: "or", label: "any" },
                ]}
              />
            </div>
          )}
          {(filters.length > 0 || rawWhere) && (
            <button
              type="button"
              className="ml-auto text-xs text-muted hover:text-fg"
              onClick={() => (onChange([]), onRawWhere(""), onRawOpen(false))}
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
