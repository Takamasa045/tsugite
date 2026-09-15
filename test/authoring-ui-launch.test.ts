import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAuthoringUi } from "../adapters/authoringUiLaunch.mjs";

const helpers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (helpers.length > 0) await helpers.pop()?.();
});

function stubSpec(modulePath: string) {
  return {
    id: "stub",
    modulePath,
    argvPrefix: [],
    productionArg: "--production",
    portArg: "--port",
    listenRelativePath: ".tsugite/authoring/ui-listen.json",
    readyPath: "/state"
  };
}

async function writeStubUiModule(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-authoring-ui-stub-"));
  const modulePath = join(root, "stubUi.mjs");
  await writeFile(modulePath, `import { createServer } from "node:http";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const productionRoot = realpathSync(arg("--production"));
const requested = Number(arg("--port") ?? "0");
const listenPath = join(productionRoot, ".tsugite", "authoring", "ui-listen.json");
const identity = { productionRoot, adapter: "stub" };
const server = createServer((req, res) => {
  if (req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, identity, view: { progress: "ready" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body>authoring</body></html>");
});
server.listen(requested, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requested;
  mkdirSync(dirname(listenPath), { recursive: true });
  writeFileSync(listenPath, JSON.stringify({ host: "127.0.0.1", port }) + "\\n");
});
`);
  return modulePath;
}

describe("authoring UI launch helper", () => {
  it("reuses a live loopback listen only when identity matches", async () => {
    const productionRoot = await realpath(await mkdtemp(join(tmpdir(), "tsugite-authoring-prod-")));
    await mkdir(join(productionRoot, ".tsugite", "authoring"), { recursive: true });
    const live = createServer((req, res) => {
      if (req.url === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          identity: { productionRoot, adapter: "stub" }
        }));
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", () => resolve()));
    const address = live.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await writeFile(
      join(productionRoot, ".tsugite", "authoring", "ui-listen.json"),
      `${JSON.stringify({ host: "127.0.0.1", port })}\n`
    );
    const reused = await ensureAuthoringUi({
      adapterId: "unused",
      productionRoot,
      spec: stubSpec(fileURLToPath(new URL("../adapters/authoringUiRegistry.mjs", import.meta.url)))
    });
    expect(reused.reused).toBe(true);
    expect(reused.port).toBe(port);

    await new Promise<void>((resolve) => live.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stub = await writeStubUiModule();
    const started = await ensureAuthoringUi({
      adapterId: "unused",
      productionRoot,
      spec: stubSpec(stub)
    });
    expect(started.reused).toBe(false);
    expect(started.port).not.toBe(port);
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const probe = await fetch(new URL("/state", started.url));
    expect(probe.ok).toBe(true);
    if (started.pid) {
      try { process.kill(started.pid, "SIGTERM"); } catch { /* already exited */ }
    }
  });

  it("rejects another production's ok:true on a stale port and launches the requested root", async () => {
    const productionRoot = await realpath(await mkdtemp(join(tmpdir(), "tsugite-authoring-self-")));
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "tsugite-authoring-other-")));
    await mkdir(join(productionRoot, ".tsugite", "authoring"), { recursive: true });
    const foreign = createServer((req, res) => {
      if (req.url === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          identity: { productionRoot: otherRoot, adapter: "stub" }
        }));
        return;
      }
      res.end("foreign");
    });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", () => resolve()));
    helpers.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
    const address = foreign.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await writeFile(
      join(productionRoot, ".tsugite", "authoring", "ui-listen.json"),
      `${JSON.stringify({ host: "127.0.0.1", port })}\n`
    );
    const stub = await writeStubUiModule();
    const started = await ensureAuthoringUi({
      adapterId: "unused",
      productionRoot,
      spec: stubSpec(stub)
    });
    expect(started.reused).toBe(false);
    expect(started.port).not.toBe(port);
    const probe = await fetch(new URL("/state", started.url)).then((response) => response.json()) as {
      identity?: { productionRoot?: string };
    };
    expect(probe.identity?.productionRoot).toBe(productionRoot);
    if (started.pid) {
      try { process.kill(started.pid, "SIGTERM"); } catch { /* already exited */ }
    }
  });

  it("does not take an executable from the production directory", async () => {
    const productionRoot = await mkdtemp(join(tmpdir(), "tsugite-authoring-exec-"));
    await mkdir(join(productionRoot, ".tsugite", "authoring"), { recursive: true });
    await writeFile(join(productionRoot, "evil.mjs"), "console.log('nope')\n");
    await expect(ensureAuthoringUi({
      adapterId: "not-registered",
      productionRoot
    })).rejects.toMatchObject({ code: "authoring.adapter_unregistered" });
  });
});
void dirname;
