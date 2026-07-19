import { lstat, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import { readState } from "./state.js";
import { sha256File } from "./render.js";

const MEDIA_EXTENSIONS = new Set([
  ".aac", ".aiff", ".aif", ".avi", ".avif", ".bmp", ".flac", ".flv", ".gif",
  ".heic", ".jpeg", ".jpg", ".m2ts", ".m4a", ".m4v", ".mkv", ".mov", ".mp3",
  ".mp4", ".mpeg", ".mpg", ".mts", ".ogg", ".png", ".tif", ".tiff", ".wav",
  ".webm", ".webp", ".wmv"
]);

export type FinalizeCompletedProjectOptions = {
  configPath: string;
  project: Project;
  manifest: Manifest;
  stateDir?: string;
  apply: boolean;
  now?: string;
};

export type FinalizeCompletedProjectResult = {
  ok: boolean;
  issues: Issue[];
  applied: boolean;
  canonicalOutput?: string;
  recordPath?: string;
  mediaFiles: string[];
  retainedMedia: string[];
  plannedBytes: number;
  deletedFiles: number;
  deletedBytes: number;
};

export async function finalizeCompletedProject(
  options: FinalizeCompletedProjectOptions
): Promise<FinalizeCompletedProjectResult> {
  const projectRoot = dirname(resolve(options.configPath));
  const stateDir = options.stateDir
    ? resolve(options.stateDir)
    : resolve(projectRoot, options.project.dist_dir);
  const runId = options.project.run_id ?? options.project.slug;
  const runDir = join(stateDir, runId);
  const canonicalOutputPath = join(runDir, "final.mp4");
  const recordPath = join(runDir, "completion-record.json");
  const empty = resultBase(options.apply);

  if (!isWithin(projectRoot, stateDir) || !isWithin(projectRoot, runDir)) {
    return failure(empty, {
      code: "finalize.state_dir_outside_project",
      message: "finalize requires the state directory to stay inside the project directory",
      path: stateDir
    });
  }
  if (stateDir === projectRoot) {
    return failure(empty, {
      code: "finalize.state_dir_unsafe",
      message: "finalize cannot use the whole project directory as its state cleanup root",
      path: stateDir
    });
  }

  let state;
  try {
    state = await readState(join(runDir, "state.json"));
  } catch (error) {
    return failure(empty, {
      code: "finalize.state_invalid",
      message: error instanceof Error ? error.message : String(error),
      path: join(runDir, "state.json")
    });
  }
  if (state.run_id !== runId || state.status !== "completed" || state.gates.gate_3.status !== "approved") {
    return failure(empty, {
      code: "finalize.run_not_completed",
      message: "finalize requires the selected run to be completed with Gate 3 approved",
      path: join(runDir, "state.json")
    });
  }

  const requiredProof = [
    [canonicalOutputPath, "finalize.output_missing", "canonical final.mp4 is required"],
    [join(runDir, "render-report.json"), "finalize.render_report_missing", "render-report.json is required"],
    [join(runDir, "gate3-qc.json"), "finalize.gate3_qc_missing", "gate3-qc.json is required"]
  ] as const;
  const proofIssues: Issue[] = [];
  for (const [path, code, message] of requiredProof) {
    if (!(await isRegularFile(path))) proofIssues.push({ code, message, path });
  }
  if (proofIssues.length > 0) return { ...empty, issues: proofIssues };
  let finalOutputDigest: string;
  try {
    finalOutputDigest = await sha256File(canonicalOutputPath);
  } catch (error) {
    return {
      ...empty,
      issues: [{
        code: "finalize.output_hash_failed",
        message: error instanceof Error ? error.message : String(error),
        path: canonicalOutputPath
      }]
    };
  }
  if (
    !state.gates.gate_3.approved_input_digest
    || state.gates.gate_3.approved_input_digest !== finalOutputDigest
  ) return failure(empty, {
    code: "finalize.gate3_output_changed",
    message: "final.mp4 no longer matches the Gate 3 approved output",
    path: canonicalOutputPath
  });

  const cleanupRoots = [
    stateDir,
    join(projectRoot, "media"),
    join(projectRoot, "qa"),
    join(projectRoot, "references")
  ];
  const allMedia = await findMediaFiles(cleanupRoots);
  const manifestDir = dirname(resolve(projectRoot, options.project.manifest));
  const referencedSourceMedia: string[] = [];
  for (const path of collectReferencedMedia(options.manifest, manifestDir)) {
    if (isWithin(projectRoot, path) && await isRegularFile(path)) referencedSourceMedia.push(path);
  }
  const retained = new Set<string>([
    ...allMedia.filter((path) => isWithin(runDir, path)),
    ...referencedSourceMedia
  ]);
  const candidates = allMedia.filter((path) => !retained.has(path)).sort();
  const mediaFiles = candidates.map((path) => toProjectRelative(projectRoot, path));
  const retainedMedia = [...retained]
    .map((path) => toProjectRelative(projectRoot, path))
    .sort();
  const sizes = await Promise.all(candidates.map(async (path) => (await lstat(path)).size));
  const plannedBytes = sizes.reduce((total, size) => total + size, 0);

  const base = {
    ok: true,
    issues: [],
    applied: options.apply,
    canonicalOutput: toProjectRelative(projectRoot, canonicalOutputPath),
    recordPath: toProjectRelative(projectRoot, recordPath),
    mediaFiles,
    retainedMedia,
    plannedBytes,
    deletedFiles: 0,
    deletedBytes: 0
  } satisfies FinalizeCompletedProjectResult;
  if (!options.apply) return base;
  if (candidates.length === 0 && await isRegularFile(recordPath)) return base;

  try {
    for (const path of candidates) await unlink(path);
    const record = {
      schema_version: 1,
      project_slug: options.project.slug,
      run_id: runId,
      completed_at: state.updated_at,
      finalized_at: options.now ?? new Date().toISOString(),
      canonical_output: toProjectRelative(projectRoot, canonicalOutputPath),
      retained_run: toProjectRelative(projectRoot, runDir),
      retained_source_media: referencedSourceMedia
        .map((path) => toProjectRelative(projectRoot, path))
        .sort(),
      cleanup: {
        media_files_deleted: candidates.length,
        bytes_reclaimed: plannedBytes,
        deleted_media_paths: mediaFiles
      }
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return {
      ...base,
      deletedFiles: candidates.length,
      deletedBytes: plannedBytes
    };
  } catch (error) {
    return failure(base, {
      code: "finalize.cleanup_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function resultBase(applied: boolean): FinalizeCompletedProjectResult {
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

function failure(base: FinalizeCompletedProjectResult, issue: Issue): FinalizeCompletedProjectResult {
  return { ...base, ok: false, issues: [issue] };
}

async function findMediaFiles(roots: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    if (await isDirectory(root)) await walk(root);
  }
  return [...found].sort();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isMediaPath(path)) {
        found.add(path);
      }
    }
  }
}

function collectReferencedMedia(value: unknown, baseDir: string, found = new Set<string>()): string[] {
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

function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function toProjectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
