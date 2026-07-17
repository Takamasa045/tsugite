import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { loadProject } from "../project/loadProject.js";
import { PipelineError } from "../types.js";

export const FEEDBACK_FILE_NAME = "feedback.jsonl";
export const FEEDBACK_MAX_FILE_BYTES = 1024 * 1024;
export const FEEDBACK_MAX_LINE_BYTES = 16 * 1024;
export const FEEDBACK_MAX_RECORDS = 10_000;

const appendQueues = new Map<string, Promise<void>>();

const safeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");
const safeSlugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "must be a safe slug");
const safeRelativePathSchema = z.string().min(1).max(512).refine((value) => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}, "must be a safe project-relative path");
const isoDateSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
  "must be an ISO 8601 UTC timestamp"
);

export const feedbackRecordSchema = z.object({
  schema_version: z.literal(1),
  id: safeIdSchema,
  created_at: isoDateSchema,
  key: safeSlugSchema,
  category: safeSlugSchema,
  signal: z.enum(["prefer", "avoid", "keep"]),
  stage: z.enum(["observed", "recurring", "promoted", "verified"]),
  summary: z.string().trim().min(1).max(1_000),
  run_id: safeIdSchema.optional(),
  gate: z.enum(["gate_1", "gate_2", "gate_3"]).optional(),
  evidence: z.array(safeRelativePathSchema).min(1).max(32).optional(),
  promotion: z.object({
    kind: z.enum(["template", "constraint", "validator", "qa", "rule", "documentation"]),
    target: safeRelativePathSchema
  }).strict().optional()
}).strict().superRefine((record, context) => {
  if (record.stage === "promoted" && !record.promotion) {
    context.addIssue({ code: "custom", message: "promoted feedback requires promotion", path: ["promotion"] });
  }
  if (record.stage === "verified" && !record.evidence?.length) {
    context.addIssue({ code: "custom", message: "verified feedback requires evidence", path: ["evidence"] });
  }
  if (record.promotion && record.stage !== "promoted") {
    context.addIssue({ code: "custom", message: "promotion is only valid for promoted feedback", path: ["promotion"] });
  }
});

export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;
export type FeedbackInput = Omit<FeedbackRecord, "schema_version" | "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type FeedbackIssue = {
  code: string;
  message: string;
  line?: number;
  path?: string;
};

export type FeedbackReadResult = {
  path: string;
  entries: FeedbackRecord[];
  issues: FeedbackIssue[];
  lineCount: number;
};

export type FeedbackProjectInput = {
  projectId: string;
  projectName: string;
  runId?: string;
  configPath?: string;
  entries: FeedbackRecord[];
  issues?: FeedbackIssue[];
};

export type FeedbackMetrics = {
  observed: number;
  recurring: number;
  promoted: number;
  verified: number;
  issues: number;
};

export type AggregatedFeedbackIssue = FeedbackIssue & {
  projectId: string;
  projectName: string;
};

export type AggregatedFeedbackPromotion = {
  projectId: string;
  projectName: string;
  kind: string;
  target: string;
};

export type AggregatedPreference = {
  key: string;
  category: string;
  signal: FeedbackRecord["signal"];
  stage: FeedbackRecord["stage"];
  summary: string;
  projectCount: number;
  projectIds: string[];
  projectNames: string[];
  runIds: string[];
  recordCount: number;
  evidence: string[];
  promotion?: AggregatedFeedbackPromotion;
  promotions: AggregatedFeedbackPromotion[];
  lastSeenAt: string;
  metrics: FeedbackMetrics;
};

export type FeedbackAggregate = {
  metrics: FeedbackMetrics;
  preferences: AggregatedPreference[];
  issues: AggregatedFeedbackIssue[];
};

export function feedbackPathForProject(configPath: string): string {
  return join(dirname(configPath), FEEDBACK_FILE_NAME);
}

export async function readProjectFeedback(configPath: string): Promise<FeedbackReadResult> {
  const path = feedbackPathForProject(configPath);
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return fileIssue(path, "feedback.symlink", "feedback.jsonl must not be a symbolic link");
    }
  } catch (error) {
    if (isFsError(error, "ENOENT")) return { path, entries: [], issues: [], lineCount: 0 };
    return fileIssue(path, "feedback.unreadable", "feedback.jsonl could not be inspected safely");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return { path, entries: [], issues: [], lineCount: 0 };
    return {
      path,
      entries: [],
      issues: [{
        code: isFsError(error, "ELOOP") ? "feedback.symlink" : "feedback.unreadable",
        message: isFsError(error, "ELOOP")
          ? "feedback.jsonl must not be a symbolic link"
          : "feedback.jsonl could not be read safely",
        path
      }],
      lineCount: 0
    };
  }

  try {
    if (!(await openHandleMatchesPath(handle, path))) {
      return fileIssue(path, "feedback.symlink", "feedback.jsonl changed or became a symbolic link while opening");
    }
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return fileIssue(path, "feedback.not_file", "feedback.jsonl must be a regular file");
    }
    if (stats.size > FEEDBACK_MAX_FILE_BYTES) {
      return fileIssue(path, "feedback.file_too_large", `feedback.jsonl must not exceed ${FEEDBACK_MAX_FILE_BYTES} bytes`);
    }
    const bounded = await readBoundedText(handle, FEEDBACK_MAX_FILE_BYTES);
    if (bounded.exceeded) {
      return fileIssue(path, "feedback.file_too_large", `feedback.jsonl must not exceed ${FEEDBACK_MAX_FILE_BYTES} bytes`);
    }
    return parseFeedbackJsonl(path, bounded.contents);
  } finally {
    await handle.close();
  }
}

export async function appendProjectFeedback(
  configPath: string,
  input: FeedbackInput
): Promise<{ path: string; entry: FeedbackRecord }> {
  const path = feedbackPathForProject(configPath);
  return withAppendLock(path, () => appendProjectFeedbackUnlocked(configPath, path, input));
}

async function appendProjectFeedbackUnlocked(
  configPath: string,
  path: string,
  input: FeedbackInput
): Promise<{ path: string; entry: FeedbackRecord }> {
  await assertRegularConfig(configPath);
  await loadProject(configPath);
  const releaseFileLock = await acquireFeedbackFileLock(`${path}.lock`);
  try {
    return await appendProjectFeedbackWithLock(path, input);
  } finally {
    await releaseFileLock();
  }
}

async function appendProjectFeedbackWithLock(
  path: string,
  input: FeedbackInput
): Promise<{ path: string; entry: FeedbackRecord }> {
  const entry = parseForAppend({
    ...input,
    schema_version: 1,
    id: input.id ?? randomUUID(),
    created_at: input.created_at ?? new Date().toISOString()
  });
  const encodedEntry = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(encodedEntry) > FEEDBACK_MAX_LINE_BYTES) {
    throw feedbackError("feedback.line_too_long", `feedback records must not exceed ${FEEDBACK_MAX_LINE_BYTES} bytes`, path);
  }

  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw feedbackError("feedback.symlink", "feedback.jsonl must not be a symbolic link", path);
    }
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    if (!isFsError(error, "ENOENT")) {
      throw feedbackError("feedback.unwritable", "feedback.jsonl could not be inspected safely", path);
    }
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    throw feedbackError(
      isFsError(error, "ELOOP") ? "feedback.symlink" : "feedback.unwritable",
      isFsError(error, "ELOOP")
        ? "feedback.jsonl must not be a symbolic link"
        : "feedback.jsonl could not be opened safely",
      path
    );
  }

  try {
    if (!(await openHandleMatchesPath(handle, path))) {
      throw feedbackError("feedback.symlink", "feedback.jsonl changed or became a symbolic link while opening", path);
    }
    const stats = await handle.stat();
    if (!stats.isFile()) throw feedbackError("feedback.not_file", "feedback.jsonl must be a regular file", path);
    if (stats.size > FEEDBACK_MAX_FILE_BYTES) {
      throw feedbackError("feedback.file_too_large", `feedback.jsonl must not exceed ${FEEDBACK_MAX_FILE_BYTES} bytes`, path);
    }
    const bounded = await readBoundedText(handle, FEEDBACK_MAX_FILE_BYTES);
    if (bounded.exceeded) {
      throw feedbackError("feedback.file_too_large", `feedback.jsonl must not exceed ${FEEDBACK_MAX_FILE_BYTES} bytes`, path);
    }
    const current = bounded.contents;
    const parsed = parseFeedbackJsonl(path, current);
    if (parsed.lineCount >= FEEDBACK_MAX_RECORDS) {
      throw feedbackError("feedback.too_many_records", `feedback.jsonl must not exceed ${FEEDBACK_MAX_RECORDS} records`, path);
    }
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    if (stats.size + Buffer.byteLength(separator + encodedEntry) > FEEDBACK_MAX_FILE_BYTES) {
      throw feedbackError("feedback.file_too_large", `feedback.jsonl must not exceed ${FEEDBACK_MAX_FILE_BYTES} bytes`, path);
    }
    await handle.write(`${separator}${encodedEntry}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, entry };
}

export function aggregateFeedback(projects: FeedbackProjectInput[]): FeedbackAggregate {
  const groups = new Map<string, Array<{ project: FeedbackProjectInput; entry: FeedbackRecord }>>();
  const issues: AggregatedFeedbackIssue[] = [];
  for (const project of projects) {
    for (const issue of project.issues ?? []) {
      issues.push({
        ...issue,
        ...(issue.path ? { path: isAbsolute(issue.path) ? basename(issue.path) : issue.path } : {}),
        projectId: project.projectId,
        projectName: project.projectName
      });
    }
    for (const entry of project.entries) {
      const rows = groups.get(entry.key) ?? [];
      rows.push({ project, entry });
      groups.set(entry.key, rows);
    }
  }

  const preferences: AggregatedPreference[] = [];
  for (const [key, rows] of groups) {
    const categories = new Set(rows.map(({ entry }) => entry.category));
    const signals = new Set(rows.map(({ entry }) => entry.signal));
    if (categories.size > 1 || signals.size > 1) {
      const owner = [...rows].sort((left, right) => left.project.projectId.localeCompare(right.project.projectId))[0]!.project;
      issues.push({
        code: "feedback.key_conflict",
        message: `feedback key '${key}' has conflicting category or signal values`,
        path: key,
        projectId: owner.projectId,
        projectName: owner.projectName
      });
      continue;
    }
    const preference = aggregatePreference(key, rows);
    if (preference.stage === "verified" && !hasVerificationAfterLatestPromotion(rows)) {
      const owner = [...rows].sort((left, right) => left.project.projectId.localeCompare(right.project.projectId))[0]!.project;
      issues.push({
        code: "feedback.promotion_history_missing",
        message: `verified feedback key '${key}' has no verification after its latest promotion`,
        path: key,
        projectId: owner.projectId,
        projectName: owner.projectName
      });
      const fallbackStage = unsupportedVerifiedFallbackStage(rows);
      preference.stage = fallbackStage;
      preference.metrics = metricsForStage(fallbackStage);
      const fallbackRepresentative = rows
        .filter(({ entry }) => stageRank(entry.stage) <= stageRank(fallbackStage))
        .sort((left, right) => right.entry.created_at.localeCompare(left.entry.created_at))[0];
      if (fallbackRepresentative) preference.summary = fallbackRepresentative.entry.summary;
    }
    preferences.push(preference);
  }
  preferences.sort((left, right) => stageRank(right.stage) - stageRank(left.stage) || left.key.localeCompare(right.key));
  issues.sort((left, right) => left.projectName.localeCompare(right.projectName) || (left.line ?? 0) - (right.line ?? 0));
  return { metrics: funnelMetrics(preferences, issues.length), preferences, issues };
}

function parseFeedbackJsonl(path: string, contents: string): FeedbackReadResult {
  const entries: FeedbackRecord[] = [];
  const issues: FeedbackIssue[] = [];
  const split = contents.split("\n");
  const lines = contents.endsWith("\n") ? split.slice(0, -1) : split;
  const lineCount = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
  const inspected = lines.slice(0, FEEDBACK_MAX_RECORDS);
  if (lines.length > FEEDBACK_MAX_RECORDS) {
    issues.push({ code: "feedback.too_many_records", message: `feedback.jsonl exceeds ${FEEDBACK_MAX_RECORDS} records`, line: FEEDBACK_MAX_RECORDS + 1, path });
  }
  for (const [index, line] of inspected.entries()) {
    const lineNumber = index + 1;
    if (Buffer.byteLength(line) > FEEDBACK_MAX_LINE_BYTES) {
      issues.push({ code: "feedback.line_too_long", message: `line exceeds ${FEEDBACK_MAX_LINE_BYTES} bytes`, line: lineNumber, path });
      continue;
    }
    if (line.trim().length === 0) {
      issues.push({ code: "feedback.empty_line", message: "feedback record line is empty", line: lineNumber, path });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      issues.push({ code: "feedback.invalid_json", message: "feedback record is not valid JSON", line: lineNumber, path });
      continue;
    }
    const parsed = feedbackRecordSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      issues.push({
        code: "feedback.invalid_record",
        message: issue?.message ?? "feedback record is invalid",
        line: lineNumber,
        path: issue?.path.length ? issue.path.join(".") : path
      });
      continue;
    }
    entries.push(parsed.data);
  }
  return { path, entries, issues, lineCount };
}

function aggregatePreference(
  key: string,
  rows: Array<{ project: FeedbackProjectInput; entry: FeedbackRecord }>
): AggregatedPreference {
  const ordered = [...rows].sort((left, right) =>
    stageRank(right.entry.stage) - stageRank(left.entry.stage)
      || right.entry.created_at.localeCompare(left.entry.created_at)
      || left.project.projectId.localeCompare(right.project.projectId)
  );
  const representative = ordered[0]!;
  const projectIds = sortedUnique(rows.map(({ project }) => project.projectId));
  const projectNames = sortedUnique(rows.map(({ project }) => project.projectName));
  const runIds = sortedUnique(rows.flatMap(({ project, entry }) => entry.run_id ? [entry.run_id] : project.runId ? [project.runId] : []));
  const evidence = sortedUnique(rows.flatMap(({ entry }) => entry.evidence ?? []));
  const orderedPromotions = ordered.flatMap(({ project, entry }) => entry.promotion
    ? [{ projectId: project.projectId, projectName: project.projectName, ...entry.promotion }]
    : []);
  const representativePromotion = orderedPromotions[0];
  const promotions = uniqueBy(
    orderedPromotions,
    (item) => `${item.projectId}\0${item.kind}\0${item.target}`
  ).sort(compareProjectPath);
  let stage = representative.entry.stage;
  if (projectIds.length >= 2 && stageRank(stage) < stageRank("recurring")) stage = "recurring";
  return {
    key,
    category: representative.entry.category,
    signal: representative.entry.signal,
    stage,
    summary: representative.entry.summary,
    projectCount: projectIds.length,
    projectIds,
    projectNames,
    runIds,
    recordCount: rows.length,
    evidence,
    ...(representativePromotion ? { promotion: representativePromotion } : {}),
    promotions,
    lastSeenAt: rows.reduce((latest, row) => row.entry.created_at > latest ? row.entry.created_at : latest, rows[0]!.entry.created_at),
    metrics: metricsForStage(stage)
  };
}

function funnelMetrics(preferences: AggregatedPreference[], issueCount: number): FeedbackMetrics {
  return preferences.reduce<FeedbackMetrics>((metrics, preference) => {
    metrics.observed += 1;
    if (stageRank(preference.stage) >= 1) metrics.recurring += 1;
    if (stageRank(preference.stage) >= 2) metrics.promoted += 1;
    if (stageRank(preference.stage) >= 3) metrics.verified += 1;
    return metrics;
  }, { observed: 0, recurring: 0, promoted: 0, verified: 0, issues: issueCount });
}

function metricsForStage(stage: FeedbackRecord["stage"]): FeedbackMetrics {
  const rank = stageRank(stage);
  return { observed: 1, recurring: rank >= 1 ? 1 : 0, promoted: rank >= 2 ? 1 : 0, verified: rank >= 3 ? 1 : 0, issues: 0 };
}

function stageRank(stage: FeedbackRecord["stage"]): number {
  return { observed: 0, recurring: 1, promoted: 2, verified: 3 }[stage];
}

function parseForAppend(value: unknown): FeedbackRecord {
  const parsed = feedbackRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw feedbackError("feedback.invalid_record", issue?.message ?? "feedback record is invalid", issue?.path.join("."));
  }
  return parsed.data;
}

function fileIssue(path: string, code: string, message: string): FeedbackReadResult {
  return { path, entries: [], issues: [{ code, message, path }], lineCount: 0 };
}

function feedbackError(code: string, message: string, path?: string): PipelineError {
  return new PipelineError({ code, message, ...(path ? { path } : {}) });
}

async function assertRegularConfig(configPath: string): Promise<void> {
  try {
    const stats = await lstat(configPath);
    if (stats.isSymbolicLink()) {
      throw feedbackError(
        "feedback.config_symlink",
        "project config must be an existing non-symlink regular file",
        configPath
      );
    }
    if (!stats.isFile()) {
      throw feedbackError("feedback.config_not_file", "project config must be a regular file", configPath);
    }
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    const code = isFsError(error, "ENOENT") ? "feedback.config_missing" : "feedback.config_unreadable";
    throw feedbackError(code, "project config must be an existing non-symlink regular file", configPath);
  }

  let handle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = isFsError(error, "ENOENT")
      ? "feedback.config_missing"
      : isFsError(error, "ELOOP")
        ? "feedback.config_symlink"
        : "feedback.config_unreadable";
    throw feedbackError(code, "project config must be an existing non-symlink regular file", configPath);
  }
  try {
    if (!(await openHandleMatchesPath(handle, configPath))) {
      throw feedbackError(
        "feedback.config_symlink",
        "project config changed or became a symbolic link while opening",
        configPath
      );
    }
    if (!(await handle.stat()).isFile()) {
      throw feedbackError("feedback.config_not_file", "project config must be a regular file", configPath);
    }
  } finally {
    await handle.close();
  }
}

async function openHandleMatchesPath(handle: FileHandle, path: string): Promise<boolean> {
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    return !current.isSymbolicLink() && opened.dev === current.dev && opened.ino === current.ino;
  } catch {
    return false;
  }
}

async function withAppendLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  appendQueues.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (appendQueues.get(path) === queued) appendQueues.delete(path);
  }
}

async function acquireFeedbackFileLock(lockPath: string): Promise<() => Promise<void>> {
  let handle;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) {
        throw feedbackError("feedback.lock_unavailable", "feedback append lock could not be acquired safely", FEEDBACK_FILE_NAME);
      }
      if (await recoverStaleFeedbackLock(lockPath)) continue;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!handle) {
    throw feedbackError("feedback.lock_timeout", "feedback append lock is already held", FEEDBACK_FILE_NAME);
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    const owner = await handle.stat();
    return async () => {
      await handle.close();
      try {
        const current = await lstat(lockPath);
        if (current.dev === owner.dev && current.ino === owner.ino) await unlink(lockPath);
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
    };
  } catch (error) {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch {
      // Preserve the original lock setup error.
    }
    throw error;
  }
}

async function recoverStaleFeedbackLock(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const owner = await handle.stat();
    if (!owner.isFile() || owner.size > 256) return false;
    const bounded = await readBoundedText(handle, 256);
    if (bounded.exceeded) return false;
    const parsed = parseLockOwner(bounded.contents);
    const staleBefore = Date.now() - 30_000;
    if (parsed) {
      if (owner.mtimeMs > staleBefore || Date.parse(parsed.createdAt) > staleBefore) return false;
      if (!isMissingProcess(parsed.pid)) return false;
    } else {
      // A process can die after O_EXCL creation but before owner metadata is durable.
      // Use a longer grace period before reclaiming malformed or empty locks.
      if (owner.mtimeMs > Date.now() - 5 * 60_000) return false;
    }
    return await unlinkLockIfUnchanged(lockPath, owner.dev, owner.ino);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function unlinkLockIfUnchanged(lockPath: string, device: number, inode: number): Promise<boolean> {
  const current = await lstat(lockPath);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== device || current.ino !== inode) {
    return false;
  }
  await unlink(lockPath);
  return true;
}

function parseLockOwner(contents: string): { pid: number; createdAt: string } | undefined {
  try {
    const value = JSON.parse(contents) as { pid?: unknown; createdAt?: unknown };
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
    return { pid: value.pid as number, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function isMissingProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isFsError(error, "ESRCH");
  }
}

function unsupportedVerifiedFallbackStage(
  rows: Array<{ project: FeedbackProjectInput; entry: FeedbackRecord }>
): FeedbackRecord["stage"] {
  if (rows.some(({ entry }) => entry.stage === "promoted" && entry.promotion)) return "promoted";
  if (new Set(rows.map(({ project }) => project.projectId)).size >= 2) return "recurring";
  return rows.some(({ entry }) => entry.stage === "recurring") ? "recurring" : "observed";
}

function hasVerificationAfterLatestPromotion(
  rows: Array<{ project: FeedbackProjectInput; entry: FeedbackRecord }>
): boolean {
  const latestPromotionAt = rows
    .filter(({ entry }) => entry.stage === "promoted" && entry.promotion)
    .reduce<string | undefined>((latest, { entry }) => (
      latest === undefined || entry.created_at > latest ? entry.created_at : latest
    ), undefined);
  const latestVerificationAt = rows
    .filter(({ entry }) => entry.stage === "verified")
    .reduce<string | undefined>((latest, { entry }) => (
      latest === undefined || entry.created_at > latest ? entry.created_at : latest
    ), undefined);
  return latestPromotionAt !== undefined
    && latestVerificationAt !== undefined
    && latestPromotionAt < latestVerificationAt;
}

async function readBoundedText(
  handle: FileHandle,
  maximumBytes: number
): Promise<{ contents: string; exceeded: boolean }> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    contents: buffer.subarray(0, Math.min(offset, maximumBytes)).toString("utf8"),
    exceeded: offset > maximumBytes
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function compareProjectPath(
  left: { projectName: string; path?: string; target?: string },
  right: { projectName: string; path?: string; target?: string }
): number {
  return left.projectName.localeCompare(right.projectName) || (left.path ?? left.target ?? "").localeCompare(right.path ?? right.target ?? "");
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
