import { cx } from "../../components/ui";

export const TYPE_META: Record<string, { label: string; className: string }> = {
  string: { label: "STR", className: "text-t-time bg-t-time/10 border-t-time/25" },
  hash: { label: "HASH", className: "text-t-json bg-t-json/10 border-t-json/25" },
  list: { label: "LIST", className: "text-t-num bg-t-num/10 border-t-num/25" },
  set: { label: "SET", className: "text-t-bool bg-t-bool/10 border-t-bool/25" },
  zset: { label: "ZSET", className: "text-danger bg-danger/10 border-danger/25" },
  stream: { label: "STRM", className: "text-t-uuid bg-t-uuid/10 border-t-uuid/25" },
  "ReJSON-RL": { label: "JSON", className: "text-iris bg-iris-soft border-iris-line" },
};

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  const m = TYPE_META[type] ?? { label: type.slice(0, 4).toUpperCase(), className: "text-muted bg-raised border-line" };
  return (
    <span className={cx("inline-flex h-[17px] w-[38px] shrink-0 items-center justify-center rounded border font-mono text-[9.5px] font-bold tracking-wide", m.className, className)}>
      {m.label}
    </span>
  );
}

/** Formats a reply the way redis-cli does. */
export function formatReply(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return "(nil)";
  if (typeof v === "number") return Number.isInteger(v) ? `(integer) ${v}` : `(double) ${v}`;
  if (typeof v === "boolean") return v ? "(true)" : "(false)";
  if (typeof v === "string") return v === "OK" || v === "PONG" || v === "QUEUED" ? v : JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "(empty array)";
    const w = String(v.length).length;
    return v
      .map((item, i) => {
        const prefix = `${String(i + 1).padStart(w)}) `;
        const body = formatReply(item, indent + " ".repeat(prefix.length));
        return (i === 0 ? "" : indent) + prefix + body;
      })
      .join("\n");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if ("error" in (v as object) && entries.length === 1) return `(error) ${(v as { error: string }).error}`;
    return entries.map(([k, val], i) => `${i === 0 ? "" : indent}${JSON.stringify(k)} => ${formatReply(val, indent + "   ")}`).join("\n");
  }
  return String(v);
}

const WRITE_COMMANDS = new Set(
  "SET SETEX PSETEX SETNX MSET MSETNX GETSET GETDEL APPEND INCR INCRBY INCRBYFLOAT DECR DECRBY DEL UNLINK RENAME RENAMENX EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST HSET HMSET HSETNX HDEL HINCRBY HINCRBYFLOAT LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LSET LREM LTRIM LINSERT LMOVE RPOPLPUSH SADD SREM SPOP SMOVE ZADD ZREM ZINCRBY ZPOPMIN ZPOPMAX ZREMRANGEBYSCORE ZREMRANGEBYRANK XADD XDEL XTRIM FLUSHDB FLUSHALL RESTORE COPY MOVE SWAPDB JSON.SET JSON.DEL".split(" "),
);
export const isWriteCommand = (line: string) => WRITE_COMMANDS.has(line.trim().split(/\s+/)[0]?.toUpperCase() ?? "");
