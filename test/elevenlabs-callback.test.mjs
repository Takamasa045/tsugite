import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { loopbackReceiver } from "../adapters/elevenlabs-v4/oauth.mjs";
describe("owned local OAuth callback listener", () => {
  it("classifies a fixed callback port collision without closing the existing listener", async () => {
    const server = createServer(), owned = await new Promise((done, reject) => { server.once("error", e => e.code === "EADDRINUSE" ? done(false) : reject(e)); server.listen(32145, "127.0.0.1", () => done(true)); });
    const receiver = loopbackReceiver("fixture-state");
    try { await expect(receiver.ready).rejects.toMatchObject({ code: "oauth_callback_port_in_use" }); if (owned) expect(server.listening).toBe(true); }
    finally { await receiver.close(); if (owned) await new Promise(done => server.close(done)); }
  });
  it("times out with a distinct reason and closes only its own listener", async () => {
    const receiver = loopbackReceiver("fixture-state", { timeoutMs: 20 });
    try {
      try { await receiver.ready; } catch (error) { expect(error.code).toBe("oauth_callback_port_in_use"); return; }
      await expect(receiver.code).rejects.toMatchObject({ code: "oauth_callback_timeout" });
    } finally { await receiver.close(); }
  });
});
