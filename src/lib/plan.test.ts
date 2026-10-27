import { describe, expect, it } from "vitest";
import { build, details, parsePlan } from "./plan";

const node = (over: Record<string, unknown> = {}) => ({ "Node Type": "Seq Scan", "Total Cost": 10, "Plan Rows": 100, ...over });

describe("parsePlan", () => {
  it("reads the array EXPLAIN (FORMAT JSON) produces", () => {
    expect(parsePlan('[{"Plan":{"Node Type":"Result"},"Planning Time":0.1}]')?.Plan["Node Type"]).toBe("Result");
  });

  it("accepts a bare object too", () => {
    expect(parsePlan('{"Plan":{"Node Type":"Result"}}')?.Plan["Node Type"]).toBe("Result");
  });

  it("declines anything that is not a plan, so plain EXPLAIN text stays text", () => {
    expect(parsePlan("Seq Scan on orders  (cost=0.00..389.00 rows=20000 width=45)")).toBeNull();
    expect(parsePlan("[]")).toBeNull();
    expect(parsePlan('[{"NotAPlan":1}]')).toBeNull();
    expect(parsePlan("")).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });
});

describe("build", () => {
  it("leaves the timings null without ANALYZE, so the view knows to show costs", () => {
    const n = build(node());
    expect(n.inclusiveMs).toBeNull();
    expect(n.selfMs).toBeNull();
    expect(n.actualRows).toBeNull();
    expect(n.misestimate).toBeNull();
    expect(n.cost).toBe(10);
  });

  it("separates the time spent in a node from the time spent in its children", () => {
    const n = build(
      node({
        "Actual Total Time": 10,
        "Actual Loops": 1,
        Plans: [node({ "Actual Total Time": 6, "Actual Loops": 1 }), node({ "Actual Total Time": 1, "Actual Loops": 1 })],
      }),
    );
    expect(n.inclusiveMs).toBe(10);
    expect(n.selfMs).toBe(3);
    expect(n.children[0].selfMs).toBe(6);
  });

  it("multiplies the per-loop figures by the loop count, which is how Postgres reports them", () => {
    const n = build(node({ "Actual Total Time": 2, "Actual Loops": 50, "Actual Rows": 3, "Plan Rows": 3 }));
    expect(n.inclusiveMs).toBe(100);
    expect(n.actualRows).toBe(150);
    expect(n.planRows).toBe(150);
    expect(n.misestimate).toBe(1);
  });

  it("never reports negative self time, which rounding in the server can imply", () => {
    const n = build(node({ "Actual Total Time": 1, "Actual Loops": 1, Plans: [node({ "Actual Total Time": 1.4, "Actual Loops": 1 })] }));
    expect(n.selfMs).toBe(0);
  });

  it("measures the estimate error in both directions", () => {
    expect(build(node({ "Plan Rows": 10, "Actual Rows": 1000, "Actual Loops": 1 })).misestimate).toBe(100);
    expect(build(node({ "Plan Rows": 1000, "Actual Rows": 10, "Actual Loops": 1 })).misestimate).toBe(100);
  });

  it("treats zero and one row as the same, so an empty scan is not a 1000x error", () => {
    expect(build(node({ "Plan Rows": 1, "Actual Rows": 0, "Actual Loops": 1 })).misestimate).toBe(1);
    expect(build(node({ "Plan Rows": 0, "Actual Rows": 1, "Actual Loops": 1 })).misestimate).toBe(1);
  });

  it("names whatever the node reads", () => {
    expect(build(node({ "Relation Name": "orders" })).target).toBe("orders");
    expect(build(node({ "Index Name": "orders_pkey" })).target).toBe("orders_pkey");
    expect(build(node({ "CTE Name": "recent" })).target).toBe("recent");
    expect(build(node()).target).toBeNull();
  });

  it("builds the whole tree", () => {
    const n = build(node({ Plans: [node({ Plans: [node()] })] }));
    expect(n.children[0].children[0].type).toBe("Seq Scan");
  });
});

describe("details", () => {
  it("keeps the keys that explain a node and drops the empty ones", () => {
    expect(details(node({ Filter: "(id > 5)", "Rows Removed by Filter": 42 }))).toEqual([
      ["Filter", "(id > 5)"],
      ["Rows Removed by Filter", "42"],
    ]);
  });

  it("omits zero and empty values, which say nothing", () => {
    expect(details(node({ Filter: "", "Rows Removed by Filter": 0, "Shared Read Blocks": 0 }))).toEqual([]);
  });

  it("ignores keys it does not know about", () => {
    expect(details(node({ "Parallel Aware": false, Alias: "o" }))).toEqual([]);
  });
});
