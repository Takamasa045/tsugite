import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, link, lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { resolveTesseractCli, runTesseractCli } from "./cli.mjs";
import { buildTesseractAudioReactiveActions } from "./audioEnvelope.mjs";
import { buildTesseractCaptionMotionActions } from "./textMotion.mjs";
import { applyTesseractDocument, applyTesseractNativeDocument } from "./document.mjs";
import {
  assertNoConflictingKeyframeActions,
  assertSupportedManifest,
  assertTesseractInputDimensions,
  assertTesseractNativeActions,
  resolveTesseractNativeOutputs,
  buildTesseractCaptionLayerTargets,
  buildTesseractDocumentLayers,
  buildTesseractMotionActions,
  buildTesseractTextActions,
  describeTesseractMotion
} from "./manifest.mjs";

const MAX_PROBE_OUTPUT = 1024 * 1024;
const MAX_CLI_OUTPUT = 4 * 1024 * 1024;
const MAX_PNG_PIXELS = 64 * 1024 * 1024;
const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;
const PROJECT_FILE_NAME = "final.tsrct";
const FONT_SUFFIXES = new Set([".ttf", ".otf", ".ttc"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

export async function renderTesseract(input, dependencies = {}) {
  const paths = parsePayload(input);
  await assertDirectory(paths.runDir, "runDir");
  await assertPathTree(paths.manifestPath, paths.runDir, "manifestPath");
  await assertPathTree(paths.outputPath, paths.runDir, "outputPath");
  await assertPathTree(paths.reportPath, paths.runDir, "reportPath");
  await assertPathTree(paths.previewPath, paths.runDir, "Tesseract preview path");
  await assertPathTree(paths.filmstripPath, paths.runDir, "Tesseract filmstrip path");
  await assertPathTree(paths.projectPath, paths.runDir, "editable project path");
  await assertDirectory(paths.projectRoot, "projectRoot");
  await assertNotExists(paths.projectPath, "editable Tesseract project");
  await assertNotExists(paths.outputPath, "final video");
  await assertNotExists(paths.reportPath, "render report");
  const manifest = await readManifest(paths.manifestPath);
  const dimensions = assertSupportedManifest(manifest, dependencies.platform ?? process.platform);
  const hasNativeAuthoring = Boolean(manifest.native_edit);
  const nativeOutputs = resolveTesseractNativeOutputs(manifest.native_edit, dependencies.platform ?? process.platform, manifest.meta.target_duration_seconds);
  for (const output of nativeOutputs) {
    const destination = resolve(paths.runDir, output.path);
    await assertPathTree(destination, paths.runDir, `native output '${output.path}'`);
    await assertNotExists(destination, `native output '${output.path}'`);
  }
  assertNativeDeclaredAssetsReferenced(manifest);
  if (hasNativeAuthoring) {
    await assertNotExists(paths.previewPath, "Tesseract preview image");
    await assertNotExists(paths.filmstripPath, "Tesseract filmstrip image");
  }
  const clipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const durationSeconds = manifest.native_edit?.payload?.document
    ? manifest.meta.target_duration_seconds
    : Math.max(manifest.meta.target_duration_seconds, clipDuration);
  const textRequired = Boolean(manifest.presentation?.title) || (manifest.captions?.length ?? 0) > 0;
  const font = await resolveFont(paths.projectRoot, paths.backendOptions, textRequired);

  const mediaPaths = new Map();
  for (const clip of manifest.clips) mediaPaths.set(clip.src, await resolveRunAsset(paths.runDir, clip.src));
  for (const group of ["bgm", "narration", "sfx"]) {
    for (const track of manifest.audio?.[group] ?? []) mediaPaths.set(track.src, await resolveRunAsset(paths.runDir, track.src));
  }
  const requestedAssetIdBySource = new Map();
  if (manifest.native_edit?.payload?.document) {
    for (const clip of manifest.clips) requestedAssetIdBySource.set(clip.src, clip.id);
  }
  for (const image of manifest.images ?? []) {
    mediaPaths.set(image.src, await resolveRunAsset(paths.runDir, image.src));
    requestedAssetIdBySource.set(image.src, image.id);
  }
  for (const asset of manifest.native_edit?.assets ?? []) {
    mediaPaths.set(asset.src, await resolveRunAsset(paths.runDir, asset.src));
    const previous = requestedAssetIdBySource.get(asset.src);
    if (previous && previous !== asset.asset_id) throw new Error(`native asset '${asset.src}' has conflicting asset IDs '${previous}' and '${asset.asset_id}'`);
    requestedAssetIdBySource.set(asset.src, asset.asset_id);
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
  for (const image of manifest.images ?? []) registerSourceRole(sourceRoleByPath, image.src, "image");
  for (const asset of manifest.native_edit?.assets ?? []) registerSourceRole(sourceRoleByPath, asset.src, asset.kind);
  for (const [src, path] of mediaPaths) {
    let canonical = await realpath(path);
    if (!isWithinRoot(canonical, await realpath(paths.runDir))) throw new Error(`media source '${src}' resolves outside the owned run directory`);
    const fileInfo = await lstat(path);
    fileIdentityBySource.set(src, `${fileInfo.dev}:${fileInfo.ino}`);
    let media = importsByPath.get(canonical);
    if (!media) {
      const role = sourceRoleByPath.get(src);
      media = role === "image" ? undefined : await (dependencies.probeMedia ?? probeMedia)(canonical);
      importsByPath.set(canonical, { media, assetId: undefined });
    }
    canonicalBySource.set(src, canonical);
    sourceInfo.set(src, importsByPath.get(canonical).media);
  }
  assertNoCrossRoleMediaReferences(sourceRoleByPath, fileIdentityBySource);
  assertNoDuplicateAudioSources(manifest, fileIdentityBySource, durationSeconds);
  if (!manifest.native_edit?.payload?.document) assertTesseractInputDimensions(manifest, sourceInfo, dimensions);

  const runtime = await (dependencies.resolveCli ?? resolveTesseractCli)();
  if (!runtime?.ok || typeof runtime.cliPath !== "string") {
    throw new Error(runtime?.message ?? "the pinned Tesseract CLI is unavailable; install it explicitly before rendering");
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
  const stagedPreviewPath = join(workDir, "preview.png");
  const stagedFilmstripPath = join(workDir, "filmstrip.png");
  const stagedNativeOutputs = nativeOutputs.map((output) => ({ ...output, stagedPath: join(workDir, output.path) }));
  const publishedArtifacts = [];
  let completed = false;
  let renderFailure;
  try {
    await assertDirectory(workDir, "Tesseract staging directory");
    const schemaResult = await invoke(["project", "schema", "--document"], "document schema");
    const documentSchema = parseJsonOutput(schemaResult.stdout, "project schema --document");
    await invoke(["project", "create", "--project", stagedProjectPath], "project creation");
    await assertRegularFile(stagedProjectPath, "editable Tesseract project", workDir);

    const requestedAssetIdByCanonical = new Map();
    for (const [src, requestedAssetId] of requestedAssetIdBySource) {
      const canonical = canonicalBySource.get(src);
      if (!canonical) throw new Error(`declared Tesseract asset '${src}' was not resolved`);
      const previous = requestedAssetIdByCanonical.get(canonical);
      if (previous && previous !== requestedAssetId) throw new Error(`asset aliases for '${src}' declare conflicting Tesseract asset IDs`);
      requestedAssetIdByCanonical.set(canonical, requestedAssetId);
    }
    const importedIds = new Set();
    for (const [canonical, entry] of importsByPath) {
      const representativeSrc = [...canonicalBySource.entries()].find(([, path]) => path === canonical)?.[0];
      if (!representativeSrc) throw new Error("internal media import path mismatch");
      const role = sourceRoleByPath.get(representativeSrc);
      if (!role || !["video", "audio", "image"].includes(role)) throw new Error(`unsupported native asset kind for '${representativeSrc}'`);
      const requestedAssetId = requestedAssetIdByCanonical.get(canonical) ?? makeAssetId(representativeSrc);
      if (importedIds.has(requestedAssetId)) throw new Error(`Tesseract assets must use unique IDs; duplicate '${requestedAssetId}'`);
      importedIds.add(requestedAssetId);
      const importResult = role === "video"
        ? await invoke(["project", "import-video", "--project", stagedProjectPath, "--file", canonical, "--asset-id", requestedAssetId], `video import for '${representativeSrc}'`)
        : await invoke(["project", "import-asset", "--project", stagedProjectPath, "--file", canonical, "--asset-id", requestedAssetId, "--kind", role], `${role} import for '${representativeSrc}'`);
      entry.assetId = parseImportedAssetId(importResult.stdout, `asset import for '${representativeSrc}'`);
      if (entry.assetId !== requestedAssetId) throw new Error(`Tesseract import for '${representativeSrc}' returned an unexpected assetId`);
      for (const [src, path] of canonicalBySource) if (path === canonical) assetIds.set(src, entry.assetId);
    }

    const nativeFontImports = [];
    for (const [index, nativeFont] of (manifest.native_edit?.fonts ?? []).entries()) {
      const fontPath = await resolveRunAsset(paths.runDir, nativeFont.src);
      if (!FONT_SUFFIXES.has(extname(fontPath).toLowerCase())) throw new Error(`native_edit.fonts.${index}.src must use TTF, OTF, or TTC`);
      const importResult = await invoke(["project", "import-font", "--project", stagedProjectPath, "--file", fontPath], `native font import ${index + 1}`);
      const faces = parseImportedFontFaces(importResult.stdout, nativeFont.family, nativeFont.style);
      nativeFontImports.push({ src: nativeFont.src, faces });
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
    const built = manifest.native_edit?.payload?.document
      ? { layers: [], clipLayers: [], nextLayerId: 1 }
      : buildTesseractDocumentLayers(manifest, { assetIds, sourceInfo, durationSeconds });
    const configured = manifest.native_edit?.payload?.document
      ? applyTesseractNativeDocument(documentSchema, manifest.native_edit.payload.document, {
          width: dimensions.width,
          height: dimensions.height,
          durationSeconds
        })
      : applyTesseractDocument(document, documentSchema, {
          width: dimensions.width,
          height: dimensions.height,
          durationSeconds,
          layers: built.layers
        });
    await writeFile(editablePath, `${JSON.stringify(configured.document, null, 2)}\n`, { flag: "w" });
    await invoke(["project", "commit", "--project", stagedProjectPath, "--file", editablePath], "project commit");

    const motionActions = manifest.native_edit?.payload?.document ? [] : buildTesseractMotionActions(manifest, {
      compositionId: configured.compositionId,
      clipLayers: built.clipLayers
    });
    const textActions = manifest.native_edit?.payload?.document ? [] : buildTesseractTextActions(manifest, {
      compositionId: configured.compositionId,
      firstLayerId: built.nextLayerId,
      fontFamily: fontFace?.fontFamily,
      fontStyle: fontFace?.fontStyle,
      width: dimensions.width,
      height: dimensions.height,
      durationSeconds
    });
    const captionLayers = buildTesseractCaptionLayerTargets(manifest, textActions);
    const captionMotionActions = manifest.native_edit?.payload?.document ? [] : buildTesseractCaptionMotionActions(manifest, {
      compositionId: configured.compositionId,
      textActions,
      width: dimensions.width,
      height: dimensions.height,
      fps: manifest.meta.fps
    });
    const audioReactiveActions = manifest.native_edit?.payload?.document ? [] : await buildTesseractAudioReactiveActions(manifest, {
      compositionId: configured.compositionId,
      clipLayers: built.clipLayers,
      captionLayers,
      canonicalBySource,
      sourceInfo,
      readPcm: dependencies.readAudioPcm
    });
    assertNoConflictingKeyframeActions(motionActions, captionMotionActions, audioReactiveActions);
    const nativeActions = manifest.native_edit?.payload?.actions ?? [];
    if (nativeActions.length > 0) {
      const actionSchemaResult = await invoke(["project", "schema"], "action schema");
      const actionSchema = parseJsonOutput(actionSchemaResult.stdout, "project schema");
      assertTesseractNativeActions(nativeActions, actionSchema);
    }
    const authoringActions = [...motionActions, ...textActions, ...captionMotionActions, ...audioReactiveActions, ...nativeActions];
    if (authoringActions.length > 0) {
      const actionsPath = join(workDir, "authoring-actions.json");
      await writeFile(actionsPath, `${JSON.stringify(authoringActions, null, 2)}\n`, { flag: "wx" });
      await invoke(["project", "apply", "--project", stagedProjectPath, "--actions", actionsPath], "motion/text authoring");
    }

    let finalNativeDocument = manifest.native_edit?.payload?.document;
    if (manifest.native_edit?.payload?.document) {
      const finalDocumentPath = join(workDir, "final-document.json");
      await invoke(["project", "checkout", "--project", stagedProjectPath, "--output", finalDocumentPath], "final document checkout");
      await assertRegularFile(finalDocumentPath, "final Tesseract document", workDir);
      finalNativeDocument = await readJsonFile(finalDocumentPath, "final Tesseract document");
    }

    if (hasNativeAuthoring) {
      const previewTime = Math.min(durationSeconds / 2, Math.max(0, durationSeconds - 0.001));
      const durationMs = Math.max(1, Math.floor(durationSeconds * 1000));
      const filmstripIntervalMs = Math.max(250, Math.ceil(durationMs / 24 / 50) * 50);
      await invoke(["preview", "--project", stagedProjectPath, "--time", String(previewTime), "--output", stagedPreviewPath], "native preview");
      await assertPng(stagedPreviewPath, "Tesseract native preview", workDir);
      await invoke(["filmstrip", "--project", stagedProjectPath, "--start-ms", "0", "--duration-ms", String(durationMs), "--interval-ms", String(filmstripIntervalMs), "--output", stagedFilmstripPath], "native filmstrip");
      await assertPng(stagedFilmstripPath, "Tesseract native filmstrip", workDir);
    }

    const exportSettings = resolveNativeExportSettings(manifest);
    const exportArgs = ["export", "--project", stagedProjectPath, "--output", stagedOutputPath];
    if (manifest.native_edit?.payload?.document) exportArgs.push("--resolution", exportSettings.resolution, "--fps", String(exportSettings.fps));
    const ffmpegPath = await resolveExportFfmpeg(paths.backendOptions);
    if (ffmpegPath) exportArgs.push("--encoder-backend", "external-ffmpeg-command", "--ffmpeg-path", ffmpegPath);
    await invoke(exportArgs, "export", 600_000);
    await assertRegularFile(stagedProjectPath, "editable Tesseract project", workDir);
    await assertRegularFile(stagedOutputPath, "rendered video", workDir);
    const metadata = await (dependencies.probeMedia ?? probeMedia)(stagedOutputPath);
    validateRenderedOutput(metadata, manifest, dimensions, durationSeconds, exportSettings, finalNativeDocument);
    await (dependencies.decodeVideo ?? decodeVideo)(stagedOutputPath, ffmpegPath);
    for (const output of stagedNativeOutputs) {
      const sidecarArgs = ["export", "--project", stagedProjectPath, "--format", "prores", "--output", output.stagedPath,
        "--resolution", exportSettings.resolution, "--fps", String(exportSettings.fps)];
      if (output.kind === "alpha_solo_prores_mov") {
        sidecarArgs.push("--fx-solo", manifest.native_edit.payload.export.prores_alpha_solo);
      }
      await invoke(sidecarArgs, output.kind === "alpha_solo_prores_mov" ? "ProRes alpha sidecar export" : "ProRes sidecar export", 600_000);
      await assertRegularFile(output.stagedPath, output.kind, workDir);
      const sidecarMetadata = await (dependencies.probeMedia ?? probeMedia)(output.stagedPath);
      validateProresSidecar(sidecarMetadata, output);
      await (dependencies.decodeVideo ?? decodeVideo)(output.stagedPath, ffmpegPath);
    }
    const nativeLayerInfo = manifest.native_edit?.payload?.document
      ? summarizeNativeDocument(finalNativeDocument, requestedAssetIdBySource, sourceRoleByPath)
      : undefined;
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
      ...(nativeLayerInfo ? nativeLayerInfo : {
        clip_count: manifest.clips.length,
        audio_track_count: (manifest.audio?.bgm?.length ?? 0) + (manifest.audio?.narration?.length ?? 0) + (manifest.audio?.sfx?.length ?? 0)
      }),
      ...(nativeFontImports.length ? { native_font_imports: nativeFontImports } : {}),
      ...(nativeOutputs.length ? { sidecars: nativeOutputs.map(({ kind, path }) => ({ kind, path })) } : {}),
      ...(hasNativeAuthoring ? { preview_path: paths.previewPath, filmstrip_path: paths.filmstripPath } : {}),
      ...(describeTesseractMotion(manifest) ? { motion: describeTesseractMotion(manifest) } : {}),
      audio_reactive_action_count: audioReactiveActions.length,
      rendered_at: new Date().toISOString()
    };
    await writeReport(stagedReportPath, report, workDir);
    await publishArtifact(stagedProjectPath, paths.projectPath, paths.runDir, "editable Tesseract project", publishedArtifacts);
    await publishArtifact(stagedOutputPath, paths.outputPath, paths.runDir, "final video", publishedArtifacts);
    for (const output of stagedNativeOutputs) {
      await publishArtifact(output.stagedPath, resolve(paths.runDir, output.path), paths.runDir, output.kind, publishedArtifacts);
    }
    if (hasNativeAuthoring) {
      await publishArtifact(stagedPreviewPath, paths.previewPath, paths.runDir, "Tesseract native preview", publishedArtifacts);
      await publishArtifact(stagedFilmstripPath, paths.filmstripPath, paths.runDir, "Tesseract native filmstrip", publishedArtifacts);
    }
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
  const previewPath = resolve(join(runDir, "preview.png"));
  const filmstripPath = resolve(join(runDir, "filmstrip.png"));
  const backendOptions = input.backendOptions ?? {};
  if (!backendOptions || typeof backendOptions !== "object" || Array.isArray(backendOptions)) throw new Error("backendOptions must be an object");
  for (const key of Object.keys(backendOptions)) {
    if (!["font_path", "font_family", "font_style", "ffmpeg_path"].includes(key)) throw new Error(`unsupported Tesseract backend option '${key}'`);
  }
  if (backendOptions.ffmpeg_path !== undefined && (typeof backendOptions.ffmpeg_path !== "string" || !isAbsolute(backendOptions.ffmpeg_path))) {
    throw new Error("ffmpeg_path must be an absolute path to an executable ffmpeg binary");
  }
  if ((backendOptions.font_family === undefined) !== (backendOptions.font_style === undefined)) {
    throw new Error("font_family and font_style must be set together when selecting a face from a font collection");
  }
  return { runDir, manifestPath, outputPath, reportPath, previewPath, filmstripPath, projectRoot, projectPath, backendOptions };
}

export function validateRenderedOutput(metadata, manifest, dimensions, expectedDuration, exportSettings = resolveNativeExportSettings(manifest), nativeDocument = manifest.native_edit?.payload?.document) {
  if (!metadata || metadata.ok === false || !metadata.hasVideo || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    throw new Error("ffprobe could not validate the Tesseract MP4 output");
  }
  if (!metadata.width || !metadata.height || !metadata.fps || !Number.isFinite(metadata.fps) || !(metadata.sizeBytes > 0)) {
    throw new Error("Tesseract MP4 has incomplete video metadata or is empty");
  }
  if (Math.abs(metadata.fps - exportSettings.fps) > 0.000001) {
    throw new Error(`Tesseract export produced ${metadata.fps} fps, but the reviewed export requests ${exportSettings.fps} fps; refusing a mismatched render`);
  }
  const expectedDimensions = expectedExportDimensions(dimensions, manifest.native_edit?.payload?.document, exportSettings.resolution);
  if (metadata.width !== expectedDimensions.width || metadata.height !== expectedDimensions.height) {
    throw new Error(`Tesseract MP4 dimensions ${metadata.width}x${metadata.height} do not match the reviewed ${exportSettings.resolution} export ${expectedDimensions.width}x${expectedDimensions.height}`);
  }
  if (Math.abs(metadata.durationSeconds - expectedDuration) > (1 / manifest.meta.fps) + 0.03) {
    throw new Error(`Tesseract export duration ${metadata.durationSeconds.toFixed(3)}s does not match the manifest duration ${expectedDuration.toFixed(3)}s`);
  }
  const expectedAudio = manifest.native_edit?.payload?.document
    ? nativeDocumentReferencesAudio(nativeDocument, manifest)
    : manifest.clips.some((clip) => clip.audio) ||
      ["bgm", "narration", "sfx"].some((group) => (manifest.audio?.[group] ?? []).some((track) => (track.volume ?? 1) > 0));
  if (manifest.native_edit?.payload?.document) {
    const expectedNativeAudio = manifest.native_edit.primary_output.audio_required;
    if (Boolean(metadata.hasAudio) !== expectedNativeAudio) {
      throw new Error("Tesseract native MP4 audio presence does not match the Gate 1 declaration");
    }
  } else if (expectedAudio && !metadata.hasAudio) {
    throw new Error("Tesseract MP4 is missing audio referenced by the native document or manifest");
  }
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
  return {
    hasVideo: Boolean(video), hasAudio: audio, durationSeconds, videoDurationSeconds, audioDurationSeconds,
    width, height, fps, videoCodec: video?.codec_name, pixelFormat: video?.pix_fmt, sizeBytes
  };
}

const ALPHA_PIXEL_FORMATS = new Set(["argb", "rgba", "abgr", "bgra"]);

export function validateProresSidecar(metadata, output) {
  if (!metadata || metadata.ok === false || !metadata.hasVideo || !(metadata.sizeBytes > 0) ||
      !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    throw new Error(`ffprobe could not validate the ${output.kind} sidecar`);
  }
  const expected = output;
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(`${output.kind} dimensions ${metadata.width}x${metadata.height} do not match the Gate 1 declaration ${expected.width}x${expected.height}`);
  }
  if (!Number.isFinite(metadata.fps) || Math.abs(metadata.fps - expected.fps) > 0.000001) {
    throw new Error(`${output.kind} fps does not match the Gate 1 declaration of ${expected.fps}`);
  }
  if (metadata.videoCodec !== expected.video_codec) {
    throw new Error(`${output.kind} video codec '${metadata.videoCodec ?? "unknown"}' does not match the Gate 1 declaration '${expected.video_codec}'`);
  }
  const actualDuration = Number.isFinite(metadata.videoDurationSeconds) ? metadata.videoDurationSeconds : metadata.durationSeconds;
  if (Math.abs(actualDuration - expected.duration_seconds) > (1 / expected.fps) + 0.03) {
    throw new Error(`${output.kind} duration ${actualDuration.toFixed(3)}s does not match the Gate 1 declaration ${expected.duration_seconds.toFixed(3)}s`);
  }
  if (Boolean(metadata.hasAudio) !== expected.audio_required) {
    throw new Error(`${output.kind} audio presence does not match the Gate 1 declaration`);
  }
  if (expected.alpha_required) {
    const pixelFormat = metadata.pixelFormat;
    if (typeof pixelFormat !== "string" || !(ALPHA_PIXEL_FORMATS.has(pixelFormat) || /^yuva\d{3,4}p(?:\d{2})?(?:le|be)?$/.test(pixelFormat))) {
      throw new Error(`${output.kind} pixel format '${pixelFormat ?? "unknown"}' does not preserve alpha`);
    }
  }
}

export async function decodeVideo(path, ffmpegPath = "ffmpeg") {
  const result = spawnSync(ffmpegPath, ["-v", "error", "-i", path, "-f", "null", "-"], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: MAX_PROBE_OUTPUT,
    windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg could not decode the Tesseract output: ${result.error?.message ?? truncate(result.stderr)}`);
}

export async function assertPng(path, label, stopRoot) {
  await assertRegularFile(path, label, stopRoot);
  const file = await lstat(path);
  if (file.size < 8 || file.size > 64 * 1024 * 1024) throw new Error(`${label} is empty or exceeds the 64 MiB artifact limit`);
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${label} is not a valid PNG file`);

  let offset = PNG_SIGNATURE.length;
  let header;
  let seenPalette = false;
  let seenImageData = false;
  let imageDataEnded = false;
  let ended = false;
  const imageData = [];
  let imageDataBytes = 0;
  let chunkCount = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length || ++chunkCount > 4096) throw new Error(`${label} has a truncated or excessive PNG chunk list`);
    const dataLength = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const crcOffset = dataStart + dataLength;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.length) throw new Error(`${label} has a truncated PNG chunk`);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(dataStart, crcOffset);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) throw new Error(`${label} contains an invalid PNG chunk type`);
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    if (pngCrc32(bytes.subarray(offset + 4, crcOffset)) !== expectedCrc) throw new Error(`${label} contains a PNG chunk with an invalid CRC`);

    if (!header && type !== "IHDR") throw new Error(`${label} is missing its PNG header chunk`);
    if (type === "IHDR") {
      if (header || offset !== PNG_SIGNATURE.length || dataLength !== 13) throw new Error(`${label} has an invalid PNG header chunk`);
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      const channelsByColor = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
      const depthsByColor = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
      if (!width || !height || width > 16_384 || height > 16_384 || width * height > MAX_PNG_PIXELS ||
          !depthsByColor.get(colorType)?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) {
        throw new Error(`${label} has unsupported or unsafe PNG image dimensions or format`);
      }
      header = { width, height, bitDepth, colorType, bitsPerPixel: channelsByColor.get(colorType) * bitDepth, interlace };
    } else if (type === "PLTE") {
      if (seenPalette || seenImageData || !dataLength || dataLength > 768 || dataLength % 3 !== 0) throw new Error(`${label} has an invalid PNG palette`);
      if (header.colorType === 0 || header.colorType === 4) throw new Error(`${label} has a palette for a grayscale PNG`);
      if (header.colorType === 3 && dataLength / 3 > 2 ** header.bitDepth) throw new Error(`${label} has too many entries in its indexed PNG palette`);
      seenPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (header.colorType === 3 && !seenPalette)) throw new Error(`${label} has an invalid PNG image-data sequence`);
      seenImageData = true;
      imageDataBytes += dataLength;
      if (imageDataBytes > 64 * 1024 * 1024) throw new Error(`${label} PNG compressed image data exceeds the artifact limit`);
      imageData.push(data);
    } else if (type === "IEND") {
      if (!seenImageData || dataLength !== 0) throw new Error(`${label} has an invalid PNG end chunk`);
      if (nextOffset !== bytes.length) throw new Error(`${label} contains bytes after its PNG end chunk`);
      ended = true;
      offset = nextOffset;
      break;
    } else {
      if (seenImageData) imageDataEnded = true;
      if (type[0] === type[0].toUpperCase()) throw new Error(`${label} contains an unsupported critical PNG chunk`);
    }
    if (seenImageData && type !== "IDAT") imageDataEnded = true;
    offset = nextOffset;
  }
  if (!header || !seenImageData || !ended) throw new Error(`${label} is missing required PNG image data or its end chunk`);

  const passes = header.interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let decodedLength = 0;
  const rowCounts = [];
  for (const [xStart, yStart, xStep, yStep] of passes) {
    const passWidth = header.width <= xStart ? 0 : Math.ceil((header.width - xStart) / xStep);
    const passHeight = header.height <= yStart ? 0 : Math.ceil((header.height - yStart) / yStep);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil(passWidth * header.bitsPerPixel / 8);
    decodedLength += passHeight * (rowBytes + 1);
    rowCounts.push({ passHeight, rowBytes });
  }
  if (decodedLength > MAX_PNG_DECODED_BYTES) throw new Error(`${label} decoded PNG image exceeds the 256 MiB safety limit`);
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageData, imageDataBytes), { maxOutputLength: decodedLength });
  } catch {
    throw new Error(`${label} contains invalid or oversized compressed PNG image data`);
  }
  if (decoded.length !== decodedLength) throw new Error(`${label} has an incomplete decoded PNG image`);
  let decodedOffset = 0;
  for (const { passHeight, rowBytes } of rowCounts) {
    for (let row = 0; row < passHeight; row += 1) {
      if (decoded[decodedOffset] > 4) throw new Error(`${label} contains an invalid PNG row filter`);
      decodedOffset += rowBytes + 1;
    }
  }
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function resolveNativeExportSettings(manifest) {
  return {
    resolution: manifest.native_edit?.payload?.export?.resolution ?? "1080p",
    fps: manifest.native_edit?.payload?.export?.fps ?? manifest.meta.fps
  };
}

export function expectedExportDimensions(canvas, nativeDocument, resolution) {
  if (!nativeDocument) return { width: canvas.width, height: canvas.height };
  const scale = resolution === "720p" ? 2 / 3 : resolution === "4k" ? 2 : 1;
  return { width: Math.round(canvas.width * scale), height: Math.round(canvas.height * scale) };
}

export function summarizeNativeDocument(document, requestedAssetIdBySource, sourceRoleByPath) {
  const roleByAssetId = new Map();
  for (const [src, assetId] of requestedAssetIdBySource) roleByAssetId.set(assetId, sourceRoleByPath.get(src));
  const layers = collectNativeLayers(document);
  let video = 0;
  let audio = 0;
  let embeddedAudio = 0;
  for (const layer of layers) {
    const assetId = nativeLayerAssetId(layer);
    const role = roleByAssetId.get(assetId) ?? nativeLayerKind(layer);
    if (role === "video") video += 1;
    if (role === "audio") audio += 1;
    if (role === "video" && Number.isFinite(layer.volume) && layer.volume > 0) embeddedAudio += 1;
  }
  return {
    native_document_layer_count: layers.length,
    native_video_layer_count: video,
    native_audio_layer_count: audio,
    native_embedded_audio_layer_count: embeddedAudio
  };
}

export function nativeDocumentReferencesAudio(document, manifest) {
  const audioAssetIds = new Set((manifest.native_edit?.assets ?? [])
    .filter((asset) => asset.kind === "audio")
    .map((asset) => asset.asset_id));
  const videoAssetIds = new Set(manifest.clips.map((clip) => clip.id));
  for (const asset of manifest.native_edit?.assets ?? []) if (asset.kind === "video") videoAssetIds.add(asset.asset_id);
  for (const layer of collectNativeLayers(document)) {
    const assetId = nativeLayerAssetId(layer);
    if (nativeLayerKind(layer) === "audio" || audioAssetIds.has(assetId)) return true;
    if (videoAssetIds.has(assetId) && Number.isFinite(layer.volume) && layer.volume > 0) return true;
    if (layer.audio === true || layer.useAudio === true || layer.audioEnabled === true) return true;
  }
  return false;
}

function assertNativeDeclaredAssetsReferenced(manifest) {
  const declared = [
    ...(manifest.images ?? []).map((image) => ({ id: image.id, label: `images asset '${image.id}'` })),
    ...(manifest.native_edit?.assets ?? []).map((asset) => ({ id: asset.asset_id, label: `native asset '${asset.asset_id}'` }))
  ];
  if (declared.length === 0) return;
  const unused = declared.find((asset) => !containsNativeValue(manifest.native_edit?.payload?.document, asset.id)
    && !containsNativeValue(manifest.native_edit?.payload?.actions ?? [], asset.id));
  if (unused) throw new Error(`${unused.label} is imported but not referenced by native_edit.document or actions`);
}

function containsNativeValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((child) => containsNativeValue(child, expected));
  if (value && typeof value === "object") return Object.values(value).some((child) => containsNativeValue(child, expected));
  return false;
}

function collectNativeLayers(document) {
  const result = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "layers" && Array.isArray(child)) result.push(...child.filter((layer) => layer && typeof layer === "object"));
      visit(child);
    }
  };
  visit(document);
  return result;
}

function nativeLayerAssetId(layer) {
  for (const key of ["assetId", "asset_id", "sourceAssetId", "mediaAssetId"]) {
    if (typeof layer?.[key] === "string") return layer[key];
  }
  if (typeof layer?.source?.assetId === "string") return layer.source.assetId;
  if (typeof layer?.source?.asset_id === "string") return layer.source.asset_id;
  return undefined;
}

function nativeLayerKind(layer) {
  const kind = [layer?.type, layer?.kind, layer?.layerType, layer?.layer_type]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (kind.includes("audio")) return "audio";
  if (kind.includes("video")) return "video";
  return undefined;
}

async function resolveExportFfmpeg(backendOptions) {
  if (process.platform !== "linux") {
    if (backendOptions.ffmpeg_path !== undefined) throw new Error("edit.backend_options.tesseract.ffmpeg_path is only supported on Linux");
    return undefined;
  }
  const path = backendOptions.ffmpeg_path;
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Linux Tesseract MP4 export requires edit.backend_options.tesseract.ffmpeg_path to name an absolute executable ffmpeg path");
  }
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("ffmpeg_path must be a regular file, not a symlink");
  try { await access(path, fsConstants.X_OK); }
  catch { throw new Error("ffmpeg_path must be executable"); }
  return path;
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
  const faces = parseImportedFontFaces(stdout);
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

function parseImportedFontFaces(stdout, requestedFamily, requestedStyle) {
  const data = parseJsonOutput(stdout, "project import-font");
  const faces = Array.isArray(data.faces) ? data.faces : (typeof data.fontFamily === "string" && typeof data.fontStyle === "string" ? [data] : []);
  if (faces.length === 0 || faces.some((face) => typeof face.fontFamily !== "string" || !face.fontFamily || typeof face.fontStyle !== "string" || !face.fontStyle)) {
    throw new Error("project import-font did not return complete fontFamily/fontStyle metadata");
  }
  if (requestedFamily !== undefined || requestedStyle !== undefined) {
    const selected = faces.find((face) => face.fontFamily === requestedFamily && face.fontStyle === requestedStyle);
    if (!selected) throw new Error("native_edit.fonts family/style do not match a face returned by project import-font");
    return [{ fontFamily: selected.fontFamily, fontStyle: selected.fontStyle }];
  }
  return faces.map((face) => ({ fontFamily: face.fontFamily, fontStyle: face.fontStyle }));
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
