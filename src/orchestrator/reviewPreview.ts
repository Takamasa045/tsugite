import { spawnCommandSync } from "../platform/process.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";

const PREVIEW_FPS = 12;
const PREVIEW_HEIGHT = 360;
const PREVIEW_MAX_SECONDS = 3;

export type ReviewPreviewResult = {
  previewPath: string;
  digest: string;
  shotId: string;
  reused: boolean;
};

type ReviewPreviewOptions = {
  configPath: string;
  project: Project;
  manifest: Manifest;
  shotId?: string;
  outputDir?: string;
  stateDir?: string;
};

type SelectedShot = {
  id: string;
  clip: Manifest["clips"][number];
  start: number;
  sourceOffset: number;
  duration: number;
};

type PreviewRecord = {
  schema_version: 1;
  digest: string;
  shot_id: string;
  preview_path: string;
  source_digest: string;
  preview_sha256: string;
};

export async function computeReviewPreviewDigest(options: {
  configPath: string;
  project: Project;
  manifest: Manifest;
  shotId: string;
}): Promise<Result<{ digest: string; sourceDigest: string }>> {
  const selected = selectShot(options.manifest, options.shotId);
  if (!selected) return failure("review_preview.shot_not_found", `review shot '${options.shotId}' was not found`, options.shotId);
  const configDir = dirname(resolve(options.configPath));
  const manifestDir = dirname(resolve(configDir, options.project.manifest));
  const assetRoot = options.project.manifest.startsWith("../") ? resolve(configDir, "..") : configDir;
  try {
    if (isExternalAsset(selected.clip.src)) {
      return failure("review_preview.source_unsafe", "review preview requires a local clip source", selected.clip.src);
    }
    const realAssetRoot = await realpath(assetRoot);
    const sourcePath = await realpath(resolve(manifestDir, selected.clip.src));
    if (!isPathWithin(realAssetRoot, sourcePath) || !(await stat(sourcePath)).isFile()) {
      return failure("review_preview.source_unsafe", "review preview source escapes the project root", selected.clip.src);
    }
    const sourceDigest = await sha256File(sourcePath);
    const imageDigests = await collectManifestImageDigests(options.manifest, manifestDir, realAssetRoot);
    return {
      ok: true,
      issues: [],
      sourceDigest,
      digest: digestPreviewInput(options.manifest, selected, sourceDigest, imageDigests)
    };
  } catch (error) {
    return failure(
      "review_preview.source_unsafe",
      error instanceof Error ? error.message : "review preview source is unavailable",
      selected.clip.src
    );
  }
}

/**
 * Renders a deliberately small, local-only preview. It does not read or
 * write pipeline state, invoke adapters, or alter any Gate data.
 */
export async function renderReviewPreview(options: ReviewPreviewOptions): Promise<Result<ReviewPreviewResult>> {
  if (!options.shotId) {
    return failure("review_preview.shot_required", "--shot is required for review-preview");
  }

  const selected = selectShot(options.manifest, options.shotId);
  if (!selected) {
    return failure("review_preview.shot_not_found", `review shot '${options.shotId}' was not found`, options.shotId);
  }

  const canonicalReviewDir = reviewDirectory(options.configPath, options.project, options.stateDir);
  const reviewDir = options.outputDir ? resolve(options.outputDir) : canonicalReviewDir;
  const configDir = dirname(resolve(options.configPath));
  const manifestPath = resolve(configDir, options.project.manifest);
  const manifestDir = dirname(manifestPath);
  if (reviewDir === configDir || reviewDir === manifestDir) {
    return failure(
      "review_preview.output_unsafe",
      "--output for review-preview must be a dedicated review directory, not the project or manifest directory",
      options.outputDir
    );
  }

  const assetRoot = options.project.manifest.startsWith("../")
    ? resolve(configDir, "..")
    : configDir;
  let sourcePath: string;
  let realAssetRoot: string;
  try {
    if (isExternalAsset(selected.clip.src)) {
      return failure("review_preview.source_unsafe", "review preview requires a local clip source", selected.clip.src);
    }
    realAssetRoot = await realpath(assetRoot);
    sourcePath = await realpath(resolve(manifestDir, selected.clip.src));
    if (!isPathWithin(realAssetRoot, sourcePath) || !(await stat(sourcePath)).isFile()) {
      return failure("review_preview.source_unsafe", "review preview source escapes the project root", selected.clip.src);
    }
  } catch (error) {
    return failure(
      "review_preview.source_unsafe",
      error instanceof Error ? error.message : "review preview source is unavailable",
      selected.clip.src
    );
  }

  const previewDir = join(reviewDir, "previews");
  const previewPath = join(previewDir, `${safeId(selected.id)}.mp4`);
  const recordPath = join(previewDir, `${safeId(selected.id)}.json`);
  if (!isPathWithin(reviewDir, previewPath) || !isPathWithin(reviewDir, recordPath)) {
    return failure("review_preview.output_unsafe", "review preview output escapes its review directory", reviewDir);
  }
  const relativePreviewPath = relative(reviewDir, previewPath).replaceAll("\\", "/");

  try {
    if (await pathIsSymlink(reviewDir)) {
      return failure("review_preview.output_unsafe", "review directory must not be a symbolic link", reviewDir);
    }
    await mkdir(reviewDir, { recursive: true });
    const realReviewDir = await realpath(reviewDir);
    if (await pathIsSymlink(previewDir)) {
      return failure("review_preview.output_unsafe", "preview directory must not be a symbolic link", previewDir);
    }
    await mkdir(previewDir, { recursive: true });
    if (!isPathWithin(realReviewDir, await realpath(previewDir))) {
      return failure("review_preview.output_unsafe", "preview directory escapes the review directory", previewDir);
    }
  } catch (error) {
    return failure("review_preview.output_unsafe", error instanceof Error ? error.message : "preview directory is unavailable", previewDir);
  }
  if (await pathIsSymlink(previewPath) || await pathIsSymlink(recordPath)) {
    return failure("review_preview.output_unsafe", "preview files must not be symbolic links", previewDir);
  }

  const sourceDigest = await sha256File(sourcePath);
  let stagedImages: Manifest["images"];
  let imageDigests: Array<{ id: string; sha256: string }>;
  try {
    const images = await stageManifestImages(options.manifest, manifestDir, realAssetRoot, previewDir);
    stagedImages = images.images;
    imageDigests = images.digests;
  } catch (error) {
    return failure("review_preview.source_unsafe", error instanceof Error ? error.message : "preview image source is unavailable");
  }
  const digest = digestPreviewInput(options.manifest, selected, sourceDigest, imageDigests);

  if (await matchesExistingPreview(recordPath, previewPath, digest, selected.id, relativePreviewPath, sourceDigest)) {
    return { ok: true, issues: [], previewPath, digest, shotId: selected.id, reused: true };
  }

  try {
    const extension = safeExtension(extname(sourcePath));
    const stagedSource = join(previewDir, `source-${sourceDigest.slice(0, 16)}${extension}`);
    if (await pathIsSymlink(stagedSource)) {
      return failure("review_preview.output_unsafe", "staged preview source must not be a symbolic link", stagedSource);
    }
    if (!(await isFile(stagedSource))) await copyFileAtomically(sourcePath, stagedSource);
    const previewManifest = createPreviewManifest(
      { ...options.manifest, images: stagedImages },
      selected,
      relative(reviewDir, stagedSource).replaceAll("\\", "/")
    );
    const backendResult = spawnCommandSync(process.execPath, [resolve("backends", options.project.edit.backend, "reviewPreview.mjs")], {
      cwd: process.cwd(),
      input: `${JSON.stringify({ reviewDir, previewPath, manifest: previewManifest })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20
    });
    if (backendResult.error || backendResult.status !== 0) {
      throw new Error(backendResult.error?.message ?? backendResult.stderr ?? backendResult.stdout ?? "preview backend failed");
    }
    const record: PreviewRecord = {
      schema_version: 1,
      digest,
      shot_id: selected.id,
      preview_path: relativePreviewPath,
      source_digest: sourceDigest,
      preview_sha256: await sha256File(previewPath)
    };
    if (await pathIsSymlink(recordPath)) {
      return failure("review_preview.output_unsafe", "preview record must not be a symbolic link", recordPath);
    }
    await writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true, issues: [], previewPath, digest, shotId: selected.id, reused: false };
  } catch (error) {
    return failure(
      "review_preview.render_failed",
      error instanceof Error ? error.message : "local preview render failed",
      previewPath
    );
  }
}

function selectShot(manifest: Manifest, shotId: string): SelectedShot | undefined {
  const captionIndex = manifest.captions.findIndex((caption, index) => (caption.id ?? `caption-${String(index + 1).padStart(2, "0")}`) === shotId);
  const start = captionIndex >= 0 ? manifest.captions[captionIndex].start : undefined;
  const end = captionIndex >= 0 ? manifest.captions[captionIndex].end : undefined;
  let cursor = 0;
  for (const clip of manifest.clips) {
    const clipStart = cursor;
    const clipEnd = cursor + clip.duration;
    if (clip.id === shotId || (start !== undefined && start < clipEnd && (end ?? start) > clipStart)) {
      const previewStart = Math.max(clipStart, start ?? clipStart);
      const sourceOffset = Math.max(0, previewStart - clipStart);
      return {
        id: shotId,
        clip,
        start: previewStart,
        sourceOffset,
        duration: Math.min(PREVIEW_MAX_SECONDS, clip.duration - sourceOffset, (end ?? clipEnd) - previewStart)
      };
    }
    cursor = clipEnd;
  }
  return undefined;
}

function digestPreviewInput(
  manifest: Manifest,
  selected: SelectedShot,
  sourceDigest: string,
  imageDigests: Array<{ id: string; sha256: string }>
): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: 1,
    selected,
    clip: selected.clip,
    captions: manifest.captions.filter((caption) => caption.start < selected.start + selected.duration && caption.end > selected.start),
    speakers: manifest.speakers,
    source_digest: sourceDigest,
    image_digests: imageDigests,
    fps: PREVIEW_FPS,
    height: PREVIEW_HEIGHT,
    aspect: manifest.meta.aspect,
    presentation: manifest.presentation
  })).digest("hex");
}

function createPreviewManifest(manifest: Manifest, selected: SelectedShot, stagedSource: string): Manifest {
  const width = manifest.meta.aspect === "9:16" ? 202 : 640;
  const duration = Math.max(1 / PREVIEW_FPS, selected.duration);
  const previewEnd = selected.start + duration;
  const captions = manifest.captions
    .filter((caption) => caption.start < previewEnd && caption.end > selected.start)
    .map((caption) => ({
      ...caption,
      start: Math.max(0, caption.start - selected.start),
      end: Math.min(duration, caption.end - selected.start)
    }))
    .filter((caption) => caption.end > caption.start);
  return {
    ...manifest,
    meta: { ...manifest.meta, fps: PREVIEW_FPS, target_duration_seconds: duration },
    clips: [{
      ...selected.clip,
      src: stagedSource,
      in: selected.clip.in + selected.sourceOffset,
      out: selected.clip.in + selected.sourceOffset + duration,
      duration,
      fps: PREVIEW_FPS,
      resolution: { width, height: PREVIEW_HEIGHT },
      audio: false
    }],
    audio: { bgm: [], narration: [], sfx: [] },
    captions,
    chapters: [],
    presentation: manifest.presentation
  };
}

async function matchesExistingPreview(
  recordPath: string,
  previewPath: string,
  digest: string,
  shotId: string,
  relativePreviewPath: string,
  sourceDigest: string
): Promise<boolean> {
  try {
    if (!(await isFile(previewPath))) return false;
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Partial<PreviewRecord>;
    return record.schema_version === 1
      && record.digest === digest
      && record.shot_id === shotId
      && record.preview_path === relativePreviewPath
      && record.source_digest === sourceDigest
      && typeof record.preview_sha256 === "string"
      && record.preview_sha256 === await sha256File(previewPath);
  } catch {
    return false;
  }
}

async function stageManifestImages(
  manifest: Manifest,
  manifestDir: string,
  realAssetRoot: string,
  previewDir: string
): Promise<{ images: Manifest["images"]; digests: Array<{ id: string; sha256: string }> }> {
  const staged = new Map<string, string>();
  const digests: Array<{ id: string; sha256: string }> = [];
  const images: Manifest["images"] = [];
  for (const image of manifest.images) {
    if (isExternalAsset(image.src)) throw new Error(`preview image must be local: ${image.src}`);
    const sourcePath = await realpath(resolve(manifestDir, image.src));
    if (!isPathWithin(realAssetRoot, sourcePath) || !(await stat(sourcePath)).isFile()) {
      throw new Error(`preview image escapes project root: ${image.src}`);
    }
    const sha256 = await sha256File(sourcePath);
    digests.push({ id: image.id, sha256 });
    let stagedName = staged.get(sourcePath);
    if (!stagedName) {
      stagedName = `image-${sha256.slice(0, 16)}-${safeId(basename(sourcePath))}`;
      const stagedPath = join(previewDir, stagedName);
      if (await pathIsSymlink(stagedPath)) throw new Error("staged preview image must not be a symbolic link");
      if (!(await isFile(stagedPath))) await copyFileAtomically(sourcePath, stagedPath);
      staged.set(sourcePath, stagedName);
    }
    images.push({ ...image, src: `previews/${stagedName}` });
  }
  return { images, digests: digests.sort((left, right) => left.id.localeCompare(right.id)) };
}

async function collectManifestImageDigests(
  manifest: Manifest,
  manifestDir: string,
  realAssetRoot: string
): Promise<Array<{ id: string; sha256: string }>> {
  const digests: Array<{ id: string; sha256: string }> = [];
  for (const image of manifest.images) {
    if (isExternalAsset(image.src)) throw new Error(`preview image must be local: ${image.src}`);
    const sourcePath = await realpath(resolve(manifestDir, image.src));
    if (!isPathWithin(realAssetRoot, sourcePath) || !(await stat(sourcePath)).isFile()) {
      throw new Error(`preview image escapes project root: ${image.src}`);
    }
    digests.push({ id: image.id, sha256: await sha256File(sourcePath) });
  }
  return digests.sort((left, right) => left.id.localeCompare(right.id));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function reviewDirectory(configPath: string, project: Project, stateDir?: string): string {
  const distDir = stateDir ? resolve(stateDir) : resolve(dirname(resolve(configPath)), project.dist_dir);
  return resolve(distDir, project.run_id ?? project.slug, "review");
}

async function copyFileAtomically(sourcePath: string, destinationPath: string): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  if (await pathIsSymlink(temporaryPath)) throw new Error("temporary preview file must not be a symbolic link");
  try {
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    await rename(temporaryPath, destinationPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeFileAtomically(destinationPath: string, contents: string): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  if (await pathIsSymlink(temporaryPath)) throw new Error("temporary preview file must not be a symbolic link");
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, destinationPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function failure<T = ReviewPreviewResult>(code: string, message: string, path?: string): Result<T> {
  const issue: Issue = { code, message, ...(path ? { path } : {}) };
  return { ok: false, issues: [issue] };
}

function isExternalAsset(value: string): boolean {
  return /^(?:[a-z]+:|\/)/i.test(value) || value.includes("\\");
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || "shot";
}

function safeExtension(value: string): string {
  return /^\.[A-Za-z0-9]{1,10}$/.test(value) ? value : ".mp4";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
