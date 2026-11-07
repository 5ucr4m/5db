import { AlertTriangle, ArrowRight, Check, Database, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, cx, Select, Spinner } from "../../components/ui";
import { ENV_META, monogram } from "../../lib/connections";
import { formatBytes } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import type { ConnectionConfig } from "../../lib/types";
import { type Session, useApp } from "../../store/app";

interface Capabilities {
  serverVersion: string;
  serverVersionFull: string;
  major: number;
  walLevel: string;
  logicalReplication: { available: boolean; blockers: string[] };
}

/** What the link between the two servers is doing. */
type LinkState =
  | { kind: "unconfigured" }
  | { kind: "blocked"; blockers: string[] }
  | { kind: "ready" }
  | { kind: "copying"; done: number; total: number }
  | { kind: "streaming"; lagBytes: number };

// Past this the target is far enough behind to be worth looking at, and the
// stream is drawn as backpressure rather than as a healthy trickle.
const LAG_WARN_BYTES = 16 * 1024 * 1024;

/**
 * One endpoint, wearing the identity it already has everywhere else in the app:
 * its own colour, its monogram, its environment ring. A generic box here would
 * make the screen belong to no particular product.
 */
function Endpoint({
  side,
  connection,
  connections,
  onPick,
  caps,
}: {
  side: "source" | "target";
  connection: ConnectionConfig | undefined;
  connections: ConnectionConfig[];
  onPick: (id: string) => void;
  caps: Capabilities | null;
}) {
  const env = connection ? (ENV_META[connection.env] ?? ENV_META.local) : null;
  return (
    <div className="flex w-[280px] shrink-0 flex-col gap-2 self-stretch">
      <span className="text-2xs font-semibold tracking-[0.14em] text-faint uppercase">
        {side === "source" ? "Publishes from" : "Subscribes on"}
      </span>

      <div
        className={cx(
          // flex-1 inside a stretched column, so a name that wraps to two
          // lines does not leave the two cards ending at different heights.
          "flex flex-1 flex-col gap-3 rounded-xl border bg-panel p-4 transition-colors",
          connection ? "border-line" : "border-dashed border-line-strong",
        )}
        style={connection && env ? { boxShadow: `inset 3px 0 0 0 ${env.color}` } : undefined}
      >
        <div className="flex items-center gap-2.5">
          {connection ? (
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-[10px] font-display text-[12px] font-bold text-white"
              style={{ background: connection.color }}
            >
              {monogram(connection.name)}
            </span>
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-line-strong text-faint">
              <Database className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <div
              className="font-display text-[16px] leading-tight font-semibold [display:-webkit-box] [overflow:hidden] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
              title={connection?.name}
            >
              {connection?.name ?? (side === "source" ? "Pick a source" : "Pick a target")}
            </div>
            {connection && env && <div className="mt-0.5 text-xs text-muted">{env.label}</div>}
          </div>
        </div>

        <Select value={connection?.id ?? ""} onChange={(e) => onPick(e.target.value)} aria-label={`${side} connection`}>
          <option value="">Choose a connection…</option>
          {connections.map((c) => (
            // The database first, because that is what is being picked, then
            // the connection name to tell two of the same database apart. A
            // long name truncating here costs nothing: the card shows it whole.
            <option key={c.id} value={c.id} title={`${c.name} — ${c.database} on ${c.host}`}>
              {c.database} · {c.name}
            </option>
          ))}
        </Select>

        {connection ? (
          caps ? (
            <div className="mt-auto flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-faint" title={caps.serverVersionFull}>
                PostgreSQL {caps.serverVersion}
              </span>
              <span
                className={cx(
                  "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  caps.walLevel === "logical" ? "border-ok/30 bg-ok/10 text-ok" : "border-warn/30 bg-warn/10 text-warn",
                )}
                title="Logical replication needs the write-ahead log to carry row changes"
              >
                wal_level={caps.walLevel}
              </span>
            </div>
          ) : (
            <span className="font-mono text-[11px] text-faint">reading server settings…</span>
          )
        ) : (
          <span className="text-[11px] text-faint">Both servers have to be saved connections first.</span>
        )}
      </div>
    </div>
  );
}

/**
 * The link. Logical replication holds write-ahead log in a slot until the
 * subscriber confirms it, so the stream is drawn as what it is: thin and calm
 * when the target keeps up, thickening and warming as the slot fills. Dots move
 * only while data moves.
 */
function Link({ state }: { state: LinkState }) {
  const flowing = state.kind === "copying" || state.kind === "streaming";
  const behind = state.kind === "streaming" && state.lagBytes >= LAG_WARN_BYTES;
  const stroke = state.kind === "blocked" ? "var(--danger)" : behind ? "var(--warn)" : flowing ? "var(--iris)" : "var(--line-strong)";
  // Backpressure, drawn: the stream swells as the slot falls behind.
  const width = state.kind === "streaming" ? Math.min(2 + Math.log10(Math.max(state.lagBytes, 1) / 1024 + 1) * 1.6, 7) : 2;

  // The same column structure as an endpoint — an eyebrow it does not use,
  // then a body that fills the rest — so the line lands on the cards' centre
  // line instead of wherever a hand-tuned offset happened to put it.
  return (
    <div className="flex w-[180px] shrink-0 flex-col gap-2 self-stretch">
      <span className="text-2xs tracking-[0.14em] uppercase invisible" aria-hidden="true">
        link
      </span>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <svg viewBox="0 0 200 24" className="h-6 w-full" role="img" aria-label={linkSummary(state)}>
          <title>{linkSummary(state)}</title>
          <line
            x1="0"
            y1="12"
            x2="186"
            y2="12"
            stroke={stroke}
            strokeWidth={width}
            strokeLinecap="round"
            strokeDasharray={flowing ? "6 6" : state.kind === "ready" ? undefined : "4 6"}
            className={flowing ? "repl-flow" : undefined}
            opacity={flowing || state.kind === "ready" ? 1 : 0.6}
          />
          <path d="M186 6 L198 12 L186 18 Z" fill={stroke} opacity={flowing || state.kind === "ready" ? 1 : 0.6} />
        </svg>

        <div className="flex h-5 items-center gap-1.5 text-center font-mono text-[11px]">
          {state.kind === "streaming" ? (
            <span className={behind ? "text-warn" : "text-muted"}>
              {state.lagBytes === 0 ? "caught up" : `${formatBytes(state.lagBytes)} behind`}
            </span>
          ) : state.kind === "copying" ? (
            <span className="text-iris">
              copying {state.done}/{state.total} tables
            </span>
          ) : state.kind === "ready" ? (
            <span className="text-muted">ready to start</span>
          ) : state.kind === "blocked" ? (
            <span className="flex items-center gap-1 text-danger">
              <AlertTriangle className="size-3" /> cannot replicate
            </span>
          ) : (
            <span className="text-faint">not configured</span>
          )}
        </div>
      </div>
    </div>
  );
}

function linkSummary(s: LinkState): string {
  switch (s.kind) {
    case "streaming":
      return s.lagBytes === 0 ? "Replicating, the target is caught up" : `Replicating, the target is ${formatBytes(s.lagBytes)} behind`;
    case "copying":
      return `Copying ${s.done} of ${s.total} tables before streaming begins`;
    case "ready":
      return "Ready to start replicating";
    case "blocked":
      return `Replication is not possible: ${s.blockers.join("; ")}`;
    default:
      return "No replication configured";
  }
}

export function ReplicationTab({ session }: { session: Session }) {
  const connections = useApp((s) => s.connections);
  const toast = useApp((s) => s.toast);

  const candidates = useMemo(() => connections.filter((c) => c.kind === "postgres"), [connections]);
  const [sourceId, setSourceId] = useState(session.connectionId);
  const [targetId, setTargetId] = useState("");
  const [caps, setCaps] = useState<Record<string, Capabilities | null>>({});

  const source = candidates.find((c) => c.id === sourceId);
  const target = candidates.find((c) => c.id === targetId);

  // Each server is asked once what it allows, so the screen can refuse early
  // and say why instead of failing halfway through a setup.
  const probe = useCallback(
    async (id: string) => {
      if (!id || caps[id] !== undefined) return;
      setCaps((c) => ({ ...c, [id]: null }));
      try {
        const got = await rpc<Capabilities>("pg.capabilities", { connectionId: id });
        setCaps((c) => ({ ...c, [id]: got }));
      } catch (e) {
        toast("error", errorMessage(e));
        setCaps((c) => {
          const { [id]: _, ...rest } = c;
          return rest;
        });
      }
    },
    [caps, toast],
  );

  useEffect(() => {
    void probe(sourceId);
  }, [sourceId, probe]);
  useEffect(() => {
    void probe(targetId);
  }, [targetId, probe]);

  const blockers = useMemo(() => {
    const out: string[] = [];
    // Only the source has to stream; the target only has to accept a
    // subscription, which any server can do.
    const sc = sourceId ? caps[sourceId] : undefined;
    if (sc && !sc.logicalReplication.available) out.push(...sc.logicalReplication.blockers.map((b) => `Source: ${b}`));
    if (source && target && source.id === target.id) out.push("The source and the target are the same connection.");
    return out;
  }, [caps, source, sourceId, target]);

  const probing = (sourceId && caps[sourceId] === null) || (targetId && caps[targetId] === null);
  const state: LinkState =
    !source || !target ? { kind: "unconfigured" } : blockers.length ? { kind: "blocked", blockers } : { kind: "ready" };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <ArrowRight className="size-4 text-iris" />
        <h2 className="font-display text-[15px] font-semibold">Replication</h2>
        <span className="text-xs text-muted">Keep a second server following this one, change by change</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-[820px] items-center justify-center gap-5 px-8 pt-10 pb-8">
          <Endpoint
            side="source"
            connection={source}
            connections={candidates}
            onPick={setSourceId}
            caps={sourceId ? (caps[sourceId] ?? null) : null}
          />
          <Link state={state} />
          <Endpoint
            side="target"
            connection={target}
            connections={candidates.filter((c) => c.id !== sourceId)}
            onPick={setTargetId}
            caps={targetId ? (caps[targetId] ?? null) : null}
          />
        </div>

        <div className="mx-auto max-w-[820px] px-8 pb-10">
          {probing ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted">
              <Spinner className="size-4" /> Reading what these servers allow…
            </div>
          ) : state.kind === "blocked" ? (
            <div className="selectable rounded-lg border border-danger/30 bg-danger/[0.06] p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <AlertTriangle className="size-4 text-danger" />
                This pair cannot replicate yet
              </div>
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {blockers.map((b) => (
                  <li key={b} className="flex gap-2">
                    <span className="text-danger">—</span>
                    {b}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-faint">
                These are server settings, not something 5db can change. On a managed provider they are usually a toggle in the console,
                followed by a restart.
              </p>
            </div>
          ) : state.kind === "ready" ? (
            <div className="selectable rounded-lg border border-line bg-panel p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <Check className="size-4 text-ok" />
                Both servers allow it
              </div>
              <p className="mt-2 text-sm text-muted">
                Starting will copy the structure of {source?.database} to {target?.database}, create a publication here and a subscription
                there, then stream every change as it happens.
              </p>
              <p className="mt-2 text-xs text-faint">
                Logical replication does not carry schema changes. 5db watches for them and tells you when the two drift apart.
              </p>
            </div>
          ) : (
            <p className="text-center text-sm text-muted">Pick the server to publish from and the one to subscribe on.</p>
          )}

          {state.kind === "ready" && (
            <div className="mt-5 flex justify-center">
              <Button variant="primary" icon={<Play className="size-3.5 fill-current" />}>
                Start replicating
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
