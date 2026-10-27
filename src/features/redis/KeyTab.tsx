import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, Check, Clock, Copy, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Button, IconButton, Input, Popover, Spinner, cx } from "../../components/ui";
import { copyText } from "../../lib/export";
import { formatBytes, formatInt, formatTtl, tryPrettyJson } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import type { RedisValue } from "../../lib/types";
import { useApp, useConnection, type Session, type Tab } from "../../store/app";
import { TypeBadge } from "./common";

type KeyTabT = Extract<Tab, { kind: "redis-key" }>;

export function KeyTab({ session, tab }: { session: Session; tab: KeyTabT }) {
  const [data, setData] = useState<RedisValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useApp((s) => s.toast);
  const confirm = useApp((s) => s.confirm);
  const bumpKeys = useApp((s) => s.bumpKeys);
  const closeTab = useApp((s) => s.closeTab);
  const updateTab = useApp((s) => s.updateTab);
  const pinTab = useApp((s) => s.pinTab);
  const conn = useConnection(session.connectionId);
  const db = Number(session.database);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await rpc<RedisValue>("redis.get", { connectionId: session.connectionId, db, key: tab.key }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [session.connectionId, db, tab.key]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a mutation, then reloads the value. */
  const run = useCallback(
    async (args: string[], okMessage?: string) => {
      try {
        await rpc("redis.command", { connectionId: session.connectionId, db, args });
        pinTab(session.id, tab.id);
        if (okMessage) toast("ok", okMessage);
        await load();
        return true;
      } catch (e) {
        toast("error", errorMessage(e));
        return false;
      }
    },
    [session.connectionId, session.id, db, tab.id, load, toast, pinTab],
  );

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${tab.key}?`,
      body: conn?.env === "prod" ? "This is a production connection. The key is removed immediately." : "The key and its value are removed immediately.",
      confirmLabel: "Delete key",
      danger: true,
    });
    if (!ok) return;
    try {
      await rpc("redis.command", { connectionId: session.connectionId, db, args: ["DEL", tab.key] });
      bumpKeys(session.id);
      closeTab(session.id, tab.id);
      toast("ok", `Deleted ${tab.key}`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const rename = async (next: string) => {
    if (!next || next === tab.key) return;
    try {
      await rpc("redis.command", { connectionId: session.connectionId, db, args: ["RENAMENX", tab.key, next] }).then((r) => {
        if ((r as { value: number }).value === 0) throw new Error(`A key named “${next}” already exists.`);
      });
      updateTab(session.id, tab.id, { key: next, title: next, preview: false } as Partial<Tab>);
      bumpKeys(session.id);
      toast("ok", `Renamed to ${next}`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <div className="text-muted">{error}</div>
        <Button size="sm" onClick={() => (bumpKeys(session.id), closeTab(session.id, tab.id))}>
          Close tab
        </Button>
      </div>
    );
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <KeyHeader data={data} loading={loading} onReload={load} onDelete={remove} onRename={rename} onTtl={(args) => run(args, "Updated expiry")} />
      <div className="min-h-0 flex-1">
        {data.type === "string" || data.type === "ReJSON-RL" ? (
          <StringEditor value={String(data.value ?? "")} truncated={data.truncated} onSave={(v) => run(data.type === "string" ? ["SET", tab.key, v, "KEEPTTL"] : ["JSON.SET", tab.key, "$", v], "Saved")} />
        ) : data.type === "hash" ? (
          <ItemsTable
            data={data}
            columns={["Field", "Value"]}
            rows={(data.value as { field: string; value: string }[]).map((r) => [r.field, r.value])}
            editableCol={1}
            onEdit={(row, v) => run(["HSET", tab.key, row[0], v])}
            onDelete={(row) => run(["HDEL", tab.key, row[0]])}
            addFields={["Field", "Value"]}
            onAdd={([f, v]) => run(["HSET", tab.key, f, v])}
          />
        ) : data.type === "list" ? (
          <ItemsTable
            data={data}
            columns={["Index", "Element"]}
            rows={(data.value as string[]).map((v, i) => [String(i), v])}
            editableCol={1}
            onEdit={(row, v) => run(["LSET", tab.key, row[0], v])}
            onDelete={(row) => run(["LREM", tab.key, "1", row[1]])}
            addFields={["Element"]}
            addLabel="Append"
            onAdd={([v]) => run(["RPUSH", tab.key, v])}
            extraAdd={{ label: "Prepend", run: ([v]) => run(["LPUSH", tab.key, v]) }}
          />
        ) : data.type === "set" ? (
          <ItemsTable
            data={data}
            columns={["Member"]}
            rows={(data.value as string[]).map((v) => [v])}
            onDelete={(row) => run(["SREM", tab.key, row[0]])}
            addFields={["Member"]}
            onAdd={([v]) => run(["SADD", tab.key, v])}
          />
        ) : data.type === "zset" ? (
          <ItemsTable
            data={data}
            columns={["Member", "Score"]}
            rows={(data.value as { member: string; score: string }[]).map((r) => [r.member, r.score])}
            editableCol={1}
            onEdit={(row, v) => run(["ZADD", tab.key, v, row[0]])}
            onDelete={(row) => run(["ZREM", tab.key, row[0]])}
            addFields={["Member", "Score"]}
            onAdd={([m, s]) => run(["ZADD", tab.key, s || "0", m])}
            numericCol={1}
          />
        ) : data.type === "stream" ? (
          <ItemsTable
            data={data}
            columns={["Entry ID", "Fields"]}
            rows={(data.value as { id: string; fields: Record<string, string> }[]).map((e) => [e.id, JSON.stringify(e.fields)])}
            onDelete={(row) => run(["XDEL", tab.key, row[0]])}
            addFields={["Field", "Value"]}
            addLabel="Add entry"
            onAdd={([f, v]) => run(["XADD", tab.key, "*", f, v])}
          />
        ) : (
          <div className="p-6 text-sm text-muted">Values of type “{data.type}” can be inspected in the console.</div>
        )}
      </div>
    </div>
  );
}

function KeyHeader({
  data,
  loading,
  onReload,
  onDelete,
  onRename,
  onTtl,
}: {
  data: RedisValue;
  loading: boolean;
  onReload: () => void;
  onDelete: () => void;
  onRename: (k: string) => void;
  onTtl: (args: string[]) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(data.key);
  const [ttlOpen, setTtlOpen] = useState(false);
  const [ttl, setTtl] = useState("");
  const ttlRef = useRef<HTMLButtonElement>(null);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    setName(data.key);
  }, [data.key]);

  const setExpiry = async (seconds: number | null) => {
    const ok = await onTtl(seconds == null ? ["PERSIST", data.key] : ["EXPIRE", data.key, String(seconds)]);
    if (ok) setTtlOpen(false);
  };

  return (
    <div className="shrink-0 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <TypeBadge type={data.type} />
        {renaming ? (
          <form
            className="flex flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setRenaming(false);
              onRename(name.trim());
            }}
          >
            <Input autoFocus mono className="h-7 flex-1" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRenaming(false)} />
            <IconButton size="sm" label="Rename" type="submit">
              <Check className="size-3.5" />
            </IconButton>
          </form>
        ) : (
          <h2 className="selectable min-w-0 truncate font-mono text-[15px] font-semibold">{data.key}</h2>
        )}
        {!renaming && (
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton size="sm" label="Copy key name" onClick={() => (void copyText(data.key), toast("ok", "Copied key name"))}>
              <Copy className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Rename key" onClick={() => setRenaming(true)}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Reload value" onClick={onReload}>
              <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
            </IconButton>
            <IconButton size="sm" label="Delete key" className="hover:!text-danger" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <button ref={ttlRef} onClick={() => (setTtl(data.ttlMs > 0 ? String(Math.round(data.ttlMs / 1000)) : ""), setTtlOpen(true))} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-raised hover:text-fg">
          <Clock className={cx("size-3.5", data.ttlMs >= 0 && "text-warn")} />
          {data.ttlMs >= 0 ? `Expires in ${formatTtl(data.ttlMs)}` : "No expiry"}
        </button>
        {data.type !== "string" && <span>{formatInt(data.length)} {data.type === "hash" ? "fields" : data.type === "stream" ? "entries" : "items"}</span>}
        {data.type === "string" && <span>{formatBytes(data.length)}</span>}
        {data.memoryBytes != null && <span>{formatBytes(data.memoryBytes)} in memory</span>}
        {data.encoding && <span className="font-mono">{data.encoding}</span>}
      </div>
      <Popover anchor={ttlRef.current} open={ttlOpen} onClose={() => setTtlOpen(false)} className="w-64 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(ttl);
            if (n > 0) void setExpiry(Math.floor(n));
          }}
        >
          <div className="mb-2 text-xs font-medium">Expire after</div>
          <div className="flex gap-1.5">
            <Input autoFocus mono className="h-7" inputMode="numeric" placeholder="seconds" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ""))} />
            <Button size="sm" variant="primary" type="submit" disabled={!Number(ttl)}>
              Set
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {[
              ["1 min", 60],
              ["1 hour", 3600],
              ["1 day", 86400],
              ["1 week", 604800],
            ].map(([l, s]) => (
              <button key={l} type="button" className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-iris hover:text-iris" onClick={() => void setExpiry(s as number)}>
                {l}
              </button>
            ))}
          </div>
          {data.ttlMs >= 0 && (
            <button type="button" className="mt-3 text-xs text-iris hover:underline" onClick={() => void setExpiry(null)}>
              Remove expiry (keep forever)
            </button>
          )}
        </form>
      </Popover>
    </div>
  );
}

function StringEditor({ value, truncated, onSave }: { value: string; truncated: boolean; onSave: (v: string) => Promise<boolean> }) {
  const pretty = useMemo(() => tryPrettyJson(value), [value]);
  const [format, setFormat] = useState(pretty != null);
  const shown = format && pretty != null ? pretty : value;
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(shown);
  }, [shown]);
  const dirty = draft !== shown;
  const save = async () => {
    let out = draft;
    if (format && pretty != null) {
      try {
        out = JSON.stringify(JSON.parse(draft));
      } catch {
        /* keep text as typed */
      }
    }
    setSaving(true);
    await onSave(out);
    setSaving(false);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        {pretty != null && (
          <button className={cx("flex items-center gap-1 rounded px-1.5 py-0.5", format ? "bg-iris-soft text-iris" : "text-muted hover:bg-raised")} onClick={() => setFormat((v) => !v)}>
            <Braces className="size-3.5" /> JSON
          </button>
        )}
        {truncated && <span className="text-warn">Showing the first 1 MB. Saving would overwrite the rest.</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(shown)}>
              Revert
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || truncated} loading={saving} onClick={save} kbd="⌘S">
            Save value
          </Button>
        </div>
      </div>
      <textarea
        className="min-h-0 flex-1 resize-none bg-panel p-4 font-mono text-[12.5px] leading-relaxed text-fg outline-none"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            if (dirty && !truncated) void save();
          }
        }}
      />
    </div>
  );
}

function ItemsTable({
  data,
  columns,
  rows,
  editableCol,
  onEdit,
  onDelete,
  addFields,
  addLabel = "Add",
  onAdd,
  extraAdd,
  numericCol,
}: {
  data: RedisValue;
  columns: string[];
  rows: string[][];
  editableCol?: number;
  onEdit?: (row: string[], value: string) => Promise<boolean>;
  onDelete: (row: string[]) => Promise<boolean>;
  addFields: string[];
  addLabel?: string;
  onAdd: (values: string[]) => Promise<boolean>;
  extraAdd?: { label: string; run: (values: string[]) => Promise<boolean> };
  numericCol?: number;
}) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ i: number; value: string } | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.some((c) => c.toLowerCase().includes(q)));
  }, [rows, filter]);

  const submitAdd = async (fn: (v: string[]) => Promise<boolean>) => {
    if (!adding || !adding[0]) return;
    if (await fn(adding)) setAdding(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-faint" />
          <Input className="h-6 pl-7 text-xs" placeholder={`Filter ${formatInt(rows.length)} loaded`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {data.truncated && <span className="text-xs text-warn">Showing the first {formatInt(rows.length)} of {formatInt(data.length)}</span>}
        <Button size="sm" variant="subtle" className="ml-auto" icon={<Plus className="size-3.5" />} onClick={() => setAdding(addFields.map(() => ""))}>
          {addLabel}
        </Button>
      </div>
      {adding && (
        <form
          className="flex shrink-0 animate-fade-in items-center gap-2 border-b border-line bg-iris-soft/40 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAdd(onAdd);
          }}
        >
          {addFields.map((f, i) => (
            <Input key={f} autoFocus={i === 0} mono className="h-7 flex-1" placeholder={f} value={adding[i]} onChange={(e) => setAdding(adding.map((x, j) => (j === i ? e.target.value : x)))} />
          ))}
          <Button size="sm" variant="primary" type="submit" disabled={!adding[0]}>
            {addLabel}
          </Button>
          {extraAdd && (
            <Button size="sm" type="button" disabled={!adding[0]} onClick={() => void submitAdd(extraAdd.run)}>
              {extraAdd.label}
            </Button>
          )}
          <IconButton size="sm" label="Cancel" type="button" onClick={() => setAdding(null)}>
            <X className="size-3.5" />
          </IconButton>
        </form>
      )}
      <div className="selectable min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              {columns.map((c, i) => (
                <th key={c} className={cx("border-b border-line px-3 py-2 text-left font-sans text-2xs font-semibold tracking-wider text-faint uppercase", i === 0 && columns.length > 1 && "w-[34%]")}>
                  {c}
                </th>
              ))}
              <th className="w-16 border-b border-line" />
            </tr>
          </thead>
          <tbody>
            {shown.map(({ r, i }) => (
              <tr key={`${i}:${r[0]}`} className="group border-b border-line/60 align-top hover:bg-raised/60">
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cx("px-3 py-1.5 break-all", ci === 0 && columns.length > 1 ? "text-fg" : "text-muted", numericCol === ci && "text-t-num tabular")}
                    onDoubleClick={() => editableCol === ci && onEdit && setEditing({ i, value: cell })}
                  >
                    {editing?.i === i && editableCol === ci ? (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (await onEdit!(r, editing.value)) setEditing(null);
                        }}
                      >
                        <textarea
                          autoFocus
                          rows={Math.min(8, Math.max(1, editing.value.split("\n").length))}
                          className="w-full resize-none rounded border border-iris bg-raised px-1.5 py-1 text-fg outline-none"
                          value={editing.value}
                          onChange={(e) => setEditing({ i, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setEditing(null);
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              (e.currentTarget.form as HTMLFormElement).requestSubmit();
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <span className="whitespace-pre-wrap">{cell}</span>
                    )}
                  </td>
                ))}
                <td className="px-2 py-1 text-right whitespace-nowrap opacity-0 group-hover:opacity-100">
                  {editableCol != null && onEdit && (
                    <IconButton size="sm" label="Edit" onClick={() => setEditing({ i, value: r[editableCol] })}>
                      <Pencil className="size-3" />
                    </IconButton>
                  )}
                  <IconButton size="sm" label="Remove" className="hover:!text-danger" onClick={() => void onDelete(r)}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="p-6 text-center text-sm text-muted">{filter ? "Nothing matches." : "Empty."}</p>}
      </div>
    </div>
  );
}
