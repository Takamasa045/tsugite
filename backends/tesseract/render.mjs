import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTesseractCli, runTesseractCli } from "./cli.mjs";
import { applyTesseractDocument } from "./document.mjs";
import { assertSupportedManifest, buildTesseractDocumentLayers, buildTesseractTextActions } from "./manifest.mjs";

const MAX_PROBE_OUTPUT = 1024 * 1024;
const MAX_CLI_OUTPUT = 4 * 1024 * 1024;
const PROJECT_FILE_NAME = "final.tsrct";

export async function renderTesseract(input, dependencies = {}) {
  const paths = parsePayload(input);
  await assertDirectory(paths.runDir, "runDir");
  await assertPathTree(paths.manifestPath, paths.runDir, "manifestPath");
  await assertPathTree(paths.outputPath, paths.runDir, "outputPath");
  await assertPathTree(paths.reportPath, paths.runDir, "reportPath");
  await assertPathTree(paths.projectPath, paths.runDir, "editable project path");
  await assertDirectory(paths.projectRoot, "projectRoot");
  await assertNotExists(paths.projectPath, "editable Tesseract project");
  await assertNotExists(paths.outputPath, "final video");
  await assertNotExists(paths.reportPath, "render report");

  const manifest = await readManifest(paths.manifestPath);
  const dimensions = assertSupportedManifest(manifest);
  const clipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const durationSeconds = Math.max(manifest.meta.target_duration_seconds, clipDuration);
  const textRequired = Boolean(manifest.presentation?.title) || (manifest.captions?.length ?? 0) > 0;
  const font = await resolveFont(paths.projectRoot, paths.backendOptions, textRequired);

  const mediaPaths = new Map();
  for (const clip of manifest.clips) mediaPaths.set(clip.src, await resolveRunAsset(paths.runDir, clip.src));
  for (const group of ["bgm", "narration", "sfx"]) {
    for (const track of manifest.audio?.[group] ?? []) mediaPaths.set(track.src, await resolveRunAsset(paths.runDir, track.src));
  }
  const sourceInfo = new Map();
  const assetIds = new Map();
  const importsByPath = new Map();
  const canonicalBySource = new Map();
  const fileIdentityBySource = new Map();
  const sourceRoleByPath = new Map();
  for (const clip of manifest.clips) registerSourceRole(sourceRoleByPath, clip.src, "video");
  for (const group of ["bgm", "narration", "sfx"]) {
    for (const track of manifest.audio?.[group] ?? []) registerSourceRole(sourceRoleByPath, track.src, "audio");
  }
  for (const [src, path] of mediaPaths) {
    let canonical = await realpath(path);
    if (!isWithinRoot(canonical, await realpath(paths.runDir))) throw new Error(`media source '${src}' resolves outside the owned run directory`);
    const fileInfo = await lstat(path);
    fileIdentityBySource.set(src, `${fileInfo.dev}:${fileInfo.ino}`);
    let media = importsByPath.get(canonical);
    if (!media) {
      media = await (dependencies.probeMedia ?? probeMedia)(canonical);
      importsByPath.set(canonical, { media, assetId: undefined });
    }
    canonicalBySource.set(src, canonical);
    sourceInfo.set(src, media);
  }
  assertNoCrossRoleMediaReferences(sourceRoleByPath, fileIdentityBySource);
  assertNoDuplicateAudioSources(manifest, fileIdentityBySource, durationSeconds);

  const runtime = await (dependencies.resolveCli ?? resolveTesseractCli)();
  if (!runtime?.ok || typeof runtime.cliPath !== "string") {
    throw new Error(runtime?.message ?? "pinned Tesseract CLI 0.1.0 is unavailable; install it explicitly before rendering");
  }
  const cliPath = runtime.cliPath;
  const invoke = async (args, stage, timeout = 120_000) => {
    const result = await (dependencies.runCli ?? runTesseractCli)(cliPath, args, { cwd: paths.runDir, timeout, maxBuffer: MAX_CLI_OUTPUT });
    if (result?.error || result?.status !== 0) {
      const detail = result?.error?.message ?? truncate(result?.stderr || result?.stdout || `exit code ${result?.status}`);
      throw new Error(`Tesseract ${stage} failed: ${detail}`);
    }
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };

  const workDir = await mkdtemp(join(paths.runDir, `.tesseract-work-${randomUUID()}-`));
  const stagedProjectPath = join(workDir, PROJECT_FILE_NAME);
  const stagedOutputPath = join(workDir, "final.mp4");
  const stagedReportPath = join(workDir, "render-report.json");
  const publishedArtifacts = [];
  let completed = false;
  let renderFailure;
  try {
    await assertDirectory(workDir, "Tesseract staging directory");
    const schemaResult = await invoke(["project", "schema", "--document"], "document schema");
    const documentSchema = parseJsonOutput(schemaResult.stdout, "project schema --document");
    await invoke(["project", "create", "--project", stagedProjectPath], "project creation");
    await assertRegularFile(stagedProjectPath, "editable Tesseract project", workDir);

    for (const [canonical, entry] of importsByPath) {
      const representativeSrc = [...canonicalBySource.entries()].find(([, path]) => path === canonical)?.[0];
      if (!representativeSrc) throw new Error("internal media import path mismatch");
      const videoSuffixes = new Set([".mp4", ".mov", ".m4v"]);
      const requestedAssetId = makeAssetId(representativeSrc);
      const importResult = videoSuffixes.has(extname(canonical).toLowerCase())
        ? await invoke(["project", "import-video", "--project", stagedProjectPath, "--file", canonical, "--asset-id", requestedAssetId], `video import for '${representativeSrc}'`)
        : await invoke(["project", "import-asset", "--project", stagedProjectPath, "--file", canonical, "--asset-id", requestedAssetId, "--kind", "audio"], `audio import for '${representativeSrc}'`);
      entry.assetId = parseImportedAssetId(importResult.stdout, `asset import for '${representativeSrc}'`);
      if (entry.assetId !== requestedAssetId) throw new Error(`Tesseract import for '${representativeSrc}' returned an unexpected assetId`);
      for (const [src, path] of canonicalBySource) if (path === canonical) assetIds.set(src, entry.assetId);
    }

    let fontFace;
    if (font.path) {
      const importResult = await invoke(["project", "import-font", "--project", stagedProjectPath, "--file", font.path], "font import");
      fontFace = selectImportedFontFace(importResult.stdout, font.family, font.style);
    }

    const editablePath = join(workDir, "editable.json");
    await invoke(["project", "checkout", "--project", stagedProjectPath, "--output", editablePath], "project checkout");
    await assertRegularFile(editablePath, "checked out Tesseract document", workDir);
    const document = await readJsonFile(editablePath, "checked out Tesseract document");
    const built = buildTesseractDocumentLayers(manifest, { assetIds, sourceInfo, durationSeconds });
    const configured = applyTesseractDocument(document, documentSchema, {
      width: dimensions.width,
      height: dimensions.height,
      durationSeconds,
      layers: built.layers
    });
    await writeFile(editablePath, `${JSON.stringify(configured.document, null, 2)}\n`, { flag: "w" });
    await invoke(["project", "commit", "--project", stagedProjectPath, "--file", editablePath], "project commit");

    const textActions = buildTesseractTextActions(manifest, {
      compositionId: configured.compositionId,
      firstLayerId: built.nextLayerId,
      fontFamily: fontFace?.fontFamily,
      fontStyle: fontFace?.fontStyle,
      width: dimensions.width,
      height: dimensions.height,
      durationSeconds
    });
    if (textActions.length > 0) {
      const actionsPath = join(workDir, "text-actions.json");
      await writeFile(actionsPath, `${JSON.stringify(textActions, null, 2)}\n`, { flag: "wx" });
      await invoke(["project", "apply", "--project", stagedProjectPath, "--actions", actionsPath], "text-layer authoring");
    }

    await invoke(["export", "--project", stagedProjectPath, "--output", stagedOutputPath], "export", 600_000);
    await assertRegularFile(stagedProjectPath, "editable Tesseract project", workDir);
    await assertRegularFile(stagedOutputPath, "rendered video", workDir);
    const metadata = await (dependencies.probeMedia ?? probeMedia)(stagedOutputPath);
    validateRenderedOutput(metadata, manifest, dimensions, durationSeconds);
    await (dependencies.decodeVideo ?? decodeVideo)(stagedOutputPath);
    const report = {
      backend: "tesseract",
      status: "rendered",
      output_path: paths.outputPath,
      manifest_path: paths.manifestPath,
      run_dir: paths.runDir,
      editable_project_path: paths.projectPath,
      duration_seconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      clip_count: manifest.clips.length,
      audio_track_count: (manifest.audio?.bgm?.length ?? 0) + (manifest.audio?.narration?.length ?? 0) + (manifest.audio?.sfx?.length ?? 0),
      rendered_at: new Date().toISOString()
    };
    await writeReport(stagedReportPath, report, workDir);
    await publishArtifact(stagedProjectPath, paths.projectPath, paths.runDir, "editable Tesseract project", publishedArtifacts);
    await publishArtifact(stagedOutputPath, paths.outputPath, paths.runDir, "final video", publishedArtifacts);
    await publishArtifact(stagedReportPath, paths.reportPath, paths.runDir, "render report", publishedArtifacts);
    completed = true;
    return report;
  } catch (error) {
    renderFailure = error;
    throw error;
  } finally {
    if (!completed) {
      const cleanupErrors = await removePublishedArtifacts(publishedArtifacts);
      if (cleanupErrors.length > 0) {
        const message = `failed to clean partial Tesseract outputs: ${cleanupErrors.join("; ")}`;
        if (renderFailure instanceof Error) renderFailure.message = `${renderFailure.message}; ${message}`;
        else throw new Error(message);
      }
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

export function parsePayload(input) {
  if (!input || typeof input !== "object") throw new Error("render payload must be a JSON object");
  const runDir = requiredAbsolutePath(input.runDir, "runDir");
  const manifestPath = requiredAbsolutePath(input.manifestPath, "manifestPath");
  const outputPath = requiredAbsolutePath(input.outputPath, "outputPath");
  const reportPath = requiredAbsolutePath(input.reportPath, "reportPath");
  const projectRoot = requiredAbsolutePath(input.projectRoot, "projectRoot");
  if (manifestPath !== resolve(join(runDir, "manifest.json"))) throw new Error("manifestPath must be <runDir>/manifest.json");
  if (outputPath !== resolve(join(runDir, "final.mp4"))) throw new Error("outputPath must be <runDir>/final.mp4");
  if (reportPath !== resolve(join(runDir, "render-report.json"))) throw new Error("reportPath must be <runDir>/render-report.json");
  const projectPath = resolve(join(runDir, PROJECT_FILE_NAME));
  const backendOptions = input.backendOptions ?? {};
  if (!backendOptions || typeof backendOptions !== "object" || Array.isArray(backendOptions)) throw new Error("backendOptions must be an object");
  for (const key of Object.keys(backendOptions)) {
    if (!["font_path", "font_family", "font_style"].includes(key)) throw new Error(`unsupported Tesseract backend option '${key}'`);
  }
  if ((backendOptions.font_family === undefined) !== (backendOptions.font_style === undefined)) {
    throw new Error("font_family and font_style must be set together when selecting a face from a font collection");
  }
  return { runDir, manifestPath, outputPath, reportPath, projectRoot, projectPath, backendOptions };
}

export function validateRenderedOutput(metadata, manifest, dimensions, expectedDuration) {
  if (!metadata || metadata.ok === false || !metadata.hasVideo || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    throw new Error("ffprobe could not validate the Tesseract MP4 output");
  }
  if (!metadata.width || !metadata.height || !metadata.fps || !Number.isFinite(metadata.fps) || !(metadata.sizeBytes > 0)) {
    throw new Error("Tesseract MP4 has incomplete video metadata or is empty");
  }
  if (Math.abs(metadata.fps - manifest.meta.fps) > 0.000001) {
    throw new Error(`Tesseract export produced ${metadata.fps} fps, but the manifest declares ${manifest.meta.fps} fps; refusing a mismatched render`);
  }
  if (metadata.width !== dimensions.width || metadata.height !== dimensions.height) {
    throw new Error(`Tesseract MP4 dimensions ${metadata.width}x${metadata.height} do not match the requested ${dimensions.width}x${dimensions.height}`);
  }
  if (Math.abs(metadata.durationSeconds - expectedDuration) > (1 / manifest.meta.fps) + 0.03) {
    throw new Error(`Tesseract export duration ${metadata.durationSeconds.toFixed(3)}s does not match the manifest duration ${expectedDuration.toFixed(3)}s`);
  }
  const expectedAudio = manifest.clips.some((clip) => clip.audio) ||
    ["bgm", "narration", "sfx"].some((group) => (manifest.audio?.[group] ?? []).some((track) => (track.volume ?? 1) > 0));
  if (expectedAudio && !metadata.hasAudio) throw new Error("Tesseract MP4 is missing audio requested by the manifest");
}

export async function probeMedia(path) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path
  ], { encoding: "utf8", maxBuffer: MAX_PROBE_OUTPUT, timeout: 30_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`ffprobe failed for '${path}': ${result.error?.message ?? truncate(result.stderr)}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`ffprobe returned invalid JSON for '${path}'`); }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const audio = Boolean(audioStream);
  const durationSeconds = positiveNumber(parsed.format?.duration, video?.duration, audioStream?.duration);
  const videoDurationSeconds = positiveNumber(video?.duration, parsed.format?.duration);
  const audioDurationSeconds = positiveNumber(audioStream?.duration, parsed.format?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  const fps = parseFrameRate(video?.avg_frame_rate || video?.r_frame_rate);
  const sizeBytes = Number(parsed.format?.size) || 0;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`ffprobe could not read a positive duration for '${path}'`);
  return { hasVideo: Boolean(video), hasAudio: audio, durationSeconds, videoDurationSeconds, audioDurationSeconds, width, height, fps, sizeBytes };
}

export async function decodeVideo(path) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: MAX_PROBE_OUTPUT,
    windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg could not decode the Tesseract output: ${result.error?.message ?? truncate(result.stderr)}`);
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
    await renderTesseract(input);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 20;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readManifest(path) {
  await assertRegularFile(path, "manifest");
  let manifest;
  try { manifest = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`manifest must be readable JSON: ${error instanceof Error ? error.message : String(error)}`); }
  assertSupportedManifest(manifest);
  return manifest;
}

async function readJsonFile(path, label) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function resolveFont(projectRoot, backendOptions, required) {
  if (!required && backendOptions.font_path === undefined) return { path: undefined };
  if (typeof backendOptions.font_path !== "string" || !backendOptions.font_path) {
    throw new Error("Tesseract title/captions require a local font; set edit.backend_options.tesseract.font_path to a project-relative TTF, OTF, or TTC file");
  }
  const fontPath = resolve(projectRoot, backendOptions.font_path);
  if (!isWithinRoot(fontPath, projectRoot) || isAbsolute(backendOptions.font_path) || backendOptions.font_path.includes("\\")) {
    throw new Error("Tesseract font_path must be a project-relative path inside the project directory");
  }
  if (backendOptions.font_path.split("/").includes("..")) {
    throw new Error("Tesseract font_path must not contain parent directory references");
  }
  if (![".ttf", ".otf", ".ttc"].includes(extname(fontPath).toLowerCase())) throw new Error("Tesseract font_path must use a TTF, OTF, or TTC font file");
  await assertRegularFile(fontPath, "configured font", projectRoot);
  return { path: fontPath, family: backendOptions.font_family, style: backendOptions.font_style };
}

async function resolveRunAsset(runDir, src) {
  if (typeof src !== "string" || !src || isAbsolute(src) || /^[a-z]+:/i.test(src) || src.includes("\\")) {
    throw new Error("Tesseract media assets must use local relative paths");
  }
  if (src.split("/").includes("..")) throw new Error("Tesseract media paths must not contain parent directory references");
  const path = resolve(runDir, src);
  if (!isWithinRoot(path, runDir)) throw new Error(`media source '${src}' escapes the owned run directory`);
  await assertRegularFile(path, `media source '${src}'`, runDir);
  return path;
}

function registerSourceRole(roles, src, role) {
  const existing = roles.get(src);
  if (existing && existing !== role) {
    throw new Error(`manifest source '${src}' cannot be reused across video and audio asset types in Tesseract`);
  }
  roles.set(src, role);
}

function assertNoCrossRoleMediaReferences(roles, fileIdentityBySource) {
  const roleByIdentity = new Map();
  for (const [src, role] of roles) {
    const identity = fileIdentityBySource.get(src);
    if (!identity) throw new Error(`manifest source '${src}' has no file identity`);
    const previous = roleByIdentity.get(identity);
    if (previous && previous.role !== role) {
      throw new Error(`manifest sources '${previous.src}' and '${src}' reference the same file as both video and audio; Tesseract asset typing is ambiguous`);
    }
    roleByIdentity.set(identity, { role, src });
  }
}

function assertNoDuplicateAudioSources(manifest, fileIdentityBySource, durationSeconds) {
  const byFileIdentity = new Map();
  for (const group of ["bgm", "narration", "sfx"]) {
    for (const [index, track] of (manifest.audio?.[group] ?? []).entries()) {
      const path = fileIdentityBySource.get(track.src);
      if (!path) throw new Error(`audio.${group}.${index} has no file identity`);
      const start = track.start ?? 0;
      const end = track.end ?? durationSeconds;
      const previous = byFileIdentity.get(path) ?? [];
      if (previous.some((range) => start < range.end && range.start < end && (track.volume ?? 1) > 0 && range.volume > 0)) {
        throw new Error(`audio.${group}.${index} overlaps another audible layer from the same resolved source and could duplicate playback`);
      }
      previous.push({ start, end, volume: track.volume ?? 1 });
      byFileIdentity.set(path, previous);
    }
  }
}

function parseImportedAssetId(stdout, label) {
  const data = parseJsonOutput(stdout, label);
  const ids = new Set();
  const visited = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (typeof value.assetId === "string") ids.add(value.assetId);
    if (typeof value.asset_id === "string") ids.add(value.asset_id);
    if (value.asset && typeof value.asset.id === "string") ids.add(value.asset.id);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(data);
  if (ids.size !== 1) throw new Error(`${label} did not return one unambiguous assetId`);
  return [...ids][0];
}

function selectImportedFontFace(stdout, requestedFamily, requestedStyle) {
  const data = parseJsonOutput(stdout, "project import-font");
  const faceList = Array.isArray(data.faces) ? data.faces : undefined;
  const faces = faceList ?? (typeof data.fontFamily === "string" && typeof data.fontStyle === "string" ? [data] : []);
  if (faces.length === 0) throw new Error("project import-font did not return fontFamily/fontStyle metadata");
  let selected;
  if (requestedFamily !== undefined || requestedStyle !== undefined) {
    selected = faces.find((face) => face.fontFamily === requestedFamily && face.fontStyle === requestedStyle);
    if (!selected) throw new Error("configured font_family/font_style do not match a face returned by project import-font");
  } else if (faces.length === 1) {
    selected = faces[0];
  } else {
    throw new Error("project import-font returned multiple font faces; set matching font_family and font_style in backend_options");
  }
  if (typeof selected.fontFamily !== "string" || !selected.fontFamily || typeof selected.fontStyle !== "string" || !selected.fontStyle) {
    throw new Error("project import-font returned incomplete font family/style metadata");
  }
  return { fontFamily: selected.fontFamily, fontStyle: selected.fontStyle };
}

function parseJsonOutput(stdout, label) {
  try { return JSON.parse(String(stdout).trim()); }
  catch { throw new Error(`${label} must return JSON so its IDs and schema can be checked safely`); }
}

async function writeReport(path, report, runDir) {
  await assertPathTree(path, runDir, "render report");
  await assertNotExists(path, "render report");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

async function publishArtifact(source, destination, runDir, label, published) {
  await assertRegularFile(source, `staged ${label}`, runDir);
  await assertPathTree(destination, runDir, label);
  await assertNotExists(destination, label);
  const sourceInfo = await lstat(source);
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} appeared while publishing; refusing to overwrite it`);
    throw new Error(`${label} could not be published safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  published.push({ path: destination, dev: sourceInfo.dev, ino: sourceInfo.ino });
}

async function removePublishedArtifacts(published) {
  const errors = [];
  for (const artifact of [...published].reverse()) {
    try {
      const info = await lstat(artifact.path);
      if (info.isSymbolicLink() || !info.isFile() || info.dev !== artifact.dev || info.ino !== artifact.ino) {
        errors.push(`${artifact.path} changed after this render created it; left untouched`);
        continue;
      }
      await unlink(artifact.path);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(`${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function assertPathTree(path, stopRoot, label) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(stopRoot);
  if (!isWithinRoot(resolvedPath, resolvedRoot)) throw new Error(`${label} must remain inside ${resolvedRoot}`);
  let current = resolvedPath;
  const existing = [];
  while (isWithinRoot(current, resolvedRoot)) {
    existing.unshift(current);
    if (current === resolvedRoot) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  for (const entry of existing) {
    try {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error(`${label} must not use a symlink path: ${entry}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function assertRegularFile(path, label, stopRoot) {
  if (stopRoot) await assertPathTree(path, stopRoot, label);
  let info;
  try { info = await lstat(path); }
  catch (error) { throw new Error(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`); }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  return info;
}

async function assertDirectory(path, label) {
  let info;
  try { info = await lstat(path); }
  catch (error) { throw new Error(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a regular non-symlink directory`);
}

async function assertNotExists(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists; refusing to overwrite an existing run artifact`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing to overwrite")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

function requiredAbsolutePath(value, name) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function isWithinRoot(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseFrameRate(value) {
  if (typeof value !== "string") return Number(value) || undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return Number(value) || undefined;
  return num / den;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return Number.NaN;
}

function makeAssetId(src) {
  const base = src.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? "asset";
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 36) || "asset";
  const suffix = createHash("sha256").update(src).digest("hex").slice(0, 10);
  return `tsugite-${safe}-${suffix}`;
}

function truncate(value) {
  return String(value ?? "").slice(0, 3000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
