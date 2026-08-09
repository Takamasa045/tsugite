/**
 * External person-consistency QA safety contracts.
 * This phase does not connect any external provider; contracts exist for fail-closed checks.
 */
import { createHash } from "node:crypto";
import type { Issue, Result } from "../../types.js";
import type { PersonConsistencyPolicyV1 } from "./schema.js";
import type { SemanticQaNetworkScope } from "./adapterContract.js";

export type ExternalPayloadPreviewV1 = {
  schema_version: "person-consistency-external-preview-v1";
  provider: string;
  region: string;
  retention: string;
  frame_count: number;
  frame_hashes: string[];
  total_bytes: number;
  estimated_cost?: {
    currency: string;
    amount: number;
    notes?: string;
  };
  network_scope: SemanticQaNetworkScope;
  privacy_notes: string[];
};

export type ExternalApprovalLedgerEntry = {
  approval_digest: string;
  approved_at: string;
  actor: string;
  preview_digest: string;
  provider: string;
};

export function buildExternalPayloadPreview(input: {
  provider: string;
  region: string;
  retention: string;
  frames: Array<{ sha256: string; bytes: number }>;
  estimated_cost?: ExternalPayloadPreviewV1["estimated_cost"];
  network_scope: SemanticQaNetworkScope;
  privacy_notes?: string[];
}): ExternalPayloadPreviewV1 {
  return {
    schema_version: "person-consistency-external-preview-v1",
    provider: input.provider,
    region: input.region,
    retention: input.retention,
    frame_count: input.frames.length,
    frame_hashes: input.frames.map((frame) => frame.sha256),
    total_bytes: input.frames.reduce((sum, frame) => sum + frame.bytes, 0),
    ...(input.estimated_cost ? { estimated_cost: input.estimated_cost } : {}),
    network_scope: input.network_scope,
    privacy_notes: input.privacy_notes ?? []
  };
}

export function digestExternalPayloadPreview(preview: ExternalPayloadPreviewV1): string {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}

/**
 * External execution is denied unless:
 * - policy.external.allowed === true
 * - explicit approval ledger entry matches preview digest
 * - estimated cost present when required
 * - network scope matches adapter capability
 *
 * Local/manual failure must never fallback to external.
 */
export function assertExternalExecutionAllowed(input: {
  policy: PersonConsistencyPolicyV1;
  preview: ExternalPayloadPreviewV1;
  approval?: ExternalApprovalLedgerEntry;
  adapterNetworkScope: SemanticQaNetworkScope;
  requireCostEstimate?: boolean;
  localFailed?: boolean;
}): Result<{ approval_digest: string }> {
  const issues: Issue[] = [];

  if (input.localFailed) {
    issues.push({
      code: "person_qa.external_fallback_forbidden",
      message: "local/manual person-consistency failure must not fallback to external execution"
    });
  }

  if (!input.policy.external.allowed) {
    issues.push({
      code: "person_qa.external_disabled",
      message: "quality.person_consistency.external.allowed is false"
    });
  }

  if (!input.approval) {
    issues.push({
      code: "person_qa.external_approval_missing",
      message: "explicit external approval ledger entry is required before network execution"
    });
  } else {
    const previewDigest = digestExternalPayloadPreview(input.preview);
    if (input.approval.preview_digest !== previewDigest) {
      issues.push({
        code: "person_qa.external_approval_mismatch",
        message: "external approval digest does not match payload preview"
      });
    }
  }

  if (input.requireCostEstimate !== false && !input.preview.estimated_cost) {
    issues.push({
      code: "person_qa.external_cost_missing",
      message: "external payload preview must include estimated cost before execution"
    });
  }

  if (input.preview.network_scope !== input.adapterNetworkScope) {
    issues.push({
      code: "person_qa.external_network_scope_mismatch",
      message: `preview network scope '${input.preview.network_scope}' does not match adapter scope '${input.adapterNetworkScope}'`
    });
  }

  // Never allow secrets in preview/provider strings (defensive).
  const serialized = JSON.stringify(input.preview);
  if (/(api[_-]?key|token|cookie|authorization|secret)/i.test(serialized)) {
    issues.push({
      code: "person_qa.external_secret_forbidden",
      message: "API keys, tokens, or cookies must not appear in external payload previews"
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    issues: [],
    approval_digest: input.approval!.approval_digest
  };
}

/** This phase keeps external adapters unconnected. */
export function isExternalAdapterConnected(): boolean {
  return false;
}
