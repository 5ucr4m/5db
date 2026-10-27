import { CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, FolderOpen, KeyRound, Link, PlugZap, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, cx, Field, Input, Modal, Segmented, Select, Toggle } from "../../components/ui";
import { blankConnection, CONNECTION_COLORS, ENV_META, parseConnectionUrl } from "../../lib/connections";
import { formatDuration } from "../../lib/format";
import { errorMessage, isTauri, rpc } from "../../lib/rpc";
import type { ConnectionConfig, ConnectionKind, EnvTag } from "../../lib/types";
import { useApp } from "../../store/app";

type TestState = { status: "idle" } | { status: "running" } | { status: "ok"; summary: string } | { status: "error"; message: string };

export function ConnectionForm({ open, initial, onClose }: { open: boolean; initial: ConnectionConfig | null; onClose: () => void }) {
  const saveConnection = useApp((s) => s.saveConnection);
  const openSession = useApp((s) => s.openSession);
  const toast = useApp((s) => s.toast);
  const [c, setC] = useState<ConnectionConfig>(initial ?? blankConnection());
  const [url, setUrl] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setC(initial ?? blankConnection());
      setUrl("");
      setTest({ status: "idle" });
      setShowPw(false);
    }
  }, [open, initial]);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => {
    setC((prev) => ({ ...prev, [k]: v }));
    setTest({ status: "idle" });
  };

  const switchKind = (kind: ConnectionKind) => {
    if (kind === c.kind) return;
    const fresh = blankConnection(kind);
    setC((prev) => ({
      ...fresh,
      id: prev.id,
      name: prev.name,
      color: prev.color,
      env: prev.env,
      host: prev.host,
      sshEnabled: prev.sshEnabled,
      sshHost: prev.sshHost,
      sshPort: prev.sshPort,
      sshUser: prev.sshUser,
      sshPassword: prev.sshPassword,
      sshKeyPath: prev.sshKeyPath,
      sshPassphrase: prev.sshPassphrase,
    }));
    setTest({ status: "idle" });
  };

  const applyUrl = (text: string) => {
    setUrl(text);
    const parsed = parseConnectionUrl(text);
    if (parsed) {
      setC((prev) => {
        const base =
          parsed.kind && parsed.kind !== prev.kind
            ? { ...blankConnection(parsed.kind), id: prev.id, color: prev.color, env: prev.env }
            : prev;
        const next = { ...base, ...parsed } as ConnectionConfig;
        if (!prev.name) next.name = parsed.kind === "redis" ? `${parsed.host}` : `${parsed.database} on ${parsed.host}`;
        return next;
      });
      setTest({ status: "idle" });
    }
  };
  const urlInvalid = url.trim().length > 0 && !parseConnectionUrl(url);

  const runTest = async () => {
    setTest({ status: "running" });
    try {
      const r = await rpc<{ version: string; latencyMs: number; pong?: string; viaSsh?: boolean }>(
        "connections.test",
        c as unknown as Record<string, unknown>,
      );
      const version = c.kind === "postgres" ? r.version.split(" on ")[0].split(",")[0] : `Redis ${r.version}`;
      setTest({ status: "ok", summary: `${version} · ${formatDuration(r.latencyMs)}${r.viaSsh ? " · via SSH" : ""}` });
    } catch (e) {
      setTest({ status: "error", message: errorMessage(e) });
    }
  };

  const save = async (connect: boolean) => {
    if (!c.name.trim()) {
      toast("error", "Give the connection a name.");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveConnection({
        ...c,
        name: c.name.trim(),
        port: Number(c.port) || (c.kind === "postgres" ? 5432 : 6379),
        sshPort: Number(c.sshPort) || 22,
      });
      onClose();
      if (connect) await openSession(saved.id);
      else toast("ok", `Saved “${saved.name}”`);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const envOptions = useMemo(
    () => (Object.keys(ENV_META) as EnvTag[]).map((e) => ({ value: e, label: ENV_META[e].label, title: ENV_META[e].description })),
    [],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={initial?.id ? `Edit ${initial.name}` : "New connection"}
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center gap-2 text-xs">
            <Button size="sm" icon={<PlugZap className="size-3.5" />} loading={test.status === "running"} onClick={runTest}>
              Test connection
            </Button>
            {test.status === "ok" && (
              <span className="flex min-w-0 items-center gap-1 text-ok">
                <CheckCircle2 className="size-3.5 shrink-0" />
                <span className="truncate">{test.summary}</span>
              </span>
            )}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => save(false)} loading={saving}>
            Save
          </Button>
          <Button variant="primary" onClick={() => save(true)} loading={saving}>
            Save and connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <Segmented
            value={c.kind}
            onChange={switchKind}
            options={[
              { value: "postgres", label: "PostgreSQL" },
              { value: "redis", label: "Redis" },
            ]}
          />
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Color">
            {CONNECTION_COLORS.map((col) => (
              <button
                type="button"
                key={col}
                role="radio"
                aria-checked={c.color === col}
                aria-label={`Color ${col}`}
                onClick={() => set("color", col)}
                className={cx(
                  "size-5 rounded-full transition-transform hover:scale-110",
                  c.color === col && "ring-2 ring-fg ring-offset-2 ring-offset-panel",
                )}
                style={{ background: col }}
              />
            ))}
          </div>
        </div>

        <Field
          label="Paste a connection URL"
          hint={
            urlInvalid ? (
              <span className="text-danger">Not a postgres:// or redis:// URL.</span>
            ) : (
              "Fills in the fields below. Nothing is saved until you press Save."
            )
          }
        >
          <div className="relative">
            <Link className="pointer-events-none absolute top-2 left-2.5 size-4 text-faint" />
            <Input
              mono
              className="pl-8"
              placeholder={c.kind === "postgres" ? "postgres://user:password@host:5432/database" : "redis://:password@host:6379/0"}
              value={url}
              onChange={(e) => applyUrl(e.target.value)}
            />
          </div>
        </Field>

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Name">
            <Input
              autoFocus
              value={c.name}
              placeholder={c.kind === "postgres" ? "Shop production" : "Session cache"}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Environment">
            <Segmented size="md" value={c.env} onChange={(v) => set("env", v)} options={envOptions} />
          </Field>
        </div>

        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Host">
            <Input mono value={c.host} placeholder="localhost" onChange={(e) => set("host", e.target.value)} />
          </Field>
          <Field label="Port">
            <Input
              mono
              inputMode="numeric"
              value={c.port || ""}
              onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={c.kind === "postgres" ? "User" : "Username (ACL)"}>
            <Input
              mono
              value={c.user}
              placeholder={c.kind === "postgres" ? "postgres" : "default"}
              onChange={(e) => set("user", e.target.value)}
            />
          </Field>
          <Field label="Password">
            <div className="relative">
              <Input
                mono
                type={showPw ? "text" : "password"}
                value={c.password}
                className="pr-8"
                onChange={(e) => set("password", e.target.value)}
              />
              <button
                type="button"
                className="absolute top-1.5 right-1.5 rounded p-0.5 text-faint hover:text-fg"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
        </div>

        {c.kind === "postgres" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database">
              <Input mono value={c.database} placeholder="postgres" onChange={(e) => set("database", e.target.value)} />
            </Field>
            <Field label="SSL">
              <Select value={c.sslMode} onChange={(e) => set("sslMode", e.target.value as ConnectionConfig["sslMode"])}>
                <option value="prefer">Prefer (use if available)</option>
                <option value="require">Require</option>
                <option value="verify-full">Require and verify certificate</option>
                <option value="disable">Disable</option>
              </Select>
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database index">
              <Input
                mono
                inputMode="numeric"
                value={c.redisDb}
                onChange={(e) => set("redisDb", Number(e.target.value.replace(/\D/g, "")) || 0)}
              />
            </Field>
            <div className="flex items-end pb-1.5">
              <Toggle checked={c.tls} onChange={(v) => set("tls", v)} label="Use TLS (rediss://)" />
            </div>
          </div>
        )}

        {c.kind === "postgres" && (
          <Toggle
            checked={c.readOnly}
            onChange={(v) => set("readOnly", v)}
            label={
              <span>
                Read-only session <span className="text-muted">— the server rejects any write</span>
              </span>
            }
          />
        )}

        <SshSection c={c} set={set} />

        {test.status === "error" && (
          <div className="selectable flex gap-2 rounded-lg border border-danger/30 bg-danger/8 p-3 text-sm">
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div>
              <div className="font-medium text-fg">Could not connect</div>
              <div className="mt-0.5 font-mono text-xs break-words text-muted">{test.message}</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SshSection({ c, set }: { c: ConnectionConfig; set: <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => void }) {
  const [open, setOpen] = useState(c.sshEnabled);
  const [auth, setAuth] = useState<"password" | "key">(c.sshKeyPath ? "key" : "password");
  const [showPw, setShowPw] = useState(false);
  useEffect(() => {
    if (c.sshEnabled) setOpen(true);
  }, [c.sshEnabled]);

  const pickKey = async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const path = await openDialog({ multiple: false, directory: false, title: "Choose a private key" });
    if (typeof path === "string") set("sshKeyPath", path);
  };

  return (
    <div className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
        {open ? <ChevronDown className="size-3.5 text-faint" /> : <ChevronRight className="size-3.5 text-faint" />}
        <KeyRound className="size-3.5 text-iris" />
        <span className="font-medium">SSH tunnel</span>
        <span className="text-xs text-muted">
          {c.sshEnabled ? `through ${c.sshUser || "…"}@${c.sshHost || "…"}` : "reach a database behind a bastion"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line p-3">
          <Toggle checked={c.sshEnabled} onChange={(v) => set("sshEnabled", v)} label="Connect through SSH" />
          {c.sshEnabled && (
            <>
              <p className="text-xs text-muted">
                The database host and port above are resolved from the SSH server, so use the address the bastion sees (often an internal
                name).
              </p>
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="SSH host">
                  <Input mono placeholder="bastion.example.com" value={c.sshHost} onChange={(e) => set("sshHost", e.target.value)} />
                </Field>
                <Field label="SSH port">
                  <Input
                    mono
                    inputMode="numeric"
                    value={c.sshPort || ""}
                    onChange={(e) => set("sshPort", Number(e.target.value.replace(/\D/g, "")) || 0)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                <Field label="SSH user">
                  <Input mono placeholder="ubuntu" value={c.sshUser} onChange={(e) => set("sshUser", e.target.value)} />
                </Field>
                <Segmented
                  value={auth}
                  onChange={(v) => {
                    setAuth(v);
                    if (v === "password") set("sshKeyPath", "");
                  }}
                  options={[
                    { value: "password", label: "Password" },
                    { value: "key", label: "Private key" },
                  ]}
                />
              </div>
              {auth === "password" ? (
                <Field label="SSH password">
                  <div className="relative">
                    <Input
                      mono
                      type={showPw ? "text" : "password"}
                      className="pr-8"
                      value={c.sshPassword}
                      onChange={(e) => set("sshPassword", e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute top-1.5 right-1.5 rounded p-0.5 text-faint hover:text-fg"
                      aria-label={showPw ? "Hide SSH password" : "Show SSH password"}
                      onClick={() => setShowPw((v) => !v)}
                    >
                      {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </Field>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Private key file">
                    <div className="flex gap-1">
                      <Input
                        mono
                        placeholder="~/.ssh/id_ed25519"
                        value={c.sshKeyPath}
                        onChange={(e) => set("sshKeyPath", e.target.value)}
                      />
                      {isTauri && (
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          icon={<FolderOpen className="size-3.5" />}
                          onClick={pickKey}
                          aria-label="Choose key file"
                        />
                      )}
                    </div>
                  </Field>
                  <Field label="Key passphrase" hint="Only if the key is encrypted.">
                    <Input mono type="password" value={c.sshPassphrase} onChange={(e) => set("sshPassphrase", e.target.value)} />
                  </Field>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
