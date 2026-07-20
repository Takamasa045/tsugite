import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { spawnCommandSync } from "../platform/process.js";
import type { ExecutionPlan } from "../orchestrator/plan.js";
import { createPlannedState, readState, type RunState } from "../orchestrator/state.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import {
  createViewerWorkflow,
  type ViewerArtifactSnapshot,
  type ViewerGate2QcEvidence,
  type ViewerGate3QcEvidence,
  type ViewerMediaPreview,
  type ViewerRunLogEvidence
} from "./workflow.js";

export type WriteWorkflowViewerOptions = {
  configPath: string;
  project: Project;
  plan: ExecutionPlan;
  stateDir?: string;
  outputDir?: string;
  bundleDir?: string;
};

export type WorkflowViewerResult = {
  viewerPath: string;
  workflowPath: string;
  outputDir: string;
  stateFound: boolean;
};

export const WORKFLOW_VIEWER_EVIDENCE_FILE = "viewer-evidence.json";
export const WORKFLOW_VIEWER_SNAPSHOT_FILE_LIMIT = 512;
export const WORKFLOW_VIEWER_SNAPSHOT_BYTE_LIMIT = 16 * 1024 * 1024 * 1024;
export const WORKFLOW_VIEWER_SNAPSHOT_PATH_BYTE_LIMIT = 512;
export const WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT = 16 * 1024 * 1024;
const WORKFLOW_VIEWER_SNAPSHOT_ENTRY_LIMIT = 512;
const WORKFLOW_VIEWER_DIRECTORY_DEPTH_LIMIT = 32;

export type WorkflowViewerSnapshotFile = {
  path: string;
  size: number;
  sha256: string;
};

type ViewerPreviewSource = {
  kind: "clip" | "image" | "audio";
  reference: string;
};

type ViewerEvidence = ViewerArtifactSnapshot & {
  reviewPresent?: true;
  gate2QcDigest?: string;
  previewSources: ViewerPreviewSource[];
};

const MATERIAL_PREVIEW_LIMITS = { clip: 2, image: 4, audio: 2 } as const;
const REVIEW_PREVIEW_FILE_LIMIT = 64;
const REVIEW_PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const viewerAppDir = join(repositoryRoot, "apps", "workflow-viewer");
const defaultBundleDir = join(viewerAppDir, "dist");

export async function prepareWorkflowViewerBundle(bundleDir?: string): Promise<string> {
  const resolvedBundleDir = bundleDir ? resolve(bundleDir) : defaultBundleDir;
  await ensureViewerBundle(resolvedBundleDir, bundleDir !== undefined);
  return resolvedBundleDir;
}

/**
 * Writes a read-only Viewer snapshot. Pipeline state and Gate artifacts are never changed.
 */
export async function writeWorkflowViewer(
  options: WriteWorkflowViewerOptions
): Promise<WorkflowViewerResult> {
  const runId = options.project.run_id ?? options.project.slug;
  const stateRoot = options.stateDir
    ? resolve(options.stateDir)
    : resolve(dirname(resolve(options.configPath)), options.project.dist_dir);
  const runDir = join(stateRoot, runId);
  const outputDir = options.outputDir ? resolve(options.outputDir) : join(runDir, "viewer");
  const bundleDir = options.bundleDir ? resolve(options.bundleDir) : defaultBundleDir;

  assertSeparateDirectories(bundleDir, outputDir);
  assertSafeViewerOutput(runDir, outputDir);

  const { state, found: stateFound } = await loadRunState(join(runDir, "state.json"), runId);
  const loadedEvidence = await loadViewerEvidence(runDir, runId);
  const { previewSources, gate2QcDigest, ...evidence } = loadedEvidence;
  await prepareWorkflowViewerBundle(options.bundleDir);
  await mkdir(outputDir, { recursive: true });
  const [reviewHref, previews] = await Promise.all([
    writeReviewPreview(runDir, outputDir, evidence.reviewPresent === true),
    writeViewerPreviews(
      runDir,
      outputDir,
      previewSources,
      evidence.gate3Qc?.outputPath
    )
  ]);
  const workflow = createViewerWorkflow(options.project, options.plan, state, {
    ...evidence,
    ...(reviewHref ? { reviewHref } : {}),
    ...(previews.length > 0 ? { previews } : {})
  });
  const workflowJson = `${JSON.stringify(workflow, null, 2)}\n`;
  const indexTemplate = await readFile(join(bundleDir, "index.html"), "utf8");
  const indexHtml = await renderViewerIndex(indexTemplate, bundleDir, workflow);

  await replaceAssets(join(bundleDir, "assets"), join(outputDir, "assets"));

  const viewerPath = join(outputDir, "index.html");
  const workflowPath = join(outputDir, "workflow.json");
  const reviewDigest = reviewHref ? await digestWorkflowViewerReview(outputDir) : undefined;
  const viewerIndexDigest = createHash("sha256").update(indexHtml).digest("hex");
  const workflowDigest = createHash("sha256").update(workflowJson).digest("hex");
  const evidencePath = join(outputDir, WORKFLOW_VIEWER_EVIDENCE_FILE);
  await Promise.all([
    writeFile(viewerPath, indexHtml),
    writeFile(workflowPath, workflowJson)
  ]);
  const files = await createWorkflowViewerSnapshotManifest(outputDir);
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schema_version: 1,
      ...(reviewDigest ? { review_digest: reviewDigest } : {}),
      viewer_index_digest: viewerIndexDigest,
      workflow_digest: workflowDigest,
      ...(gate2QcDigest ? { gate2_qc_digest: gate2QcDigest } : {}),
      files
    }, null, 2)}\n`,
    { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW }
  );

  return { viewerPath, workflowPath, outputDir, stateFound };
}

export function getWorkflowViewerOpenCommand(
  viewerPath: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [viewerPath] };
  if (platform === "win32") return { command: "explorer.exe", args: [viewerPath] };
  return { command: "xdg-open", args: [viewerPath] };
}

export async function openWorkflowViewer(viewerPath: string): Promise<void> {
  const target = getWorkflowViewerOpenCommand(viewerPath);
  await promisify(execFile)(target.command, target.args);
}

async function loadRunState(
  statePath: string,
  runId: string
): Promise<{ state: RunState; found: boolean }> {
  try {
    const state = await readState(statePath);
    if (state.run_id !== runId) {
      throw new Error(`state run_id '${state.run_id}' does not match project run_id '${runId}'`);
    }
    return { state, found: true };
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    return { state: createPlannedState(runId), found: false };
  }
}

async function loadViewerEvidence(runDir: string, runId: string): Promise<ViewerEvidence> {
  const reviewPath = join(runDir, "review", "index.html");
  const reviewDataPath = join(runDir, "review", "review-data.json");
  const [reviewFilePresent, reviewDataPresent, gate2Result, gate3Qc, runLog] = await Promise.all([
    isFile(reviewPath),
    isFile(reviewDataPath),
    readOptionalGate2Qc(join(runDir, "gate2-qc.json")),
    readOptionalGate3Qc(join(runDir, "gate3-qc.json")),
    readOptionalRunLog(join(runDir, "run-log.md"), runId)
  ]);

  let reviewPresent = false;
  if (reviewFilePresent && reviewDataPresent) {
    await Promise.all([
      readFile(reviewPath, "utf8"),
      readJson(reviewDataPath, "Gate 1 review data")
    ]);
    reviewPresent = true;
  }

  return {
    ...(reviewPresent ? { reviewPresent: true as const } : {}),
    ...(gate2Result ? { gate2Qc: gate2Result.evidence } : {}),
    ...(gate2Result ? { gate2QcDigest: gate2Result.digest } : {}),
    ...(gate3Qc ? { gate3Qc } : {}),
    ...(runLog ? { runLog } : {}),
    previewSources: gate2Result?.previewSources ?? []
  };
}

async function readOptionalRunLog(
  path: string,
  expectedRunId: string
): Promise<ViewerRunLogEvidence | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw new Error(`Run log could not be read: ${errorMessage(error)}`, { cause: error });
  }

  const runId = text.match(/^# Run Log: (.+)$/m)?.[1]?.trim();
  const mode = text.match(/^- mode: (.+)$/m)?.[1]?.trim();
  const assetCountText = text.match(/^- asset_count: (.+)$/m)?.[1]?.trim();
  const actualCreditsText = text.match(/^- actual_credits: (.+)$/m)?.[1]?.trim();
  const inputDigest = text.match(/^- input_digest: ([a-f0-9]{64})$/m)?.[1];
  const generatedAt = text.match(/^- generated_at: (.+)$/m)?.[1]?.trim();
  const assetCount = Number(assetCountText);
  const actualCredits = Number(actualCreditsText);

  if (runId !== expectedRunId) {
    throw new Error(`Run log run_id '${runId ?? "missing"}' does not match project run_id '${expectedRunId}'`);
  }
  if (
    !mode ||
    assetCountText === undefined ||
    actualCreditsText === undefined ||
    !Number.isInteger(assetCount) ||
    assetCount < 0 ||
    !Number.isFinite(actualCredits) ||
    actualCredits < 0 ||
    !inputDigest ||
    (generatedAt !== undefined && Number.isNaN(Date.parse(generatedAt)))
  ) {
    throw new Error("Run log is missing valid summary fields");
  }

  const requestSection = text.match(/^## Requests\s*\n([\s\S]*)$/m)?.[1];
  if (requestSection === undefined) throw new Error("Run log is missing the Requests section");
  const requestLines = requestSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const requests = requestLines.map((line, index) => parseRunLogRequest(line, index));

  return {
    runId,
    mode,
    assetCount,
    actualCredits,
    inputDigest,
    ...(generatedAt ? { generatedAt } : {}),
    requests
  };
}

function parseRunLogRequest(
  line: string,
  index: number
): ViewerRunLogEvidence["requests"][number] {
  const match = line.match(
    /^- ([A-Za-z0-9._-]+): attempts=(\d+), credits=(\d+(?:\.\d+)?), clips=(\d+)$/
  );
  if (!match) throw new Error(`Run log request ${index + 1} is malformed`);
  const [, id, attemptsText, creditsText, clipsText] = match;
  const attempts = Number(attemptsText);
  const credits = Number(creditsText);
  const clips = Number(clipsText);
  if (!id || !Number.isSafeInteger(attempts) || !Number.isFinite(credits) || !Number.isSafeInteger(clips)) {
    throw new Error(`Run log request ${index + 1} is malformed`);
  }
  return { id, attempts, credits, clips };
}

async function readOptionalGate2Qc(path: string): Promise<{
  evidence: ViewerGate2QcEvidence;
  digest: string;
  previewSources: ViewerPreviewSource[];
} | undefined> {
  const parsed = await readOptionalQcInput(path, "Gate 2 QC");
  if (!parsed) return undefined;
  const { input, ok, issues, rawText } = parsed;
  const assets = input.assets === undefined
    ? undefined
    : parseGate2Assets(input.assets);
  return {
    digest: createHash("sha256").update(rawText).digest("hex"),
    evidence: {
      ok,
      issues,
      ...optionalNumberProperty(input, "target_duration_seconds", "targetDurationSeconds", "Gate 2 QC"),
      ...optionalNumberProperty(input, "total_clip_duration_seconds", "totalClipDurationSeconds", "Gate 2 QC"),
      ...optionalNumberProperty(input, "duration_delta_seconds", "durationDeltaSeconds", "Gate 2 QC"),
      ...optionalIntegerProperty(input, "asset_count", "assetCount", "Gate 2 QC"),
      ...(assets ? { assetKinds: assets.counts } : {})
    },
    previewSources: assets?.previewSources ?? []
  };
}

async function readOptionalGate3Qc(path: string): Promise<ViewerGate3QcEvidence | undefined> {
  const parsed = await readOptionalQcInput(path, "Gate 3 QC");
  if (!parsed) return undefined;
  const { input, ok, issues } = parsed;
  return {
    ok,
    issues,
    ...(input.output_path === undefined
      ? {}
      : { outputPath: requiredString(input.output_path, "Gate 3 QC output_path") }),
    ...(input.expected === undefined ? {} : { expected: parseGate3Expected(input.expected) }),
    ...(input.actual === undefined ? {} : { actual: parseGate3Actual(input.actual) }),
    ...(input.content === undefined ? {} : { content: parseGate3Content(input.content) })
  };
}

async function readOptionalQcInput(
  path: string,
  label: string
): Promise<{ input: Record<string, unknown>; ok: boolean; issues: Issue[]; rawText: string } | undefined> {
  let input: unknown;
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
    input = JSON.parse(rawText) as unknown;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw new Error(`${label} could not be read: ${errorMessage(error)}`, { cause: error });
  }

  if (!isRecord(input) || typeof input.ok !== "boolean") {
    throw new Error(`${label} must contain a boolean 'ok' field`);
  }
  if (input.issues !== undefined && !Array.isArray(input.issues)) {
    throw new Error(`${label} 'issues' must be an array`);
  }

  const issues = (input.issues ?? []).map((issue, index) => parseIssue(issue, label, index));
  return { input, ok: input.ok, issues, rawText };
}

function parseGate2Assets(input: unknown): {
  counts: { clip: number; image: number; audio: number };
  previewSources: ViewerPreviewSource[];
} {
  if (!Array.isArray(input)) throw new Error("Gate 2 QC 'assets' must be an array");
  const counts = { clip: 0, image: 0, audio: 0 };
  const previewSources: ViewerPreviewSource[] = [];
  for (const [index, asset] of input.entries()) {
    if (!isRecord(asset) || (asset.kind !== "clip" && asset.kind !== "image" && asset.kind !== "audio")) {
      throw new Error(`Gate 2 QC asset ${index + 1} must contain a valid 'kind'`);
    }
    counts[asset.kind] += 1;
    if (typeof asset.src === "string" && asset.src.length > 0) {
      previewSources.push({ kind: asset.kind, reference: asset.src });
    }
  }
  return { counts, previewSources };
}

async function writeViewerPreviews(
  runDir: string,
  outputDir: string,
  sources: ViewerPreviewSource[],
  finalOutputPath: string | undefined
): Promise<ViewerMediaPreview[]> {
  const previewsDir = join(outputDir, "previews");
  await rm(previewsDir, { recursive: true, force: true });

  const selectedSources = (["clip", "image", "audio"] as const).flatMap((kind) =>
    sources.filter((source) => source.kind === kind).slice(0, MATERIAL_PREVIEW_LIMITS[kind])
  );
  if (selectedSources.length === 0 && !finalOutputPath) return [];

  await mkdir(previewsDir, { recursive: true });
  const previews: ViewerMediaPreview[] = [];
  const copiedCounts = { clip: 0, image: 0, audio: 0 };

  for (const source of selectedSources) {
    const nextIndex = copiedCounts[source.kind] + 1;
    const kind = previewKind(source.kind);
    const extension = allowedPreviewExtension(kind, source.reference);
    if (!extension) continue;
    const fileName = `generated-${kind}-${String(nextIndex).padStart(2, "0")}${extension}`;
    if (!(await copySafeRunFile(runDir, source.reference, join(previewsDir, fileName)))) continue;
    copiedCounts[source.kind] = nextIndex;
    previews.push({
      id: `generated-${kind}-${String(nextIndex).padStart(2, "0")}`,
      role: "material",
      kind,
      label: `生成した${previewKindLabel(kind)} ${nextIndex}`,
      description: previewDescription(kind),
      src: `./previews/${fileName}`
    });
  }

  if (finalOutputPath) {
    const extension = allowedPreviewExtension("video", finalOutputPath);
    const fileName = extension ? `final-video${extension}` : undefined;
    if (fileName && await copySafeRunFile(runDir, finalOutputPath, join(previewsDir, fileName))) {
      previews.push({
        id: "final-video",
        role: "final",
        kind: "video",
        label: "完成動画",
        description: "確認・承認を終えた完成版です。",
        src: `./previews/${fileName}`
      });
    }
  }

  return previews;
}

type ReviewPreviewFile = {
  source: string;
  relativePath: string;
  size: number;
};

async function writeReviewPreview(
  runDir: string,
  outputDir: string,
  reviewPresent: boolean
): Promise<string | undefined> {
  const destinationDir = join(outputDir, "review");
  await rm(destinationDir, { recursive: true, force: true });
  if (!reviewPresent) return undefined;

  const reviewDir = join(runDir, "review");
  const files = await collectReviewPreviewFiles(runDir, reviewDir);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (
    files.length === 0 ||
    files.length > REVIEW_PREVIEW_FILE_LIMIT ||
    totalBytes > REVIEW_PREVIEW_BYTE_LIMIT
  ) return undefined;

  for (const file of files) {
    const destination = join(destinationDir, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.source, destination);
  }
  return "./review/index.html";
}

async function collectReviewPreviewFiles(runDir: string, reviewDir: string): Promise<ReviewPreviewFile[]> {
  const [realRunDir, realReviewDir] = await Promise.all([realpath(runDir), realpath(reviewDir)]);
  if (!isSameOrDescendant(relative(realRunDir, realReviewDir))) return [];
  const files: ReviewPreviewFile[] = [];
  let visitedEntries = 0;

  const addFile = async (source: string, relativePath: string): Promise<void> => {
    const realSource = await realpath(source);
    if (!isSameOrDescendant(relative(realReviewDir, realSource))) return;
    const sourceStat = await stat(realSource);
    if (!sourceStat.isFile()) return;
    files.push({ source: realSource, relativePath, size: sourceStat.size });
  };

  await addFile(join(reviewDir, "index.html"), "index.html");
  const walkAssets = async (
    directory: string,
    relativeDirectory: string,
    depth: number
  ): Promise<void> => {
    if (depth > WORKFLOW_VIEWER_DIRECTORY_DEPTH_LIMIT) {
      throw new Error("Viewer review contains directories that are too deeply nested");
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visitedEntries += 1;
      if (visitedEntries > WORKFLOW_VIEWER_SNAPSHOT_ENTRY_LIMIT) {
        throw new Error("Viewer review contains too many entries");
      }
      if (entry.isSymbolicLink()) continue;
      const source = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walkAssets(source, relativePath, depth + 1);
      } else if (entry.isFile()) {
        await addFile(source, relativePath);
      }
      if (files.length > REVIEW_PREVIEW_FILE_LIMIT) return;
    }
  };
  await walkAssets(join(reviewDir, "assets"), "assets", 1);
  return files;
}

export async function digestWorkflowViewerReview(runDir: string): Promise<string | undefined> {
  let files: ReviewPreviewFile[];
  try {
    files = await collectReviewPreviewFiles(runDir, join(runDir, "review"));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return undefined;
    throw error;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (
    files.length === 0
    || files.length > REVIEW_PREVIEW_FILE_LIMIT
    || totalBytes > REVIEW_PREVIEW_BYTE_LIMIT
  ) return undefined;
  const digest = createHash("sha256");
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    digest.update(file.relativePath.replaceAll("\\", "/"));
    digest.update("\0");
    const fingerprint = await fingerprintRegularFile(file.source);
    if (!fingerprint || fingerprint.size !== file.size) return undefined;
    digest.update(fingerprint.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export async function createWorkflowViewerSnapshotManifest(
  outputDir: string
): Promise<WorkflowViewerSnapshotFile[]> {
  const root = resolve(outputDir);
  const realRoot = await realpath(root);
  const references = ["index.html", "workflow.json"];
  const traversal = { entries: 0 };
  for (const directory of ["assets", "previews", "review"]) {
    await collectSnapshotReferences(root, directory, references, traversal, 1);
  }
  if (references.length > WORKFLOW_VIEWER_SNAPSHOT_FILE_LIMIT) {
    throw new Error("Viewer snapshot contains too many files");
  }
  const files: WorkflowViewerSnapshotFile[] = [];
  let totalBytes = 0;
  for (const reference of [...new Set(references)].sort((left, right) => left.localeCompare(right))) {
    if (!isSafeSnapshotReference(reference)) throw new Error("Viewer snapshot contains an unsafe path");
    if (Buffer.byteLength(reference) > WORKFLOW_VIEWER_SNAPSHOT_PATH_BYTE_LIMIT) {
      throw new Error("Viewer snapshot path is too long");
    }
    const candidate = resolve(root, reference);
    const realCandidate = await realpath(candidate);
    if (!isSameOrDescendant(relative(realRoot, realCandidate))) {
      throw new Error("Viewer snapshot file resolves outside its root");
    }
    const fingerprint = await fingerprintRegularFile(candidate);
    if (!fingerprint) throw new Error("Viewer snapshot contains a non-regular file");
    if (
      (reference === "index.html" || reference === "workflow.json")
      && fingerprint.size > WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT
    ) {
      throw new Error("Viewer snapshot document is too large");
    }
    totalBytes += fingerprint.size;
    if (totalBytes > WORKFLOW_VIEWER_SNAPSHOT_BYTE_LIMIT) {
      throw new Error("Viewer snapshot is too large");
    }
    files.push({ path: reference, size: fingerprint.size, sha256: fingerprint.sha256 });
  }
  return files;
}

async function collectSnapshotReferences(
  root: string,
  reference: string,
  output: string[],
  traversal: { entries: number },
  depth: number
): Promise<void> {
  if (depth > WORKFLOW_VIEWER_DIRECTORY_DEPTH_LIMIT) {
    throw new Error("Viewer snapshot contains directories that are too deeply nested");
  }
  let entries;
  try {
    const stats = await lstat(resolve(root, reference));
    if (stats.isSymbolicLink()) throw new Error("Viewer snapshot contains a symbolic link");
    if (!stats.isDirectory()) throw new Error("Viewer snapshot path must be a directory");
    entries = await readdir(resolve(root, reference), { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    traversal.entries += 1;
    if (traversal.entries > WORKFLOW_VIEWER_SNAPSHOT_ENTRY_LIMIT) {
      throw new Error("Viewer snapshot contains too many entries");
    }
    if (entry.isSymbolicLink()) throw new Error("Viewer snapshot contains a symbolic link");
    const child = `${reference}/${entry.name}`;
    if (!isSafeSnapshotReference(child)) throw new Error("Viewer snapshot contains an unsafe path");
    if (entry.isDirectory()) {
      await collectSnapshotReferences(root, child, output, traversal, depth + 1);
    }
    else if (entry.isFile()) output.push(child);
    else throw new Error("Viewer snapshot contains an unsupported file type");
    if (output.length > WORKFLOW_VIEWER_SNAPSHOT_FILE_LIMIT) {
      throw new Error("Viewer snapshot contains too many files");
    }
  }
}

function isSafeSnapshotReference(reference: string): boolean {
  return reference.length > 0
    && !reference.startsWith("/")
    && !reference.includes("\\")
    && !reference.includes("\0")
    && reference.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function fingerprintRegularFile(
  path: string
): Promise<{ size: number; sha256: string } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return undefined;
    const sha256 = await sha256OpenedFile(handle, before);
    return { size: before.size, sha256 };
  } catch (error) {
    if (
      isFileSystemError(error, "ENOENT")
      || isFileSystemError(error, "ENOTDIR")
      || isFileSystemError(error, "ELOOP")
    ) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function sha256OpenedFile(handle: FileHandle, before: Stats): Promise<string> {
  const digest = createHash("sha256");
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) digest.update(chunk as Buffer);
  const after = await handle.stat();
  if (!sameFingerprintIdentity(before, after)) {
    throw new Error("File changed while it was being fingerprinted");
  }
  return digest.digest("hex");
}

function sameFingerprintIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function previewKind(kind: ViewerPreviewSource["kind"]): ViewerMediaPreview["kind"] {
  return kind === "clip" ? "video" : kind;
}

function previewKindLabel(kind: ViewerMediaPreview["kind"]): string {
  if (kind === "video") return "映像";
  if (kind === "image") return "画像";
  return "音声";
}

function previewDescription(kind: ViewerMediaPreview["kind"]): string {
  if (kind === "video") return "完成動画に使った映像素材です。";
  if (kind === "image") return "映像制作に使った画像素材です。";
  return "完成動画に使った音声素材です。";
}

function allowedPreviewExtension(
  kind: ViewerMediaPreview["kind"],
  reference: string
): string | undefined {
  const extension = extname(reference).toLowerCase();
  const allowed = {
    video: new Set([".mp4", ".webm"]),
    image: new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]),
    audio: new Set([".mp3", ".wav", ".m4a", ".ogg"])
  }[kind];
  return allowed.has(extension) ? extension : undefined;
}

async function copySafeRunFile(
  runDir: string,
  reference: string,
  destination: string
): Promise<boolean> {
  const absoluteReference = isAbsolute(reference);
  if (!absoluteReference && (reference.includes("\\") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(reference))) {
    return false;
  }
  const sourcePath = absoluteReference ? resolve(reference) : resolve(runDir, reference);
  if (!isSameOrDescendant(relative(runDir, sourcePath))) return false;
  try {
    const [realRunDir, realSource] = await Promise.all([realpath(runDir), realpath(sourcePath)]);
    if (!isSameOrDescendant(relative(realRunDir, realSource))) return false;
    if (!(await stat(realSource)).isFile()) return false;
    await copyFile(realSource, destination);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function parseGate3Expected(input: unknown): NonNullable<ViewerGate3QcEvidence["expected"]> {
  if (!isRecord(input)) throw new Error("Gate 3 QC 'expected' must be an object");
  return {
    durationSeconds: requiredFiniteNumber(input.duration_seconds, "Gate 3 QC expected.duration_seconds"),
    width: requiredPositiveInteger(input.width, "Gate 3 QC expected.width"),
    height: requiredPositiveInteger(input.height, "Gate 3 QC expected.height"),
    fps: requiredFiniteNumber(input.fps, "Gate 3 QC expected.fps"),
    audioRequired: requiredBoolean(input.audio_required, "Gate 3 QC expected.audio_required")
  };
}

function parseGate3Actual(input: unknown): NonNullable<ViewerGate3QcEvidence["actual"]> {
  if (!isRecord(input)) throw new Error("Gate 3 QC 'actual' must be an object");
  return {
    ...optionalNumberProperty(input, "duration_seconds", "durationSeconds", "Gate 3 QC actual"),
    ...optionalIntegerProperty(input, "width", "width", "Gate 3 QC actual"),
    ...optionalIntegerProperty(input, "height", "height", "Gate 3 QC actual"),
    ...optionalNumberProperty(input, "fps", "fps", "Gate 3 QC actual"),
    ...(input.has_audio === undefined
      ? {}
      : { hasAudio: requiredBoolean(input.has_audio, "Gate 3 QC actual.has_audio") })
  };
}

function parseGate3Content(input: unknown): NonNullable<ViewerGate3QcEvidence["content"]> {
  if (!isRecord(input)) throw new Error("Gate 3 QC 'content' must be an object");
  return {
    ...optionalNumberProperty(input, "longest_black_seconds", "longestBlackSeconds", "Gate 3 QC content"),
    ...optionalNumberProperty(input, "longest_silence_seconds", "longestSilenceSeconds", "Gate 3 QC content")
  };
}

function optionalNumberProperty<OutputKey extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: OutputKey,
  label: string
): { [Key in OutputKey]?: number } {
  if (input[inputKey] === undefined) return {};
  return { [outputKey]: requiredFiniteNumber(input[inputKey], `${label} ${inputKey}`) } as { [Key in OutputKey]: number };
}

function optionalIntegerProperty<OutputKey extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: OutputKey,
  label: string
): { [Key in OutputKey]?: number } {
  if (input[inputKey] === undefined) return {};
  return { [outputKey]: requiredPositiveInteger(input[inputKey], `${label} ${inputKey}`, true) } as { [Key in OutputKey]: number };
}

function requiredFiniteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) throw new Error(`${label} must be a finite number`);
  return input;
}

function requiredPositiveInteger(input: unknown, label: string, allowZero = false): number {
  if (!Number.isInteger(input) || Number(input) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return Number(input);
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requiredBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${label} must be a boolean`);
  return input;
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} could not be read: ${errorMessage(error)}`, { cause: error });
  }
}

function parseIssue(input: unknown, label: string, index: number): Issue {
  if (!isRecord(input) || typeof input.code !== "string" || typeof input.message !== "string") {
    throw new Error(`${label} issue ${index + 1} must contain string 'code' and 'message' fields`);
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    throw new Error(`${label} issue ${index + 1} 'path' must be a string`);
  }
  return {
    code: input.code,
    message: input.message,
    ...(input.path ? { path: input.path } : {})
  };
}

async function ensureViewerBundle(bundleDir: string, customBundle: boolean): Promise<void> {
  if (customBundle) {
    if (!(await isDirectory(bundleDir))) {
      throw new Error(`Viewer bundle directory was not found: ${bundleDir}`);
    }
    return;
  }

  // Always rebuild the repository-owned bundle so the CLI cannot export stale Viewer source.
  const result = spawnCommandSync("npm", ["--prefix", viewerAppDir, "run", "build"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024 * 10
  });
  if (result.error) {
    throw new Error(`Viewer bundle build could not start: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Viewer bundle build failed${detail ? `: ${detail}` : ""}`);
  }
  if (!(await isDirectory(bundleDir))) {
    throw new Error(`Viewer bundle build did not create: ${bundleDir}`);
  }
}

async function replaceAssets(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await isDirectory(sourceDir))) {
    throw new Error(`Viewer bundle assets directory was not found: ${sourceDir}`);
  }
  await rm(targetDir, { recursive: true, force: true });
  await copyDirectory(sourceDir, targetDir);
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    } else {
      throw new Error(`Viewer bundle assets cannot contain links or special files: ${source}`);
    }
  }
}

async function renderViewerIndex(
  indexHtml: string,
  bundleDir: string,
  workflow: unknown
): Promise<string> {
  const withInlineStyles = await inlineStylesheets(indexHtml, bundleDir);
  const moduleScriptPattern = /<script\b[^>]*>\s*<\/script\s*>/gi;
  let moduleMatch: RegExpExecArray | null;
  while ((moduleMatch = moduleScriptPattern.exec(withInlineStyles)) !== null) {
    const openingTag = moduleMatch[0].slice(0, moduleMatch[0].indexOf(">") + 1);
    if (attributeValue(openingTag, "type")?.toLowerCase() !== "module") continue;
    const sourceReference = attributeValue(openingTag, "src");
    if (!sourceReference) continue;
    const sourcePath = resolveBundleAsset(bundleDir, sourceReference);
    const source = escapeInlineScript(await readFile(sourcePath, "utf8"));
    const workflowScript = renderWorkflowDataScript(workflow);
    const inlineModule = `<script type="module">${source}</script>`;
    return `${withInlineStyles.slice(0, moduleMatch.index)}${workflowScript}\n    ${inlineModule}${withInlineStyles.slice(moduleMatch.index + moduleMatch[0].length)}`;
  }

  throw new Error("Viewer bundle index.html does not contain an external module script");
}

async function inlineStylesheets(indexHtml: string, bundleDir: string): Promise<string> {
  const linkPattern = /<link\b[^>]*>/gi;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(indexHtml)) !== null) {
    const rel = attributeValue(match[0], "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("stylesheet")) continue;
    const href = attributeValue(match[0], "href");
    if (!href) throw new Error("Viewer bundle stylesheet link is missing href");
    const cssPath = resolveBundleAsset(bundleDir, href);
    const css = escapeInlineStyle(await readFile(cssPath, "utf8"));
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `<style>${css}</style>`
    });
  }

  return replacements.reduceRight(
    (html, replacement) =>
      `${html.slice(0, replacement.start)}${replacement.value}${html.slice(replacement.end)}`,
    indexHtml
  );
}

function renderWorkflowDataScript(workflow: unknown): string {
  const safeJson = JSON.stringify(workflow)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<script id="tsugite-workflow-data" type="application/json">${safeJson}</script>`;
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match?.[2];
}

function resolveBundleAsset(bundleDir: string, reference: string): string {
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(reference) || reference.startsWith("//")) {
    throw new Error(`Viewer bundle cannot reference an external asset: ${reference}`);
  }
  if (reference.includes("\\")) {
    throw new Error(`Viewer bundle asset path must use forward slashes: ${reference}`);
  }
  const cleanReference = reference.split(/[?#]/, 1)[0]!.replace(/^\/+/, "");
  const assetPath = resolve(bundleDir, cleanReference);
  const relativePath = relative(bundleDir, assetPath);
  if (isSameOrDescendant(relativePath)) return assetPath;
  throw new Error(`Viewer bundle asset escapes the bundle directory: ${reference}`);
}

function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(source: string): string {
  return source.replace(/<\/style/gi, "<\\/style");
}

function assertSeparateDirectories(bundleDir: string, outputDir: string): void {
  if (pathsOverlap(bundleDir, outputDir)) {
    throw new Error("Viewer bundle and output directories must not overlap");
  }
}

function assertSafeViewerOutput(runDir: string, outputDir: string): void {
  if (isSameOrDescendant(relative(outputDir, runDir))) {
    throw new Error("Viewer output must not be the run directory or its ancestor");
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = relative(first, second);
  const secondToFirst = relative(second, first);
  return isSameOrDescendant(firstToSecond) || isSameOrDescendant(secondToFirst);
}

function isSameOrDescendant(path: string): boolean {
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
