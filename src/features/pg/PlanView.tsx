import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../../components/ui";
import { formatDuration, formatInt } from "../../lib/format";
import { build, details, num, type PlanNode, type RawPlan } from "../../lib/plan";

export { parsePlan } from "../../lib/plan";

function Row({ node, depth, worstSelf, analyzed }: { node: PlanNode; depth: number; worstSelf: number; analyzed: boolean }) {
  const [open, setOpen] = useState(true);
  const extra = details(node.raw);
  const share = analyzed && worstSelf > 0 ? (node.selfMs ?? 0) / worstSelf : 0;
  // Ten times out is where a bad estimate starts producing a bad plan.
  const badEstimate = node.misestimate != null && node.misestimate >= 10;

  return (
    <div>
      <div
        className={cx("flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised", share > 0.5 && "bg-warn/[0.07]")}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {node.children.length ? (
          <button type="button" className="mt-0.5 text-faint hover:text-fg" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="mt-0.5 size-3.5 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium text-fg">{node.type}</span>
            {node.target && <span className="font-mono text-xs text-iris">{node.target}</span>}
            {node.loops > 1 && <span className="text-2xs text-faint">×{formatInt(node.loops)} loops</span>}

            {analyzed ? (
              <span className="ml-auto flex items-center gap-2 tabular">
                <span className="text-xs text-muted" title="Time in this node alone">
                  {formatDuration(node.selfMs ?? 0)}
                </span>
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
                  <span
                    className={cx("block h-full rounded-full", share > 0.5 ? "bg-warn" : "bg-iris")}
                    style={{ width: `${Math.max(share * 100, 2)}%` }}
                  />
                </span>
              </span>
            ) : (
              <span className="ml-auto text-xs text-muted tabular" title="Estimated total cost">
                cost {node.cost.toFixed(0)}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-faint">
            <span>
              rows {formatInt(node.planRows)} est
              {node.actualRows != null && (
                <>
                  {" · "}
                  <span className={badEstimate ? "text-warn" : undefined}>{formatInt(node.actualRows)} actual</span>
                </>
              )}
            </span>
            {badEstimate && (
              <span className="flex items-center gap-1 font-sans text-warn">
                <AlertTriangle className="size-3" />
                {node.misestimate!.toFixed(0)}× out
              </span>
            )}
            {extra.map(([k, v]) => (
              <span key={k} className="max-w-[48ch] truncate" title={`${k}: ${v}`}>
                <span className="text-muted">{k}:</span> {v}
              </span>
            ))}
          </div>
        </div>
      </div>

      {open && node.children.map((c, i) => <Row key={i} node={c} depth={depth + 1} worstSelf={worstSelf} analyzed={analyzed} />)}
    </div>
  );
}

export function PlanView({ plan }: { plan: RawPlan }) {
  const root = useMemo(() => build(plan.Plan), [plan]);
  const analyzed = root.inclusiveMs != null;
  const worstSelf = useMemo(() => {
    let worst = 0;
    const walk = (n: PlanNode) => {
      worst = Math.max(worst, n.selfMs ?? 0);
      n.children.forEach(walk);
    };
    walk(root);
    return worst;
  }, [root]);

  const planning = num(plan["Planning Time"]);
  const execution = num(plan["Execution Time"]);

  return (
    <div className="selectable flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-4 py-2 text-xs">
        {!analyzed && (
          <span className="text-muted">
            Estimates only. Use <b className="font-semibold text-fg">Analyze</b> to measure the real thing.
          </span>
        )}
        {planning != null && (
          <span className="text-muted">
            Planning <span className="text-fg tabular">{formatDuration(planning)}</span>
          </span>
        )}
        {execution != null && (
          <span className="text-muted">
            Execution <span className="text-fg tabular">{formatDuration(execution)}</span>
          </span>
        )}
        <span className="text-muted">
          Total cost <span className="text-fg tabular">{root.cost.toFixed(0)}</span>
        </span>
        {analyzed && <span className="ml-auto text-faint">The bar is the time in that node alone, against the slowest one.</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 pr-3">
        <Row node={root} depth={0} worstSelf={worstSelf} analyzed={analyzed} />
      </div>
    </div>
  );
}
