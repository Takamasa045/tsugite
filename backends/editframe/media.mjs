import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import {
  assertDirectory,
  assertNoSymlinkBetween,
  assertRegularFile,
  confinedError,
  fileIdentity,
  isExternalAssetPath,
  isPathWithin,
  sameIdentity
} from "./confine.mjs";
import { publicMediaUrl } from "./document.mjs";

export function uniquePublicName(index, clipId, sourceRelative) {
  const rawExt = extname(sourceRelative).toLowerCase() || ".mp4";
  const extension = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : ".mp4";
  const digest = createHash("sha256")
    .update(String(index))
    .update("\0")
    .update(String(clipId ?? ""))
    .update("\0")
    .update(String(sourceRelative ?? ""))
    .digest("hex")
    .slice(0, 16);
  return `clip-${index}-${digest}${extension}`;
}

export function mediaLookupFromPlan(plan) {
  const lookup = Object.create(null);
  for (const item of plan) {
    lookup[item.clipId] = item;
  }
  return lookup;
}

export async function planPublicMedia(manifest, runDir) {
  const realRunDir = await resolve(runDir);
  await assertDirectory(runDir, "runDir");
  const plan = [];
  const names = new Set();
  const clipIds = new Set();
  for (const [index, clip] of (manifest.clips ?? []).entries()) {
    if (clipIds.has(clip.id)) {
      throw confinedError(`duplicate clip id '${clip.id}'`);
    }
    clipIds.add(clip.id);
    const sourceRelative = clip.src;
    const sourceAbsolute = await assertRunAsset(sourceRelative, `clip '${clip.id}'`, runDir, realRunDir);
    const identity = await fileIdentity(sourceAbsolute);
    const publicName = uniquePublicName(index, clip.id, sourceRelative);
    if (names.has(publicName)) {
      throw confinedError(`public media name collided for clip '${clip.id}'`);
    }
    names.add(publicName);
    plan.push({
      clipId: clip.id,
      index,
      sourceRelative,
      sourceAbsolute,
      publicName,
      publicUrl: publicMediaUrl(publicName),
      identity
    });
  }
  return plan;
}

export async function copyPublicMedia(plan, compositionDir) {
  await preparePublicMediaDir(compositionDir);
  const mediaDir = join(compositionDir, "public", "media");
  for (const item of plan) {
    await copyOne(item, join(mediaDir, item.publicName), compositionDir);
  }
}

async function preparePublicMediaDir(compositionDir) {
  await assertNoSymlinkBetween(compositionDir, compositionDir, "composition dir");
  await mkdir(compositionDir, { recursive: true });
  await assertDirectory(compositionDir, "composition dir");
  const publicDir = join(compositionDir, "public");
  await mkdir(publicDir, { recursive: true });
  await assertDirectory(publicDir, "public dir");
  const mediaDir = join(publicDir, "media");
  await mkdir(mediaDir, { recursive: true });
  await assertDirectory(mediaDir, "public media dir");
}

async function copyOne(item, destination, compositionDir) {
  await assertNoSymlinkBetween(destination, compositionDir, `destination for clip '${item.clipId}'`);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      throw confinedError(`destination for clip '${item.clipId}' must not be a symlink`);
    }
    if (!existing.isFile()) {
      throw confinedError(`destination for clip '${item.clipId}' exists and is not a regular file`);
    }
    await unlink(destination);
  } catch (error) {
    if (error && error.exitCode === 10) throw error;
    if (error && error.code !== "ENOENT") throw error;
  }
  const current = await assertRegularFile(item.sourceAbsolute, `clip '${item.clipId}'`);
  const identity = {
    dev: current.dev,
    ino: current.ino,
    size: current.size,
    mtimeMs: current.mtimeMs
  };
  if (!sameIdentity(item.identity, identity)) {
    throw confinedError(`clip '${item.clipId}' changed between plan and copy`);
  }
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  const destFlags = process.platform === "win32" ? flags : flags | constants.O_NOFOLLOW;
  let dest;
  try {
    dest = await open(destination, destFlags, 0o644);
  } catch (error) {
    throw confinedError(
      `clip '${item.clipId}' destination is not a safe exclusive file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    const bytes = await readFile(item.sourceAbsolute);
    await dest.writeFile(bytes);
  } finally {
    await dest.close();
  }
  await assertRegularFile(destination, `copied clip '${item.clipId}'`);
  const realDestination = await resolve(destination);
  if (!isPathWithin(compositionDir, realDestination) && !isPathWithin(await resolve(compositionDir), destination)) {
    throw confinedError(`copied media escaped composition dir: ${item.publicName}`);
  }
}

async function assertRunAsset(value, label, runDir, realRunDir) {
  if (typeof value !== "string" || value.length === 0) {
    throw confinedError(`${label} must be a local asset path`);
  }
  if (isAbsolute(value) || isExternalAssetPath(value)) {
    throw confinedError(`${label} must be a local asset path`);
  }
  const resolved = resolve(runDir, value);
  if (!isPathWithin(runDir, resolved)) {
    throw confinedError(`${label} must stay inside runDir`);
  }
  await assertRegularFile(resolved, label, runDir);
  const realAsset = resolve(resolved);
  if (!isPathWithin(realRunDir, realAsset) && !isPathWithin(runDir, resolved)) {
    throw confinedError(`${label} must stay inside runDir`);
  }
  return resolved;
}
