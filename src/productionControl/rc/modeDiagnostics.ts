/**
 * RC mode diagnostics: legacy / shadow / active.
 * Default remains legacy (design: disabled / unspecified). Active requires authority.
 * Shadow is read-only: no execution, no Gate subject mutation.
 * Invalid/unknown mode → unsafe_unknown (never collapsed to legacy).
 */
import type { Project } from "../../project/schema.js";
import {
  resolveOrchestrationMode,
  requireActiveModeForEffect,
  requireResolvedModeForEffect
} from "../activePipeline.js";
import type { ProductionControlMode } from "../schema.js";
import { pcError } from "../errors.js";
import { sha256Canonical } from "../canonical.js";
import {
  projectRevisionBindings,
  rcRevisionBindingsDigest,
  type RcRuntimeMode
} from "./revisionBindings.js";

export type ModeCapability = {
  reads_control_plane: boolean;
  writes_shadow_artifacts: boolean;
  mutates_gate_subject: boolean;
  may_execute_generation: boolean;
  may_paid_submit: boolean;
  may_render: boolean;
  may_finalize_apply: boolean;
  authority_required: boolean;
};

export type ModeTransition =
  | { from: RcRuntimeMode; to: RcRuntimeMode; allowed: true; conditions: string[] }
  | { from: RcRuntimeMode; to: RcRuntimeMode; allowed: false; blocked_reasons: string[] };

export type ModeDiagnosticsReport = {
  schema_version: 1;
  runtime_mode: RcRuntimeMode;
  project_mode: ProductionControlMode | "unspecified";
  default_mode: "legacy";
  capabilities: ModeCapability;
  revision_bindings: ReturnType<typeof projectRevisionBindings>;
  revision_bindings_digest: string;
  transitions: ModeTransition[];
  safety: {
    legacy_byte_semantic_invariant: true;
    shadow_read_only: boolean;
    active_authority_required: boolean;
    no_auto_active_migration: true;
  };
  digest: string;
};

const MODE_ORDER: readonly RcRuntimeMode[] = ["legacy", "shadow", "active"] as const;

const EFFECTFUL_REQUESTS = new Set([
  "external-submit",
  "provider_submit",
  "gate",
  "gate_mutation",
  "job",
  "paid-regeneration",
  "billing",
  "billing_spend",
  "local-recovery",
  "render",
  "finalize",
  "finalize_apply",
  "network_fetch"
]);

/**
 * Map known ProductionControlMode / legacy alias to runtime mode.
 * Unknown non-empty strings throw PC_MODE_UNSAFE_UNKNOWN (never silent legacy).
 */
export function toRuntimeMode(
  mode: ProductionControlMode | undefined | "legacy" | string
): RcRuntimeMode {
  if (mode === "active") return "active";
  if (mode === "shadow") return "shadow";
  if (mode === "disabled" || mode === "legacy" || mode === undefined) return "legacy";
  throw pcError(
    "PC_MODE_UNSAFE_UNKNOWN",
    `unsafe_unknown production control mode: ${String(mode)}`
  );
}

/** Inspect raw project.orchestration.mode without collapsing unknown → legacy. */
export function readRawOrchestrationMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: unknown } } | undefined
): unknown {
  return project?.orchestration?.mode;
}

export function resolveRuntimeMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: string } } | undefined
): RcRuntimeMode {
  const raw = readRawOrchestrationMode(project);
  if (raw === undefined || raw === null || raw === "") {
    return "legacy";
  }
  if (typeof raw !== "string") {
    throw pcError("PC_MODE_UNSAFE_UNKNOWN", `unsafe_unknown production control mode type: ${typeof raw}`);
  }
  return toRuntimeMode(raw);
}

export function modeCapabilities(mode: RcRuntimeMode): ModeCapability {
  if (mode === "active") {
    return {
      reads_control_plane: true,
      writes_shadow_artifacts: true,
      mutates_gate_subject: false,
      may_execute_generation: true,
      may_paid_submit: true,
      may_render: true,
      may_finalize_apply: true,
      authority_required: true
    };
  }
  if (mode === "shadow") {
    return {
      reads_control_plane: true,
      writes_shadow_artifacts: true,
      mutates_gate_subject: false,
      may_execute_generation: false,
      may_paid_submit: false,
      may_render: false,
      may_finalize_apply: false,
      authority_required: false
    };
  }
  return {
    reads_control_plane: false,
    writes_shadow_artifacts: false,
    mutates_gate_subject: false,
    may_execute_generation: false,
    may_paid_submit: false,
    may_render: false,
    may_finalize_apply: false,
    authority_required: false
  };
}

/**
 * Allowed mode transitions for RC migration/rollback.
 * Forward activation is explicit; rollback never auto-executes provider/Gate/billing.
 */
export function evaluateModeTransition(
  from: RcRuntimeMode,
  to: RcRuntimeMode,
  options: {
    coordinator?: boolean;
    preview_digest?: string;
    coordination_root_ready?: boolean;
    identity_blocked?: boolean;
  } = {}
): ModeTransition {
  if (from === to) {
    return {
      from,
      to,
      allowed: true,
      conditions: ["mode unchanged"]
    };
  }

  if (
    (from === "active" && (to === "shadow" || to === "legacy"))
    || (from === "shadow" && to === "legacy")
  ) {
    return {
      from,
      to,
      allowed: true,
      conditions: [
        "rollback mode switch only",
        "append-only artifacts retained",
        "no provider/Gate/billing auto-execution"
      ]
    };
  }

  if (from === "legacy" && to === "shadow") {
    return {
      from,
      to,
      allowed: true,
      conditions: [
        "shadow is read-only",
        "no Gate subject mutation",
        "no execution authority"
      ]
    };
  }

  if (to === "active" && (from === "shadow" || from === "legacy")) {
    const blocked: string[] = [];
    if (!options.coordinator) blocked.push("coordinator actor required");
    if (!options.preview_digest) blocked.push("migration preview digest required");
    if (options.coordination_root_ready === false) blocked.push("coordination root not ready");
    if (options.identity_blocked) {
      blocked.push("identity migration blocked; confirmation/verification must not be invented");
    }
    if (blocked.length > 0) {
      return { from, to, allowed: false, blocked_reasons: blocked };
    }
    return {
      from,
      to,
      allowed: true,
      conditions: [
        "explicit project opt-in / active intent",
        "coordinator approval",
        "preview digest bound",
        "authority required for effectful work"
      ]
    };
  }

  return {
    from,
    to,
    allowed: false,
    blocked_reasons: [`transition ${from}→${to} is not a defined RC migration path`]
  };
}

/**
 * Enforce shadow no-execution against an actual effect request.
 * Without an effect argument this is a no-op capability check (shadow is allowed to exist).
 */
export function assertShadowNoExecution(
  mode: RcRuntimeMode,
  effect?: string
): void {
  if (mode !== "shadow") return;
  if (effect === undefined || effect === "") return;
  if (EFFECTFUL_REQUESTS.has(effect)) {
    throw pcError(
      "PC_MODE_INACTIVE",
      `shadow mode forbids effect request: ${effect}`
    );
  }
}

export function assertActiveAuthority(
  mode: RcRuntimeMode,
  effect: "external-submit" | "gate" | "job" | "paid-regeneration" | "local-recovery"
): void {
  if (mode !== "active") {
    throw pcError("PC_MODE_INACTIVE", `active mode required at ${effect} boundary`);
  }
  requireActiveModeForEffect("active", effect);
}

export function diagnoseMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: string } } | undefined
): ModeDiagnosticsReport {
  // Fail closed on unknown modes before any capability projection.
  const runtime = resolveRuntimeMode(project);
  const resolved = resolveOrchestrationMode(project);
  const projectMode: ProductionControlMode | "unspecified" = resolved ?? "unspecified";
  const caps = modeCapabilities(runtime);
  const transitions: ModeTransition[] = [];
  for (const from of MODE_ORDER) {
    for (const to of MODE_ORDER) {
      if (from === to) continue;
      transitions.push(evaluateModeTransition(from, to, {
        coordinator: true,
        preview_digest: "preview",
        coordination_root_ready: true,
        identity_blocked: false
      }));
    }
  }
  const body = {
    schema_version: 1 as const,
    runtime_mode: runtime,
    project_mode: projectMode,
    default_mode: "legacy" as const,
    capabilities: caps,
    revision_bindings: projectRevisionBindings(),
    revision_bindings_digest: rcRevisionBindingsDigest(),
    transitions,
    safety: {
      legacy_byte_semantic_invariant: true as const,
      shadow_read_only: runtime !== "active",
      active_authority_required: caps.authority_required,
      no_auto_active_migration: true as const
    }
  };
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}

/** Re-export effect helpers used by CLI diagnostics without widening authority. */
export {
  requireResolvedModeForEffect,
  resolveOrchestrationMode
};
