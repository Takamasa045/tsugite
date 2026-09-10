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
import { applyPinnedHyperframesPatches } from "./apply-pinned-patches.mjs";
import { renderIndexHtml, renderRuntimeSource } from "./document.mjs";
import { stopCatalogProcess } from "./catalog.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
await applyPinnedHyperframesPatches(root);
const require = createRequire(import.meta.url);
const packagePath = require.resolve("hyperframes/package.json");
const hfRequire = createRequire(packagePath);
const { default: puppeteer } = await import(hfRequire.resolve("puppeteer-core"));
const sharp = hfRequire("sharp");
const version = JSON.parse(await readFile(packagePath, "utf8")).version;
assert.equal(version, "0.8.24", "Revalidate the Studio contract before changing the pinned version");
const chrome = process.env.PUPPETEER_EXECUTABLE_PATH;
assert(chrome, "Set PUPPETEER_EXECUTABLE_PATH to an installed Chrome 152+ executable; no browser is downloaded.");
const out = join(root, "dist/verification/hyperframes-webmcp-fixes", new Date().toISOString().replace(/[:.]/g, "-"));
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
const report = { version, fixtureOnly: true, phase: "startup", calls: [], cycles: [], startedAt: new Date().toISOString() };
let browser;
let page;
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

const CYAN = { name: "cyan", hex: "#67e8f9", rgb: [103, 232, 249], text: "WebMCP verified" };
const ORANGE = { name: "orange", hex: "#f97316", rgb: [249, 115, 22], text: "WebMCP cycle two" };

async function call(page, name, input = {}) {
  const result = await page.evaluate(async ({ name, input }) => {
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return JSON.parse(await mc.executeTool(tool, JSON.stringify(input)));
  }, { name, input });
  report.calls.push({ phase: report.phase, name, input, result });
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  return result;
}

async function previewEvidence(page) {
  return page.evaluate(() => [...document.querySelectorAll("hyperframes-player")].map((player) => {
    const frame = player.shadowRoot?.querySelector("iframe");
    const doc = frame?.contentDocument;
    const ctor = doc?.defaultView?.HTMLElement;
    return {
      src: frame?.src, readyState: doc?.readyState, href: doc?.location?.href,
      hasDefaultView: Boolean(doc?.defaultView),
      htmlElementType: typeof ctor,
      elements: [...(doc?.querySelectorAll("[data-hf-id]") ?? [])].map((element) => {
        let instanceofDefaultViewHTMLElement = false;
        let instanceofThrew = null;
        try { instanceofDefaultViewHTMLElement = Boolean(ctor && element instanceof ctor); }
        catch (error) { instanceofThrew = String(error); }
        return {
          id: element.id, hfId: element.getAttribute("data-hf-id"),
          tag: element.tagName, namespaceURI: element.namespaceURI, nodeType: element.nodeType,
          isConnected: element.isConnected, ownerDocumentMatches: element.ownerDocument === doc,
          text: element.textContent, color: doc.defaultView?.getComputedStyle(element).color,
          instanceofDefaultViewHTMLElement, instanceofThrew,
          instanceofPageHTMLElement: element instanceof HTMLElement
        };
      })
    };
  }));
}

async function ready(page) {
  await page.waitForFunction(async () => {
    const mc = document.modelContext;
    if (!mc?.getTools) return false;
    return (await mc.getTools()).length === 12;
  }, { timeout: 45_000, polling: 250 });
  await page.waitForFunction(() => {
    const frame = document.querySelector("hyperframes-player")?.shadowRoot?.querySelector("iframe");
    const doc = frame?.contentDocument;
    return doc?.readyState === "complete" && doc.querySelector("#caption-1")?.getAttribute("data-hf-id");
  }, { timeout: 45_000, polling: 250 });
}

async function countColorPixels(png, rgb) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.channels, 3);
  let pixels = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (
      Math.abs(data[i] - rgb[0]) <= 3
      && Math.abs(data[i + 1] - rgb[1]) <= 3
      && Math.abs(data[i + 2] - rgb[2]) <= 3
    ) pixels++;
  }
  return pixels;
}

async function captureUpdatedFrame(page, color, label) {
  const attempts = [];
  for (const settleMs of [1000, 3000, 5000]) {
    const frame = await call(page, "studio_frame", { time: 2, settleMs });
    assert.equal(new URL(frame.url).origin, origin);
    const response = await fetch(frame.url, { signal: AbortSignal.timeout(30_000) });
    assert(response.ok && response.headers.get("content-type")?.includes("image/png"));
    const png = Buffer.from(await response.arrayBuffer());
    const pixels = await countColorPixels(png, color.rgb);
    const other = color === CYAN ? ORANGE : CYAN;
    const otherPixels = await countColorPixels(png, other.rgb);
    attempts.push({ settleMs, [color.name + "Pixels"]: pixels, [other.name + "Pixels"]: otherPixels, sha256: hash(png) });
    await writeFile(join(out, `frame-${label}-${settleMs}.png`), png);
    if (pixels >= 100) {
      await writeFile(join(out, `frame-${label}.png`), png);
      return { attempts, pixels, otherPixels };
    }
  }
  assert(false, `Frame remained stale for ${label}: ${color.name} text is absent`);
}

async function editCycle(page, handle, color, label) {
  report.phase = `edit-${label}`;
  const beforeSha = hash(await readFile(htmlPath));
  await call(page, "studio_select", { handle });
  const selected = await call(page, "studio_inspect", { handle });
  assert.equal(selected.isCurrentSelection, true);
  assert.equal(selected.can.editText, true);
  assert.equal(selected.can.editStyles, true);
  await call(page, "studio_set_text", { text: color.text });
  const textReadback = await call(page, "studio_inspect", { handle });
  assert.equal(textReadback.isCurrentSelection, true);
  assert.equal(textReadback.text, color.text);
  assert.equal(textReadback.can.editStyles, true);
  const style = await call(page, "studio_set_style", { styles: { color: color.hex } });
  assert.deepEqual(style.rejected, {});
  const after = await call(page, "studio_inspect", { handle });
  assert.equal(after.text, color.text);
  assert.equal(after.styles.color, `rgb(${color.rgb.join(", ")})`);
  const source = await readFile(htmlPath, "utf8");
  assert(source.includes(color.text) && source.includes(color.hex));
  const afterSha = hash(source);
  assert.notEqual(beforeSha, afterSha);
  assert.equal((await call(page, "studio_seek", { time: 2 })).playhead, 2);
  report.phase = `frame-${label}`;
  const frame = await captureUpdatedFrame(page, color, label);
  const cycle = {
    label, text: color.text, color: color.hex,
    sourceBeforeSha256: beforeSha, sourceAfterSha256: afterSha,
    frame
  };
  report.cycles.push(cycle);
  return cycle;
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
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => { window.__nativeWebMCP = typeof document.modelContext?.getTools === "function"; });
  const served = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/assets/index-") || !url.endsWith(".js")) return;
    try {
      const buf = Buffer.from(await response.buffer());
      served.push({ url, bytes: buf.length, sha256: hash(buf) });
    } catch { /* navigation teardown */ }
  });
  await page.goto(`${origin}/#project/${projectId}`);
  report.phase = "initial-read";
  await ready(page);
  report.nativeWebMCP = await page.evaluate(() => window.__nativeWebMCP);
  assert.equal(report.nativeWebMCP, true, "Native WebMCP unavailable; enable a supported Chrome build");
  report.world = await page.evaluate(() => ({
    evaluateSeesOnNewDocumentMarker: window.__nativeWebMCP === true,
    scripts: [...document.querySelectorAll("script[src]")].map((script) => script.src)
  }));
  report.served = served;
  report.tools = await page.evaluate(async () => (await document.modelContext.getTools()).map(({ name, inputSchema }) => ({ name, inputSchema })));
  const scene = await call(page, "studio_look");
  assert.equal(scene.projectId, projectId);
  assert.equal(scene.elementCount, 1);
  const handle = scene.elements[0].handle;
  const before = await call(page, "studio_inspect", { handle });
  assert.equal(before.text, "WebMCP before");
  assert.equal(before.can.editText, true);
  assert.equal(before.can.editStyles, true);
  await editCycle(page, handle, CYAN, "cycle1");
  report.phase = "reload-read";
  await page.reload();
  await ready(page);
  const reloaded = await call(page, "studio_look");
  const reloadHandle = reloaded.elements[0].handle;
  const persisted = await call(page, "studio_inspect", { handle: reloadHandle });
  assert.equal(persisted.text, CYAN.text);
  assert.equal(persisted.styles.color, `rgb(${CYAN.rgb.join(", ")})`);
  await editCycle(page, reloadHandle, ORANGE, "cycle2");
  await page.screenshot({ path: join(out, "studio.png") });
  report.phase = "complete";
  report.ok = true;
  report.notVerified = ["motion authoring", "host agent permission UI", "pipeline render", "Gate transitions"];
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (page && !page.isClosed()) {
    report.previewAtFailure = await previewEvidence(page).catch((error) => ({ error: error.message }));
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  const cleanupKeepAlive = setInterval(() => {}, 1000);
  try {
    report.cleanup = await stopCatalogProcess(child);
  } finally {
    clearInterval(cleanupKeepAlive);
  }
  if (!report.cleanup.stopped) {
    report.ok = false;
    report.cleanupError = "Studio process tree did not stop cleanly";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "server.log"), logs);
  console.log(JSON.stringify({ ok: report.ok, version, evidence: out, error: report.error }));
}
