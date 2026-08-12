/**
 * Durable production-control mode intent (append-only) + current-mode pointer.
 * project.yaml is never rewritten. Active readers prefer durable SoT when present.
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

export type ModeIntentV1 = {
  schema_version: 1;
  intended_mode: RcRuntimeMode;
  previous_mode: RcRuntimeMode;
  preview_digest?: string;
  apply_digest?: string;
  actor: string;
  recorded_at: string;
  no_source_project_rewrite: true;
  revision_bindings_digest: string;
  digest: string;
};

export type CurrentModePointerV1 = {
  schema_version: 1;
  runtime_mode: RcRuntimeMode;
  intent_digest: string;
  intent_relative_path: string;
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
    const { digest: claimed, ...body } = raw;
    const expected = sha256Canonical(body);
    if (claimed !== expected) {
      throw pcError("PC_CONTRACT_INVALID", "current-mode pointer digest mismatch");
    }
    return raw;
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
  preview_digest?: string;
  apply_digest?: string;
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
    const recordedAt = (input.now ?? (() => new Date().toISOString()))();
    const intentBody = {
      schema_version: 1 as const,
      intended_mode: input.intended_mode,
      previous_mode: input.previous_mode,
      ...(input.preview_digest ? { preview_digest: input.preview_digest } : {}),
      ...(input.apply_digest ? { apply_digest: input.apply_digest } : {}),
      actor: input.actor,
      recorded_at: recordedAt,
      no_source_project_rewrite: true as const,
      revision_bindings_digest: rcRevisionBindingsDigest(),
      revision_bindings: projectRevisionBindings()
    };
    const digest = sha256Canonical(intentBody);
    const intent: ModeIntentV1 = {
      schema_version: 1,
      intended_mode: intentBody.intended_mode,
      previous_mode: intentBody.previous_mode,
      ...(intentBody.preview_digest ? { preview_digest: intentBody.preview_digest } : {}),
      ...(intentBody.apply_digest ? { apply_digest: intentBody.apply_digest } : {}),
      actor: intentBody.actor,
      recorded_at: intentBody.recorded_at,
      no_source_project_rewrite: true,
      revision_bindings_digest: intentBody.revision_bindings_digest,
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
      updated_at: recordedAt
    };
    const pointer: CurrentModePointerV1 = {
      ...pointerBody,
      digest: sha256Canonical(pointerBody)
    };
    await atomicReplaceJson(join(dir, "current-mode.json"), pointer);

    return {
      intent,
      pointer,
      relative_paths: [
        intentRel,
        "production-control/mode/current-mode.json"
      ].map((path) => path.split(sep).join("/"))
    };
  } finally {
    await rootLock.release();
  }
}

/**
 * Resolve runtime mode: durable current-mode pointer is authoritative when present;
 * otherwise project.yaml orchestration.mode (legacy default when unspecified).
 */
export async function resolveDurableRuntimeMode(input: {
  projectRoot?: string;
  project_mode?: RcRuntimeMode;
}): Promise<{
  runtime_mode: RcRuntimeMode;
  source: "durable_pointer" | "project_yaml" | "default_legacy";
  pointer?: CurrentModePointerV1;
}> {
  if (input.projectRoot) {
    const pointer = await readCurrentModePointer(input.projectRoot);
    if (pointer) {
      return { runtime_mode: pointer.runtime_mode, source: "durable_pointer", pointer };
    }
  }
  if (input.project_mode) {
    return { runtime_mode: input.project_mode, source: "project_yaml" };
  }
  return { runtime_mode: "legacy", source: "default_legacy" };
}
