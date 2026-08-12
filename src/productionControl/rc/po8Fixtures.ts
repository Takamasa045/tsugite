/**
 * Strict PO-8 RC fixture loader.
 * Parses fixture_id / project / authoring / expected golden / adversarial.
 * Module inputs come only from fixture fields + frozen referenced fixtures.
 * Hardcoded DIGEST_A-F and marker "1" paths are forbidden in consumers.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sha256Bytes, sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";

export const PO8_FIXTURE_IDS = [
  "legacy-h3",
  "standalone-v2",
  "lyric-mv",
  "identity-phase-a-e",
  "gate2-auto-pass-cascade",
  "job-revision-submission-unknown",
  "recovery-unknown-price",
  "mission-tree-finalize-learning"
] as const;

export type Po8FixtureId = (typeof PO8_FIXTURE_IDS)[number];

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/, "lowercase sha256 required");
const nonEmpty = z.string().min(1).max(2_000);

const routeAuthoringSchema = z.object({
  ir_model: nonEmpty,
  provider_model: nonEmpty,
  model_profile_seed: nonEmpty,
  connection_id: nonEmpty,
  connection_seed: nonEmpty,
  adapter_id: nonEmpty,
  transport: z.literal("fixture"),
  mode_binding: nonEmpty
}).strict();

const musicAuthoringSchema = z.object({
  contract_id: nonEmpty,
  revision: z.number().int().nonnegative(),
  master_audio_asset_id: nonEmpty,
  master_audio_seed: nonEmpty,
  duration_ms: z.number().int().positive(),
  sample_rate: z.number().int().positive(),
  channels: z.number().int().positive(),
  analyzer_id: nonEmpty,
  analyzer_version: nonEmpty,
  tempo_bpm: z.number().positive(),
  meter: nonEmpty,
  section_id: nonEmpty,
  section_label: nonEmpty,
  section_end_ms: z.number().int().positive()
}).strict();

const lyricsAuthoringSchema = z.object({
  contract_id: nonEmpty,
  revision: z.number().int().nonnegative(),
  language_bcp47: nonEmpty,
  /** Must match project IR lyric text byte-for-byte when present. */
  canonical_text: nonEmpty,
  cue_id: nonEmpty,
  section_id: nonEmpty,
  occurrence_id: nonEmpty,
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  singer_ids: z.array(nonEmpty).min(1).max(8)
}).strict();

const gateAuthoringSchema = z.object({
  production_id: nonEmpty,
  run_id: nonEmpty,
  production_contract_seed: nonEmpty,
  contract_set_seed: nonEmpty,
  task_tree_seed: nonEmpty,
  review_artifact_seed: nonEmpty,
  generation_unit_seed: nonEmpty,
  compilation_seed: nonEmpty,
  pricing: z.object({
    status: z.literal("known"),
    version: nonEmpty,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: z.number().nonnegative(),
    max_amount: z.number().nonnegative(),
    zero_cost_policy_id: nonEmpty
  }).strict(),
  unknown_pricing: z.object({
    status: z.literal("unknown"),
    version: nonEmpty,
    currency: z.null(),
    amount: z.null(),
    max_amount: z.null()
  }).strict(),
  gate2_auto_pass_input: z.object({
    project_opt_in: z.boolean(),
    credits_consumed: z.number().int().nonnegative(),
    newly_generated_assets: z.number().int().nonnegative(),
    technical_qa_issue_count: z.number().int().nonnegative(),
    has_semantic_qa: z.boolean()
  }).strict(),
  gate2_credits_block_input: z.object({
    project_opt_in: z.boolean(),
    credits_consumed: z.number().int().positive(),
    newly_generated_assets: z.number().int().nonnegative(),
    technical_qa_issue_count: z.number().int().nonnegative(),
    has_semantic_qa: z.boolean()
  }).strict(),
  human_decision: z.object({
    decision_id: nonEmpty,
    decision: z.literal("approved"),
    actor: z.literal("human"),
    decided_at: z.string().datetime({ offset: true })
  }).strict()
}).strict();

const jobAuthoringSchema = z.object({
  production_id: nonEmpty,
  run_id: nonEmpty,
  node_id: nonEmpty,
  attempt_id: nonEmpty,
  generation_job_id: nonEmpty,
  approval_seed: nonEmpty,
  gate_bundle_seed: nonEmpty,
  gate_1_decision_seed: nonEmpty,
  request_seed: nonEmpty,
  compilation_seed: nonEmpty,
  pricing_binding_seed: nonEmpty,
  approval_observed_revision: z.number().int().positive(),
  next_revision: z.number().int().positive(),
  provider_job_id: nonEmpty
}).strict();

const recoveryAuthoringSchema = z.object({
  production_id: nonEmpty,
  run_id: nonEmpty,
  node_id: nonEmpty,
  reservation_id: nonEmpty,
  grant_seed: nonEmpty,
  attempt_key_seed: nonEmpty,
  pricing_binding_seed: nonEmpty,
  requested_credits: z.number().int().positive(),
  price_unknown: z.literal(true),
  local_action: z.literal("resume-known-job-poll")
}).strict();

const missionAuthoringSchema = z.object({
  production_id: nonEmpty,
  plan_seed: nonEmpty,
  contract_seed: nonEmpty,
  task_tree_seed: nonEmpty,
  snapshot_relative_path: nonEmpty,
  snapshot_seed: nonEmpty,
  learning: z.object({
    candidate_id: nonEmpty,
    feedback_key: nonEmpty,
    observations: z.array(z.object({
      id: nonEmpty,
      key: nonEmpty,
      summary: nonEmpty,
      stage: z.enum(["observed", "recurring"]),
      evidence: z.array(nonEmpty).min(1)
    }).strict()).min(2),
    symptom: nonEmpty,
    hypothesized_cause: nonEmpty,
    proposed_rule: z.object({
      target_kind: z.literal("lesson"),
      target_ref: nonEmpty,
      scope: nonEmpty,
      minimal_change: nonEmpty
    }).strict(),
    invariants: z.array(nonEmpty).min(1),
    experiment_requirements: z.array(nonEmpty).min(1),
    experiment_id: nonEmpty,
    baseline_seed: nonEmpty,
    candidate_ref_seed: nonEmpty,
    proposed_patch_seed: nonEmpty,
    rollback_ref: nonEmpty
  }).strict()
}).strict();

const authoringSchema = z.object({
  route: routeAuthoringSchema.optional(),
  music: musicAuthoringSchema.optional(),
  lyrics: lyricsAuthoringSchema.optional(),
  gate: gateAuthoringSchema.optional(),
  job: jobAuthoringSchema.optional(),
  recovery: recoveryAuthoringSchema.optional(),
  mission: missionAuthoringSchema.optional(),
  /** Optional seeds for identity verification adversarial only. */
  identity: z.object({
    production_id: nonEmpty,
    forged_output_seed: nonEmpty,
    forged_evidence_seed: nonEmpty,
    forged_subject_seed: nonEmpty
  }).strict().optional()
}).strict();

const adversarialCaseSchema = z.object({
  name: nonEmpty,
  expect: z.enum(["error", "digest_change", "blocked"])
}).strict();

const expectedSchema = z.object({
  /** Exact sha256 (or measured status tokens that are not bare "0"/"1" markers). */
  golden_digests: z.record(z.string().min(1).max(128), z.string().min(1).max(128))
}).strict();

export const po8FixtureManifestSchema = z.object({
  schema_version: z.literal(1),
  fixture_id: z.enum(PO8_FIXTURE_IDS),
  kind: nonEmpty,
  description: nonEmpty,
  project: z.record(z.string(), z.unknown()),
  authoring: authoringSchema,
  expected: expectedSchema,
  adversarial: z.array(adversarialCaseSchema).min(1),
  identity: z.object({
    locked_true_implies_verified: z.literal(false),
    definition_confirmation_inferred_from_gate1: z.literal(false)
  }).strict().optional(),
  safety_expectations: z.array(nonEmpty).min(1)
}).strict();

export type Po8FixtureManifest = z.infer<typeof po8FixtureManifestSchema> & {
  /** sha256 of raw fixture file bytes (authoritative bind for all module evidence). */
  fixture_digest: string;
  /** Absolute real path of the fixture file (internal only; not serialized to status). */
  fixture_path: string;
};

const REPO_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/production-control/po8"
);

/** Digest a stable seed string into lowercase sha256 (fixture authoring only). */
export function seedDigest(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

export function buildRouteFromAuthoring(route: z.infer<typeof routeAuthoringSchema>) {
  const base = {
    ir_model: route.ir_model,
    provider_model: route.provider_model,
    model_profile_digest: seedDigest(route.model_profile_seed),
    connection_id: route.connection_id,
    connection_digest: seedDigest(route.connection_seed),
    adapter_id: route.adapter_id,
    transport: route.transport,
    mode_binding: route.mode_binding
  };
  return {
    ...base,
    route_digest: sha256Canonical(base)
  };
}

export async function loadPo8Fixture(fixtureId: Po8FixtureId): Promise<Po8FixtureManifest> {
  const path = join(REPO_FIXTURE_ROOT, `${fixtureId}.fixture.json`);
  const real = await realpath(path);
  const stat = await lstat(real);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", `fixture must be a regular file: ${fixtureId}`);
  }
  const bytes = await readFile(real);
  const fixture_digest = sha256Bytes(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw pcError("PC_SCHEMA_INVALID", `fixture JSON parse failed: ${fixtureId}`);
  }
  const result = po8FixtureManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      `fixture schema invalid: ${fixtureId}: ${result.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  if (result.data.fixture_id !== fixtureId) {
    throw pcError(
      "PC_SCHEMA_INVALID",
      `fixture id mismatch: expected ${fixtureId}, got ${result.data.fixture_id}`
    );
  }
  // Reject bare marker-only goldens like "0"/"1" alone for measured digests
  for (const [key, value] of Object.entries(result.data.expected.golden_digests)) {
    if (value === "0" || value === "1") {
      throw pcError(
        "PC_SCHEMA_INVALID",
        `fixture golden digest ${key} must not be bare marker "0"/"1"`
      );
    }
  }
  return {
    ...result.data,
    fixture_digest,
    fixture_path: real
  };
}

export function assertGoldenDigests(
  fixture: Po8FixtureManifest,
  actual: Record<string, string>
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(fixture.expected.golden_digests)) {
    const got = actual[key];
    if (got === undefined) {
      mismatches.push(`missing actual digest: ${key}`);
    } else if (got !== expected) {
      mismatches.push(`${key}: expected ${expected}, got ${got}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
