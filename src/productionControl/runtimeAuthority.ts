/**
 * Production runtime authority resolution (async, circular-import safe).
 * Resolved once at project validation/load; never mixed into authoring YAML or Gate digests.
 * CLI main entries must reuse the same resolved context.
 */
import { dirname, resolve } from "node:path";
import {
  readCurrentModePointer,
  resolveProjectRuntimeMode,
  type CurrentModePointerV1,
  type RuntimeModeResolution
} from "./rc/modeIntent.js";
import type { RcRuntimeMode } from "./rc/revisionBindings.js";
import { rcRevisionBindingsDigest } from "./rc/revisionBindings.js";
import { pcError } from "./errors.js";
import type { EffectPolicy } from "./rc/effectCapability.js";

/** Internal non-authoring runtime context carried on ValidateProjectResult. */
export type ResolvedRuntimeAuthority = {
  schema_version: 1;
  runtime_mode: RcRuntimeMode;
  source: RuntimeModeResolution["source"];
  intent_digest?: string;
  revision_bindings_digest: string;
  production_id?: string;
  pointer?: CurrentModePointerV1;
  yaml_mode?: RcRuntimeMode;
  /** True when pointer was completely absent and YAML/legacy fallback applied. */
  pointer_absent: boolean;
};

export type ProjectRuntimeContext = {
  runtime_authority: ResolvedRuntimeAuthority;
  /** Optional RC/fixture effect policy (deny+record). Production default: undefined. */
  effect_policy?: EffectPolicy;
};

/**
 * Resolve durable pointer + YAML once for validate/plan/review/run/render/finalize/recover/gate.
 * - Pointer present → authoritative (YAML non-legacy mismatch fails).
 * - Pointer complete absence only → YAML/legacy.
 * - production_id / revision_bindings mismatch fails closed.
 */
export async function resolveRuntimeAuthority(input: {
  projectRoot?: string;
  configPath?: string;
  project?: { orchestration?: { mode?: string }; slug?: string; run_id?: string } | Record<string, unknown>;
  production_id?: string;
}): Promise<ResolvedRuntimeAuthority> {
  const projectRoot = input.projectRoot
    ?? (input.configPath ? resolve(dirname(input.configPath)) : undefined);
  const resolved = await resolveProjectRuntimeMode({
    projectRoot,
    project: input.project,
    production_id: input.production_id
  });
  const liveDigest = rcRevisionBindingsDigest();
  if (
    resolved.revision_bindings_digest
    && resolved.revision_bindings_digest !== liveDigest
  ) {
    throw pcError(
      "PC_MODE_UNSAFE_UNKNOWN",
      `runtime authority revision mismatch: pointer ${resolved.revision_bindings_digest.slice(0, 12)}… vs live ${liveDigest.slice(0, 12)}…`
    );
  }
  return {
    schema_version: 1,
    runtime_mode: resolved.runtime_mode,
    source: resolved.source,
    ...(resolved.pointer?.intent_digest ? { intent_digest: resolved.pointer.intent_digest } : {}),
    revision_bindings_digest: resolved.revision_bindings_digest ?? liveDigest,
    ...(resolved.production_id ? { production_id: resolved.production_id } : {}),
    ...(resolved.pointer ? { pointer: resolved.pointer } : {}),
    ...(resolved.yaml_mode ? { yaml_mode: resolved.yaml_mode } : {}),
    pointer_absent: resolved.source !== "durable_pointer"
  };
}

/**
 * Map resolved authority to production-control mode string for effect boundaries.
 * legacy → undefined (legacy-compatible); shadow/active stay explicit.
 */
export function authorityToOrchestrationMode(
  authority: ResolvedRuntimeAuthority
): "disabled" | "shadow" | "active" | undefined {
  if (authority.runtime_mode === "active") return "active";
  if (authority.runtime_mode === "shadow") return "shadow";
  if (authority.runtime_mode === "legacy") return "disabled";
  return undefined;
}

/** Shadow / unresolved deny for activePipeline effect entries. */
export function assertAuthorityAllowsEffect(
  authority: ResolvedRuntimeAuthority,
  effect: string
): void {
  if (authority.runtime_mode === "shadow") {
    throw pcError("PC_MODE_INACTIVE", `shadow mode forbids effect request: ${effect}`);
  }
}

export async function readModePointerIfPresent(
  projectRoot: string
): Promise<CurrentModePointerV1 | undefined> {
  return readCurrentModePointer(projectRoot);
}

/**
 * Single trusted projection of orchestration.mode from resolved authority.
 * Durable pointer is SoT when present; YAML is not re-resolved inside pipeline bodies.
 * Use this projection (or explicit runtime_authority options) for plan/run/review/render/gate.
 */
export function projectWithRuntimeAuthority<T extends Record<string, unknown>>(
  project: T,
  authority: ResolvedRuntimeAuthority | undefined
): T {
  if (!authority) return project;
  const base = { ...project } as Record<string, unknown>;
  if (authority.runtime_mode === "legacy") {
    const { orchestration: _drop, ...rest } = base;
    return rest as unknown as T;
  }
  const prior = base.orchestration && typeof base.orchestration === "object" && !Array.isArray(base.orchestration)
    ? base.orchestration as Record<string, unknown>
    : {};
  return {
    ...base,
    orchestration: {
      ...prior,
      mode: authority.runtime_mode === "shadow" ? "shadow" : "active"
    }
  } as unknown as T;
}

/**
 * Prefer explicit runtime_authority over project.orchestration.mode (no internal YAML re-resolve).
 */
export function orchestrationModeFromAuthority(
  authority: ResolvedRuntimeAuthority | undefined,
  project?: { orchestration?: { mode?: string } }
): "disabled" | "shadow" | "active" | undefined {
  if (authority) return authorityToOrchestrationMode(authority);
  const mode = project?.orchestration?.mode;
  if (mode === "active" || mode === "shadow" || mode === "disabled") return mode;
  return undefined;
}

export type { EffectPolicy, RuntimeModeResolution, RcRuntimeMode };
