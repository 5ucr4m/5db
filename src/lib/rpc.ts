// One RPC surface for the whole app. Inside Tauri it goes through IPC; in a
// plain browser (`pnpm bridge` + `pnpm dev`) it goes to the dev HTTP bridge.

export interface RpcError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: number;
}

export class RpcFailure extends Error {
  readonly info: RpcError;
  constructor(info: RpcError) {
    super(info.message);
    this.info = info;
  }
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEV_BRIDGE = (import.meta.env.VITE_DEV_BRIDGE as string | undefined) ?? "http://127.0.0.1:1430/rpc";

let tauriInvoke: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    if (!tauriInvoke) tauriInvoke = (await import("@tauri-apps/api/core")).invoke;
    try {
      return (await tauriInvoke("rpc", { method, params })) as T;
    } catch (e) {
      throw new RpcFailure(normalize(e));
    }
  }
  let res: Response;
  try {
    res = await fetch(DEV_BRIDGE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new RpcFailure({ message: "The dev bridge is not running. Start it with `pnpm bridge`." });
  }
  const body = (await res.json()) as { ok: boolean; data?: T; error?: RpcError };
  if (!body.ok) throw new RpcFailure(body.error ?? { message: "Unknown error" });
  return body.data as T;
}

function normalize(e: unknown): RpcError {
  if (e && typeof e === "object" && "message" in e) return e as RpcError;
  return { message: String(e) };
}

export function errorMessage(e: unknown): string {
  if (e instanceof RpcFailure) return e.info.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
