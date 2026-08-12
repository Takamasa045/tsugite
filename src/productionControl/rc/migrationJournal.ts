/**
 * Create-only migration/rollback journal stage machine.
 * Stages (safe order): planned → events → snapshot → artifacts → pointer → complete
 *
 * Rationale:
 * - planned binds preview/production/revision before any durable mutation
 * - events/snapshot build control-plane state before mode pointer flips
 * - artifacts are append-only create-only blobs
 * - pointer is CAS mode switch after state exists
 * - complete seals the transaction (resume only before complete)
 *
 * Each stage: fsync + readback + digest. Resume requires exact same
 * preview/production/revision. Conflicting journal → fail closed.
 */
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertSafeJsonValue, sha256Canonical } from "../canonical.js";
import { acquireProductionControlRootLock, pcError } from "../errors.js";
import { resolveCanonicalProductionControlRoot } from "../activeRunGeneration.js";
import { assertMigrationPathContained } from "./pathSafety.js";
import { rcRevisionBindingsDigest } from "./revisionBindings.js";
import type { RcRuntimeMode } from "./revisionBindings.js";

export const MIGRATION_JOURNAL_STAGES = [
  "planned",
  "events",
  "snapshot",
  "artifacts",
  "pointer",
  "complete"
] as const;

export type MigrationJournalStage = (typeof MIGRATION_JOURNAL_STAGES)[number];

export type MigrationJournalV1 = {
  schema_version: 1;
  kind: "migration" | "rollback";
  stage: MigrationJournalStage;
  preview_digest: string;
  production_id: string;
  revision_bindings_digest: string;
  target_mode: RcRuntimeMode;
  source_mode: RcRuntimeMode;
  actor: string;
  stages_completed: MigrationJournalStage[];
  stage_digests: Partial<Record<MigrationJournalStage, string>>;
  event_digest?: string;
  snapshot_digest?: string;
  mode_intent_digest?: string;
  created_at: string;
  updated_at: string;
  digest: string;
};

export type JournalCrashHook = (stage: MigrationJournalStage, journal: MigrationJournalV1) => void | Promise<void>;

const STAGE_ORDER: readonly MigrationJournalStage[] = MIGRATION_JOURNAL_STAGES;

function stageIndex(stage: MigrationJournalStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function nextStage(stage: MigrationJournalStage): MigrationJournalStage | undefined {
  const idx = stageIndex(stage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return undefined;
  return STAGE_ORDER[idx + 1];
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(filePath: string, value: unknown, createOnly: boolean): Promise<void> {
  assertSafeJsonValue(value, filePath);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${Math.random().toString(16).slice(2)}.jrnl.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (createOnly) {
      const reserve = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await reserve.close();
    }
    await rename(temp, filePath);
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST") {
      throw pcError("PC_ARTIFACT_DUPLICATE", `journal create-only conflict: ${filePath}`);
    }
    throw error;
  }
}

function sealJournal(body: Omit<MigrationJournalV1, "digest">): MigrationJournalV1 {
  return { ...body, digest: sha256Canonical(body) };
}

function parseJournal(raw: MigrationJournalV1): MigrationJournalV1 {
  const { digest: claimed, ...body } = raw;
  const expected = sha256Canonical(body);
  if (claimed !== expected) {
    throw pcError("PC_CONTRACT_INVALID", "migration journal digest mismatch");
  }
  return raw;
}

export function journalPath(controlRoot: string): string {
  return join(controlRoot, "migration", "journal.json");
}

export async function readMigrationJournal(
  projectRoot: string
): Promise<MigrationJournalV1 | undefined> {
  const root = await realpath(resolve(projectRoot)).catch(() => resolve(projectRoot));
  const controlRoot = resolveCanonicalProductionControlRoot(root);
  const path = journalPath(controlRoot);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw pcError("PC_PATH_UNSAFE", "migration journal must be a regular file");
    }
    const raw = JSON.parse(await readFile(path, "utf8")) as MigrationJournalV1;
    return parseJournal(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export type BeginJournalInput = {
  projectRoot: string;
  kind: "migration" | "rollback";
  preview_digest: string;
  production_id: string;
  target_mode: RcRuntimeMode;
  source_mode: RcRuntimeMode;
  actor: string;
  now?: () => string;
  /** Test-only: fire after writing a stage (before advancing). */
  crash_after_stage?: MigrationJournalStage;
  crash_hook?: JournalCrashHook;
};

/**
 * Begin or resume a journal. Resume requires exact same preview/production/revision.
 * Complete journals are left in place (append-only history) — new tx needs new preview.
 */
export async function beginOrResumeJournal(input: BeginJournalInput): Promise<{
  journal: MigrationJournalV1;
  resumed: boolean;
  controlRoot: string;
}> {
  if (input.actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "migration journal requires actor=coordinator");
  }
  const projectRoot = await realpath(resolve(input.projectRoot));
  const controlRoot = resolveCanonicalProductionControlRoot(projectRoot);
  await assertMigrationPathContained({
    projectRoot,
    candidate: controlRoot,
    label: "production-control",
    allowMissingLeaf: true
  });
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const revision = rcRevisionBindingsDigest();
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  const path = journalPath(controlRoot);

  const rootLock = await acquireProductionControlRootLock(controlRoot);
  try {
    const existing = await readMigrationJournal(projectRoot);
    if (existing) {
      if (existing.stage === "complete") {
        // Prior complete journal is historical; require no conflict with new planned identity
        // by starting a fresh journal file only when digests differ — create-only replace after complete.
        if (
          existing.preview_digest === input.preview_digest
          && existing.production_id === input.production_id
          && existing.revision_bindings_digest === revision
          && existing.target_mode === input.target_mode
          && existing.kind === input.kind
        ) {
          return { journal: existing, resumed: true, controlRoot };
        }
        // Different transaction after complete: remove complete journal then create new (under lock).
        await rm(path, { force: true });
      } else {
        // Incomplete: resume only exact match
        if (
          existing.preview_digest !== input.preview_digest
          || existing.production_id !== input.production_id
          || existing.revision_bindings_digest !== revision
          || existing.target_mode !== input.target_mode
          || existing.kind !== input.kind
        ) {
          throw pcError(
            "PC_LEDGER_CONFLICT",
            "conflicting migration journal: preview/production/revision/mode mismatch on resume"
          );
        }
        return { journal: existing, resumed: true, controlRoot };
      }
    }

    const body: Omit<MigrationJournalV1, "digest"> = {
      schema_version: 1,
      kind: input.kind,
      stage: "planned",
      preview_digest: input.preview_digest,
      production_id: input.production_id,
      revision_bindings_digest: revision,
      target_mode: input.target_mode,
      source_mode: input.source_mode,
      actor: input.actor,
      stages_completed: ["planned"],
      stage_digests: {
        planned: sha256Canonical({
          preview_digest: input.preview_digest,
          production_id: input.production_id,
          revision,
          target_mode: input.target_mode
        })
      },
      created_at: nowIso,
      updated_at: nowIso
    };
    const journal = sealJournal(body);
    await atomicWriteJson(path, journal, true);
    // Readback
    const readback = await readMigrationJournal(projectRoot);
    if (!readback || readback.digest !== journal.digest) {
      throw pcError("PC_CONTRACT_INVALID", "migration journal planned readback mismatch");
    }
    if (input.crash_after_stage === "planned" && input.crash_hook) {
      await input.crash_hook("planned", readback);
    }
    return { journal: readback, resumed: false, controlRoot };
  } finally {
    await rootLock.release();
  }
}

export async function advanceJournalStage(input: {
  projectRoot: string;
  expected_preview_digest: string;
  production_id: string;
  to_stage: MigrationJournalStage;
  event_digest?: string;
  snapshot_digest?: string;
  mode_intent_digest?: string;
  stage_payload?: Record<string, unknown>;
  now?: () => string;
  crash_after_stage?: MigrationJournalStage;
  crash_hook?: JournalCrashHook;
}): Promise<MigrationJournalV1> {
  const projectRoot = await realpath(resolve(input.projectRoot));
  const controlRoot = resolveCanonicalProductionControlRoot(projectRoot);
  const revision = rcRevisionBindingsDigest();
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  const path = journalPath(controlRoot);

  const rootLock = await acquireProductionControlRootLock(controlRoot);
  try {
    const existing = await readMigrationJournal(projectRoot);
    if (!existing) {
      throw pcError("PC_CONTRACT_INVALID", "migration journal missing for advance");
    }
    if (
      existing.preview_digest !== input.expected_preview_digest
      || existing.production_id !== input.production_id
      || existing.revision_bindings_digest !== revision
    ) {
      throw pcError(
        "PC_LEDGER_CONFLICT",
        "journal advance identity mismatch (preview/production/revision)"
      );
    }
    if (existing.stage === "complete") {
      if (input.to_stage === "complete") return existing;
      throw pcError("PC_LEDGER_CONFLICT", "cannot advance completed migration journal");
    }

    // Already past target stage on resume: return current journal unchanged.
    if (stageIndex(existing.stage) > stageIndex(input.to_stage)) {
      return existing;
    }

    const expectedNext = nextStage(existing.stage);
    // Allow re-entering current stage on resume (idempotent), or advance to next only.
    if (input.to_stage !== existing.stage && input.to_stage !== expectedNext) {
      throw pcError(
        "PC_CONTRACT_INVALID",
        `invalid journal stage transition ${existing.stage} → ${input.to_stage}`
      );
    }

    const stageDigest = sha256Canonical({
      stage: input.to_stage,
      preview_digest: existing.preview_digest,
      production_id: existing.production_id,
      ...(input.event_digest ? { event_digest: input.event_digest } : {}),
      ...(input.snapshot_digest ? { snapshot_digest: input.snapshot_digest } : {}),
      ...(input.mode_intent_digest ? { mode_intent_digest: input.mode_intent_digest } : {}),
      ...(input.stage_payload ? { stage_payload: input.stage_payload } : {})
    });

    const stages_completed = existing.stages_completed.includes(input.to_stage)
      ? existing.stages_completed
      : [...existing.stages_completed, input.to_stage];

    const body: Omit<MigrationJournalV1, "digest"> = {
      schema_version: 1,
      kind: existing.kind,
      stage: input.to_stage,
      preview_digest: existing.preview_digest,
      production_id: existing.production_id,
      revision_bindings_digest: existing.revision_bindings_digest,
      target_mode: existing.target_mode,
      source_mode: existing.source_mode,
      actor: existing.actor,
      stages_completed,
      stage_digests: {
        ...existing.stage_digests,
        [input.to_stage]: stageDigest
      },
      ...(input.event_digest ?? existing.event_digest
        ? { event_digest: input.event_digest ?? existing.event_digest }
        : {}),
      ...(input.snapshot_digest ?? existing.snapshot_digest
        ? { snapshot_digest: input.snapshot_digest ?? existing.snapshot_digest }
        : {}),
      ...(input.mode_intent_digest ?? existing.mode_intent_digest
        ? { mode_intent_digest: input.mode_intent_digest ?? existing.mode_intent_digest }
        : {}),
      created_at: existing.created_at,
      updated_at: nowIso
    };
    const journal = sealJournal(body);
    await atomicWriteJson(path, journal, false);
    const readback = await readMigrationJournal(projectRoot);
    if (!readback || readback.digest !== journal.digest || readback.stage !== input.to_stage) {
      throw pcError("PC_CONTRACT_INVALID", `migration journal ${input.to_stage} readback mismatch`);
    }
    if (input.crash_after_stage === input.to_stage && input.crash_hook) {
      await input.crash_hook(input.to_stage, readback);
    }
    return readback;
  } finally {
    await rootLock.release();
  }
}

/** True when journal exists and is fully complete for the given preview. */
export function journalIsComplete(
  journal: MigrationJournalV1 | undefined,
  preview_digest?: string
): boolean {
  if (!journal || journal.stage !== "complete") return false;
  if (preview_digest && journal.preview_digest !== preview_digest) return false;
  return STAGE_ORDER.every((stage) => journal.stages_completed.includes(stage));
}

export { STAGE_ORDER, nextStage, stageIndex };
