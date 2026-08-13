/**
 * Exact revision bindings for RC integration.
 * package_version is read from package.json (realpath, regular file, no symlink);
 * schema/compiler constants come from exported production modules only.
 * Hand-written floating versions and self-declared digests are rejected.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_CONTRACT_COMPILER_VERSION } from "../contractCompiler.js";
import {
  PRODUCTION_CONTRACT_SCHEMA_VERSION,
  TASK_TREE_SCHEMA_VERSION
} from "../schema.js";
import { GATE_BUNDLE_SCHEMA_VERSION } from "../gateBundle.js";
import { GENERATION_JOB_APPROVAL_BINDING_SCHEMA_VERSION } from "../generationBridge.js";
import { RECOVERY_POLICY_SCHEMA_VERSION } from "../recoveryContracts.js";
import { LEARNING_CANDIDATE_SCHEMA_VERSION } from "../learning/schema.js";
import { MISSION_METRICS_SCHEMA_VERSION } from "../metrics.js";
import { FINALIZE_RETENTION_SCHEMA_VERSION } from "../finalizeRetention.js";
import { LAUNCHER_MISSION_TREE_DTO_SCHEMA_VERSION } from "../publicProjection.js";
import { sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";
import { H3_WORKFLOW_VERSION } from "../../videoPromptDirector/compile.js";
import { H3_GRAMMAR_V3_VERSION } from "../../videoPromptDirector/render/h3GrammarV3.js";
import { VIDEO_PROMPT_IR_VERSION } from "../../videoPromptDirector/schemaV2.js";

/** Runtime mode names used by RC diagnostics (legacy == design "disabled"/unspecified). */
export type RcRuntimeMode = "legacy" | "shadow" | "active";

export const MIGRATION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const ROLLBACK_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RELEASE_READINESS_SCHEMA_VERSION = 1 as const;

// Re-export production module versions so RC consumers import from one place.
export {
  PRODUCTION_CONTRACT_SCHEMA_VERSION,
  TASK_TREE_SCHEMA_VERSION,
  GATE_BUNDLE_SCHEMA_VERSION,
  GENERATION_JOB_APPROVAL_BINDING_SCHEMA_VERSION,
  RECOVERY_POLICY_SCHEMA_VERSION,
  LEARNING_CANDIDATE_SCHEMA_VERSION,
  MISSION_METRICS_SCHEMA_VERSION,
  FINALIZE_RETENTION_SCHEMA_VERSION,
  LAUNCHER_MISSION_TREE_DTO_SCHEMA_VERSION
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export function readPackageVersionSync(repoRoot = REPO_ROOT): string {
  const packagePath = join(repoRoot, "package.json");
  let real: string;
  try {
    real = realpathSync(packagePath);
  } catch {
    throw pcError("PC_SCHEMA_INVALID", "package.json is required for revision bindings");
  }
  const stat = lstatSync(real);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "package.json must be a regular file (no symlink)");
  }
  const bytes = readFileSync(real);
  const pkg = JSON.parse(bytes.toString("utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw pcError("PC_SCHEMA_INVALID", "package.json version is required for revision bindings");
  }
  return pkg.version;
}

export function packageJsonContentDigest(repoRoot = REPO_ROOT): string {
  const packagePath = join(repoRoot, "package.json");
  const real = realpathSync(packagePath);
  const stat = lstatSync(real);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "package.json must be a regular file (no symlink)");
  }
  return createHash("sha256").update(readFileSync(real)).digest("hex");
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
  package_json_digest: string;
  production_contract_schema: typeof PRODUCTION_CONTRACT_SCHEMA_VERSION;
  task_tree_schema: typeof TASK_TREE_SCHEMA_VERSION;
  video_prompt_ir: typeof VIDEO_PROMPT_IR_VERSION;
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
    package_json: "package.json#version+sha256";
    production_contract_schema: "schema.PRODUCTION_CONTRACT_SCHEMA_VERSION";
    production_contract_compiler: "contractCompiler.PRODUCTION_CONTRACT_COMPILER_VERSION";
    h3_workflow: "videoPromptDirector.compile.H3_WORKFLOW_VERSION";
    h3_grammar_v3: "videoPromptDirector.render.h3GrammarV3.H3_GRAMMAR_V3_VERSION";
    video_prompt_ir: "videoPromptDirector.schemaV2.VIDEO_PROMPT_IR_VERSION";
  };
};

export function projectRevisionBindings(options: {
  /** @deprecated Production entry forbids version override — always read package.json. */
  package_version?: string;
  repoRoot?: string;
  /** Reject if caller tries to inject a precomputed digest. */
  self_declared_digest?: string;
  /** Test-only: allow package_version override (never on production CLI paths). */
  allow_package_version_override?: boolean;
} = {}): RcRevisionBindings {
  if (options.self_declared_digest !== undefined) {
    throw pcError("PC_SCHEMA_INVALID", "self-declared revision bindings digest is rejected");
  }
  if (options.package_version !== undefined && options.allow_package_version_override !== true) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      "production revision bindings reject package_version override; read package.json only"
    );
  }
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const package_version = options.allow_package_version_override && options.package_version
    ? options.package_version
    : readPackageVersionSync(repoRoot);
  // Fail closed: package.json digest is required (no synthetic version fallback).
  const package_json_digest = packageJsonContentDigest(repoRoot);
  return {
    schema_version: RELEASE_READINESS_SCHEMA_VERSION,
    package_version,
    package_json_digest,
    production_contract_schema: PRODUCTION_CONTRACT_SCHEMA_VERSION,
    task_tree_schema: TASK_TREE_SCHEMA_VERSION,
    video_prompt_ir: VIDEO_PROMPT_IR_VERSION,
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
      package_json: "package.json#version+sha256",
      production_contract_schema: "schema.PRODUCTION_CONTRACT_SCHEMA_VERSION",
      production_contract_compiler: "contractCompiler.PRODUCTION_CONTRACT_COMPILER_VERSION",
      h3_workflow: "videoPromptDirector.compile.H3_WORKFLOW_VERSION",
      h3_grammar_v3: "videoPromptDirector.render.h3GrammarV3.H3_GRAMMAR_V3_VERSION",
      video_prompt_ir: "videoPromptDirector.schemaV2.VIDEO_PROMPT_IR_VERSION"
    }
  };
}

export function rcRevisionBindingsDigest(options?: {
  package_version?: string;
  repoRoot?: string;
  allow_package_version_override?: boolean;
}): string {
  return sha256Canonical(projectRevisionBindings(options));
}

/** Recompute digest from live package.json + constants; reject forged digest claims. */
export function assertRevisionBindingsDigest(claimed: string, options?: {
  package_version?: string;
  repoRoot?: string;
  allow_package_version_override?: boolean;
}): void {
  const expected = rcRevisionBindingsDigest(options);
  if (claimed !== expected) {
    throw pcError("PC_CONTRACT_INVALID", "revision bindings digest mismatch (self-declared digests rejected)");
  }
}
