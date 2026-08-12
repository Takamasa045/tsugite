/**
 * Durable production-control mode intent (append-only) + current-mode pointer.
 * project.yaml is never rewritten. Active readers prefer durable SoT when present.
 * Pointer updates use expected previous intent digest CAS + root lock + readback.
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
import { dirname, join, resolve, sep } from "node:path";
import { assertSafeJsonValue, sha256Canonical } from "../canonical.js";
import { acquireProductionControlRootLock, pcError } from "../errors.js";
import { resolveCanonicalProductionControlRoot } from "../activeRunGeneration.js";
import { assertMigrationPathContained } from "./pathSafety.js";
import { projectRevisionBindings, rcRevisionBindingsDigest, type RcRuntimeMode } from "./revisionBindings.js";
import { resolveRuntimeMode, toRuntimeMode } from "./modeDiagnostics.js";

export type ModeIntentV1 = {
  schema_version: 1;
  intended_mode: RcRuntimeMode;
  previous_mode: RcRuntimeMode;
  production_id?: string;
  preview_digest?: string;
  apply_digest?: string;
  actor: string;
  recorded_at: string;
  no_source_project_rewrite: true;
  revision_bindings_digest: string;
  previous_intent_digest?: string;
  digest: string;
};

export type CurrentModePointerV1 = {
  schema_version: 1;
  runtime_mode: RcRuntimeMode;
  intent_digest: string;
  intent_relative_path: string;
  production_id?: string;
  revision_bindings_digest: string;
  previous_intent_digest?: string;
  updated_at: string;
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

async function atomicCreateOnlyJson(filePath: string, value: unknown): Promise<void> {
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
      throw pcError("PC_ARTIFACT_DUPLICATE", `mode intent artifact already exists: ${filePath}`);
    }
    throw error;
  }
}

/** Replace pointer via create-temp + rename (pointer is not append-only; intents are). */
async function atomicReplaceJson(filePath: string, value: unknown): Promise<void> {
  assertSafeJsonValue(value, filePath);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${Math.random().toString(16).slice(2)}.ptr.tmp`);
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
    await rename(temp, filePath);
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function modeDir(controlRoot: string): string {
  return join(controlRoot, "mode");
}

function parsePointer(raw: CurrentModePointerV1): CurrentModePointerV1 {
  const { digest: claimed, ...body } = raw;
  const expected = sha256Canonical(body);
  if (claimed !== expected) {
    throw pcError("PC_CONTRACT_INVALID", "current-mode pointer digest mismatch");
  }
  return raw;
}

export async function readCurrentModePointer(
  projectRoot: string
): Promise<CurrentModePointerV1 | undefined> {
  const root = await realpath(resolve(projectRoot)).catch(() => resolve(projectRoot));
  const controlRoot = resolveCanonicalProductionControlRoot(root);
  const pointerPath = join(modeDir(controlRoot), "current-mode.json");
  try {
    const stat = await lstat(pointerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw pcError("PC_PATH_UNSAFE", "current-mode pointer must be a regular file");
    }
    const raw = JSON.parse(await readFile(pointerPath, "utf8")) as CurrentModePointerV1;
    return parsePointer(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function appendModeIntent(input: {
  projectRoot: string;
  intended_mode: RcRuntimeMode;
  previous_mode: RcRuntimeMode;
  actor: string;
  production_id?: string;
  preview_digest?: string;
  apply_digest?: string;
  /**
   * CAS: when a current pointer exists, must equal pointer.intent_digest.
   * Omit only when no pointer exists yet (first intent).
   */
  expected_previous_intent_digest?: string;
  now?: () => string;
}): Promise<{ intent: ModeIntentV1; pointer: CurrentModePointerV1; relative_paths: string[] }> {
  if (input.actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "mode intent requires actor=coordinator");
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
  const rootLock = await acquireProductionControlRootLock(controlRoot);
  try {
    const existing = await readCurrentModePointer(projectRoot);
    if (existing) {
      if (!input.expected_previous_intent_digest) {
        throw pcError(
          "PC_LEDGER_CONFLICT",
          "mode pointer CAS requires expected_previous_intent_digest when pointer exists"
        );
      }
      if (input.expected_previous_intent_digest !== existing.intent_digest) {
        throw pcError(
          "PC_LEDGER_CONFLICT",
          "mode pointer CAS mismatch: expected previous intent digest does not match current pointer"
        );
      }
    } else if (
      input.expected_previous_intent_digest !== undefined
      && input.expected_previous_intent_digest !== ""
    ) {
      throw pcError(
        "PC_LEDGER_CONFLICT",
        "mode pointer CAS: expected previous intent but pointer is absent"
      );
    }

    const recordedAt = (input.now ?? (() => new Date().toISOString()))();
    const revision_bindings_digest = rcRevisionBindingsDigest();
    const intentBody = {
      schema_version: 1 as const,
      intended_mode: input.intended_mode,
      previous_mode: input.previous_mode,
      ...(input.production_id ? { production_id: input.production_id } : {}),
      ...(input.preview_digest ? { preview_digest: input.preview_digest } : {}),
      ...(input.apply_digest ? { apply_digest: input.apply_digest } : {}),
      actor: input.actor,
      recorded_at: recordedAt,
      no_source_project_rewrite: true as const,
      revision_bindings_digest,
      ...(existing ? { previous_intent_digest: existing.intent_digest } : {}),
      revision_bindings: projectRevisionBindings()
    };
    const digest = sha256Canonical(intentBody);
    const intent: ModeIntentV1 = {
      schema_version: 1,
      intended_mode: intentBody.intended_mode,
      previous_mode: intentBody.previous_mode,
      ...(intentBody.production_id ? { production_id: intentBody.production_id } : {}),
      ...(intentBody.preview_digest ? { preview_digest: intentBody.preview_digest } : {}),
      ...(intentBody.apply_digest ? { apply_digest: intentBody.apply_digest } : {}),
      actor: intentBody.actor,
      recorded_at: intentBody.recorded_at,
      no_source_project_rewrite: true,
      revision_bindings_digest: intentBody.revision_bindings_digest,
      ...(intentBody.previous_intent_digest
        ? { previous_intent_digest: intentBody.previous_intent_digest }
        : {}),
      digest
    };
    const dir = modeDir(controlRoot);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const intentRel = `production-control/mode/intent-${digest.slice(0, 16)}.json`;
    const intentPath = join(dir, `intent-${digest.slice(0, 16)}.json`);
    await atomicCreateOnlyJson(intentPath, intent);

    const pointerBody = {
      schema_version: 1 as const,
      runtime_mode: input.intended_mode,
      intent_digest: digest,
      intent_relative_path: intentRel,
      ...(input.production_id ? { production_id: input.production_id } : {}),
      revision_bindings_digest,
      ...(existing ? { previous_intent_digest: existing.intent_digest } : {}),
      updated_at: recordedAt
    };
    const pointer: CurrentModePointerV1 = {
      ...pointerBody,
      digest: sha256Canonical(pointerBody)
    };
    const pointerPath = join(dir, "current-mode.json");
    await atomicReplaceJson(pointerPath, pointer);

    // Readback: re-read pointer and require exact match
    const readback = await readCurrentModePointer(projectRoot);
    if (!readback || readback.digest !== pointer.digest || readback.intent_digest !== digest) {
      throw pcError("PC_CONTRACT_INVALID", "mode pointer readback mismatch after CAS update");
    }

    return {
      intent,
      pointer: readback,
      relative_paths: [
        intentRel,
        "production-control/mode/current-mode.json"
      ].map((path) => path.split(sep).join("/"))
    };
  } finally {
    await rootLock.release();
  }
}

export type RuntimeModeResolution = {
  runtime_mode: RcRuntimeMode;
  source: "durable_pointer" | "project_yaml" | "default_legacy";
  pointer?: CurrentModePointerV1;
  yaml_mode?: RcRuntimeMode;
  production_id?: string;
  revision_bindings_digest?: string;
  /** Fail-closed mismatches (empty when ok). */
  mismatches: string[];
};

/**
 * Common runtime mode resolver for project loader / validate / plan / review / run --dry-run.
 * - Pointer complete absence only → YAML / legacy fallback.
 * - Pointer present is authoritative for active/shadow exact mode.
 * - YAML vs pointer production_id / revision_bindings_digest mismatch → fail-closed.
 */
export async function resolveProjectRuntimeMode(input: {
  projectRoot?: string;
  project?: { orchestration?: { mode?: string }; slug?: string; run_id?: string } | Record<string, unknown>;
  production_id?: string;
}): Promise<RuntimeModeResolution> {
  const mismatches: string[] = [];
  let yaml_mode: RcRuntimeMode | undefined;
  if (input.project) {
    try {
      yaml_mode = resolveRuntimeMode(input.project as { orchestration?: { mode?: string } });
    } catch (error) {
      throw error;
    }
  }

  if (input.projectRoot) {
    const pointer = await readCurrentModePointer(input.projectRoot);
    if (pointer) {
      const liveBindings = rcRevisionBindingsDigest();
      if (pointer.revision_bindings_digest && pointer.revision_bindings_digest !== liveBindings) {
        mismatches.push(
          `pointer revision_bindings_digest ${pointer.revision_bindings_digest.slice(0, 12)}… differs from live ${liveBindings.slice(0, 12)}…`
        );
      }
      if (
        input.production_id
        && pointer.production_id
        && pointer.production_id !== input.production_id
      ) {
        mismatches.push(
          `pointer production_id ${pointer.production_id} differs from expected ${input.production_id}`
        );
      }
      // YAML non-legacy that disagrees with pointer is fail-closed (not silent override).
      if (
        yaml_mode
        && yaml_mode !== "legacy"
        && yaml_mode !== pointer.runtime_mode
      ) {
        mismatches.push(
          `durable mode ${pointer.runtime_mode} differs from project.yaml mode ${yaml_mode}`
        );
      }
      if (mismatches.length > 0) {
        throw pcError(
          "PC_MODE_UNSAFE_UNKNOWN",
          `runtime mode authority mismatch: ${mismatches.join("; ")}`
        );
      }
      return {
        runtime_mode: pointer.runtime_mode,
        source: "durable_pointer",
        pointer,
        yaml_mode,
        production_id: pointer.production_id,
        revision_bindings_digest: pointer.revision_bindings_digest,
        mismatches: []
      };
    }
  }

  if (yaml_mode) {
    return {
      runtime_mode: yaml_mode,
      source: yaml_mode === "legacy" ? "default_legacy" : "project_yaml",
      yaml_mode,
      production_id: input.production_id,
      mismatches: []
    };
  }
  return {
    runtime_mode: "legacy",
    source: "default_legacy",
    mismatches: []
  };
}

/**
 * Resolve runtime mode: durable current-mode pointer is authoritative when present;
 * otherwise project.yaml orchestration.mode (legacy default when unspecified).
 * @deprecated Prefer resolveProjectRuntimeMode for fail-closed authority checks.
 */
export async function resolveDurableRuntimeMode(input: {
  projectRoot?: string;
  project_mode?: RcRuntimeMode;
}): Promise<{
  runtime_mode: RcRuntimeMode;
  source: "durable_pointer" | "project_yaml" | "default_legacy";
  pointer?: CurrentModePointerV1;
}> {
  const resolved = await resolveProjectRuntimeMode({
    projectRoot: input.projectRoot,
    project: input.project_mode
      ? { orchestration: { mode: input.project_mode === "legacy" ? "disabled" : input.project_mode } }
      : undefined
  });
  return {
    runtime_mode: resolved.runtime_mode,
    source: resolved.source,
    ...(resolved.pointer ? { pointer: resolved.pointer } : {})
  };
}

export { toRuntimeMode };
