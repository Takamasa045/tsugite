/**
 * RC rollback orchestrator: active → shadow → legacy.
 * Append-only artifacts are never deleted or rewritten.
 * Rollback never auto-runs provider, Gate, billing, or submit.
 * Safety counts come from an EffectLedger when provided — never hardcoded true.
 */
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeJsonValue, sha256Canonical } from "../canonical.js";
import { acquireProductionControlRootLock, pcError } from "../errors.js";
import { resolveCanonicalProductionControlRoot } from "../activeRunGeneration.js";
import {
  evaluateModeTransition,
  resolveRuntimeMode
} from "./modeDiagnostics.js";
import {
  projectRevisionBindings,
  rcRevisionBindingsDigest,
  type RcRuntimeMode
} from "./revisionBindings.js";
import { assertMigrationPathContained } from "./pathSafety.js";
import { appendModeIntent } from "./modeIntent.js";
import type { EffectLedger } from "./effectLedger.js";

export type RollbackRecordV1 = {
  schema_version: 1;
  from_mode: RcRuntimeMode;
  to_mode: "shadow" | "legacy";
  preserved_relative_paths: string[];
  deleted_artifacts: [];
  rewritten_artifacts: [];
  mode_intent_digest?: string;
  safety: {
    provider_submit_count: number | "unknown";
    gate_mutation_count: number | "unknown";
    billing_spend_count: number | "unknown";
    network_fetch_count: number | "unknown";
    ledger_digest?: string;
    /** True only when all instrumented channels are 0; unknown never becomes true. */
    observed_zero_effects: boolean;
  };
  revision_bindings_digest: string;
  actor: string;
  recorded_at: string;
  digest: string;
};

export type RollbackPreviewV1 = {
  schema_version: 1;
  from_mode: RcRuntimeMode;
  to_mode: "shadow" | "legacy";
  allowed: boolean;
  blocked_reasons: string[];
  will_delete: false;
  will_rewrite: false;
  will_auto_execute: false;
  digest: string;
};

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicCreateJson(filePath: string, value: unknown): Promise<void> {
  assertSafeJsonValue(value, filePath);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
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
    const reserve = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await reserve.close();
    await rename(temp, filePath);
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST") {
      throw pcError("PC_ARTIFACT_DUPLICATE", `rollback artifact already exists: ${filePath}`);
    }
    throw error;
  }
}

async function listPreservedRelativePaths(projectRoot: string, controlRoot: string): Promise<string[]> {
  const preserved: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stats;
      try {
        stats = await lstat(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(full);
      } else if (stats.isFile()) {
        preserved.push(relative(projectRoot, full).split(sep).join("/"));
      }
    }
  }
  await walk(controlRoot);
  return preserved.sort();
}

export function previewRollback(input: {
  project: { orchestration?: { mode?: string } } | Record<string, unknown>;
  to_mode: "shadow" | "legacy";
  coordinator?: boolean;
}): RollbackPreviewV1 {
  const from = resolveRuntimeMode(input.project as { orchestration?: { mode?: string } });
  const transition = evaluateModeTransition(from, input.to_mode, {
    coordinator: input.coordinator ?? false
  });
  const blocked: string[] = [];
  if (!transition.allowed) {
    blocked.push(...("blocked_reasons" in transition ? transition.blocked_reasons : ["transition denied"]));
  }
  const body = {
    schema_version: 1 as const,
    from_mode: from,
    to_mode: input.to_mode,
    allowed: blocked.length === 0 && transition.allowed,
    blocked_reasons: blocked,
    will_delete: false as const,
    will_rewrite: false as const,
    will_auto_execute: false as const
  };
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}

export async function applyRollback(input: {
  project: { orchestration?: { mode?: string } } | Record<string, unknown>;
  projectRoot: string;
  to_mode: "shadow" | "legacy";
  actor: string;
  now?: () => string;
  ledger?: EffectLedger;
}): Promise<{ preview: RollbackPreviewV1; record: RollbackRecordV1 }> {
  if (input.actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "rollback apply requires actor=coordinator");
  }
  const preview = previewRollback({
    project: input.project,
    to_mode: input.to_mode,
    coordinator: true
  });
  if (!preview.allowed) {
    throw pcError("PC_CONTRACT_INVALID", `rollback blocked: ${preview.blocked_reasons.join("; ")}`);
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

  input.ledger?.markFixtureInProcessBoundary();
  input.ledger?.recordCall({
    module: "productionControl/rc/rollbackOrchestrator",
    api: "applyRollback",
    result: "ok",
    digests: { preview: preview.digest }
  });

  const modeIntent = await appendModeIntent({
    projectRoot,
    intended_mode: input.to_mode,
    previous_mode: preview.from_mode,
    actor: "coordinator",
    now: input.now
  });

  const rootLock = await acquireProductionControlRootLock(controlRoot);
  try {
    const before = await listPreservedRelativePaths(projectRoot, controlRoot);
    const recordedAt = (input.now ?? (() => new Date().toISOString()))();
    const safetyEvidence = input.ledger?.safetyEvidence();
    const safety = {
      provider_submit_count: safetyEvidence?.provider_submit_count ?? ("unknown" as const),
      gate_mutation_count: safetyEvidence?.gate_mutation_count ?? ("unknown" as const),
      billing_spend_count: safetyEvidence?.billing_spend_count ?? ("unknown" as const),
      network_fetch_count: safetyEvidence?.network_fetch_count ?? ("unknown" as const),
      ...(safetyEvidence ? { ledger_digest: safetyEvidence.digest } : {}),
      observed_zero_effects: input.ledger?.allZeroSafetyChannels() === true
    };

    const recordBody = {
      schema_version: 1 as const,
      from_mode: preview.from_mode,
      to_mode: input.to_mode,
      preserved_relative_paths: before,
      deleted_artifacts: [] as [],
      rewritten_artifacts: [] as [],
      mode_intent_digest: modeIntent.intent.digest,
      safety,
      revision_bindings_digest: rcRevisionBindingsDigest(),
      actor: input.actor,
      recorded_at: recordedAt,
      revision_bindings: projectRevisionBindings()
    };
    const digest = sha256Canonical(recordBody);
    const record: RollbackRecordV1 = {
      schema_version: 1,
      from_mode: recordBody.from_mode,
      to_mode: recordBody.to_mode,
      preserved_relative_paths: recordBody.preserved_relative_paths,
      deleted_artifacts: [],
      rewritten_artifacts: [],
      mode_intent_digest: recordBody.mode_intent_digest,
      safety: recordBody.safety,
      revision_bindings_digest: recordBody.revision_bindings_digest,
      actor: recordBody.actor,
      recorded_at: recordBody.recorded_at,
      digest
    };

    const migrationDir = join(controlRoot, "migration");
    await mkdir(migrationDir, { recursive: true, mode: 0o700 });
    await atomicCreateJson(join(migrationDir, `rollback-${digest.slice(0, 16)}.json`), record);

    const after = await listPreservedRelativePaths(projectRoot, controlRoot);
    for (const path of before) {
      if (!after.includes(path)) {
        throw pcError("PC_RECOVERY_INVALID", `rollback lost preserved path: ${path}`);
      }
    }

    return { preview, record };
  } finally {
    await rootLock.release();
  }
}

/**
 * Legacy readers ignore control-plane paths: they never become Gate subjects
 * or deletion candidates for legacy finalize media cleanup.
 */
export function legacyReaderIgnoresControlPlane(relativePath: string): boolean {
  const portable = relativePath.split("\\").join("/");
  return (
    portable === "production-control"
    || portable.startsWith("production-control/")
    || portable.includes("/production-control/")
    || portable === "coordination"
    || portable.startsWith("coordination/")
  );
}
