import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import puppeteer from "puppeteer-core";

const viewerRoot = dirname(fileURLToPath(import.meta.url));
const evidenceRoot = "/private/tmp/tsugite-po-0a-evidence";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function startViewerServer() {
  const viteCli = join(viewerRoot, "..", "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", process.env.TSUGITE_PO_0A_PORT ?? "4178", "--strictPort", "--configLoader", "runner"],
    { cwd: join(viewerRoot, ".."), stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Viewer dev server did not start: ${output}`)), 15_000);
    const consume = (chunk) => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer);
        reject(new Error(`Viewer dev server exited before ready (${code ?? signal}): ${output}`));
      }
    });
  });
  return {
    child,
    url: `http://127.0.0.1:${port}/`
  };
}

async function waitForScene(page, status, timeout = 10_000) {
  await page.waitForFunction(
    (expected) => document.querySelector("[data-scene-surface]")?.getAttribute("data-scene-status") === expected,
    { timeout },
    status
  );
}

async function assertSafeSceneText(page) {
  const text = await page.$eval("body", (body) => body.innerText);
  assert.equal(text.includes("/Users/"), false);
  assert.equal(text.includes("scene initialization failure"), false);
  assert.equal(text.includes("Error:"), false);
  assert.equal(text.includes("at Workflow"), false);
}

async function nodeCount(page) {
  return page.$$eval(
    "[data-testid=workflow-scene-fallback] [data-node-id]",
    (nodes) => nodes.length
  );
}

async function waitForFallback(page, reason) {
  await waitForScene(page, "degraded", 8_000);
  const actual = await page.$eval("[data-testid=scene-fallback-reason]", (element) => element.textContent);
  assert.match(actual ?? "", new RegExp(reason.replaceAll(".", "\\.")));
  assert.equal(await nodeCount(page), 8);
  await assertSafeSceneText(page);
}

async function newPage(browser, url, initScript) {
  const page = await browser.newPage();
  page.__po0aConsoleTypes = [];
  page.__po0aPageErrorNames = [];
  page.on("console", (message) => page.__po0aConsoleTypes.push(message.type()));
  page.on("pageerror", (error) => page.__po0aPageErrorNames.push(error.name));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  if (initScript) await page.evaluateOnNewDocument(initScript);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

async function waitForActualCanvas(page) {
  try {
    await waitForScene(page, "ready", 20_000);
  } catch (error) {
    const state = await page.evaluate(() => {
      const scene = document.querySelector("[data-scene-surface]");
      return {
        status: scene?.getAttribute("data-scene-status"),
        renderer: scene?.getAttribute("data-renderer"),
        firstFrame: scene?.getAttribute("data-first-frame"),
        fallbackReason: document.querySelector("[data-testid=scene-fallback-reason]")?.textContent,
        canvas: Boolean(document.querySelector("canvas"))
      };
    });
    await page.screenshot({ path: join(evidenceRoot, "actual-canvas-timeout.png") });
    throw new Error(`Actual Canvas did not reach ready: ${JSON.stringify({ state, consoleTypes: page.__po0aConsoleTypes, pageErrorNames: page.__po0aPageErrorNames })}`, { cause: error });
  }
}

test("PO-0A actual browser covers Canvas, node hit, and all degraded scene paths", async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const server = await startViewerServer();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader"
    ]
  });
  const pages = [];
  try {
    const actualCanvas = await newPage(browser, server.url);
    pages.push(actualCanvas);
    await waitForActualCanvas(actualCanvas);
    const canvasEvidence = await actualCanvas.$eval("canvas", (canvas) => ({
      width: canvas.width,
      height: canvas.height,
      webgl: Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl")),
      firstFrame: canvas.closest("[data-scene-surface]")?.getAttribute("data-first-frame")
    }));
    assert.equal(canvasEvidence.webgl, true);
    assert.equal(canvasEvidence.firstFrame, "true");
    assert.ok(canvasEvidence.width > 0);
    assert.ok(canvasEvidence.height > 0);
    const workflowEvidence = await actualCanvas.evaluate(() => ({
      timelineNodeCount: document.querySelectorAll(
        'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] > li'
      ).length,
      canvasNodeLabelCount: document.querySelectorAll('.scene-node-label:not([hidden])').length,
      eventMarkerCount: document.querySelectorAll('[data-testid="event-marker"]').length,
      summaryText: document.querySelector('aside[aria-label="制作の記録"]')?.textContent ?? ''
    }));
    assert.equal(workflowEvidence.timelineNodeCount, 8);
    assert.equal(workflowEvidence.canvasNodeLabelCount, 8);
    assert.equal(workflowEvidence.eventMarkerCount, 16);
    assert.match(workflowEvidence.summaryText, /8\s*工程/);
    await actualCanvas.screenshot({ path: join(evidenceRoot, "actual-canvas.png") });

    const highDprCanvas = await newPage(browser, server.url);
    pages.push(highDprCanvas);
    await highDprCanvas.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await highDprCanvas.reload({ waitUntil: "domcontentloaded" });
    await waitForActualCanvas(highDprCanvas);
    const highDprEvidence = await highDprCanvas.$eval("canvas", (canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        devicePixelRatio: window.devicePixelRatio,
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        timelineNodeCount: document.querySelectorAll(
          'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] > li'
        ).length
      };
    });
    assert.ok(highDprEvidence.devicePixelRatio > 1);
    assert.ok(highDprEvidence.cssWidth > 0 && highDprEvidence.cssHeight > 0);
    assert.ok(highDprEvidence.pixelWidth >= highDprEvidence.cssWidth);
    assert.ok(highDprEvidence.pixelHeight >= highDprEvidence.cssHeight);
    assert.equal(highDprEvidence.timelineNodeCount, 8);

    const firstNode = await actualCanvas.$eval(".scene-node-label", (label) => {
      const rect = label.getBoundingClientRect();
      return { name: label.getAttribute("aria-label"), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    assert.ok(firstNode.name);
    await actualCanvas.$$eval(".scene-node-label", (labels) => labels.forEach((label) => {
      label.style.pointerEvents = "none";
      label.style.visibility = "hidden";
    }));
    const hitName = firstNode.name.replace(/の詳細を表示$/, "");
    let hit = false;
    for (const offset of [18, 30, 42, 54, 66]) {
      await actualCanvas.mouse.click(firstNode.x, firstNode.y + offset);
      await delay(100);
      hit = await actualCanvas.$eval(
        `section[aria-label="タイムライン操作"] button[aria-pressed="true"]`,
        (button, expectedName) => button.textContent?.includes(expectedName) ?? false,
        hitName
      );
      if (hit) break;
    }
    assert.equal(hit, true, "Canvas click did not select a 3D node hit target");
    await actualCanvas.screenshot({ path: join(evidenceRoot, "actual-canvas-node-hit.png") });

    const nullContext = await newPage(browser, server.url, () => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(kind, ...args) {
        if (typeof kind === "string" && kind.toLowerCase().includes("webgl")) return null;
        return original.call(this, kind, ...args);
      };
    });
    pages.push(nullContext);
    await waitForFallback(nullContext, "viewer.scene.webgl_unavailable");
    const nullContextValue = await nullContext.evaluate(() => document.createElement("canvas").getContext("webgl"));
    assert.equal(nullContextValue, null);
    await nullContext.screenshot({ path: join(evidenceRoot, "fallback-webgl-unavailable.png") });

    const retry = await newPage(browser, server.url, () => {
      const original = HTMLCanvasElement.prototype.getContext;
      globalThis.__TSUGITE_PO_0A_ALLOW_WEBGL__ = false;
      HTMLCanvasElement.prototype.getContext = function getContext(kind, ...args) {
        if (
          typeof kind === "string"
          && kind.toLowerCase().includes("webgl")
          && !globalThis.__TSUGITE_PO_0A_ALLOW_WEBGL__
        ) return null;
        return original.call(this, kind, ...args);
      };
    });
    pages.push(retry);
    await waitForFallback(retry, "viewer.scene.webgl_unavailable");
    await retry.evaluate(() => {
      globalThis.__TSUGITE_PO_0A_ALLOW_WEBGL__ = true;
    });
    await retry.click('[data-testid="workflow-scene-fallback"] button');
    await waitForScene(retry, "ready");
    const retryEvidence = await retry.evaluate(() => ({
      fallback: Boolean(document.querySelector('[data-testid="workflow-scene-fallback"]')),
      loading: Boolean(document.querySelector('[data-scene-loading="true"]')),
      canvas: document.querySelectorAll("canvas").length,
      renderer: document.querySelector("[data-scene-surface]")?.getAttribute("data-renderer"),
      firstFrame: document.querySelector("[data-scene-surface]")?.getAttribute("data-first-frame")
    }));
    assert.equal(retryEvidence.fallback, false);
    assert.equal(retryEvidence.loading, false);
    assert.equal(retryEvidence.canvas, 1);
    assert.equal(retryEvidence.renderer, "webgl");
    assert.equal(retryEvidence.firstFrame, "true");

    const keyboard = await newPage(browser, server.url, () => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(kind, ...args) {
        if (typeof kind === "string" && kind.toLowerCase().includes("webgl")) return null;
        return original.call(this, kind, ...args);
      };
    });
    pages.push(keyboard);
    await keyboard.setViewport({ width: 420, height: 700, deviceScaleFactor: 2 });
    await keyboard.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await keyboard.reload({ waitUntil: "domcontentloaded" });
    await waitForFallback(keyboard, "viewer.scene.webgl_unavailable");
    const zoomSession = await keyboard.createCDPSession();
    await zoomSession.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
    await keyboard.focus("[data-testid=workflow-scene-fallback] [data-node-id]");
    assert.equal(await keyboard.evaluate(() => document.activeElement?.getAttribute("data-node-id")), "plan");
    await keyboard.keyboard.press("ArrowDown");
    assert.equal(await keyboard.evaluate(() => document.activeElement?.getAttribute("data-node-id")), "storyboard");
    await keyboard.keyboard.press("Enter");
    await keyboard.waitForFunction(() => document.querySelector("[data-node-id=storyboard]")?.getAttribute("aria-pressed") === "true");
    const responsiveEvidence = await keyboard.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      devicePixelRatio: window.devicePixelRatio,
      reducedMotion: document.querySelector("[data-testid=workflow-scene-fallback]")?.getAttribute("data-reduced-motion")
    }));
    assert.equal(responsiveEvidence.reducedMotion, "true");
    assert.ok(responsiveEvidence.devicePixelRatio > 1);
    assert.ok(responsiveEvidence.documentWidth <= responsiveEvidence.viewport + 1);
    assert.equal(await nodeCount(keyboard), 8);
    await keyboard.screenshot({ path: join(evidenceRoot, "fallback-keyboard-responsive.png") });

    const contextLost = await newPage(browser, server.url);
    pages.push(contextLost);
    await waitForActualCanvas(contextLost);
    await contextLost.click(
      'section[aria-label="タイムライン操作"] button[aria-label="素材承認の工程詳細を表示"]'
    );
    await contextLost.waitForFunction(
      () => document.querySelector('section[aria-label="タイムライン操作"] button[aria-pressed="true"]')?.textContent?.includes("素材承認")
    );
    const contextEvent = await contextLost.$eval("canvas", (canvas) => {
      const event = new Event("webglcontextlost", { cancelable: true });
      return { dispatchResult: canvas.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
    });
    try {
      await waitForFallback(contextLost, "viewer.scene.context_lost");
    } catch (error) {
      const sceneState = await contextLost.$eval("[data-scene-surface]", (scene) => ({
        status: scene.getAttribute("data-scene-status"),
        renderer: scene.getAttribute("data-renderer"),
        firstFrame: scene.getAttribute("data-first-frame")
      }));
      throw new Error(`Context loss was not surfaced: ${JSON.stringify({ contextEvent, sceneState })}`, { cause: error });
    }
    assert.equal(
      await contextLost.$eval('[data-node-id="approval"]', (button) => button.getAttribute("aria-pressed")),
      "true"
    );
    assert.ok(await contextLost.$eval("aside[aria-label=制作の記録]", (aside) => aside.textContent?.includes("素材承認")));
    await contextLost.screenshot({ path: join(evidenceRoot, "fallback-context-lost.png") });

    const initialization = await newPage(browser, server.url, () => {
      globalThis.__TSUGITE_SCENE_TEST__ = "initialization-throw";
    });
    pages.push(initialization);
    await waitForFallback(initialization, "viewer.scene.initialization_failed");
    await initialization.screenshot({ path: join(evidenceRoot, "fallback-initialization-failed.png") });

    const firstFrameTimeout = await newPage(browser, server.url, () => {
      globalThis.__TSUGITE_SCENE_TEST__ = "first-frame-timeout";
    });
    pages.push(firstFrameTimeout);
    await waitForFallback(firstFrameTimeout, "viewer.scene.first_frame_timeout");
    await firstFrameTimeout.screenshot({ path: join(evidenceRoot, "fallback-first-frame-timeout.png") });
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    server.child.kill("SIGTERM");
  }
});
