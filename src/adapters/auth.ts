import type { AdapterDefinition } from "./registry.js";
import { spawnCommandSync } from "../platform/process.js";
import { parseAdapterErrorEnvelope, describeAdapterError } from "../../adapters/error-envelope.mjs";
import type { Result } from "../types.js";
function hasCredentialFields(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set(["access_token", "refresh_token", "id_token", "tokens", "authorization", "client_secret", "private_key", "password"]);
  return Object.entries(value).some(([key, item]) => forbidden.has(key.toLowerCase()) || hasCredentialFields(item, depth + 1));
}
export function runAdapterAuth(adapter: AdapterDefinition, input: Record<string, unknown>): Result<{ auth: Record<string, unknown> }> {
  if (!adapter.auth) return { ok: false, issues: [{ code: "auth.unsupported", message: "この接続は公開認証入口に対応していません。接続手順を確認してください。" }] };
  const child = spawnCommandSync(adapter.auth.executable, adapter.auth.args, { cwd: process.cwd(), input: JSON.stringify(input), encoding: "utf8", timeout: input.action === "cached" ? 10_000 : input.action === "login" ? 360_000 : 60_000, maxBuffer: 100_000 });
  if (child.error || child.signal || child.status !== 0) {
    const envelope = parseAdapterErrorEnvelope(child.stderr ?? "");
    return { ok: false, issues: [{ code: envelope ? `auth.${envelope.code}` : "auth.failed", message: envelope ? describeAdapterError(envelope.code) : "接続操作の結果を確認できませんでした。生成は開始していません。", ...(envelope ? { adapter_error: envelope } : {}) }] };
  }
  try {
    const auth = JSON.parse(child.stdout);
    if (!auth || auth.schema_version !== 1 || auth.kind !== "tsugite.connection-auth" || auth.action !== input.action || auth.generated !== false || hasCredentialFields(auth)) throw new Error();
    return { ok: true, issues: [], auth };
  } catch { return { ok: false, issues: [{ code: "auth.invalid_result", message: "接続の確認結果を安全に読み取れませんでした。" }] }; }
}

export function readAdapterAuthCache(adapter: AdapterDefinition) {
  if (!adapter.auth) return undefined;
  const result = runAdapterAuth(adapter, { action: "cached" });
  if (!result.ok) return { configured: null, checked_at: null, cache_only: true };
  const value = result.auth;
  return { configured: typeof value.configured === "boolean" ? value.configured : null,
    checked_at: typeof value.checked_at === "string" ? value.checked_at : null,
    ...(typeof value.expired === "boolean" ? { expired: value.expired } : {}), cache_only: true };
}
export async function withConnectionCaches<T extends { adapter?: string }>(connections: T[]) {
  const { loadAdapterDefinition } = await import("./registry.js");
  return Promise.all(connections.map(async connection => {
    const adapter = connection.adapter ? await loadAdapterDefinition(connection.adapter).catch(() => undefined) : undefined;
    const connectionStatus = adapter ? readAdapterAuthCache(adapter) : undefined;
    return { ...connection, ...(connectionStatus ? { connectionStatus } : {}) };
  }));
}
