import crossSpawn from "cross-spawn";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const spawnSync = crossSpawn.sync;

const EXIT_VALIDATION_FAILED = 10;
const EXIT_TRANSIENT_EXTERNAL_FAILURE = 20;
const EXIT_MISSING_DEPENDENCY = 30;
const EXIT_INVALID_REQUEST = 40;
const MAX_OUTPUT = 1024 * 1024 * 10;

const HYPERFRAMES_LINT_COMMAND = ["npx", "hyperframes", "lint", "--json"];
const HYPERFRAMES_SAFE_LINT_COMMAND = ["npx", "--no-install", "hyperframes", "lint", "--json"];
const HYPERFRAMES_RENDER_COMMAND = ["npx", "--no-install", "hyperframes", "render"];
const HYPERFRAMES_VERSION_COMMAND = ["npx", "--no-install", "hyperframes", "--version"];
const LOCAL_GSAP_RUNTIME = "tsugite-gsap-runtime.js";

class RunnerError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

try {
  const input = parsePayload(await readPayload());
  const manifest = await readManifest(input.manifestPath);
  await assertLocalManifestAssets(manifest, input.runDir);

  const dependency = checkHyperFramesDependency(input.runDir);
  if (!dependency.ok) {
    await writeFailureResult(input, manifest, {
      status: "dependency_missing",
      exitCode: EXIT_MISSING_DEPENDENCY,
      issue: {
        code: "hyperframes.dependency_missing",
        message: dependency.message,
        command: dependency.command
      }
    });
  }

  await writeHyperFramesProject(input.runDir, manifest);

  const preflight = runHyperFramesLint(input.runDir);
  if (!preflight.ok) {
    await writeFailureResult(input, manifest, {
      status: "preflight_failed",
      exitCode: EXIT_VALIDATION_FAILED,
      issue: {
        code: "hyperframes.preflight_failed",
        message: "HyperFrames lint failed",
        command: HYPERFRAMES_LINT_COMMAND,
        exit_code: preflight.exitCode,
        stderr: truncate(preflight.stderr),
        stdout: truncate(preflight.stdout)
      }
    });
  }

  const render = runHyperFramesRender(input.runDir, input.outputPath, manifest.meta.fps);
  if (!render.ok) {
    await writeFailureResult(input, manifest, {
      status: "render_failed",
      exitCode: EXIT_TRANSIENT_EXTERNAL_FAILURE,
      issue: {
        code: "hyperframes.render_failed",
        message: "HyperFrames render failed",
        command: render.command,
        exit_code: render.exitCode,
        stderr: truncate(render.stderr),
        stdout: truncate(render.stdout)
      }
    });
  }

  await writeSuccessResult(input, manifest, render);
} catch (error) {
  if (error instanceof RunnerError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }

  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(EXIT_TRANSIENT_EXTERNAL_FAILURE);
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
  const resolvedExpected = resolve(expected);
  if (actual !== resolvedExpected) {
    throw new RunnerError(`${name} must equal ${resolvedExpected}`, EXIT_INVALID_REQUEST);
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

async function assertLocalManifestAssets(manifest, runDir) {
  const assets = [];
  for (const [index, clip] of (manifest.clips ?? []).entries()) {
    assets.push([`clips[${index}].src`, clip?.src]);
  }
  for (const track of ["bgm", "narration", "sfx"]) {
    for (const [index, entry] of (manifest.audio?.[track] ?? []).entries()) {
      if (entry?.src) assets.push([`audio.${track}[${index}].src`, entry.src]);
    }
  }
  for (const [index, image] of (manifest.images ?? []).entries()) {
    assets.push([`images[${index}].src`, image?.src]);
  }

  const realRunDir = await realpath(runDir);
  for (const [label, value] of assets) {
    if (typeof value !== "string" || isExternalAssetPath(value)) {
      throw new RunnerError(`${label} must be a local asset path`, EXIT_VALIDATION_FAILED);
    }
    if (isAbsolute(value) || !isPathWithin(runDir, resolve(runDir, value))) {
      throw new RunnerError(`${label} must stay inside runDir`, EXIT_VALIDATION_FAILED);
    }
    try {
      const realAssetPath = await realpath(resolve(runDir, value));
      if (!isPathWithin(realRunDir, realAssetPath)) {
        throw new RunnerError(`${label} must stay inside runDir`, EXIT_VALIDATION_FAILED);
      }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(`${label} must reference a readable run asset`, EXIT_VALIDATION_FAILED);
    }
  }
}

function isPathWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isExternalAssetPath(value) {
  const path = value.trim();
  return path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path);
}

function checkHyperFramesDependency(runDir) {
  const result = spawnSync(HYPERFRAMES_VERSION_COMMAND[0], HYPERFRAMES_VERSION_COMMAND.slice(1), {
    cwd: runDir,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });

  if (result.error) {
    return {
      ok: false,
      command: HYPERFRAMES_VERSION_COMMAND,
      message: `HyperFrames CLI is not available: ${result.error.message}`
    };
  }

  if (result.status !== 0) {
    const details = renderCommandOutput(result.stderr, result.stdout);
    return {
      ok: false,
      command: HYPERFRAMES_VERSION_COMMAND,
      message: details
        ? `HyperFrames CLI is not available via npx --no-install: ${details}`
        : "HyperFrames CLI is not available via npx --no-install"
    };
  }

  return { ok: true };
}

function runHyperFramesLint(runDir) {
  const result = spawnSync(HYPERFRAMES_SAFE_LINT_COMMAND[0], HYPERFRAMES_SAFE_LINT_COMMAND.slice(1), {
    cwd: runDir,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });

  if (result.error) {
    return {
      ok: false,
      exitCode: undefined,
      stderr: result.error.message,
      stdout: ""
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

function runHyperFramesRender(runDir, outputPath, fps) {
  const command = [
    ...HYPERFRAMES_RENDER_COMMAND,
    "--output",
    outputPath,
    "--fps",
    String(fps),
    "--quality",
    "standard"
  ];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: runDir,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });

  if (result.error) {
    return {
      ok: false,
      command,
      exitCode: undefined,
      stderr: result.error.message,
      stdout: ""
    };
  }

  return {
    ok: result.status === 0,
    command,
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

async function writeHyperFramesProject(runDir, manifest) {
  await writeFile(join(runDir, LOCAL_GSAP_RUNTIME), renderLocalGsapRuntime());
  await writeFile(join(runDir, "index.html"), renderIndexHtml(manifest));
}

function renderIndexHtml(manifest) {
  const size = compositionSize(manifest);
  const duration = manifest.meta.target_duration_seconds;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${size.width},height=${size.height},initial-scale=1">
  <style>
    html, body {
      margin: 0;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: #050505;
      font-family: Arial, sans-serif;
    }
    #tsugite-render {
      position: relative;
      width: ${size.width}px;
      height: ${size.height}px;
      overflow: hidden;
      background: #050505;
    }
    video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #050505;
    }
    .caption {
      position: absolute;
      left: 7%;
      right: 7%;
      bottom: 8%;
      padding: 24px 32px;
      color: #ffffff;
      background: rgba(0, 0, 0, 0.68);
      border-radius: 8px;
      font-size: ${manifest.meta.aspect === "9:16" ? 48 : 36}px;
      line-height: 1.28;
      text-align: center;
      text-wrap: balance;
    }
  </style>
  <script src="./${LOCAL_GSAP_RUNTIME}"></script>
</head>
<body>
  <div id="tsugite-render" data-composition-id="tsugite-render" data-start="0" data-duration="${duration}" data-width="${size.width}" data-height="${size.height}">
${renderClips(manifest.clips)}
${renderAudio(manifest.audio)}
${renderCaptions(manifest.captions)}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    window.__timelines["tsugite-render"] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
}

function renderClips(clips) {
  let start = 0;
  return clips
    .flatMap((clip) => {
      const duration = clip.out - clip.in;
      const id = escapeAttr(clip.id);
      const src = escapeAttr(clip.src);
      const elements = [
        `    <video id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="0" data-media-start="${clip.in}" src="${src}" muted playsinline></video>`
      ];
      if (clip.audio) {
        elements.push(
          `    <audio id="${id}-audio" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="1" data-media-start="${clip.in}" data-volume="1" src="${src}"></audio>`
        );
      }
      start += duration;
      return elements;
    })
    .join("\n");
}

function renderAudio(audio) {
  const tracks = [
    ["bgm", audio?.bgm ?? []],
    ["narration", audio?.narration ?? []],
    ["sfx", audio?.sfx ?? []]
  ];
  const elements = [];
  for (const [track, entries] of tracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const start = entry.start ?? 0;
      const duration = entry.end && entry.end > start ? entry.end - start : undefined;
      elements.push(
        `    <audio id="${escapeAttr(entry.id ?? `${track}-${index + 1}`)}" class="clip" data-start="${start}"${duration ? ` data-duration="${duration}"` : ""} data-track-index="${index + 2}"${entry.volume === undefined ? "" : ` data-volume="${entry.volume}"`} src="${escapeAttr(entry.src)}"></audio>`
      );
    }
  }
  return elements.join("\n");
}

function renderCaptions(captions) {
  return (captions ?? [])
    .map((caption, index) => {
      const duration = Math.max(0.01, caption.end - caption.start);
      return `    <div id="${escapeAttr(caption.id ?? `caption-${index + 1}`)}" class="clip caption" data-start="${caption.start}" data-duration="${duration}" data-track-index="${index + 20}">${escapeHtml(caption.text)}</div>`;
    })
    .join("\n");
}

function renderLocalGsapRuntime() {
  return `(() => {
  class StaticTimeline {
    constructor() { this.currentTime = 0; this.currentScale = 1; }
    pause() { return this; }
    play() { return this; }
    seek(value) { this.currentTime = Number(value) || 0; return this; }
    totalTime(value) { if (value === undefined) return this.currentTime; return this.seek(value); }
    time(value) { if (value === undefined) return this.currentTime; return this.seek(value); }
    duration() { return 0; }
    totalDuration() { return 0; }
    timeScale(value) { if (value === undefined) return this.currentScale; this.currentScale = Number(value) || 1; return this; }
    getChildren() { return []; }
    getTweensOf() { return []; }
    eventCallback() { return this; }
    progress(value) { if (value === undefined) return 0; return this; }
    add() { return this; }
    set() { return this; }
    to() { return this; }
    from() { return this; }
    fromTo() { return this; }
    clear() { return this; }
    kill() { return this; }
  }
  window.gsap = { timeline: () => new StaticTimeline() };
})();
`;
}

function compositionSize(manifest) {
  const first = manifest.clips?.[0]?.resolution;
  if (first?.width && first?.height) {
    return { width: even(first.width), height: even(first.height) };
  }
  return manifest.meta.aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function even(value) {
  return value % 2 === 0 ? value : value + 1;
}

async function writeSuccessResult(input, manifest, render) {
  const metadata = probeRenderedMedia(input.outputPath);
  const report = {
    backend: "hyperframes",
    status: "rendered",
    output_path: input.outputPath,
    manifest_path: input.manifestPath,
    run_dir: input.runDir,
    duration_seconds: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    clip_count: Array.isArray(manifest.clips) ? manifest.clips.length : 0,
    rendered_at: new Date().toISOString(),
    render: {
      command: render.command,
      stdout: truncate(render.stdout),
      stderr: truncate(render.stderr)
    }
  };
  await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report_path: input.reportPath, output_path: input.outputPath }));
}

async function writeFailureResult(input, manifest, failure) {
  const report = {
    backend: "hyperframes",
    status: failure.status,
    output_path: input.outputPath,
    manifest_path: input.manifestPath,
    run_dir: input.runDir,
    clip_count: Array.isArray(manifest.clips) ? manifest.clips.length : 0,
    checked_at: new Date().toISOString(),
    preflight: {
      required_command: HYPERFRAMES_LINT_COMMAND,
      safe_command: HYPERFRAMES_SAFE_LINT_COMMAND
    },
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

function renderCommandOutput(stderr, stdout) {
  return `${stderr}\n${stdout}`.trim().slice(0, 1000);
}

function truncate(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, 2000);
}

function probeRenderedMedia(path) {
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate:format=duration",
    "-of",
    "json",
    path
  ], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT
  });
  if (result.status !== 0) return {};

  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
      duration: Number(parsed.format?.duration) || undefined,
      fps: parseFrameRate(stream.r_frame_rate),
      width: Number(stream.width) || undefined,
      height: Number(stream.height) || undefined
    };
  } catch {
    return {};
  }
}

function parseFrameRate(value) {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return Number(value) || undefined;
  return num / den;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
