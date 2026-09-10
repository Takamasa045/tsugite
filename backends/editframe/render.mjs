import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertDirectory, assertNoSymlinkBetween, assertRegularFile, mkdirOwned, writeSafeFile } from "./confine.mjs";
import {
  assertSupportedManifest,
  canonicalPath,
  renderClientScript,
  renderIndexHtml,
  renderStyles,
  renderViteConfig
} from "./document.mjs";
import { copyPublicMedia, mediaLookupFromPlan, planPublicMedia } from "./media.mjs";
import { createFreshOwnedCompositionDir } from "./ownedDir.mjs";
import {
  allocateLoopbackPort,
  assertOwnedListener,
  childEnv,
  ownedOutput,
  spawnOwned,
  stopOwned,
  waitExit,
  waitForHttp
} from "./processGroup.mjs";
import { ensureRuntimeModuleLink, missingRuntimeMessage, resolveEditframeCli } from "./runtimePath.mjs";
import { resolveOutputDimensions } from "../outputDimensions.mjs";

const EXIT_VALIDATION_FAILED = 10;
const EXIT_TRANSIENT_EXTERNAL_FAILURE = 20;
const EXIT_MISSING_DEPENDENCY = 30;
const EXIT_INVALID_REQUEST = 40;
const RENDER_TIMEOUT_MS = 90_000;
const MIN_OUTPUT_BYTES = 1000;

class RunnerError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const owned = [];
let exiting = false;

async function onSignal() {
  if (exiting) return;
  exiting = true;
  await cleanupOwned();
  process.exit(143);
}

process.on("SIGINT", () => {
  void onSignal();
});
process.on("SIGTERM", () => {
  void onSignal();
});

try {
  await main();
} catch (error) {
  const cleanupError = await cleanupOwned();
  const message = error instanceof Error ? error.message : String(error);
  console.error(cleanupError ? `${message}; cleanup: ${cleanupError}` : error instanceof Error ? error.stack ?? message : message);
  process.exit(error?.exitCode ?? EXIT_TRANSIENT_EXTERNAL_FAILURE);
}

async function main() {
  const input = parsePayload(await readPayload());
  await assertDirectory(input.runDir, "runDir");
  await assertRegularFile(input.manifestPath, "manifestPath", input.runDir);
  await assertNoSymlinkBetween(input.outputPath, input.runDir, "outputPath");
  await assertNoSymlinkBetween(input.reportPath, input.runDir, "reportPath");
  const manifest = await readManifest(input.manifestPath);
  try {
    assertSupportedManifest(manifest);
  } catch (error) {
    throw new RunnerError(error instanceof Error ? error.message : String(error), EXIT_VALIDATION_FAILED);
  }
  let plan;
  try {
    plan = await planPublicMedia(manifest, input.runDir);
  } catch (error) {
    throw new RunnerError(error instanceof Error ? error.message : String(error), error?.exitCode ?? EXIT_VALIDATION_FAILED);
  }

  const runtime = resolveEditframeCli();
  if (!runtime.ok) {
    await writeFailureResult(input, manifest, {
      status: "dependency_missing",
      exitCode: EXIT_MISSING_DEPENDENCY,
      issue: {
        code: "editframe.dependency_missing",
        message: runtime.message ?? missingRuntimeMessage()
      }
    });
  }

  let compositionDir;
  try {
    compositionDir = canonicalPath(await createFreshOwnedCompositionDir(input.runDir));
  } catch (error) {
    throw new RunnerError(error instanceof Error ? error.message : String(error), error?.exitCode ?? EXIT_INVALID_REQUEST);
  }
  await copyPublicMedia(plan, compositionDir);
  const lookup = mediaLookupFromPlan(plan);
  const html = renderIndexHtml(manifest, { mediaByClipId: lookup });
  for (const item of plan) {
    if (!html.includes(`src="${item.publicUrl}"`)) {
      throw new RunnerError(`composition is missing public URL ${item.publicUrl}`, EXIT_VALIDATION_FAILED);
    }
  }
  const size = resolveOutputDimensions(manifest);
  const port = await allocateLoopbackPort();
  await writeSafeFile(
    join(compositionDir, "package.json"),
    `${JSON.stringify({ name: "tsugite-editframe-composition", private: true, type: "module" }, null, 2)}\n`,
    compositionDir
  );
  await writeSafeFile(join(compositionDir, "index.html"), html, compositionDir);
  await mkdirOwned(join(compositionDir, "src"), compositionDir, "src dir");
  await mkdirOwned(join(compositionDir, "cache"), compositionDir, "cache dir");
  await writeSafeFile(join(compositionDir, "src", "index.js"), renderClientScript(runtime.elementsCss), compositionDir);
  await writeSafeFile(join(compositionDir, "src", "styles.css"), renderStyles(size), compositionDir);
  await writeSafeFile(
    join(compositionDir, "vite.config.js"),
    renderViteConfig({
      port,
      compositionDir,
      runtimeRoot: runtime.root
    }),
    compositionDir
  );

  await unlinkIfExists(input.outputPath);
  await ensureRuntimeModuleLink(compositionDir, runtime);
  const vite = spawnOwned(
    [process.execPath, runtime.viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: compositionDir, env: childEnv() }
  );
  owned.push(vite);
  const url = `http://127.0.0.1:${port}/index.html`;
  try {
    await waitForHttp(url, {
      expectedStatus: 200,
      expectedType: "text/html",
      expectedText: plan[0].publicUrl
    });
    await assertOwnedListener(port, vite.pgid);
    const mediaUrl = `http://127.0.0.1:${port}${plan[0].publicUrl}`;
    await waitForHttp(mediaUrl, {
      expectedStatus: 206,
      range: "bytes=0-99",
      expectedType: "video/",
      expectedByteLength: 100,
      forbiddenType: "text/html"
    });
  } catch (error) {
    const logs = ownedOutput(vite);
    throw new RunnerError(
      `local Editframe preview server failed: ${error instanceof Error ? error.message : String(error)}\n${logs.stderr}\n${logs.stdout}`,
      EXIT_TRANSIENT_EXTERNAL_FAILURE
    );
  }

  const renderHandle = spawnOwned(
    [
      process.execPath,
      runtime.cliPath,
      "render",
      "--url",
      `http://127.0.0.1:${port}/index.html`,
      "-o",
      input.outputPath,
      "--fps",
      String(manifest.meta.fps)
    ],
    { cwd: compositionDir, env: childEnv() }
  );
  owned.push(renderHandle);
  let code;
  try {
    code = await waitExit(renderHandle, RENDER_TIMEOUT_MS);
  } catch (error) {
    throw new RunnerError(
      `Editframe render timed out or failed to start: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_TRANSIENT_EXTERNAL_FAILURE
    );
  }
  const output = ownedOutput(renderHandle);
  if (code !== 0) {
    await writeFailureResult(input, manifest, {
      status: "render_failed",
      exitCode: EXIT_TRANSIENT_EXTERNAL_FAILURE,
      issue: {
        code: "editframe.render_failed",
        message: "Editframe render failed",
        exit_code: code,
        stderr: output.stderr.slice(0, 2000),
        stdout: output.stdout.slice(0, 2000)
      }
    });
  }

  const metadata = probeRenderedMedia(input.outputPath);
  if (!metadata.ok) {
    await writeFailureResult(input, manifest, {
      status: "render_failed",
      exitCode: EXIT_TRANSIENT_EXTERNAL_FAILURE,
      issue: {
        code: "editframe.output_invalid",
        message: metadata.message
      }
    });
  }

  const cleanupError = await cleanupOwned();
  if (cleanupError) {
    throw new RunnerError(`render produced output but owned processes did not stop: ${cleanupError}`, EXIT_TRANSIENT_EXTERNAL_FAILURE);
  }
  await writeSuccessResult(input, manifest, renderHandle, metadata, compositionDir);
}

async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
}

async function cleanupOwned() {
  const errors = [];
  for (const handle of owned.splice(0).reverse()) {
    try {
      await stopOwned(handle);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readPayload() {
  try {
    return JSON.parse(await readStdin());
  } catch (error) {
    throw new RunnerError(
      `render payload must be JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_INVALID_REQUEST
    );
  }
}

function parsePayload(input) {
  if (!input || typeof input !== "object") {
    throw new RunnerError("render payload must be an object", EXIT_INVALID_REQUEST);
  }
  const runDir = requiredPath(input.runDir, "runDir");
  const manifestPath = requiredPath(input.manifestPath, "manifestPath");
  const outputPath = requiredPath(input.outputPath, "outputPath");
  const reportPath = requiredPath(input.reportPath, "reportPath");
  assertExactPath(manifestPath, join(runDir, "manifest.json"), "manifestPath");
  assertExactPath(outputPath, join(runDir, "final.mp4"), "outputPath");
  assertExactPath(reportPath, join(runDir, "render-report.json"), "reportPath");
  return { runDir, manifestPath, outputPath, reportPath };
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerError(`${name} must be a non-empty path`, EXIT_INVALID_REQUEST);
  }
  if (!isAbsolute(value)) {
    throw new RunnerError(`${name} must be absolute`, EXIT_INVALID_REQUEST);
  }
  return resolve(value);
}

function assertExactPath(actual, expected, name) {
  if (actual !== resolve(expected)) {
    throw new RunnerError(`${name} must equal ${resolve(expected)}`, EXIT_INVALID_REQUEST);
  }
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new RunnerError(
      `manifest must be readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_VALIDATION_FAILED
    );
  }
}

function probeRenderedMedia(path) {
  let info;
  try {
    info = spawnSync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (info.status !== 0) {
    return { ok: false, message: "ffprobe could not read the Editframe output" };
  }
  let parsed;
  try {
    parsed = JSON.parse(info.stdout);
  } catch {
    return { ok: false, message: "ffprobe output was not JSON" };
  }
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  const fps = parseFrameRate(video?.r_frame_rate || video?.avg_frame_rate);
  let size = 0;
  try {
    size = Number(parsed.format?.size) || 0;
  } catch {
    size = 0;
  }
  if (!video || !Number.isFinite(duration) || duration <= 0 || !width || !height || !fps || size < MIN_OUTPUT_BYTES) {
    return { ok: false, message: "Editframe output is empty, stale, or not a valid video" };
  }
  return { ok: true, duration, width, height, fps, size };
}

function parseFrameRate(value) {
  if (typeof value !== "string") return Number(value) || undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return Number(value) || undefined;
  return num / den;
}

async function writeSuccessResult(input, manifest, render, metadata, compositionDir) {
  const output = ownedOutput(render);
  const report = {
    backend: "editframe",
    status: "rendered",
    output_path: input.outputPath,
    manifest_path: input.manifestPath,
    run_dir: input.runDir,
    duration_seconds: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    clip_count: Array.isArray(manifest.clips) ? manifest.clips.length : 0,
    composition_dir: compositionDir,
    rendered_at: new Date().toISOString(),
    render: {
      stdout: output.stdout.slice(0, 2000),
      stderr: output.stderr.slice(0, 2000)
    }
  };
  await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report_path: input.reportPath, output_path: input.outputPath }));
}

async function writeFailureResult(input, manifest, failure) {
  const cleanupError = await cleanupOwned();
  if (cleanupError) {
    failure.issue = {
      ...failure.issue,
      cleanup: cleanupError
    };
  }
  const report = {
    backend: "editframe",
    status: failure.status,
    output_path: input.outputPath,
    manifest_path: input.manifestPath,
    run_dir: input.runDir,
    clip_count: Array.isArray(manifest?.clips) ? manifest.clips.length : 0,
    checked_at: new Date().toISOString(),
    issue: failure.issue
  };
  await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ok: false,
      code: failure.issue.code,
      issue: failure.issue,
      report_path: input.reportPath,
      output_path: input.outputPath
    })
  );
  process.exit(failure.exitCode);
}
