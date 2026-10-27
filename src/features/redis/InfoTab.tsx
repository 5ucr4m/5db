import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { IconButton, Input, Spinner } from "../../components/ui";
import { formatInt } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import type { RedisInfo } from "../../lib/types";
import { type Session, useApp } from "../../store/app";

function uptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function InfoTab({ session, active }: { session: Session; active: boolean }) {
  const [info, setInfo] = useState<RedisInfo | null>(session.redisInfo ?? null);
  const [filter, setFilter] = useState("");
  const toast = useApp((s) => s.toast);
  const load = useCallback(async () => {
    try {
      setInfo(await rpc<RedisInfo>("redis.info", { connectionId: session.connectionId, db: Number(session.database) }));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [session.connectionId, session.database, toast]);
  useEffect(() => {
    void load();
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, active]);

  if (!info)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const s = info.sections;
  const get = (sec: string, k: string) => s[sec]?.[k];
  const hits = Number(get("stats", "keyspace_hits") ?? 0);
  const misses = Number(get("stats", "keyspace_misses") ?? 0);
  const totalKeys = Object.values(s.keyspace ?? {}).reduce((n, v) => n + Number(/keys=(\d+)/.exec(v)?.[1] ?? 0), 0);
  const cards: [string, string, string?][] = [
    ["Version", get("server", "redis_version") ?? get("server", "valkey_version") ?? "—", get("server", "redis_mode")],
    [
      "Uptime",
      uptime(Number(get("server", "uptime_in_seconds") ?? 0)),
      `since ${new Date(Date.now() - Number(get("server", "uptime_in_seconds") ?? 0) * 1000).toLocaleDateString()}`,
    ],
    ["Memory", get("memory", "used_memory_human") ?? "—", `peak ${get("memory", "used_memory_peak_human") ?? "—"}`],
    ["Clients", formatInt(Number(get("clients", "connected_clients") ?? 0)), `${get("clients", "blocked_clients") ?? 0} blocked`],
    [
      "Ops / sec",
      formatInt(Number(get("stats", "instantaneous_ops_per_sec") ?? 0)),
      `${formatInt(Number(get("stats", "total_commands_processed") ?? 0))} total`,
    ],
    [
      "Hit rate",
      hits + misses ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : "—",
      `${formatInt(hits)} hits · ${formatInt(misses)} misses`,
    ],
    ["Keys", formatInt(totalKeys), `${Object.keys(s.keyspace ?? {}).length} databases in use`],
  ];
  const q = filter.toLowerCase();

  return (
    <div className="selectable h-full overflow-auto px-8 py-6">
      <div className="mb-5 flex items-center gap-3">
        <h2 className="font-display text-xl font-bold">Server</h2>
        <span className="font-mono text-xs text-muted">{get("server", "os")}</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-faint" />
            <Input className="h-7 pl-7 text-xs" placeholder="Find a metric" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <IconButton label="Refresh" onClick={load}>
            <RefreshCw className="size-3.5" />
          </IconButton>
        </div>
      </div>
      {!q && (
        <div className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
          {cards.map(([k, v, sub]) => (
            <div key={k} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-2xs font-semibold tracking-wider text-faint uppercase">{k}</div>
              <div className="mt-1 font-display text-2xl font-semibold tabular">{v}</div>
              {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
        {Object.entries(s).map(([section, kv]) => {
          const entries = Object.entries(kv).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q));
          if (!entries.length) return null;
          return (
            <section key={section} className="rounded-xl border border-line bg-panel">
              <h3 className="border-b border-line px-4 py-2 font-display text-sm font-semibold capitalize">{section}</h3>
              <dl className="max-h-72 overflow-auto px-4 py-2 font-mono text-[11.5px]">
                {entries.map(([k, v]) => (
                  <div key={k} className="flex gap-3 border-b border-line/40 py-1 last:border-0">
                    <dt className="w-1/2 shrink-0 truncate text-muted" title={k}>
                      {k}
                    </dt>
                    <dd className="min-w-0 break-all text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
