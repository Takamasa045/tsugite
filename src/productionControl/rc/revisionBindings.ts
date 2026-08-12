/**
 * Exact revision bindings for RC integration.
 * These pin contract / task tree / job / recovery / learning / launcher / finalize
 * identities so migration and diagnostics never invent floating versions.
 */
import { PRODUCTION_CONTRACT_COMPILER_VERSION } from "../contractCompiler.js";
import { sha256Canonical } from "../canonical.js";

/** Runtime mode names used by RC diagnostics (legacy == design "disabled"/unspecified). */
export type RcRuntimeMode = "legacy" | "shadow" | "active";

export const RC_REVISION_BINDINGS = Object.freeze({
  schema_version: 1 as const,
  package_version: "0.9.0",
  production_contract_schema: 1 as const,
  task_tree_schema: 1 as const,
  video_prompt_ir: 2 as const,
  h3_compiler_workflow: 3 as const,
  /** Legacy H3 workflow v2 remains a pure reader / upgrader source. */
  legacy_h3_workflow_reader: 2 as const,
  contract_compiler: PRODUCTION_CONTRACT_COMPILER_VERSION,
  gate_bundle_schema: 1 as const,
  generation_job_approval_binding: 1 as const,
  recovery_policy_schema: 1 as const,
  learning_candidate_schema: 1 as const,
  mission_metrics_schema: 1 as const,
  finalize_retention_schema: 1 as const,
  launcher_mission_tree_dto: 1 as const,
  migration_artifact_schema: 1 as const,
  rollback_artifact_schema: 1 as const,
  release_readiness_schema: 1 as const
});

export type RcRevisionBindings = typeof RC_REVISION_BINDINGS;

export function rcRevisionBindingsDigest(): string {
  return sha256Canonical(RC_REVISION_BINDINGS);
}

/** Surface bindings without inventing new fields for unknown consumers. */
export function projectRevisionBindings(): RcRevisionBindings {
  return RC_REVISION_BINDINGS;
}
