import { useEffect, useState } from "react";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { errorMessage, rpc } from "../../lib/rpc";
import { useApp, type Session } from "../../store/app";

export function NewKeyDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: Session }) {
  const [type, setType] = useState("string");
  const [key, setKey] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const bumpKeys = useApp((s) => s.bumpKeys);
  const openTab = useApp((s) => s.openTab);

  useEffect(() => {
    if (open) {
      setKey("");
      setA("");
      setB("");
      setTtl("");
    }
  }, [open]);

  const labels: Record<string, [string, string | null]> = {
    string: ["Value", null],
    hash: ["Field", "Value"],
    list: ["First element", null],
    set: ["First member", null],
    zset: ["Member", "Score"],
    stream: ["Field", "Value"],
  };
  const [la, lb] = labels[type];

  const create = async () => {
    if (!key.trim()) return;
    setBusy(true);
    const db = Number(session.database);
    const call = (args: string[]) => rpc("redis.command", { connectionId: session.connectionId, db, args });
    try {
      const exists = (await call(["EXISTS", key])) as { value: number };
      if (exists.value) {
        toast("error", `A key named “${key}” already exists.`);
        return;
      }
      const cmd: Record<string, string[]> = {
        string: ["SET", key, a],
        hash: ["HSET", key, a || "field", b],
        list: ["RPUSH", key, a],
        set: ["SADD", key, a],
        zset: ["ZADD", key, b || "0", a],
        stream: ["XADD", key, "*", a || "field", b],
      };
      await call(cmd[type]);
      const seconds = Number(ttl);
      if (ttl && seconds > 0) await call(["EXPIRE", key, String(Math.floor(seconds))]);
      bumpKeys(session.id);
      openTab(session.id, { kind: "redis-key", title: key, key });
      toast("ok", `Created ${key}`);
      onClose();
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New key"
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={create}>
            Create key
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="string">String</option>
              <option value="hash">Hash</option>
              <option value="list">List</option>
              <option value="set">Set</option>
              <option value="zset">Sorted set</option>
              <option value="stream">Stream</option>
            </Select>
          </Field>
          <Field label="Key">
            <Input autoFocus mono placeholder="user:42:profile" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
        <div className={lb ? "grid grid-cols-2 gap-3" : ""}>
          <Field label={la}>
            <Input mono value={a} onChange={(e) => setA(e.target.value)} />
          </Field>
          {lb && (
            <Field label={lb}>
              <Input mono value={b} onChange={(e) => setB(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Expire after (seconds)" hint="Leave empty to keep the key forever.">
          <Input mono inputMode="numeric" placeholder="3600" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
