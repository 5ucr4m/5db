export type TypeFamily = "num" | "text" | "time" | "bool" | "json" | "uuid" | "array" | "binary" | "enum" | "other";

/** Maps a Postgres type (as `format_type` or OID name prints it) to a visual family. */
export function typeFamily(dataType: string, category?: string): TypeFamily {
  const t = dataType.toLowerCase();
  if (t.endsWith("[]") || t.startsWith("_") || category === "A") return "array";
  if (category === "E") return "enum";
  // The integer alternatives are anchored: an unanchored `^int` also matches
  // "interval", which is a time type.
  if (/^(small|big)?int(2|4|8|eger)?$|^numeric|^decimal|^real$|^double|^float|^money$|^(big|small)?serial|^oid$/.test(t)) return "num";
  if (/^bool/.test(t)) return "bool";
  if (/^json/.test(t)) return "json";
  if (/^uuid/.test(t)) return "uuid";
  if (/^bytea/.test(t)) return "binary";
  if (/^(timestamp|date|time|interval)/.test(t)) return "time";
  if (/^(text|character|varchar|char|bpchar|name|citext)/.test(t)) return "text";
  if (category === "N") return "num";
  if (category === "D") return "time";
  if (category === "S") return "text";
  if (category === "B") return "bool";
  return "other";
}

export const familyGlyph: Record<TypeFamily, string> = {
  num: "#",
  text: "Aa",
  time: "◷",
  bool: "◐",
  json: "{}",
  uuid: "id",
  array: "[]",
  binary: "01",
  enum: "≡",
  other: "·",
};

export const familyColor: Record<TypeFamily, string> = {
  num: "text-t-num",
  text: "text-muted",
  time: "text-t-time",
  bool: "text-t-bool",
  json: "text-t-json",
  uuid: "text-t-uuid",
  array: "text-t-json",
  binary: "text-faint",
  enum: "text-iris",
  other: "text-faint",
};

const nf = new Intl.NumberFormat("en-US");
export const formatInt = (n: number | null | undefined) => (n == null ? "—" : nf.format(n));

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTtl(ms: number): string {
  if (ms === -1) return "No expiry";
  if (ms === -2) return "Expired";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function tryPrettyJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);
