import { describe, expect, it } from "vitest";
import { describeMismatch, type Job, jobNoun, keptBackup, stepLabel } from "./transfer";

const job = (over: Partial<Job>): Job => ({
  id: "j",
  kind: "transfer",
  state: "done",
  log: [],
  error: null,
  elapsedMs: 0,
  bytes: 0,
  file: null,
  steps: [],
  report: null,
  ...over,
});

describe("describeMismatch", () => {
  const at = { schema: "public", table: "orders" };

  it("says how many rows are missing when a table arrived short", () => {
    expect(describeMismatch({ ...at, source: 20000, target: 19990 })).toBe("holds 19,990 of 20,000 rows — 10 missing");
  });

  it("tells a table that never arrived from one that arrived empty", () => {
    expect(describeMismatch({ ...at, source: 20000, target: null })).toBe("never arrived — 20,000 rows missing");
    expect(describeMismatch({ ...at, source: 20000, target: 0 })).toBe("holds 0 of 20,000 rows — 20,000 missing");
    expect(describeMismatch({ ...at, source: 0, target: null })).toBe("never arrived");
  });

  it("reads a surplus as rows that were already there", () => {
    expect(describeMismatch({ ...at, source: 100, target: 130 })).toBe("holds 130 rows, 30 more than the 100 that were sent");
  });
});

describe("keptBackup", () => {
  it("offers the backup only when the transfer stopped short with one in hand", () => {
    expect(keptBackup(job({ state: "failed", file: "/tmp/x/shop.dumpdir" }))).toBe("/tmp/x/shop.dumpdir");
    expect(keptBackup(job({ state: "cancelled", file: "/tmp/x/shop.dumpdir" }))).toBe("/tmp/x/shop.dumpdir");
    expect(keptBackup(job({ state: "failed", file: null }))).toBeNull();
  });

  it("never offers one that is still being written, or that belongs to another kind of job", () => {
    expect(keptBackup(job({ state: "running", file: "/tmp/x/shop.dumpdir" }))).toBeNull();
    expect(keptBackup(job({ kind: "dump", state: "failed", file: "/tmp/shop.dump" }))).toBeNull();
  });
});

describe("labels", () => {
  it("names every step the backend reports, and passes an unknown one through", () => {
    for (const key of ["dump", "restore", "verify", "analyze", "cleanup"]) expect(stepLabel(key)).not.toBe(key);
    expect(stepLabel("something-new")).toBe("something-new");
  });

  it("names each kind of job", () => {
    expect([jobNoun("dump"), jobNoun("restore"), jobNoun("transfer")]).toEqual(["Backup", "Restore", "Copy"]);
  });
});
