import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAUTH, keychainAccessToken, keychainCredentialSession, withElevenGrantBinding, elevenOAuthStatus } from "../adapters/elevenlabs-v4/oauth.mjs";
import { cachedProfileStatus } from "../adapters/elevenlabs-v4/profile.mjs";
const discovery = JSON.parse(await readFile(new URL("./fixtures/elevenlabs-oauth-discovery.json", import.meta.url), "utf8"));
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = () => ({ version: 1, issuer: OAUTH.issuer, resource: OAUTH.resource, client_id: "https://client.example/tsugite.json", scope: OAUTH.scopes, grant_epoch: "fixture-epoch", expires_at: 1,
  tokens: { access_token: "fixture-expired", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: OAUTH.scopes } });
async function rootDir() { const root = await mkdtemp(join(tmpdir(), "tsugite-oauth-lock-")); roots.push(root); return root; }
function child(root, checkpoint) {
  const proc = spawn(process.execPath, [resolve("test/fixtures/elevenlabs-oauth-process-child.mjs"), root, ...(checkpoint ? [checkpoint] : [])], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let text = ""; proc.stdout.on("data", value => text += value);
  const ready = checkpoint ? new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error("fixture checkpoint timeout")), 10_000); proc.once("message", msg => { clearTimeout(timer); done(msg); }); proc.once("exit", () => clearTimeout(timer)); }) : undefined;
  return { proc, ready, exited: new Promise(done => proc.once("exit", (code, signal) => done({ code, signal, output: text }))) };
}
function fetchFixture(counter) { return async url => {
  if (String(url) === OAUTH.resourceMetadata) return Response.json(discovery.resource);
  if (String(url) === OAUTH.metadata) return Response.json(discovery.metadata);
  if (String(url) !== OAUTH.token) throw new Error("fixture denied network");
  counter.count++;
  return Response.json({ access_token: "fixture-new", refresh_token: "fixture-rotated", token_type: "Bearer", expires_in: 3600, scope: OAUTH.scopes });
}; }
describe("dedicated OAuth profile process coordination", () => {
  it("A04 reloads after the process lock so two processes rotate the token only once", async () => {
    const root = await rootDir(); await writeFile(join(root, "dummy-record.json"), JSON.stringify(record()));
    const a = child(root), b = child(root), results = await Promise.all([a.exited, b.exited]);
    expect(results.every(r => r.code === 0 && JSON.parse(r.output).expected_fixture_token === true)).toBe(true);
    expect(await readFile(join(root, "refresh-trace.txt"), "utf8")).toBe("refresh\n");
    const saved = JSON.parse(await readFile(join(root, "dummy-record.json"))); expect(saved.grant_epoch).toBe("fixture-epoch"); expect(saved.credential_revision).toMatch(/^[a-f0-9-]{36}$/);
    expect((await readdir(root)).includes("refresh-intent.json")).toBe(false);
    const cached = await cachedProfileStatus({ profileDirectory: root }); expect(cached).toMatchObject({ configured: true, cache_only: true });
    expect(JSON.stringify(cached)).not.toMatch(/fixture-new|fixture-rotated/);
  }, 20_000);
  it("A05 retains rotation uncertainty after process death and never sends the old refresh token again", async () => {
    const root = await rootDir(); await writeFile(join(root, "dummy-record.json"), JSON.stringify(record()));
    const stopped = child(root, "refresh"); try { expect(await stopped.ready).toBe("refresh"); } finally { stopped.proc.kill("SIGKILL"); }
    expect((await stopped.exited).signal).toBe("SIGKILL");
    const next = await child(root).exited; expect(JSON.parse(next.output)).toMatchObject({ ok: false, code: "oauth_refresh_uncertain" });
    expect(await readFile(join(root, "refresh-trace.txt"), "utf8")).toBe("refresh\n");
    expect(await readFile(join(root, "refresh-intent.json"), "utf8")).not.toMatch(/fixture-refresh|fixture-expired/);
  }, 20_000);
  it("A05 stops after refresh succeeds but secure save fails", async () => {
    const root = await rootDir(), counter = { count: 0 }, saved = record();
    const options = { profileDirectory: root, store: { load: async () => saved, save: async () => { throw new Error("private OS failure"); } }, fetchImpl: fetchFixture(counter) };
    await expect(keychainAccessToken(options)).rejects.toThrow("oauth_refresh_failed");
    await expect(keychainAccessToken(options)).rejects.toThrow("oauth_refresh_uncertain"); expect(counter.count).toBe(1);
  });
  it("A07 binds token and epoch from one snapshot and stops a replaced grant before paid acceptance", async () => {
    const root = await rootDir(); let saved = { ...record(), expires_at: Date.now() + 3600_000 };
    const options = { profileDirectory: root, store: { load: async () => saved } }, action = vi.fn();
    const session = await keychainCredentialSession(options);
    saved = { ...saved, grant_epoch: "replacement" };
    await expect(withElevenGrantBinding(session.binding, action, options)).rejects.toThrow("billing_connection_changed"); expect(action).not.toHaveBeenCalled();
  });
  it("A02 status and cache reads never create files, refresh or save", async () => {
    const root = await rootDir(), save = vi.fn(), fetchImpl = vi.fn();
    expect((await cachedProfileStatus({ profileDirectory: root })).configured).toBeNull();
    await elevenOAuthStatus({ store: { load: async () => record(), save }, fetchImpl });
    expect(await readdir(root)).toEqual([]); expect(save).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("A09 public and direct login entry points enforce the same two approvals before OS/network side effects", () => {
    const direct = spawnSync(process.execPath, ["adapters/elevenlabs-v4/auth.mjs", "login"], { encoding: "utf8" });
    const wrapper = spawnSync(process.execPath, ["bin/pipeline", "auth", "--connection", "elevenlabs", "--action", "login", "--actor", "coordinator", "--json"], { encoding: "utf8" });
    expect(direct.status).toBe(40); expect(wrapper.status).toBe(1);
    expect(JSON.parse(direct.stderr).code).toBe("oauth_execution_approval_required");
    expect(JSON.parse(wrapper.stderr).issues[0].adapter_error.code).toBe("oauth_execution_approval_required");
  });
});
