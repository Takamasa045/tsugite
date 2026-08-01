/**
 * Finalize planning helpers: media scan, retention partition, plan digest, result shells.
 * No apply mutation or Gate orchestration.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Issue } from "../types.js";
import type { FinalizeFileIdentity } from "./finalizeJournal.js";
import { JOURNAL_DIR_NAME } from "./finalizeJournal.js";
import {
  hasSymlinkAlongPath,
  isRealDirectory,
  isRegularFile,
  isWithinPath
} from "./finalizePathSafety.js";
import { QUARANTINE_DIR_NAME } from "./finalizeQuarantine.js";
import {
  comparePath,
  errorMessageOr,
  isNodeError,
  toProjectRelative
} from "./finalizeShared.js";
import type { FinalizeCompletedProjectResult } from "./finalizeTypes.js";

/** Local alias kept for the many call sites that still use the historical name. */
const isWithin = isWithinPath;

const MEDIA_EXTENSIONS = new Set([
  ".aac", ".aiff", ".aif", ".avi", ".avif", ".bmp", ".flac", ".flv", ".gif",
  ".heic", ".jpeg", ".jpg", ".m2ts", ".m4a", ".m4v", ".mkv", ".mov", ".mp3",
  ".mp4", ".mpeg", ".mpg", ".mts", ".ogg", ".png", ".tif", ".tiff", ".wav",
  ".webm", ".webp", ".wmv"
]);

export const CLEANUP_ROOT_NAMES = ["media", "qa", "references"] as const;

export function resultBase(applied: boolean): FinalizeCompletedProjectResult {
  return {
    ok: false,
    issues: [],
    applied,
    mediaFiles: [],
    retainedMedia: [],
    plannedBytes: 0,
    deletedFiles: 0,
    deletedBytes: 0
  };
}

export function failure(
  base: FinalizeCompletedProjectResult,
  issue: Issue
): FinalizeCompletedProjectResult {
  return {
    ...base,
    ok: false,
    deletedFiles: 0,
    deletedBytes: 0,
    issues: [issue]
  };
}

export function buildPlanDigest(input: {
  projectRoot: string;
  configPath: string;
  manifestPath: string;
  stateDir: string;
  projectsHome: string;
  destinationRoot: string;
  alreadyHome: boolean;
  runId: string;
  finalOutputDigest: string;
  gate3ApprovedInputDigest: string;
  retainedMedia: readonly string[];
  candidates: readonly FinalizeFileIdentity[];
}): string {
  const payload = {
    project_root: resolve(input.projectRoot),
    config_path: resolve(input.configPath),
    manifest_path: resolve(input.manifestPath),
    state_dir: resolve(input.stateDir),
    launcher: {
      projects_home: resolve(input.projectsHome),
      destination_root: resolve(input.destinationRoot),
      already_home: input.alreadyHome
    },
    run_id: input.runId,
    final_output_digest: input.finalOutputDigest,
    gate3_approved_input_digest: input.gate3ApprovedInputDigest,
    retained_media: [...input.retainedMedia].sort(comparePath),
    candidates: [...input.candidates]
      .map((candidate) => ({
        path: candidate.path,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        device: candidate.device,
        inode: candidate.inode
      }))
      .sort((left, right) => comparePath(left.path, right.path))
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Partition scanned media into retained vs deletion candidates using path, realpath,
 * and device/inode identity so hardlinks / case aliases / Unicode aliases are retained.
 */
export async function partitionMediaByRetention(
  allMedia: readonly string[],
  runDir: string,
  referencedSourceMedia: readonly string[],
  projectRoot: string
): Promise<{ retained: string[]; candidates: string[] }> {
  const seedRetained = [
    ...allMedia.filter((path) => isWithin(runDir, path)),
    ...referencedSourceMedia
  ];
  const retainedSet = new Set<string>();
  const identity = await collectIdentityKeys(seedRetained);

  for (const path of seedRetained) retainedSet.add(path);

  for (const path of allMedia) {
    if (retainedSet.has(path)) continue;
    try {
      if (!(await isRegularFile(path))) continue;
      const stats = await lstat(path);
      const key = identityKey(stats.dev, stats.ino);
      if (identity.inodeKeys.has(key)) {
        retainedSet.add(path);
        continue;
      }
      const real = await realpath(path);
      if (identity.realPaths.has(real)) {
        retainedSet.add(path);
      }
    } catch {
      // leave unreadable paths as candidates only if still regular files later
    }
  }

  // Also match by realpath equality against referenced/run media even when inode capture fails.
  for (const path of allMedia) {
    if (retainedSet.has(path)) continue;
    try {
      const real = await realpath(path);
      if (identity.realPaths.has(real)) retainedSet.add(path);
    } catch {
      // ignore
    }
  }

  const retained = [...retainedSet].sort(comparePath);
  const candidates = allMedia.filter((path) => !retainedSet.has(path)).sort(comparePath);
  void projectRoot;
  return { retained, candidates };
}

export async function collectIdentityKeys(paths: readonly string[]): Promise<{
  inodeKeys: Set<string>;
  realPaths: Set<string>;
}> {
  const inodeKeys = new Set<string>();
  const realPaths = new Set<string>();
  for (const path of paths) {
    try {
      if (!(await isRegularFile(path))) continue;
      const stats = await lstat(path);
      inodeKeys.add(identityKey(stats.dev, stats.ino));
      realPaths.add(await realpath(path));
    } catch {
      // skip unreadable
    }
  }
  return { inodeKeys, realPaths };
}

export function identityKey(device: number, inode: number): string {
  return `${device}:${inode}`;
}

export async function findMediaFiles(roots: string[], projectRoot: string): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    if (!(await isRealDirectory(root))) continue;
    if (!isWithin(projectRoot, root)) continue;
    await walk(root);
  }
  return [...found].sort();

  async function walk(directory: string): Promise<void> {
    if (!isWithin(projectRoot, directory)) return;
    const entries = await readdir(directory, withFileTypesTrue());
    for (const entry of entries) {
      if (entry.name === QUARANTINE_DIR_NAME || entry.name === JOURNAL_DIR_NAME) continue;
      const path = join(directory, entry.name);
      if (!isWithin(projectRoot, path)) continue;
      // Dirent methods do not follow symlinks; skip both file and directory links.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && isMediaPath(path) && await isRegularFile(path)) {
        found.add(path);
      }
    }
  }
}

function withFileTypesTrue(): { withFileTypes: true } {
  return { withFileTypes: true };
}

export async function captureRegularFileIdentity(
  absolutePath: string,
  projectRoot: string
): Promise<FinalizeFileIdentity | undefined> {
  try {
    if (!isWithin(projectRoot, absolutePath)) return undefined;
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return {
      path: toProjectRelative(projectRoot, absolutePath),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      device: stats.dev,
      inode: stats.ino
    };
  } catch {
    return undefined;
  }
}

export function collectReferencedMedia(
  value: unknown,
  baseDir: string,
  found = new Set<string>()
): string[] {
  if (typeof value === "string") {
    if (isMediaPath(value)) found.add(resolve(baseDir, value));
    return [...found];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedMedia(item, baseDir, found);
    return [...found];
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferencedMedia(item, baseDir, found);
  }
  return [...found];
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function inspectManifestMediaReference(
  absolutePath: string,
  projectRoot: string
): Promise<Issue | undefined> {
  if (!isWithin(projectRoot, absolutePath)) {
    return {
      code: "finalize.manifest_path_unsafe",
      message: "manifest media reference is outside the project; finalize cannot safely decide retention",
      path: absolutePath
    };
  }
  try {
    if (await hasSymlinkAlongPath(projectRoot, absolutePath)) {
      return {
        code: "finalize.manifest_path_unsafe",
        message: "manifest media reference path contains a symbolic link; finalize cannot safely decide retention",
        path: absolutePath
      };
    }
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return {
        code: "finalize.manifest_path_unsafe",
        message: "manifest media reference is a symbolic link; finalize cannot safely decide retention",
        path: absolutePath
      };
    }
    if (!stats.isFile()) {
      return {
        code: "finalize.manifest_path_unsafe",
        message: "manifest media reference is not a regular file; finalize cannot safely decide retention",
        path: absolutePath
      };
    }
    const [realProjectRoot, realPath] = await Promise.all([
      realpath(projectRoot),
      realpath(absolutePath)
    ]);
    if (!isWithin(realProjectRoot, realPath)) {
      return {
        code: "finalize.manifest_path_unsafe",
        message: "manifest media reference realpath escaped the project; finalize cannot safely decide retention",
        path: absolutePath
      };
    }
  } catch (error) {
    return {
      code: "finalize.manifest_path_unsafe",
      message: errorMessageOr(error, "manifest media reference could not be safety-checked"),
      path: absolutePath
    };
  }
  return undefined;
}
