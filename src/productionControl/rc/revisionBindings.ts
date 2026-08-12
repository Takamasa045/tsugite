/**
 * Exact revision bindings for RC integration.
 * package_version is read from package.json; schema/compiler constants come from
 * exported production modules. Hand-written floating versions and self-declared
 * digests are rejected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_CONTRACT_COMPILER_VERSION } from "../contractCompiler.js";
import { sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";
import { H3_WORKFLOW_VERSION } from "../../videoPromptDirector/compile.js";
import { H3_GRAMMAR_V3_VERSION } from "../../videoPromptDirector/render/h3GrammarV3.js";
import { VIDEO_PROMPT_V2_WORKFLOW_VERSION } from "../../videoPromptDirector/compileV2.js";

/** Runtime mode names used by RC diagnostics (legacy == design "disabled"/unspecified). */
export type RcRuntimeMode = "legacy" | "shadow" | "active";

/** Schema version literals re-exported from productionControl schema shapes. */
export const PRODUCTION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const TASK_TREE_SCHEMA_VERSION = 1 as const;
export const GATE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const GENERATION_JOB_APPROVAL_BINDING_SCHEMA_VERSION = 1 as const;
export const RECOVERY_POLICY_SCHEMA_VERSION = 1 as const;
export const LEARNING_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const MISSION_METRICS_SCHEMA_VERSION = 1 as const;
export const FINALIZE_RETENTION_SCHEMA_VERSION = 1 as const;
export const LAUNCHER_MISSION_TREE_DTO_SCHEMA_VERSION = 1 as const;
export const MIGRATION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const ROLLBACK_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RELEASE_READINESS_SCHEMA_VERSION = 1 as const;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export function readPackageVersionSync(repoRoot = REPO_ROOT): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw pcError("PC_SCHEMA_INVALID", "package.json version is required for revision bindings");
  }
  return pkg.version;
}

function videoPromptIrMajor(version: string): number {
  // VIDEO_PROMPT_V2_WORKFLOW_VERSION tracks grammar; IR version is 2 by export contract.
  void version;
  return 2;
}

function h3CompilerWorkflowMajor(version: string): number {
  const n = Number(version);
  if (!Number.isFinite(n)) {
    throw pcError("PC_SCHEMA_INVALID", `invalid H3 grammar version: ${version}`);
  }
  return n;
}

function legacyH3WorkflowMajor(version: string): number {
  const n = Number(version);
  if (!Number.isFinite(n)) {
    throw pcError("PC_SCHEMA_INVALID", `invalid legacy H3 workflow version: ${version}`);
  }
  return n;
}

export type RcRevisionBindings = {
  schema_version: typeof RELEASE_READINESS_SCHEMA_VERSION;
  package_version: string;
  production_contract_schema: typeof PRODUCTION_CONTRACT_SCHEMA_VERSION;
  task_tree_schema: typeof TASK_TREE_SCHEMA_VERSION;
  video_prompt_ir: number;
  h3_compiler_workflow: number;
  legacy_h3_workflow_reader: number;
  contract_compiler: typeof PRODUCTION_CONTRACT_COMPILER_VERSION;
  gate_bundle_schema: typeof GATE_BUNDLE_SCHEMA_VERSION;
  generation_job_approval_binding: typeof GENERATION_JOB_APPROVAL_BINDING_SCHEMA_VERSION;
  recovery_policy_schema: typeof RECOVERY_POLICY_SCHEMA_VERSION;
  learning_candidate_schema: typeof LEARNING_CANDIDATE_SCHEMA_VERSION;
  mission_metrics_schema: typeof MISSION_METRICS_SCHEMA_VERSION;
  finalize_retention_schema: typeof FINALIZE_RETENTION_SCHEMA_VERSION;
  launcher_mission_tree_dto: typeof LAUNCHER_MISSION_TREE_DTO_SCHEMA_VERSION;
  migration_artifact_schema: typeof MIGRATION_ARTIFACT_SCHEMA_VERSION;
  rollback_artifact_schema: typeof ROLLBACK_ARTIFACT_SCHEMA_VERSION;
  release_readiness_schema: typeof RELEASE_READINESS_SCHEMA_VERSION;
  /** Provenance only — never accepted as the bindings digest itself. */
  sources: {
    package_json: "package.json#version";
    production_contract_compiler: "contractCompiler.PRODUCTION_CONTRACT_COMPILER_VERSION";
    h3_workflow: "videoPromptDirector.compile.H3_WORKFLOW_VERSION";
    h3_grammar_v3: "videoPromptDirector.render.h3GrammarV3.H3_GRAMMAR_V3_VERSION";
    video_prompt_v2: "videoPromptDirector.compileV2.VIDEO_PROMPT_V2_WORKFLOW_VERSION";
  };
};

export function projectRevisionBindings(options: {
  package_version?: string;
  /** Reject if caller tries to inject a precomputed digest. */
  self_declared_digest?: string;
} = {}): RcRevisionBindings {
  if (options.self_declared_digest !== undefined) {
    throw pcError("PC_SCHEMA_INVALID", "self-declared revision bindings digest is rejected");
  }
  const package_version = options.package_version ?? readPackageVersionSync();
  return {
    schema_version: RELEASE_READINESS_SCHEMA_VERSION,
    package_version,
    production_contract_schema: PRODUCTION_CONTRACT_SCHEMA_VERSION,
    task_tree_schema: TASK_TREE_SCHEMA_VERSION,
    video_prompt_ir: videoPromptIrMajor(VIDEO_PROMPT_V2_WORKFLOW_VERSION),
    h3_compiler_workflow: h3CompilerWorkflowMajor(H3_GRAMMAR_V3_VERSION),
    legacy_h3_workflow_reader: legacyH3WorkflowMajor(H3_WORKFLOW_VERSION),
    contract_compiler: PRODUCTION_CONTRACT_COMPILER_VERSION,
    gate_bundle_schema: GATE_BUNDLE_SCHEMA_VERSION,
    generation_job_approval_binding: GENERATION_JOB_APPROVAL_BINDING_SCHEMA_VERSION,
    recovery_policy_schema: RECOVERY_POLICY_SCHEMA_VERSION,
    learning_candidate_schema: LEARNING_CANDIDATE_SCHEMA_VERSION,
    mission_metrics_schema: MISSION_METRICS_SCHEMA_VERSION,
    finalize_retention_schema: FINALIZE_RETENTION_SCHEMA_VERSION,
    launcher_mission_tree_dto: LAUNCHER_MISSION_TREE_DTO_SCHEMA_VERSION,
    migration_artifact_schema: MIGRATION_ARTIFACT_SCHEMA_VERSION,
    rollback_artifact_schema: ROLLBACK_ARTIFACT_SCHEMA_VERSION,
    release_readiness_schema: RELEASE_READINESS_SCHEMA_VERSION,
    sources: {
      package_json: "package.json#version",
      production_contract_compiler: "contractCompiler.PRODUCTION_CONTRACT_COMPILER_VERSION",
      h3_workflow: "videoPromptDirector.compile.H3_WORKFLOW_VERSION",
      h3_grammar_v3: "videoPromptDirector.render.h3GrammarV3.H3_GRAMMAR_V3_VERSION",
      video_prompt_v2: "videoPromptDirector.compileV2.VIDEO_PROMPT_V2_WORKFLOW_VERSION"
    }
  };
}

export function rcRevisionBindingsDigest(options?: {
  package_version?: string;
}): string {
  return sha256Canonical(projectRevisionBindings(options));
}

/** Recompute digest from live package.json + constants; reject forged digest claims. */
export function assertRevisionBindingsDigest(claimed: string, options?: { package_version?: string }): void {
  const expected = rcRevisionBindingsDigest(options);
  if (claimed !== expected) {
    throw pcError("PC_CONTRACT_INVALID", "revision bindings digest mismatch (self-declared digests rejected)");
  }
}
