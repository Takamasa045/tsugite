/**
 * Approved rule revisions bind only to new Missions at compile time.
 * Pending / validated / declined never enter Task inputs or Gate subjects.
 * In-flight Missions require an explicit RevisionIntent (PO-6) to adopt.
 */
import { sha256Canonical, withoutField } from "../canonical.js";
import { pcError } from "../errors.js";
import type { DigestRef } from "../schema.js";
import {
  parseRuleRevision,
  parseRuleSetSnapshot,
  ruleSetSnapshotSchema,
  type PromotionProposalV1,
  type RuleRevisionV1,
  type RuleSetSnapshotV1
} from "./schema.js";

export type CompileRuleSetInput = {
  rule_set_id: string;
  production_id?: string;
  /** Only applied revisions accepted. */
  applied_revisions: RuleRevisionV1[];
  compiled_at: string;
};

/**
 * Compile a rule-set snapshot from applied rule revisions only.
 * Rejects pending/validated/approved-but-unapplied proposals.
 */
export function compileRuleSetForNewMission(input: CompileRuleSetInput): RuleSetSnapshotV1 {
  const revisions: DigestRef[] = [];
  const seen = new Set<string>();

  for (const revision of input.applied_revisions) {
    const parsed = parseRuleRevision(revision);
    // Apply path already requires decision; double-check decision subject present.
    if (!parsed.decision) {
      throw pcError("PC_SCHEMA_INVALID", "rule revision missing human decision");
    }
    const key = `${parsed.rule_id}.r${parsed.revision}`;
    if (seen.has(key)) {
      throw pcError("PC_SCHEMA_INVALID", "duplicate rule revision in rule set", { key });
    }
    seen.add(key);
    revisions.push({
      kind: "rule-revision",
      id: key,
      digest: parsed.digest
    });
  }

  // Stable order for deterministic digests.
  revisions.sort((left, right) => left.id.localeCompare(right.id));

  const draft = {
    schema_version: 1 as const,
    rule_set_id: input.rule_set_id,
    ...(input.production_id ? { production_id: input.production_id } : {}),
    rule_revisions: revisions,
    compiled_at: input.compiled_at
  };

  return ruleSetSnapshotSchema.parse({
    ...draft,
    digest: sha256Canonical(draft)
  });
}

/**
 * Reject binding non-applied proposals into a mission rule set.
 */
export function assertProposalNotBindableToMission(proposal: PromotionProposalV1): void {
  if (proposal.status !== "applied" || !proposal.applied_rule_revision) {
    throw pcError(
      "PC_ROLE_FORBIDDEN",
      "pending/validated/approved proposals cannot bind to Mission rule sets",
      { status: proposal.status }
    );
  }
}

/**
 * Existing pinned Mission rule_set_digest is immutable from learning apply.
 * New Missions may receive a freshly compiled snapshot only.
 */
export function assertDoesNotMutatePinnedMission(input: {
  pinned_rule_set_digest: string;
  existing_mission_ids: string[];
  new_rule_set: RuleSetSnapshotV1;
}): void {
  const snapshot = parseRuleSetSnapshot(input.new_rule_set);
  if (input.existing_mission_ids.length === 0) return;
  // Learning apply never rewrites pinned digests on existing missions.
  if (snapshot.digest === input.pinned_rule_set_digest) return;
  // Omitting production_id must not retroactively bind to existing pinned missions/Gates.
  if (!snapshot.production_id) {
    throw pcError(
      "PC_ROLE_FORBIDDEN",
      "approved rules must target a new production_id; omitting production_id cannot rebind existing missions"
    );
  }
  // If a different digest is compiled, it may only be attached to a NEW production_id.
  if (input.existing_mission_ids.includes(snapshot.production_id)) {
    throw pcError(
      "PC_ROLE_FORBIDDEN",
      "approved rules must not retroactively change existing pinned missions"
    );
  }
}

export function ruleSetDigest(snapshot: RuleSetSnapshotV1): string {
  return parseRuleSetSnapshot(snapshot).digest;
}

export function assertRuleSetDigest(snapshot: RuleSetSnapshotV1): void {
  const expected = sha256Canonical(withoutField(snapshot, "digest"));
  if (expected !== snapshot.digest) {
    throw pcError("PC_SCHEMA_INVALID", "rule set snapshot digest mismatch");
  }
}
