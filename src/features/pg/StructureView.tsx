import type { ReactNode } from "react";
import { ArrowUpRight, KeyRound, Link2 } from "lucide-react";
import { Badge, cx } from "../../components/ui";
import { familyColor, familyGlyph, formatBytes, formatInt, typeFamily } from "../../lib/format";
import type { TableStructure } from "../../lib/types";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="mb-2 flex items-baseline gap-2 font-display text-sm font-semibold">
        {title}
        {count != null && <span className="font-sans text-xs font-normal text-faint">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const th = "border-b border-line px-3 py-2 text-left text-2xs font-semibold tracking-wider text-faint uppercase";
const td = "border-b border-line/60 px-3 py-2 align-top";

export function StructureView({ s, onOpenTable }: { s: TableStructure; onOpenTable: (schema: string, table: string) => void }) {
  const fkByColumn = new Map<string, { schema: string; table: string; column: string }>();
  for (const fk of s.foreignKeys) fk.columns.forEach((c, i) => fkByColumn.set(c, { schema: fk.refSchema, table: fk.refTable, column: fk.refColumns[i] }));

  return (
    <div className="selectable h-full overflow-auto px-8 py-6">
      <div className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-2">
        <div>
          <div className="text-2xs font-semibold tracking-[0.14em] text-faint uppercase">{s.kind === "table" ? "Table" : s.kind === "view" ? "View" : s.kind === "matview" ? "Materialized view" : "Foreign table"}</div>
          <h2 className="font-display text-2xl font-bold tracking-tight">
            <span className="text-faint">{s.schema}.</span>
            {s.name}
          </h2>
          {s.comment && <p className="mt-1 max-w-2xl text-sm text-muted">{s.comment}</p>}
        </div>
        <dl className="flex gap-6 text-sm">
          {[
            ["Rows (est.)", formatInt(s.rowEstimate)],
            ["Total size", formatBytes(s.totalBytes)],
            ["Table data", formatBytes(s.tableBytes)],
            ["Owner", s.owner],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-2xs font-semibold tracking-wider text-faint uppercase">{k}</dt>
              <dd className="font-mono text-[13px] tabular">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Section title="Columns" count={s.columns.length}>
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={cx(th, "w-10")}>#</th>
                <th className={th}>Name</th>
                <th className={th}>Type</th>
                <th className={th}>Nullable</th>
                <th className={th}>Default</th>
                <th className={th}>Comment</th>
              </tr>
            </thead>
            <tbody>
              {s.columns.map((c) => {
                const fam = typeFamily(c.dataType, c.category);
                const fk = fkByColumn.get(c.name);
                return (
                  <tr key={c.name} className="hover:bg-raised/60">
                    <td className={cx(td, "font-mono text-xs text-faint tabular")}>{c.position}</td>
                    <td className={td}>
                      <span className="flex items-center gap-1.5 font-mono text-[12.5px] font-medium">
                        {c.name}
                        {c.isPk && <KeyRound className="size-3 text-warn" />}
                        {fk && (
                          <button className="inline-flex items-center gap-0.5 rounded px-1 font-sans text-[11px] font-normal text-info hover:bg-info/10" onClick={() => onOpenTable(fk.schema, fk.table)}>
                            <Link2 className="size-3" /> {fk.table}.{fk.column}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className={td}>
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        <span className={cx("w-4 text-center text-[10px] font-semibold", familyColor[fam])}>{familyGlyph[fam]}</span>
                        {c.dataType}
                        {c.identity && <Badge>identity</Badge>}
                        {c.generated && <Badge>generated</Badge>}
                      </span>
                      {c.enumValues && <div className="mt-1 font-mono text-[11px] text-faint">{c.enumValues.join(" · ")}</div>}
                    </td>
                    <td className={cx(td, "text-xs", c.nullable ? "text-muted" : "font-medium")}>{c.nullable ? "yes" : "NOT NULL"}</td>
                    <td className={cx(td, "max-w-[260px] truncate font-mono text-xs text-muted")} title={c.default ?? ""}>
                      {c.default ?? <span className="text-faint">—</span>}
                    </td>
                    <td className={cx(td, "text-xs text-muted")}>{c.comment ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {s.indexes.length > 0 && (
        <Section title="Indexes" count={s.indexes.length}>
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Definition</th>
                  <th className={cx(th, "text-right")}>Size</th>
                </tr>
              </thead>
              <tbody>
                {s.indexes.map((i) => (
                  <tr key={i.name}>
                    <td className={td}>
                      <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
                        {i.name}
                        {i.primary ? <Badge tone="warn">primary</Badge> : i.unique && <Badge tone="iris">unique</Badge>}
                        <Badge>{i.method}</Badge>
                      </span>
                    </td>
                    <td className={cx(td, "font-mono text-[11.5px] text-muted")}>{i.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, "")}</td>
                    <td className={cx(td, "text-right font-mono text-xs tabular")}>{formatBytes(i.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {s.foreignKeys.length > 0 && (
        <Section title="References" count={s.foreignKeys.length}>
          <div className="flex flex-col gap-1.5">
            {s.foreignKeys.map((fk) => (
              <button
                key={fk.name}
                onClick={() => onOpenTable(fk.refSchema, fk.refTable)}
                className="group flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-left font-mono text-xs hover:border-iris-line"
              >
                <span className="font-medium">{fk.columns.join(", ")}</span>
                <span className="text-faint">→</span>
                <span className="text-info">
                  {fk.refSchema}.{fk.refTable}({fk.refColumns.join(", ")})
                </span>
                <span className="ml-auto truncate text-faint">{fk.definition.replace(/^FOREIGN KEY .*?REFERENCES \S+/, "").trim()}</span>
                <ArrowUpRight className="size-3.5 text-faint group-hover:text-iris" />
              </button>
            ))}
          </div>
        </Section>
      )}

      {s.referencedBy.length > 0 && (
        <Section title="Referenced by" count={s.referencedBy.length}>
          <div className="flex flex-col gap-1.5">
            {s.referencedBy.map((r) => (
              <button
                key={`${r.schema}.${r.table}.${r.name}`}
                onClick={() => onOpenTable(r.schema, r.table)}
                className="group flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-left font-mono text-xs hover:border-iris-line"
              >
                <span className="text-info">
                  {r.schema}.{r.table}
                </span>
                <span className="text-faint">({r.columns.join(", ")})</span>
                <span className="ml-auto truncate text-faint">{r.name}</span>
                <ArrowUpRight className="size-3.5 text-faint group-hover:text-iris" />
              </button>
            ))}
          </div>
        </Section>
      )}

      {s.constraints.filter((c) => c.type !== "foreign key").length > 0 && (
        <Section title="Constraints">
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <table className="w-full border-collapse text-sm">
              <tbody>
                {s.constraints
                  .filter((c) => c.type !== "foreign key")
                  .map((c) => (
                    <tr key={c.name}>
                      <td className={cx(td, "w-56 font-mono text-xs font-medium")}>{c.name}</td>
                      <td className={cx(td, "w-28")}>
                        <Badge tone={c.type === "primary key" ? "warn" : c.type === "unique" ? "iris" : "neutral"}>{c.type}</Badge>
                      </td>
                      <td className={cx(td, "font-mono text-[11.5px] text-muted")}>{c.definition}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {s.triggers.length > 0 && (
        <Section title="Triggers" count={s.triggers.length}>
          {s.triggers.map((t) => (
            <pre key={t.name} className="mb-1.5 rounded-lg border border-line bg-panel p-3 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
              {t.definition}
              {!t.enabled && <span className="ml-2 text-warn">(disabled)</span>}
            </pre>
          ))}
        </Section>
      )}

      {s.viewDefinition && (
        <Section title="Definition">
          <pre className="rounded-lg border border-line bg-panel p-4 font-mono text-xs whitespace-pre-wrap">{s.viewDefinition.trim()}</pre>
        </Section>
      )}
    </div>
  );
}
