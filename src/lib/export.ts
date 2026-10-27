import { isTauri, rpc } from "./rpc";
import type { Cell } from "./types";

function csvField(v: Cell): string {
  if (v == null) return "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  return [columns.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))].join("\n") + "\n";
}

export function toTsv(columns: string[] | null, rows: Cell[][]): string {
  const clean = (v: Cell) => (v == null ? "" : v.replace(/[\t\n\r]/g, " "));
  const body = rows.map((r) => r.map(clean).join("\t"));
  return (columns ? [columns.join("\t"), ...body] : body).join("\n");
}

export function toJson(columns: string[], rows: Cell[][]): string {
  return (
    JSON.stringify(
      rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
      null,
      2,
    ) + "\n"
  );
}

export function toMarkdown(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v == null ? "NULL" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));
  return (
    [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join(
      "\n",
    ) + "\n"
  );
}

/** Asks for a destination path. Returns null if the user cancelled. In the browser build, `null` path means "download". */
export async function pickSavePath(defaultName: string, ext: string): Promise<string | null | "download"> {
  if (!isTauri) return "download";
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return path ?? null;
}

/** Saves text to a user-chosen file. Returns the path (or file name) on success, null when cancelled. */
export async function saveText(defaultName: string, ext: string, contents: string): Promise<string | null> {
  const target = await pickSavePath(defaultName, ext);
  if (target === null) return null;
  if (target === "download") {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return defaultName;
  }
  await rpc("fs.writeText", { path: target, contents });
  return target;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
