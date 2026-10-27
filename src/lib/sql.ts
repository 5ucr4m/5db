import type { Cell, TableStructure } from "./types";

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const qualified = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;
export const literal = (v: Cell) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

export interface StatementRange {
  from: number;
  to: number;
  text: string;
}

/**
 * Splits SQL into statements on top-level semicolons, respecting quotes,
 * dollar-quoted bodies and comments. Offsets index into the original text.
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    // Comments and bare semicolons are empty queries: the server accepts them
    // but they only add a stray empty result set.
    const meaningful = text
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/[;\s]/g, "");
    if (meaningful) out.push({ from: start + lead, to: start + lead + text.length, text });
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
      } else i++;
    } else if (c === ";") {
      push(i + 1);
      i++;
      start = i;
    } else i++;
  }
  push(n);
  return out;
}

/** The statement under (or immediately before) the cursor. */
export function statementAt(sql: string, offset: number): StatementRange | null {
  const stmts = splitStatements(sql);
  if (!stmts.length) return null;
  for (const s of stmts) if (offset >= s.from && offset <= s.to) return s;
  let best: StatementRange | null = null;
  for (const s of stmts) if (s.to <= offset) best = s;
  return best ?? stmts[0];
}

/** Statements worth a confirmation on production connections. */
export function destructiveReason(sql: string): string | null {
  for (const { text } of splitStatements(sql)) {
    const s = text
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
    if (/^DROP\s/.test(s)) return "drops an object";
    if (/^TRUNCATE\s/.test(s)) return "truncates a table";
    if (/^ALTER\s+TABLE\s.+\sDROP\s/.test(s)) return "drops a column or constraint";
    if (/^DELETE\s+FROM\s/.test(s) && !/\sWHERE\s/.test(s)) return "deletes every row (no WHERE clause)";
    if (/^UPDATE\s/.test(s) && !/\sWHERE\s/.test(s)) return "updates every row (no WHERE clause)";
  }
  return null;
}

export function generateDdl(t: TableStructure): string {
  const rel = qualified(t.schema, t.name);
  if (t.kind === "view" || t.kind === "matview") {
    const kw = t.kind === "view" ? "VIEW" : "MATERIALIZED VIEW";
    return `CREATE ${kw} ${rel} AS\n${(t.viewDefinition ?? "").trimEnd()}\n`;
  }
  const lines = t.columns.map((c) => {
    let l = `  ${quoteIdent(c.name)} ${c.dataType}`;
    if (c.default != null && !c.generated) l += ` DEFAULT ${c.default}`;
    if (!c.nullable) l += " NOT NULL";
    return l;
  });
  for (const con of t.constraints) {
    if (con.type === "trigger") continue;
    lines.push(`  CONSTRAINT ${quoteIdent(con.name)} ${con.definition}`);
  }
  let ddl = `CREATE TABLE ${rel} (\n${lines.join(",\n")}\n);\n`;
  for (const idx of t.indexes) {
    const backsConstraint = t.constraints.some((c) => c.name === idx.name);
    if (!backsConstraint) ddl += `\n${idx.definition};`;
  }
  for (const tr of t.triggers) ddl += `\n${tr.definition};`;
  if (t.comment) ddl += `\n\nCOMMENT ON TABLE ${rel} IS ${literal(t.comment)};`;
  for (const c of t.columns) {
    if (c.comment) ddl += `\nCOMMENT ON COLUMN ${rel}.${quoteIdent(c.name)} IS ${literal(c.comment)};`;
  }
  return ddl.trimEnd() + "\n";
}

export function insertStatements(table: string, columns: string[], rows: Cell[][]): string {
  const cols = columns.map(quoteIdent).join(", ");
  return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(literal).join(", ")});`).join("\n") + "\n";
}
