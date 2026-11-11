// What a transfer job reports, and how to say it. The job itself is run by the
// backend (`transfer.rs`); this is only the reading of it.

import { formatInt } from "./format";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface Step {
  key: string;
  state: StepState;
  detail: string | null;
  ms: number | null;
}

export interface Mismatch {
  schema: string;
  table: string;
  source: number;
  /** null when the table never arrived. */
  target: number | null;
}

export interface TransferReport {
  tables: number;
  rows: number;
  mismatches: Mismatch[];
}

export interface Job {
  id: string;
  kind: "dump" | "restore" | "transfer";
  state: "running" | "done" | "failed" | "cancelled";
  log: string[];
  error: string | null;
  elapsedMs: number;
  bytes: number;
  file: string | null;
  steps: Step[];
  report: TransferReport | null;
}

const STEP_LABELS: Record<string, string> = {
  dump: "Back up the source",
  restore: "Restore into the target",
  verify: "Compare every table",
  analyze: "Collect statistics",
  cleanup: "Delete the backup",
};

export const stepLabel = (key: string) => STEP_LABELS[key] ?? key;

export const jobNoun = (kind: Job["kind"]) => (kind === "dump" ? "Backup" : kind === "restore" ? "Restore" : "Copy");

/** What is wrong with one table, in the terms someone deciding what to do next needs. */
export function describeMismatch(m: Mismatch): string {
  if (m.target == null) return m.source === 0 ? "never arrived" : `never arrived — ${formatInt(m.source)} rows missing`;
  const gap = m.target - m.source;
  // More than was sent means the rows landed on top of some that were already there.
  if (gap > 0) return `holds ${formatInt(m.target)} rows, ${formatInt(gap)} more than the ${formatInt(m.source)} that were sent`;
  return `holds ${formatInt(m.target)} of ${formatInt(m.source)} rows — ${formatInt(-gap)} missing`;
}

/** A backup that outlived its transfer, which only a whole one that was never proven to have arrived does. */
export function keptBackup(job: Job): string | null {
  return job.kind === "transfer" && job.state !== "running" && job.state !== "done" ? job.file : null;
}
