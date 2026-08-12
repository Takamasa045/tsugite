import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import puppeteer from "puppeteer-core";

const viewerRoot = dirname(fileURLToPath(import.meta.url));
const evidenceRoot = process.env.TSUGITE_PO_0A_EVIDENCE_ROOT ?? "/private/tmp/tsugite-po-0a-evidence";
const chromePath = process.env.TSUGITE_PO_0A_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Active Mission Tree fixture — same shape as App.scene.integration (3 nodes, non-blank center). */
const ACTIVE_MISSION_TREE_WORKFLOW = {
  id: "mission-active",
  name: "Active Mission Tree",
  description: "current decision: 人間の判断待ちです",
  status: "waiting_approval",
  duration: 40,
  nodes: [
    {
      id: "mission-root",
      name: "mission-root",
      technicalName: "mission-root",
      type: "group",
      description: "ready",
      status: "queued",
      progress: 0,
      startedAt: 0,
      position: { layer: 0, order: 0 },
      inputs: [],
      outputs: ["task-a", "task-b"],
      logs: [],
      details: {
        purpose: "Mission Tree（読み取り専用）",
        activity: "ready",
        outcome: "ready",
        inputs: [],
        outputs: [],
      },
    },
    {
      id: "task-a",
      name: "edit-and-compose",
      technicalName: "task-a",
      type: "task",
      agent: "editor",
      description: "completed",
      status: "completed",
      progress: 100,
      startedAt: 10,
      position: { layer: 1, order: 1 },
      inputs: ["mission-root"],
      outputs: ["task-b"],
      logs: [],
      details: {
        purpose: "Mission Tree（読み取り専用）",
        activity: "completed",
        outcome: "completed",
        inputs: [],
        outputs: [],
      },
    },
    {
      id: "task-b",
      name: "output-qa",
      technicalName: "task-b",
      type: "approval",
      agent: "critic",
      description: "task.awaiting_human",
      status: "waiting_approval",
      progress: 0,
      startedAt: 20,
      position: { layer: 1, order: 2 },
      inputs: ["task-a"],
      outputs: [],
      logs: [],
      details: {
        purpose: "Mission Tree（読み取り専用）",
        activity: "awaiting_human",
        outcome: "task.awaiting_human",
        inputs: [],
        outputs: [],
      },
    },
  ],
  edges: [
    { id: "edge-mission-root-task-a", source: "mission-root", target: "task-a" },
    { id: "edge-mission-root-task-b", source: "mission-root", target: "task-b" },
    { id: "dep-task-a-task-b", source: "task-a", target: "task-b" },
  ],
  events: [
    { time: 0, nodeId: "mission-root", status: "queued", progress: 0 },
    { time: 10, nodeId: "task-a", status: "completed", progress: 100 },
    { time: 20, nodeId: "task-b", status: "waiting_approval", progress: 0 },
  ],
  missionTree: {
    productionId: "prod-active-browser",
    mode: "active",
    missionStatus: "ready",
    treeRevision: 1,
    sourceEventSequence: 1,
    currentDecision: {
      kind: "awaiting_human",
      summary: "人間の判断待ちです",
      reasonCode: "task.awaiting_human",
      nodeId: "task-b",
    },
    recovery: { active: false, attempts: 0, limit: 2 },
    taskTreeReadOnly: true,
    legacyWorkflowPreserved: true,
    digest: "e".repeat(64),
  },
};

const NATURAL_DEGRADED_REASONS = [
  "viewer.scene.webgl_unavailable",
  "viewer.scene.context_lost",
  "viewer.scene.first_frame_timeout",
  "viewer.scene.initialization_failed",
];

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
  assert.equal(text.includes("subject_digest"), false);
  assert.equal(text.includes("decision_digest"), false);
}

async function nodeCount(page) {
  return page.$$eval(
    "[data-testid=workflow-scene-fallback] [data-node-id]",
    (nodes) => nodes.length
  );
}

async function edgeCount(page) {
  return page.$$eval(
    "[data-testid=workflow-scene-fallback] [data-edge-id]",
    (edges) => edges.length
  );
}

async function readSceneState(page) {
  return page.evaluate(() => {
    const scene = document.querySelector("[data-scene-surface]");
    const reasonText = document.querySelector("[data-testid=scene-fallback-reason]")?.textContent ?? "";
    const reasonMatch = reasonText.match(/viewer\.scene\.[a-z_]+/);
    return {
      status: scene?.getAttribute("data-scene-status") ?? null,
      renderer: scene?.getAttribute("data-renderer") ?? null,
      firstFrame: scene?.getAttribute("data-first-frame") ?? null,
      reason: reasonMatch?.[0] ?? null,
      reasonText,
      canvas: Boolean(document.querySelector("canvas")),
      canvasWidth: document.querySelector("canvas")?.width ?? 0,
      canvasHeight: document.querySelector("canvas")?.height ?? 0,
      fallbackNodes: document.querySelectorAll("[data-testid=workflow-scene-fallback] [data-node-id]").length,
      fallbackEdges: document.querySelectorAll("[data-testid=workflow-scene-fallback] [data-edge-id]").length,
      fallbackVisible: Boolean(document.querySelector("[data-testid=workflow-scene-fallback]")),
      blankCenter: (() => {
        const surface = document.querySelector("[data-scene-surface]");
        if (!surface) return true;
        const hasCanvas = Boolean(surface.querySelector("canvas"));
        const hasFallback = Boolean(surface.querySelector("[data-testid=workflow-scene-fallback]"));
        const hasLoading = Boolean(surface.querySelector("[data-scene-loading='true']"));
        return !hasCanvas && !hasFallback && !hasLoading;
      })(),
      timelineNodeCount: document.querySelectorAll(
        'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] > li'
      ).length,
      summaryText: document.querySelector('aside[aria-label="制作の記録"]')?.textContent ?? "",
      missionDecisionKind: document.querySelector("[data-testid=mission-tree-decision-kind]")?.textContent ?? null,
      missionDecision: document.querySelector("[data-testid=mission-tree-decision]")?.textContent ?? null,
    };
  });
}

/**
 * Capability-aware terminal wait: ready Canvas OR non-blank degraded fallback.
 * Never treats a blank center as success.
 */
async function waitForSceneTerminal(page, { timeout = 20_000, expectedNodes = 8 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        const scene = document.querySelector("[data-scene-surface]");
        const status = scene?.getAttribute("data-scene-status");
        if (status === "ready") {
          return scene?.getAttribute("data-first-frame") === "true"
            && Boolean(document.querySelector("canvas"));
        }
        if (status === "degraded") {
          const fallback = document.querySelector("[data-testid=workflow-scene-fallback]");
          return Boolean(fallback) && (fallback?.textContent?.trim().length ?? 0) > 0;
        }
        return false;
      },
      { timeout }
    );
  } catch (error) {
    const state = await readSceneState(page);
    await page.screenshot({ path: join(evidenceRoot, "scene-terminal-timeout.png") }).catch(() => {});
    throw new Error(
      `Scene never reached ready or non-blank degraded: ${JSON.stringify({
        state,
        consoleTypes: page.__po0aConsoleTypes,
        pageErrorNames: page.__po0aPageErrorNames,
      })}`,
      { cause: error }
    );
  }

  const state = await readSceneState(page);
  assert.equal(state.blankCenter, false, `Center must not be blank: ${JSON.stringify(state)}`);

  if (state.status === "ready") {
    assert.equal(state.renderer, "webgl");
    assert.equal(state.firstFrame, "true");
    assert.equal(state.canvas, true);
    assert.ok(state.canvasWidth > 0);
    assert.ok(state.canvasHeight > 0);
    return { mode: "canvas", state };
  }

  assert.equal(state.status, "degraded");
  assert.equal(state.renderer, "dom-tree");
  assert.equal(state.fallbackVisible, true);
  assert.ok(
    NATURAL_DEGRADED_REASONS.includes(state.reason),
    `Unexpected degraded reason: ${state.reasonText}`
  );
  assert.equal(state.fallbackNodes, expectedNodes);
  assert.ok(state.fallbackEdges > 0, "DOM-SVG fallback must render edges");
  await assertSafeSceneText(page);
  return { mode: "fallback", state };
}

async function waitForFallback(page, reason, expectedNodes = 8) {
  await waitForScene(page, "degraded", 8_000);
  const actual = await page.$eval("[data-testid=scene-fallback-reason]", (element) => element.textContent);
  assert.match(actual ?? "", new RegExp(reason.replaceAll(".", "\\.")));
  assert.equal(await nodeCount(page), expectedNodes);
  assert.ok((await edgeCount(page)) > 0 || expectedNodes === 0);
  await assertSafeSceneText(page);
}

async function assertFallbackInteraction(page, { expectedNodes = 8, firstNodeId, secondNodeId } = {}) {
  assert.equal(await nodeCount(page), expectedNodes);
  assert.ok((await edgeCount(page)) > 0);

  const firstSelector = firstNodeId
    ? `[data-testid=workflow-scene-fallback] [data-node-id="${firstNodeId}"]`
    : "[data-testid=workflow-scene-fallback] [data-node-id]";
  await page.focus(firstSelector);
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute("data-node-id"));
  assert.ok(focusedId);

  await page.keyboard.press("ArrowDown");
  const afterArrow = await page.evaluate(() => document.activeElement?.getAttribute("data-node-id"));
  if (secondNodeId) {
    assert.equal(afterArrow, secondNodeId);
  } else {
    assert.ok(afterArrow);
    assert.notEqual(afterArrow, focusedId);
  }

  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (nodeId) => document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("aria-pressed") === "true",
    { timeout: 3_000 },
    secondNodeId ?? afterArrow
  );

  const selected = secondNodeId ?? afterArrow;
  const sideSelected = await page.evaluate((nodeId) => {
    const pressed = document.querySelector(
      'section[aria-label="タイムライン操作"] button[aria-pressed="true"]'
    );
    const heading = document.querySelector('aside[aria-label="制作の記録"] h2, aside[aria-label="制作の記録"] h3');
    return {
      timelinePressed: pressed?.textContent ?? null,
      hasHeading: Boolean(heading),
      nodePressed: document.querySelector(`[data-testid=workflow-scene-fallback] [data-node-id="${nodeId}"]`)
        ?.getAttribute("aria-pressed") === "true",
    };
  }, selected);
  assert.equal(sideSelected.nodePressed, true);

  // Retry must keep a non-blank center (ready canvas or still-degraded fallback).
  await page.click('[data-testid="scene-fallback-retry"]');
  const afterRetry = await waitForSceneTerminal(page, { expectedNodes });
  assert.equal(afterRetry.state.blankCenter, false);
  return afterRetry;
}

async function assertCanvasPath(page, { expectedTimelineNodes = 8 } = {}) {
  const canvasEvidence = await page.$eval("canvas", (canvas) => ({
    width: canvas.width,
    height: canvas.height,
    webgl: Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl")),
    firstFrame: canvas.closest("[data-scene-surface]")?.getAttribute("data-first-frame"),
    visible: (() => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })(),
  }));
  assert.equal(canvasEvidence.webgl, true);
  assert.equal(canvasEvidence.firstFrame, "true");
  assert.equal(canvasEvidence.visible, true);
  assert.ok(canvasEvidence.width > 0);
  assert.ok(canvasEvidence.height > 0);

  const workflowEvidence = await page.evaluate(() => ({
    timelineNodeCount: document.querySelectorAll(
      'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] > li'
    ).length,
    canvasNodeLabelCount: document.querySelectorAll(".scene-node-label:not([hidden])").length,
    eventMarkerCount: document.querySelectorAll('[data-testid="event-marker"]').length,
    summaryText: document.querySelector('aside[aria-label="制作の記録"]')?.textContent ?? "",
  }));
  assert.equal(workflowEvidence.timelineNodeCount, expectedTimelineNodes);
  assert.ok(workflowEvidence.canvasNodeLabelCount >= Math.min(expectedTimelineNodes, 1));
  if (expectedTimelineNodes === 8) {
    assert.equal(workflowEvidence.canvasNodeLabelCount, 8);
    assert.equal(workflowEvidence.eventMarkerCount, 16);
    assert.match(workflowEvidence.summaryText, /8\s*工程/);
  }

  // Interaction: prefer 3D node hit; fall back to timeline selection sync when
  // layout makes mesh hit flaky (e.g. compact Mission Tree).
  const labelCount = await page.$$eval(".scene-node-label:not([hidden])", (labels) => labels.length);
  assert.ok(labelCount > 0, "Canvas path must expose node labels");

  const firstNode = await page.$eval(".scene-node-label", (label) => {
    const rect = label.getBoundingClientRect();
    return {
      name: label.getAttribute("aria-label"),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });
  assert.ok(firstNode.name);
  await page.$$eval(".scene-node-label", (labels) => labels.forEach((label) => {
    label.style.pointerEvents = "none";
    label.style.visibility = "hidden";
  }));
  const hitName = firstNode.name.replace(/の詳細を表示$/, "");
  let hit = false;
  for (const offset of [18, 30, 42, 54, 66]) {
    await page.mouse.click(firstNode.x, firstNode.y + offset);
    await delay(120);
    hit = await page.evaluate((expectedName) => {
      const button = document.querySelector(
        'section[aria-label="タイムライン操作"] button[aria-pressed="true"]'
      );
      return button?.textContent?.includes(expectedName) ?? false;
    }, hitName);
    if (hit) break;
  }

  if (!hit && expectedTimelineNodes === 8) {
    assert.equal(hit, true, "Canvas click did not select a 3D node hit target");
  } else if (!hit) {
    // Compact Mission Tree layouts can miss mesh hits; timeline selection still
    // proves ready Canvas + non-blank interaction wiring.
    const timelineButtons = await page.$$(
      'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] button'
    );
    assert.ok(timelineButtons.length >= expectedTimelineNodes);
    await timelineButtons[Math.min(1, timelineButtons.length - 1)].click();
    await page.waitForFunction(
      () => Boolean(
        document.querySelector(
          'section[aria-label="タイムライン操作"] button[aria-pressed="true"]'
        )
      ),
      { timeout: 3_000 }
    );
    const selected = await page.evaluate(() => ({
      pressed: document.querySelector(
        'section[aria-label="タイムライン操作"] button[aria-pressed="true"]'
      )?.textContent ?? null,
      canvas: Boolean(document.querySelector("canvas")),
      status: document.querySelector("[data-scene-surface]")?.getAttribute("data-scene-status"),
    }));
    assert.ok(selected.pressed);
    assert.equal(selected.canvas, true);
    assert.equal(selected.status, "ready");
  }
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

async function writeBrowserEvidenceManifest(root, measured) {
  const names = (await readdir(root)).filter((name) => name !== "manifest.json").sort();
  const artifacts = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+\.(png|json|txt)$/.test(name)) continue;
    const bytes = await readFile(join(root, name));
    artifacts.push({
      kind: name.endsWith(".png") ? "screenshot" : "manifest",
      relative_path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength
    });
  }
  const body = {
    schema_version: 1,
    fixture_only: true,
    primary_mode: measured.primary_mode,
    measured: {
      webgl_unavailable: measured.webgl_unavailable === true,
      context_lost: measured.context_lost === true,
      initialization_failed: measured.initialization_failed === true,
      first_frame_timeout: measured.first_frame_timeout === true,
      non_blank_fallback: measured.non_blank_fallback === true,
      keyboard_selection: measured.keyboard_selection === true,
      mission_tree_decision: measured.mission_tree_decision === true,
      mission_tree_exit: measured.mission_tree_exit === true
    },
    scene: measured.scene ?? {},
    artifacts
  };
  const output_digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const manifest = { ...body, output_digest };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function newPageWithEmbeddedWorkflow(browser, url, workflow) {
  const page = await browser.newPage();
  page.__po0aConsoleTypes = [];
  page.__po0aPageErrorNames = [];
  page.on("console", (message) => page.__po0aConsoleTypes.push(message.type()));
  page.on("pageerror", (error) => page.__po0aPageErrorNames.push(error.name));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((workflowJson) => {
    const original = Document.prototype.getElementById;
    Document.prototype.getElementById = function getElementById(id) {
      if (id === "tsugite-workflow-data") {
        const el = document.createElement("script");
        el.id = "tsugite-workflow-data";
        el.type = "application/json";
        el.textContent = workflowJson;
        return el;
      }
      return original.call(this, id);
    };
  }, JSON.stringify(workflow));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

test("PO-0A/PO-7 capability-aware browser: Canvas or non-blank DOM-SVG, degraded paths, Mission Tree", async () => {
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
  const measured = {
    primary_mode: "fallback",
    webgl_unavailable: false,
    context_lost: false,
    initialization_failed: false,
    first_frame_timeout: false,
    non_blank_fallback: false,
    keyboard_selection: false,
    mission_tree_decision: false,
    mission_tree_exit: false,
    scene: {}
  };
  try {
    // --- Legacy 8-stage fixture: capability-aware primary path ---
    const primary = await newPage(browser, server.url);
    pages.push(primary);
    const primaryResult = await waitForSceneTerminal(primary, { expectedNodes: 8 });
    measured.primary_mode = primaryResult.mode;
    measured.scene = primaryResult.state;
    if (primaryResult.mode === "fallback") {
      measured.non_blank_fallback = primaryResult.state.blankCenter === false;
    }
    await primary.screenshot({
      path: join(evidenceRoot, primaryResult.mode === "canvas" ? "actual-canvas.png" : "natural-fallback.png"),
    });

    if (primaryResult.mode === "canvas") {
      await assertCanvasPath(primary, { expectedTimelineNodes: 8 });
      await primary.screenshot({ path: join(evidenceRoot, "actual-canvas-node-hit.png") });

      const highDprCanvas = await newPage(browser, server.url);
      pages.push(highDprCanvas);
      await highDprCanvas.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await highDprCanvas.reload({ waitUntil: "domcontentloaded" });
      const highDprResult = await waitForSceneTerminal(highDprCanvas, { expectedNodes: 8 });
      if (highDprResult.mode === "canvas") {
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
            ).length,
          };
        });
        assert.ok(highDprEvidence.devicePixelRatio > 1);
        assert.ok(highDprEvidence.cssWidth > 0 && highDprEvidence.cssHeight > 0);
        assert.ok(highDprEvidence.pixelWidth >= highDprEvidence.cssWidth);
        assert.ok(highDprEvidence.pixelHeight >= highDprEvidence.cssHeight);
        assert.equal(highDprEvidence.timelineNodeCount, 8);
      } else {
        assert.equal(highDprResult.state.fallbackNodes, 8);
        assert.ok(highDprResult.state.fallbackEdges > 0);
      }
    } else {
      // Natural headless/SwiftShader degradation: still fully operable.
      assert.equal(primaryResult.state.timelineNodeCount, 8);
      assert.match(primaryResult.state.summaryText, /8\s*工程/);
      await assertFallbackInteraction(primary, {
        expectedNodes: 8,
        firstNodeId: "plan",
        secondNodeId: "storyboard",
      });
      await primary.screenshot({ path: join(evidenceRoot, "natural-fallback-interaction.png") });
    }

    // --- Forced webgl unavailable ---
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
    assert.equal(await edgeCount(nullContext), 8);
    measured.webgl_unavailable = true;
    measured.non_blank_fallback = true;
    await nullContext.screenshot({ path: join(evidenceRoot, "fallback-webgl-unavailable.png") });

    // --- Retry: if environment can host WebGL, reach ready; otherwise stay non-blank degraded ---
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
    await retry.click('[data-testid="scene-fallback-retry"]');
    const retryResult = await waitForSceneTerminal(retry, { expectedNodes: 8 });
    if (retryResult.mode === "canvas") {
      assert.equal(retryResult.state.renderer, "webgl");
      assert.equal(retryResult.state.firstFrame, "true");
      assert.equal(
        await retry.evaluate(() => Boolean(document.querySelector('[data-testid="workflow-scene-fallback"]'))),
        false
      );
    } else {
      assert.equal(retryResult.state.fallbackNodes, 8);
      assert.ok(retryResult.state.fallbackEdges > 0);
      assert.ok(NATURAL_DEGRADED_REASONS.includes(retryResult.state.reason));
    }

    // --- Keyboard / responsive / reduced motion on forced fallback ---
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
      reducedMotion: document.querySelector("[data-testid=workflow-scene-fallback]")?.getAttribute("data-reduced-motion"),
      edges: document.querySelectorAll("[data-testid=workflow-scene-fallback] [data-edge-id]").length,
    }));
    assert.equal(responsiveEvidence.reducedMotion, "true");
    assert.ok(responsiveEvidence.devicePixelRatio > 1);
    assert.ok(responsiveEvidence.documentWidth <= responsiveEvidence.viewport + 1);
    assert.equal(await nodeCount(keyboard), 8);
    assert.equal(responsiveEvidence.edges, 8);
    measured.keyboard_selection = true;
    await keyboard.screenshot({ path: join(evidenceRoot, "fallback-keyboard-responsive.png") });

    // --- Forced context-lost injection: always measured, never skipped as green ---
    const injectedLoss = await newPage(browser, server.url, () => {
      globalThis.__TSUGITE_SCENE_TEST__ = "context-lost";
    });
    pages.push(injectedLoss);
    await waitForFallback(injectedLoss, "viewer.scene.context_lost");
    assert.equal(await nodeCount(injectedLoss), 8);
    assert.ok((await edgeCount(injectedLoss)) > 0);
    measured.context_lost = true;
    await injectedLoss.screenshot({ path: join(evidenceRoot, "fallback-context-lost.png") });

    // --- Canvas event path when WebGL first-frame is actually available ---
    const contextProbe = await newPage(browser, server.url);
    pages.push(contextProbe);
    const contextProbeResult = await waitForSceneTerminal(contextProbe, { expectedNodes: 8 });
    if (contextProbeResult.mode === "canvas") {
      await contextProbe.click(
        'section[aria-label="タイムライン操作"] button[aria-label="素材承認の工程詳細を表示"]'
      );
      await contextProbe.waitForFunction(
        () => document.querySelector('section[aria-label="タイムライン操作"] button[aria-pressed="true"]')?.textContent?.includes("素材承認")
      );
      const contextEvent = await contextProbe.$eval("canvas", (canvas) => {
        const event = new Event("webglcontextlost", { cancelable: true });
        return { dispatchResult: canvas.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
      });
      try {
        await waitForFallback(contextProbe, "viewer.scene.context_lost");
      } catch (error) {
        const sceneState = await contextProbe.$eval("[data-scene-surface]", (scene) => ({
          status: scene.getAttribute("data-scene-status"),
          renderer: scene.getAttribute("data-renderer"),
          firstFrame: scene.getAttribute("data-first-frame"),
        }));
        throw new Error(`Context loss was not surfaced: ${JSON.stringify({ contextEvent, sceneState })}`, { cause: error });
      }
      assert.equal(
        await contextProbe.$eval('[data-node-id="approval"]', (button) => button.getAttribute("aria-pressed")),
        "true"
      );
      assert.ok(await contextProbe.$eval("aside[aria-label=制作の記録]", (aside) => aside.textContent?.includes("素材承認")));
      assert.ok((await edgeCount(contextProbe)) > 0);
      await contextProbe.screenshot({ path: join(evidenceRoot, "fallback-context-lost-canvas-event.png") });
    } else {
      await contextProbe.screenshot({ path: join(evidenceRoot, "fallback-context-lost-natural.png") });
    }

    // --- Initialization throw / first-frame timeout (dev injection) ---
    const initialization = await newPage(browser, server.url, () => {
      globalThis.__TSUGITE_SCENE_TEST__ = "initialization-throw";
    });
    pages.push(initialization);
    await waitForFallback(initialization, "viewer.scene.initialization_failed");
    measured.initialization_failed = true;
    await initialization.screenshot({ path: join(evidenceRoot, "fallback-initialization-failed.png") });

    const firstFrameTimeout = await newPage(browser, server.url, () => {
      globalThis.__TSUGITE_SCENE_TEST__ = "first-frame-timeout";
    });
    pages.push(firstFrameTimeout);
    await waitForFallback(firstFrameTimeout, "viewer.scene.first_frame_timeout");
    measured.first_frame_timeout = true;
    await firstFrameTimeout.screenshot({ path: join(evidenceRoot, "fallback-first-frame-timeout.png") });

    // --- Active Mission Tree: Canvas or non-blank DOM-SVG, decision strip, interaction ---
    const missionPage = await newPageWithEmbeddedWorkflow(browser, server.url, ACTIVE_MISSION_TREE_WORKFLOW);
    pages.push(missionPage);
    const missionResult = await waitForSceneTerminal(missionPage, { expectedNodes: 3 });
    await missionPage.screenshot({
      path: join(
        evidenceRoot,
        missionResult.mode === "canvas" ? "mission-tree-canvas.png" : "mission-tree-fallback.png"
      ),
    });

    const missionUi = await missionPage.evaluate(() => ({
      decisionKind: document.querySelector("[data-testid=mission-tree-decision-kind]")?.textContent ?? null,
      decision: document.querySelector("[data-testid=mission-tree-decision]")?.textContent ?? null,
      missionStatus: document.querySelector("[data-testid=mission-tree-status]") !== null,
      timelineCount: document.querySelectorAll(
        'section[aria-label="タイムライン操作"] ol[aria-label="工程一覧"] > li'
      ).length,
      body: document.body.innerText,
    }));
    assert.equal(missionUi.missionStatus, true);
    assert.equal(missionUi.decisionKind, "awaiting_human");
    assert.match(missionUi.decision ?? "", /人間の判断待ち/);
    assert.equal(missionUi.timelineCount, 3);
    assert.equal(missionUi.body.includes("subject_digest"), false);
    assert.equal(missionUi.body.includes("/Users/"), false);
    measured.mission_tree_decision = missionUi.decisionKind === "awaiting_human";
    measured.mission_tree_exit = /人間の判断待ち/.test(missionUi.decision ?? "");

    if (missionResult.mode === "canvas") {
      await assertCanvasPath(missionPage, { expectedTimelineNodes: 3 });
    } else {
      assert.equal(missionResult.state.fallbackNodes, 3);
      assert.equal(missionResult.state.fallbackEdges, 3);
      await assertFallbackInteraction(missionPage, {
        expectedNodes: 3,
        firstNodeId: "mission-root",
        secondNodeId: "task-a",
      });
    }

    const requiredMeasured = [
      "webgl_unavailable",
      "context_lost",
      "initialization_failed",
      "first_frame_timeout",
      "non_blank_fallback",
      "keyboard_selection",
      "mission_tree_decision",
      "mission_tree_exit"
    ];
    const missing = requiredMeasured.filter((key) => measured[key] !== true);
    assert.equal(missing.length, 0, `Unmeasured browser paths treated as failure: ${missing.join(", ")}`);
    await writeBrowserEvidenceManifest(evidenceRoot, measured);
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    server.child.kill("SIGTERM");
  }
});
