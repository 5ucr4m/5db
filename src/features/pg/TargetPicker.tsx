import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Field, Input, Select } from "../../components/ui";
import { ENV_META } from "../../lib/connections";
import { errorMessage, rpc } from "../../lib/rpc";
import { useApp } from "../../store/app";

export interface Target {
  connectionId: string;
  database: string;
}

export const NO_TARGET: Target = { connectionId: "", database: "" };

/**
 * Where something lands: a saved PostgreSQL connection, and one database on it.
 * The two are picked separately because a server holds many databases, and a
 * fresh one is the usual shape of a migration.
 */
export function TargetPicker({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: Target;
  onChange: (t: Target) => void;
  disabled?: boolean;
}) {
  const connections = useApp((s) => s.connections);
  const toast = useApp((s) => s.toast);
  const targets = connections.filter((c) => c.kind === "postgres");
  const target = targets.find((c) => c.id === value.connectionId);

  // The databases that actually exist on the chosen server.
  const [dbs, setDbs] = useState<{ name: string }[] | null>(null);
  const [listed, setListed] = useState(0);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `listed` is the request to read the server again
  useEffect(() => {
    setDbs(null);
    if (!value.connectionId) return;
    let stale = false;
    rpc<{ name: string }[]>("pg.databases", { connectionId: value.connectionId })
      .then((list) => !stale && setDbs(list))
      .catch((e) => {
        if (stale) return;
        toast("error", errorMessage(e));
        setDbs([]);
      });
    return () => {
      stale = true;
    };
  }, [value.connectionId, listed, toast]);

  const create = async () => {
    const name = newName.trim();
    if (!name || !value.connectionId) return;
    setCreating(true);
    try {
      await rpc("pg.createDatabase", { connectionId: value.connectionId, name });
      toast("ok", `Created ${name}`);
      setNewName("");
      setListed((n) => n + 1);
      onChange({ ...value, database: name });
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  // Kept selectable while the list is being read again, and when it could not be.
  const known = dbs?.some((d) => d.name === value.database) ?? false;

  return (
    <>
      <Field label={label} hint="Any saved PostgreSQL connection, including one on another server.">
        <Select
          value={value.connectionId}
          disabled={disabled}
          onChange={(e) => {
            const picked = targets.find((c) => c.id === e.target.value);
            onChange({ connectionId: e.target.value, database: picked?.database ?? "" });
          }}
        >
          <option value="">Pick a connection…</option>
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.host} ({ENV_META[c.env]?.label ?? c.env})
            </option>
          ))}
        </Select>
      </Field>

      {target && (
        <Field
          label="Database on that server"
          hint="It all lands in one database. Make a new one when it should not land on top of anything."
        >
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={value.database}
              onChange={(e) => onChange({ ...value, database: e.target.value })}
              disabled={disabled || !dbs}
            >
              {!dbs ? (
                <option value={value.database}>Reading the server…</option>
              ) : (
                <>
                  <option value="">Pick a database…</option>
                  {value.database && !known && <option value={value.database}>{value.database}</option>}
                  {dbs.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              mono
              className="h-8 flex-1 text-xs"
              value={newName}
              disabled={disabled}
              placeholder="or create one: neoprop_novo"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) void create();
              }}
            />
            <Button
              size="sm"
              className="h-8"
              icon={<Plus className="size-3.5" />}
              onClick={create}
              loading={creating}
              disabled={disabled || !newName.trim()}
            >
              Create
            </Button>
          </div>
        </Field>
      )}
    </>
  );
}
