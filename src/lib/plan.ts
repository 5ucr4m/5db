/**
 * Reading `EXPLAIN (FORMAT JSON)`: the shape Postgres emits, and the numbers
 * worth deriving from it. Rendering lives in features/pg/PlanView.tsx.
 */

/**
 * A node of `EXPLAIN (FORMAT JSON)`. Postgres uses spaced, title-cased keys and
 * adds whole groups of them per option, so everything beyond what is read here
 * is kept and shown as detail rather than being modelled.
 */
export interface RawNode {
  "Node Type": string;
  Plans?: RawNode[];
  [key: string]: unknown;
}

export interface RawPlan {
  Plan: RawNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  Triggers?: unknown[];
}

/** Parses the single cell `EXPLAIN (FORMAT JSON)` returns. Null if it is not one. */
export function parsePlan(text: string | null): RawPlan | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    const first = Array.isArray(v) ? v[0] : v;
    return first && typeof first === "object" && first.Plan ? (first as RawPlan) : null;
  } catch {
    return null;
  }
}

export interface PlanNode {
  raw: RawNode;
  type: string;
  /** Relation, index or CTE the node reads, when it reads one. */
  target: string | null;
  children: PlanNode[];
  cost: number;
  /** Wall time including children and every loop, in ms; null without ANALYZE. */
  inclusiveMs: number | null;
  /** Wall time spent in this node alone. */
  selfMs: number | null;
  planRows: number;
  actualRows: number | null;
  loops: number;
  /** How far the row estimate was out, as a factor of at least 1. */
  misestimate: number | null;
}

export const num = (n: unknown): number | null => (typeof n === "number" ? n : null);
const str = (n: unknown): string | null => (typeof n === "string" ? n : null);

export function build(raw: RawNode): PlanNode {
  const children = (raw.Plans ?? []).map(build);
  const loops = num(raw["Actual Loops"]) ?? 1;
  const perLoop = num(raw["Actual Total Time"]);
  const inclusiveMs = perLoop == null ? null : perLoop * loops;
  const childTotal = children.reduce((a, c) => a + (c.inclusiveMs ?? 0), 0);
  const planRows = (num(raw["Plan Rows"]) ?? 0) * loops;
  const actualPerLoop = num(raw["Actual Rows"]);
  const actualRows = actualPerLoop == null ? null : actualPerLoop * loops;
  // Both sides floored at one row: the ratio between 0 and 1 rows is noise.
  const misestimate =
    actualRows == null ? null : Math.max(Math.max(actualRows, 1) / Math.max(planRows, 1), Math.max(planRows, 1) / Math.max(actualRows, 1));
  return {
    raw,
    type: raw["Node Type"],
    target: str(raw["Relation Name"]) ?? str(raw["Index Name"]) ?? str(raw["CTE Name"]) ?? str(raw["Function Name"]),
    children,
    cost: num(raw["Total Cost"]) ?? 0,
    inclusiveMs,
    selfMs: inclusiveMs == null ? null : Math.max(inclusiveMs - childTotal, 0),
    planRows,
    actualRows,
    loops,
    misestimate,
  };
}

/** The keys worth showing under a node, in the order they read best. */
const DETAIL_KEYS = [
  "Filter",
  "Rows Removed by Filter",
  "Index Cond",
  "Rows Removed by Index Recheck",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Rows Removed by Join Filter",
  "Sort Key",
  "Sort Method",
  "Sort Space Used",
  "Group Key",
  "Heap Fetches",
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
];

export function details(raw: RawNode): [string, string][] {
  const out: [string, string][] = [];
  for (const k of DETAIL_KEYS) {
    const v = raw[k];
    if (v == null || v === 0 || v === "") continue;
    out.push([k, String(v)]);
  }
  return out;
}
