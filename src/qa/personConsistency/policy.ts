/**
 * Project-level person consistency policy helpers.
 */
import type { Issue, Result } from "../../types.js";
import {
  personConsistencyPolicySchema,
  type PersonConsistencyPolicyV1,
  type PersonConsistencyStage
} from "./schema.js";

export type ProjectQualityLike = {
  person_consistency?: unknown;
};

export type ProjectWithQuality = {
  quality?: ProjectQualityLike;
  gates?: {
    gate_2?: {
      auto_pass?: string;
    };
  };
};

export function parsePersonConsistencyPolicy(
  input: unknown
): Result<{ policy: PersonConsistencyPolicyV1 | undefined }> {
  if (input === undefined || input === null) {
    return { ok: true, issues: [], policy: undefined };
  }
  const parsed = personConsistencyPolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "person_qa.policy_invalid",
          message: parsed.error.issues[0]?.message ?? "invalid person consistency policy",
          path: "quality.person_consistency"
        }
      ]
    };
  }
  return { ok: true, issues: [], policy: parsed.data };
}

export function readPersonConsistencyPolicy(
  project: ProjectWithQuality
): Result<{ policy: PersonConsistencyPolicyV1 | undefined }> {
  return parsePersonConsistencyPolicy(project.quality?.person_consistency);
}

export function isPersonConsistencyEnabled(project: ProjectWithQuality): boolean {
  const result = readPersonConsistencyPolicy(project);
  return Boolean(result.ok && result.policy?.enabled);
}

export function personConsistencyRequiredForStage(
  project: ProjectWithQuality,
  stage: PersonConsistencyStage
): boolean {
  const result = readPersonConsistencyPolicy(project);
  if (!result.ok || !result.policy?.enabled) return false;
  return result.policy.stages.includes(stage);
}

/**
 * Gate 2 auto-pass is forbidden when semantic person QA is enabled.
 * Returns a machine-readable blocked reason token for run logs.
 */
export function gate2AutoPassBlockedByPersonQa(
  project: ProjectWithQuality
): string | undefined {
  if (isPersonConsistencyEnabled(project)) {
    return "semantic_qa_enabled";
  }
  return undefined;
}

export function validatePersonConsistencyAgainstAutoPass(
  project: ProjectWithQuality
): Issue[] {
  if (isPersonConsistencyEnabled(project) && project.gates?.gate_2?.auto_pass) {
    return [
      {
        code: "person_qa.auto_pass_forbidden",
        message:
          "quality.person_consistency.enabled forbids gates.gate_2.auto_pass (semantic_qa_enabled)",
        path: "gates.gate_2.auto_pass"
      }
    ];
  }
  return [];
}
