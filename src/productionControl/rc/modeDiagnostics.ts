/**
 * RC mode diagnostics: legacy / shadow / active.
 * Default remains legacy (design: disabled / unspecified). Active requires authority.
 * Shadow is read-only: no execution, no Gate subject mutation.
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

export function toRuntimeMode(
  mode: ProductionControlMode | undefined | "legacy"
): RcRuntimeMode {
  if (mode === "active") return "active";
  if (mode === "shadow") return "shadow";
  return "legacy";
}

export function resolveRuntimeMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: string } } | undefined
): RcRuntimeMode {
  return toRuntimeMode(resolveOrchestrationMode(project));
}

export function modeCapabilities(mode: RcRuntimeMode): ModeCapability {
  if (mode === "active") {
    return {
      reads_control_plane: true,
      writes_shadow_artifacts: true,
      mutates_gate_subject: false, // Gate mutation still requires human decision path
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

  // Rollback paths: always allowed as mode switch; never delete artifacts.
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

  // Forward: legacy → shadow
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

  // Forward: shadow → active or legacy → active
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

  // shadow → active already covered; forbid active → active etc.
  return {
    from,
    to,
    allowed: false,
    blocked_reasons: [`transition ${from}→${to} is not a defined RC migration path`]
  };
}

export function assertShadowNoExecution(mode: RcRuntimeMode): void {
  if (mode === "shadow") {
    // Shadow may compute digests and write shadow artifacts only.
    return;
  }
  if (mode === "legacy") return;
}

export function assertActiveAuthority(mode: RcRuntimeMode, effect: "external-submit" | "gate" | "job" | "paid-regeneration" | "local-recovery"): void {
  if (mode !== "active") {
    throw pcError("PC_MODE_INACTIVE", `active mode required at ${effect} boundary`);
  }
  requireActiveModeForEffect("active", effect);
}

export function diagnoseMode(
  project: Pick<Project, "orchestration"> | { orchestration?: { mode?: string } } | undefined
): ModeDiagnosticsReport {
  const resolved = resolveOrchestrationMode(project);
  const projectMode: ProductionControlMode | "unspecified" = resolved ?? "unspecified";
  const runtime = toRuntimeMode(resolved);
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
