import { lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Issue } from "../types.js";
import {
  FinalizePersistenceError,
  captureDirectoryIdentity,
  hasSymlinkAlongPath,
  readContainedRegularFileText,
  unlinkContainedRegularFile,
  writeAtomicRegularFile
} from "./finalizePersistence.js";

/** Project-local phase journal root under the approved state directory. */
export const JOURNAL_DIR_NAME = ".tsugite-finalize-journal";

export type FinalizeFileIdentity = {
  path: string;
  size: number;
  mtimeMs: number;
  device: number;
  inode: number;
};

export type FinalizeJournalPhase =
  | "planned"
  | "quarantining"
  | "quarantined"
  | "promoting"
  | "promoted"
  | "recording"
  | "recorded"
  | "deleting"
  | "completed";

export const FINALIZE_JOURNAL_PHASES = new Set<FinalizeJournalPhase>([
  "planned",
  "quarantining",
  "quarantined",
  "promoting",
  "promoted",
  "recording",
  "recorded",
  "deleting",
  "completed"
]);

export type FinalizeJournalCandidate = {
  original_path: string;
  original_relative: string;
  quarantine_path?: string;
  identity: FinalizeFileIdentity;
  permanently_deleted: boolean;
  /**
   * Write-ahead flag: permanent unlink of the quarantined file is intentional and
   * may already have happened when permanently_deleted is still false after a crash.
   */
  delete_intent?: boolean;
};

export type FinalizeJournal = {
  schema_version: 1;
  run_id: string;
  plan_digest: string;
  phase: FinalizeJournalPhase;
  quarantine_root: string;
  candidates: FinalizeJournalCandidate[];
  deleted_files: number;
  deleted_bytes: number;
  deleted_paths: string[];
  created_at: string;
  updated_at: string;
  /**
   * Snapshot of the source-tree completion-record.json before the provisional write.
   * `null` means no prior source record existed; a string is the exact prior file text.
   * Omitted only on legacy journals written before this field existed.
   */
  previous_completion_record?: string | null;
  /**
   * Snapshot of the durable-home completion-record.json before promotion/provisional write.
   * Kept separate from the source snapshot so rollback restores each boundary correctly.
   * `null` means no prior durable record existed; omitted on legacy journals and when
   * source and durable paths are the same (already-home).
   */
  previous_durable_completion_record?: string | null;
};

export type FinalizeJournalLoadResult =
  | { status: "missing" }
  | { status: "invalid"; issues: Issue[] }
  | { status: "ok"; journal: FinalizeJournal };

export function finalizeJournalPath(stateDir: string, runId: string): string {
  return join(stateDir, JOURNAL_DIR_NAME, `${runId}.json`);
}

/**
 * Load a structurally valid finalize journal, or undefined when missing/invalid.
 * Path containment is enforced separately during recovery.
 */
export async function readFinalizeJournal(
  stateDir: string,
  runId: string
): Promise<FinalizeJournal | undefined> {
  const loaded = await loadFinalizeJournalSchema(stateDir, runId);
  return loaded.status === "ok" ? loaded.journal : undefined;
}

export async function loadFinalizeJournalSchema(
  stateDir: string,
  runId: string
): Promise<FinalizeJournalLoadResult> {
  const path = finalizeJournalPath(stateDir, runId);
  const boundary = resolve(stateDir);
  const read = await readContainedRegularFileText({
    path,
    containWithin: boundary
  });
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "unsafe") {
    // Fail closed: never treat symlink/escape paths as a recoverable journal.
    return {
      status: "invalid",
      issues: [{
        code: "finalize.journal_path_unsafe",
        message: read.message,
        path: read.path
      }]
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch (error) {
    return {
      status: "invalid",
      issues: [{
        code: "finalize.journal_invalid",
        message: errorMessageOr(error, "finalize journal is not valid JSON"),
        path
      }]
    };
  }

  const parsed = parseFinalizeJournalSchema(raw, runId, path);
  if (!parsed.ok) return { status: "invalid", issues: parsed.issues };
  return { status: "ok", journal: parsed.journal };
}

export function parseFinalizeJournalSchema(
  raw: unknown,
  runId: string,
  journalPath: string
): { ok: true; journal: FinalizeJournal } | { ok: false; issues: Issue[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal root must be an object",
        path: journalPath
      }]
    };
  }
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal schema_version must be 1",
        path: journalPath
      }]
    };
  }
  if (value.run_id !== runId || typeof value.run_id !== "string") {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal run_id does not match the selected run",
        path: journalPath
      }]
    };
  }
  if (typeof value.plan_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.plan_digest)) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal plan_digest must be a 64-char hex digest",
        path: journalPath
      }]
    };
  }
  if (typeof value.phase !== "string" || !FINALIZE_JOURNAL_PHASES.has(value.phase as FinalizeJournalPhase)) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal phase is unknown or missing",
        path: journalPath
      }]
    };
  }
  if (typeof value.quarantine_root !== "string" || value.quarantine_root.length === 0) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal quarantine_root must be a non-empty string",
        path: journalPath
      }]
    };
  }
  if (!Array.isArray(value.candidates)) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal candidates must be an array",
        path: journalPath
      }]
    };
  }
  if (
    typeof value.deleted_files !== "number"
    || !Number.isInteger(value.deleted_files)
    || value.deleted_files < 0
    || typeof value.deleted_bytes !== "number"
    || !Number.isFinite(value.deleted_bytes)
    || value.deleted_bytes < 0
    || !Array.isArray(value.deleted_paths)
    || value.deleted_paths.some((entry) => typeof entry !== "string")
    || typeof value.created_at !== "string"
    || typeof value.updated_at !== "string"
  ) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal measured progress fields are invalid",
        path: journalPath
      }]
    };
  }
  if (
    value.previous_completion_record !== undefined
    && value.previous_completion_record !== null
    && typeof value.previous_completion_record !== "string"
  ) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal previous_completion_record must be string, null, or omitted",
        path: journalPath
      }]
    };
  }
  if (
    value.previous_durable_completion_record !== undefined
    && value.previous_durable_completion_record !== null
    && typeof value.previous_durable_completion_record !== "string"
  ) {
    return {
      ok: false,
      issues: [{
        code: "finalize.journal_invalid",
        message: "finalize journal previous_durable_completion_record must be string, null, or omitted",
        path: journalPath
      }]
    };
  }

  const candidates: FinalizeJournalCandidate[] = [];
  for (const [index, entry] of value.candidates.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        issues: [{
          code: "finalize.journal_invalid",
          message: `finalize journal candidate[${index}] must be an object`,
          path: journalPath
        }]
      };
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.original_path !== "string"
      || typeof candidate.original_relative !== "string"
      || typeof candidate.permanently_deleted !== "boolean"
      || (candidate.quarantine_path !== undefined && typeof candidate.quarantine_path !== "string")
      || (candidate.delete_intent !== undefined && typeof candidate.delete_intent !== "boolean")
      || !candidate.identity
      || typeof candidate.identity !== "object"
      || Array.isArray(candidate.identity)
    ) {
      return {
        ok: false,
        issues: [{
          code: "finalize.journal_invalid",
          message: `finalize journal candidate[${index}] has invalid fields`,
          path: journalPath
        }]
      };
    }
    const identity = candidate.identity as Record<string, unknown>;
    if (
      typeof identity.path !== "string"
      || typeof identity.size !== "number"
      || !Number.isFinite(identity.size)
      || typeof identity.mtimeMs !== "number"
      || !Number.isFinite(identity.mtimeMs)
      || typeof identity.device !== "number"
      || !Number.isFinite(identity.device)
      || typeof identity.inode !== "number"
      || !Number.isFinite(identity.inode)
    ) {
      return {
        ok: false,
        issues: [{
          code: "finalize.journal_invalid",
          message: `finalize journal candidate[${index}] identity is invalid`,
          path: journalPath
        }]
      };
    }
    candidates.push({
      original_path: candidate.original_path,
      original_relative: candidate.original_relative,
      quarantine_path: typeof candidate.quarantine_path === "string"
        ? candidate.quarantine_path
        : undefined,
      permanently_deleted: candidate.permanently_deleted,
      delete_intent: candidate.delete_intent === true ? true : candidate.delete_intent === false ? false : undefined,
      identity: {
        path: identity.path,
        size: identity.size,
        mtimeMs: identity.mtimeMs,
        device: identity.device,
        inode: identity.inode
      }
    });
  }

  return {
    ok: true,
    journal: {
      schema_version: 1,
      run_id: value.run_id,
      plan_digest: value.plan_digest,
      phase: value.phase as FinalizeJournalPhase,
      quarantine_root: value.quarantine_root,
      candidates,
      deleted_files: value.deleted_files,
      deleted_bytes: value.deleted_bytes,
      deleted_paths: value.deleted_paths as string[],
      created_at: value.created_at,
      updated_at: value.updated_at,
      previous_completion_record: value.previous_completion_record as string | null | undefined,
      previous_durable_completion_record:
        value.previous_durable_completion_record as string | null | undefined
    }
  };
}

/**
 * Persist a finalize journal atomically (temp + rename + fsync), then optionally invoke hooks.
 * When `assign` is provided it runs after the durable write and before hooks so a hook throw
 * cannot leave the caller's in-memory journal behind the on-disk write-ahead state.
 */
export async function writeFinalizeJournal(input: {
  stateDir: string;
  runId: string;
  journal: FinalizeJournal;
  containWithin?: string;
  afterPhase?: (phase: FinalizeJournalPhase, journal: FinalizeJournal) => Promise<void>;
  assign?: (journal: FinalizeJournal) => void;
}): Promise<FinalizeJournal> {
  const path = finalizeJournalPath(input.stateDir, input.runId);
  await mkdir(dirname(path), { recursive: true });
  const journal = {
    ...input.journal,
    updated_at: input.journal.updated_at
  };
  await writeAtomicRegularFile({
    path,
    contents: `${JSON.stringify(journal, null, 2)}\n`,
    containWithin: input.containWithin ?? resolve(input.stateDir)
  });
  input.assign?.(journal);
  if (input.afterPhase) {
    await input.afterPhase(journal.phase, journal);
  }
  return journal;
}

export async function updateFinalizeJournalPhase(input: {
  stateDir: string;
  journal: FinalizeJournal;
  phase: FinalizeJournalPhase;
  containWithin?: string;
  afterPhase?: (phase: FinalizeJournalPhase, journal: FinalizeJournal) => Promise<void>;
  assign?: (journal: FinalizeJournal) => void;
}): Promise<FinalizeJournal> {
  return writeFinalizeJournal({
    stateDir: input.stateDir,
    runId: input.journal.run_id,
    journal: {
      ...input.journal,
      phase: input.phase,
      updated_at: new Date().toISOString()
    },
    containWithin: input.containWithin,
    afterPhase: input.afterPhase,
    assign: input.assign
  });
}

/**
 * Remove a finalize journal only when the path stays inside stateDir without symlink
 * ancestors or a leaf symlink. Re-checks boundary identity immediately before unlink.
 * Unsafe paths are left untouched (never follow external journal targets).
 */
export async function clearFinalizeJournal(stateDir: string, runId: string): Promise<void> {
  const boundary = resolve(stateDir);
  const path = finalizeJournalPath(stateDir, runId);
  let boundaryBefore;
  try {
    boundaryBefore = await captureDirectoryIdentity(boundary);
  } catch {
    // stateDir missing/symlink/replaced: refuse all mutation.
    return;
  }

  try {
    const boundaryAfter = await captureDirectoryIdentity(boundary);
    if (
      boundaryAfter.device !== boundaryBefore.device
      || boundaryAfter.inode !== boundaryBefore.inode
      || boundaryAfter.realPath !== boundaryBefore.realPath
    ) {
      return;
    }
    await unlinkContainedRegularFile({
      path,
      containWithin: boundary
    });
  } catch (error) {
    // Prefer leaving an orphan journal over deleting through a substituted path.
    if (!(error instanceof FinalizePersistenceError)) throw error;
    return;
  }

  const dir = join(stateDir, JOURNAL_DIR_NAME);
  try {
    const boundaryForDir = await captureDirectoryIdentity(boundary);
    if (
      boundaryForDir.device !== boundaryBefore.device
      || boundaryForDir.inode !== boundaryBefore.inode
      || boundaryForDir.realPath !== boundaryBefore.realPath
    ) {
      return;
    }
    if (await hasSymlinkAlongPath(boundary, dir)) return;
    const dirStats = await lstat(dir);
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) return;
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  } catch {
    // ignore non-empty / missing / unsafe journal dirs
  }
}

function errorMessageOr(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}
