/** Real Studio + real browser WebMCP smoke. Only edits a generated fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIndexHtml, renderRuntimeSource } from "./document.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const packagePath = require.resolve("hyperframes/package.json");
const hfRequire = createRequire(packagePath);
const { default: puppeteer } = await import(hfRequire.resolve("puppeteer-core"));
const sharp = hfRequire("sharp");
const version = JSON.parse(await readFile(packagePath, "utf8")).version;
const chrome = process.env.PUPPETEER_EXECUTABLE_PATH;
assert(chrome, "Set PUPPETEER_EXECUTABLE_PATH to an installed Chrome 152+ executable; no browser is downloaded.");
const out = join(root, "dist/verification/hyperframes-webmcp", new Date().toISOString().replace(/[:.]/g, "-"));
const projectId = `webmcp-${Date.now()}`;
const fixture = join(out, projectId);
await mkdir(fixture, { recursive: true });
const manifest = {
  meta: { target_duration_seconds: 5, aspect: "16:9", fps: 30 },
  clips: [], audio: {}, captions: [{ text: "WebMCP before", start: 0, end: 5 }]
};
const htmlPath = join(fixture, "index.html");
await writeFile(htmlPath, renderIndexHtml(manifest));
await writeFile(join(fixture, "tsugite-gsap-runtime.js"), renderRuntimeSource(manifest));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const origin = `http://localhost:${port}`;
const report = { version, fixtureOnly: true, calls: [], startedAt: new Date().toISOString() };
let browser;
let logs = "";
let spawnError;
const child = spawn(process.execPath, [
  join(root, "node_modules/hyperframes/bin/hyperframes.mjs"), "preview", fixture,
  "--foreground", "--force-new", "--no-open", "--no-proxy", "--port", String(port)
], { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
child.on("error", (error) => { spawnError = error; });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (data) => { logs = (logs + data).slice(-64 * 1024); });
}

async function call(page, name, input = {}) {
  const result = await page.evaluate(async ({ name, input }) => {
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    // RegisteredTool and JSON string are the consumer API, not (name, object).
    return JSON.parse(await mc.executeTool(tool, JSON.stringify(input)));
  }, { name, input });
  report.calls.push({ name, input, result });
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  return result;
}

async function ready(page) {
  await page.waitForFunction(async () => {
    const mc = document.modelContext;
    if (!mc?.getTools) return false;
    return (await mc.getTools()).length === 12;
  }, { timeout: 45_000, polling: 250 });
  // Wait for the real fixture preview, without firing editing/inspection actors
  // repeatedly during React initialization. Tool calls follow separately below.
  await page.waitForFunction(() => {
    const frame = document.querySelector("hyperframes-player")?.shadowRoot?.querySelector("iframe");
    const doc = frame?.contentDocument;
    return doc?.readyState === "complete" && doc.querySelector("#caption-1")?.getAttribute("data-hf-id");
  }, { timeout: 45_000, polling: 250 });
}

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, "Studio exited before becoming ready");
    let available = false;
    try { available = (await fetch(`${origin}/api/projects`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { /* Startup only; bounded by deadline. */ }
    if (available) break;
    assert(Date.now() < deadline, "Studio startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await puppeteer.launch({
    executablePath: chrome, headless: true, protocolTimeout: 60_000,
    args: ["--enable-features=WebMCP"]
  });
  report.browser = await browser.version();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  // Observe the native API before Studio boot; never inject a registry or tool callback.
  await page.evaluateOnNewDocument(() => { window.__nativeWebMCP = typeof document.modelContext?.getTools === "function"; });
  await page.goto(`${origin}/#project/${projectId}`);
  await ready(page);
  report.nativeWebMCP = await page.evaluate(() => window.__nativeWebMCP);
  assert.equal(report.nativeWebMCP, true, "Native WebMCP unavailable; enable a supported Chrome build");
  report.tools = await page.evaluate(async () => (await document.modelContext.getTools()).map(({ name, inputSchema }) => ({ name, inputSchema })));
  const scene = await call(page, "studio_look");
  assert.equal(scene.projectId, projectId);
  assert.equal(scene.elementCount, 1);
  const handle = scene.elements[0].handle;
  const before = await call(page, "studio_inspect", { handle });
  assert.equal(before.text, "WebMCP before");
  report.sourceBeforeSha256 = hash(await readFile(htmlPath));
  await call(page, "studio_select", { handle });
  // 0.8.24 writes ambient selection. Wait for React's selection readback separately.
  const selected = await call(page, "studio_inspect", { handle });
  assert.equal(selected.isCurrentSelection, true);
  await call(page, "studio_set_text", { text: "WebMCP verified" });
  assert.equal((await call(page, "studio_inspect", { handle })).isCurrentSelection, true);
  const style = await call(page, "studio_set_style", { styles: { color: "#67e8f9" } });
  assert.deepEqual(style.rejected, {});
  const after = await call(page, "studio_inspect", { handle });
  assert.equal(after.text, "WebMCP verified");
  assert.equal(after.styles.color, "rgb(103, 232, 249)");
  const source = await readFile(htmlPath, "utf8");
  assert(source.includes("WebMCP verified") && source.includes("#67e8f9"));
  report.sourceAfterSha256 = hash(source);
  assert.notEqual(report.sourceBeforeSha256, report.sourceAfterSha256);
  assert.equal((await call(page, "studio_seek", { time: 2 })).playhead, 2);
  // A valid PNG can still be the pre-edit render cache. Verify fixture pixels,
  // retrying only frame reads (never writes) within the official settleMs bound.
  report.frameAttempts = [];
  for (const settleMs of [1000, 3000, 5000]) {
    const frame = await call(page, "studio_frame", { time: 2, settleMs });
    assert.equal(new URL(frame.url).origin, origin);
    const response = await fetch(frame.url, { signal: AbortSignal.timeout(30_000) });
    assert(response.ok && response.headers.get("content-type")?.includes("image/png"));
    const png = Buffer.from(await response.arrayBuffer());
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.equal(info.channels, 3);
    let cyanPixels = 0;
    for (let i = 0; i < data.length; i += 3) {
      if (Math.abs(data[i] - 103) <= 3 && Math.abs(data[i + 1] - 232) <= 3 && Math.abs(data[i + 2] - 249) <= 3) cyanPixels++;
    }
    report.frameAttempts.push({ settleMs, cyanPixels, sha256: hash(png) });
    await writeFile(join(out, `frame-${settleMs}.png`), png);
    if (cyanPixels >= 100) {
      await writeFile(join(out, "frame.png"), png);
      break;
    }
  }
  assert(report.frameAttempts.at(-1).cyanPixels >= 100, "Frame remained stale: edited cyan text is absent");
  await page.reload();
  await ready(page);
  const reloaded = await call(page, "studio_look");
  const persisted = await call(page, "studio_inspect", { handle: reloaded.elements[0].handle });
  assert.equal(persisted.text, "WebMCP verified");
  assert.equal(persisted.styles.color, "rgb(103, 232, 249)");
  await page.screenshot({ path: join(out, "studio.png") });
  report.ok = true;
  report.notVerified = ["motion authoring", "host agent permission UI", "pipeline render", "Gate transitions"];
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* Already exited. */ }
    }, 10_000);
    timer.unref();
    await closed;
    clearTimeout(timer);
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "server.log"), logs);
  console.log(JSON.stringify({ ok: report.ok, version, evidence: out, error: report.error }));
}
