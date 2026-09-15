import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthoringUi } from "../adapters/hypit/ui/server.mjs";

const roots = [];
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function listeningPort(server) {
  if (server.listening) return Promise.resolve(server.address().port);
  return new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
}

describe("authoring HTTP mutations", () => {
  it("rejects cross-origin POST and accepts same-origin CSRF JSON", async () => {
    const productionRoot = mkdtempSync(join(tmpdir(), "tsugite-http-"));
    roots.push(productionRoot);
    mkdirSync(join(productionRoot, ".tsugite", "authoring"), { recursive: true });
    const token = "a".repeat(64);
    const server = startAuthoringUi({
      productionRoot,
      port: 0,
      csrfToken: token,
      hooks: {
        setInstruction: () => ({ ui: { progress: "instruction-set", fake: false } }),
        authorSources: () => ({ ui: { progress: "blocked-test", fake: false } })
      }
    });
    servers.push(server);
    const port = await listeningPort(server);
    const origin = `http://127.0.0.1:${port}`;
    const evil = await fetch(`${origin}/instruction`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "http://evil.test" },
      body: "{}"
    });
    expect(evil.status).toBe(403);
    const missingCsrf = await fetch(`${origin}/instruction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin
      },
      body: "{}"
    });
    expect(missingCsrf.status).toBe(403);
    const ok = await fetch(`${origin}/instruction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-tsugite-csrf": token,
        cookie: `tsugite_csrf=${token}`
      },
      body: JSON.stringify({ text: "keep unknown cost unknown" })
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.state.ui.fake).toBe(false);
  });
});
