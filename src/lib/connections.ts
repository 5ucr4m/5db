import type { ConnectionConfig, ConnectionKind, EnvTag } from "./types";

export const CONNECTION_COLORS = ["#8b6cff", "#4cb4ff", "#2ec4b6", "#3dd68c", "#f5b84b", "#ff7a59", "#ff6b9a", "#8fa3bf"];

export const ENV_META: Record<EnvTag, { label: string; color: string; description: string }> = {
  local: { label: "Local", color: "#8fa3bf", description: "Your machine" },
  dev: { label: "Dev", color: "#3dd68c", description: "Shared development" },
  staging: { label: "Staging", color: "#f5b84b", description: "Pre-production" },
  prod: { label: "Production", color: "#ff6b81", description: "Asks before destructive statements" },
};

export function blankConnection(kind: ConnectionKind = "postgres"): ConnectionConfig {
  return {
    id: "",
    name: "",
    kind,
    color: CONNECTION_COLORS[0],
    env: "local",
    host: "localhost",
    port: kind === "postgres" ? 5432 : 6379,
    user: kind === "postgres" ? "postgres" : "",
    password: "",
    database: kind === "postgres" ? "postgres" : "",
    sslMode: "prefer",
    redisDb: 0,
    tls: false,
    readOnly: false,
    sshEnabled: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshPassword: "",
    sshKeyPath: "",
    sshPassphrase: "",
  };
}

/** Parses postgres://, postgresql://, redis:// and rediss:// URLs into a partial config. */
export function parseConnectionUrl(raw: string): Partial<ConnectionConfig> | null {
  const text = raw.trim();
  const m = /^(postgres(?:ql)?|rediss?):\/\//i.exec(text);
  if (!m) return null;
  let url: URL;
  try {
    // URL() does not know these schemes' authority rules; borrow http's.
    url = new URL(text.replace(/^[a-z]+:\/\//i, "http://"));
  } catch {
    return null;
  }
  const scheme = m[1].toLowerCase();
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const path = dec(url.pathname.replace(/^\//, ""));
  if (scheme.startsWith("redis")) {
    return {
      kind: "redis",
      host: url.hostname || "localhost",
      port: url.port ? Number(url.port) : 6379,
      user: dec(url.username),
      password: dec(url.password),
      redisDb: path && /^\d+$/.test(path) ? Number(path) : 0,
      tls: scheme === "rediss",
    };
  }
  const ssl = url.searchParams.get("sslmode");
  return {
    kind: "postgres",
    host: url.hostname || "localhost",
    port: url.port ? Number(url.port) : 5432,
    user: dec(url.username) || "postgres",
    password: dec(url.password),
    database: path || "postgres",
    sslMode: ssl === "disable" || ssl === "require" || ssl === "verify-full" ? ssl : ssl === "verify-ca" ? "verify-full" : "prefer",
  };
}

export function connectionSummary(c: ConnectionConfig): string {
  const host = `${c.host || "localhost"}:${c.port}${c.sshEnabled ? ` via ${c.sshHost}` : ""}`;
  return c.kind === "postgres" ? `${c.user ? c.user + "@" : ""}${host}/${c.database}` : `${host} · db ${c.redisDb}`;
}

export function monogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
