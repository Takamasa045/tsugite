/**
 * PO-7 / T08 — Learning loop, metrics, Mission Tree projection, finalize retention.
 * Fixture-only: no provider, network, generation, billing, Gate mutation, render, finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyApprovedPromotion,
  assertDoesNotMutatePinnedMission,
  assertProposalNotBindableToMission,
  assertSafetySlosZero,
  assertSingleProvenanceWindow,
  buildProductionCompletionDigest,
  buildProductionCompletionRecord,
  compileRuleSetForNewMission,
  createLearningCandidate,
  createPromotionProposal,
  decidePromotionProposal,
  excludeControlPlaneFromDeletionCandidates,
  isControlPlaneRetainedPath,
  isExactKeyRecurring,
  isExperimentApplyEligible,
  LearningArtifactStore,
  legacyNotRecorded,
  missionTreeToViewerWorkflow,
  parseLearningCandidate,
  parseLearningExperiment,
  parseMissionMetrics,
  parseMissionTreePublicProjection,
  parsePromotionProposal,
  projectLearningStatus,
  projectMissionMetrics,
  projectMissionTree,
  proposalSubjectDigest,
  runLearningExperiment,
  safetySloViolations,
  sha256Canonical,
  createInitialMissionState,
  type HumanDecisionRef,
  type LearningCandidateV1,
  type MissionState
} from "../src/productionControl/index.js";
import { buildPlanDigest } from "../src/orchestrator/finalizePlanHelpers.js";

const NOW = "2026-08-12T12:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

function human(decision: string, subject_digest: string, actor = "human-reviewer"): HumanDecisionRef {
  return {
    decision_id: `dec-${decision}`,
    decision,
    actor,
    decided_at: NOW,
    subject_digest
  };
}

function makeCandidate(overrides: Partial<{
  candidate_id: string;
  key: string;
  observation_count: number;
}> = {}): LearningCandidateV1 {
  const key = overrides.key ?? "caption-overflow";
  const observation_count = overrides.observation_count ?? 2;
  const observations = Array.from({ length: observation_count }, (_, index) => ({
    id: `obs-${index + 1}`,
    key,
    summary: `caption overflow case ${index + 1}`,
    stage: "recurring" as const,
    evidence: [`qa/gate2-qc-${index + 1}.json`]
  }));
  const created = createLearningCandidate({
    candidate_id: overrides.candidate_id ?? "cand-caption-1",
    observations,
    feedback_keys: [key],
    symptom: "caption overflows frame on vertical export",
    hypothesized_cause: "line-break rule ignores safe margin",
    proposed_rule: {
      target_kind: "validator",
      target_ref: "src/qa/caption-bounds.ts",
      scope: "vertical-caption",
      minimal_change: "reject captions exceeding safe margin"
    },
    invariants: ["no Gate auto-approval", "no secret in public DTO"],
    experiment_requirements: ["fixture replay of vertical caption sample"],
    semantic_matches_advisory: ["similar wrap issue on another project"]
  });
  if (created.status !== "created") {
    throw new Error(created.reasons.join("; "));
  }
  return created.candidate;
}

function missionWithStatuses(
  productionId: string,
  nodes: Array<{ id: string; status: MissionState["nodes"][string]["status"]; stale?: boolean }>
): MissionState {
  const state = createInitialMissionState(productionId);
  state.mission_status = "ready";
  state.tree_revision = 1;
  state.applied_event_sequence = 1;
  state.applied_event_digest = DIGEST_A;
  for (const node of nodes) {
    state.nodes[node.id] = {
      node_id: node.id,
      status: node.status,
      task_revision: 1,
      input_digest: DIGEST_A,
      dependency_closure_digest: DIGEST_B,
      stale: node.stale ?? node.status === "stale"
    };
  }
  return state;
}

describe("PO-7 learning loop", () => {
  it("marks exact feedback-key recurrence and keeps semantic matches advisory", () => {
    const candidate = makeCandidate({ observation_count: 2 });
    expect(isExactKeyRecurring(candidate)).toBe(true);
    expect(candidate.recurrence.exact_key_count).toBe(2);
    expect(candidate.recurrence.semantic_matches_advisory).toEqual([
      "similar wrap issue on another project"
    ]);

    const single = makeCandidate({ candidate_id: "cand-single", observation_count: 1 });
    expect(isExactKeyRecurring(single)).toBe(false);
    expect(single.recurrence.exact_key_count).toBe(1);
  });

  it("refuses candidate creation when observation or rule target is insufficient", () => {
    const result = createLearningCandidate({
      candidate_id: "cand-empty",
      observations: [],
      feedback_keys: ["x"],
      symptom: "s",
      hypothesized_cause: "c",
      proposed_rule: {
        target_kind: "lesson",
        target_ref: "LESSONS.md",
        scope: "s",
        minimal_change: "m"
      },
      invariants: ["i"],
      experiment_requirements: ["e"]
    });
    expect(result.status).toBe("insufficient");
  });

  it("rejects secret or absolute path content in candidate free text", () => {
    const result = createLearningCandidate({
      candidate_id: "cand-secret",
      observations: [{
        id: "obs-1",
        key: "leak",
        summary: "s",
        stage: "observed",
        evidence: ["qa/x.json"]
      }],
      feedback_keys: ["leak"],
      symptom: "saw key sk-abcdefghijklmnop",
      hypothesized_cause: "logged /Users/me/secret",
      proposed_rule: {
        target_kind: "lesson",
        target_ref: "LESSONS.md",
        scope: "s",
        minimal_change: "do not log secrets"
      },
      invariants: ["no secret"],
      experiment_requirements: ["fixture"]
    });
    expect(result.status).toBe("insufficient");
  });

  it("runs fixture→replay→shadow experiments and never treats validated as apply", () => {
    const candidate = makeCandidate();
    const fixture = runLearningExperiment({
      experiment_id: "exp-fixture",
      candidate,
      mode: "fixture",
      baseline_ref: { kind: "fixture", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "fixture", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "caption-overflow-count", comparator: "lte", threshold: 0 }],
      safety_invariants: ["silent_paid_spend=0"],
      metric_samples: [{
        metric_id: "caption-overflow-count",
        value: 0,
        provenance: "fixture"
      }]
    });
    expect(fixture.result?.status).toBe("validated");
    expect(isExperimentApplyEligible(fixture)).toBe(false);

    const unknown = runLearningExperiment({
      experiment_id: "exp-unknown",
      candidate,
      mode: "replay",
      baseline_ref: { kind: "replay", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "replay", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "caption-overflow-count", comparator: "lte", threshold: 0 }],
      safety_invariants: ["silent_paid_spend=0"],
      metric_samples: [{
        metric_id: "caption-overflow-count",
        value: null,
        provenance: "replay"
      }]
    });
    expect(unknown.result?.status).toBe("inconclusive");

    const rejected = runLearningExperiment({
      experiment_id: "exp-fail",
      candidate,
      mode: "shadow",
      baseline_ref: { kind: "shadow", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "shadow", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "caption-overflow-count", comparator: "lte", threshold: 0 }],
      safety_invariants: ["silent_paid_spend=0"],
      metric_samples: [{
        metric_id: "caption-overflow-count",
        value: 3,
        provenance: "shadow"
      }]
    });
    expect(rejected.result?.status).toBe("rejected");

    expect(() => runLearningExperiment({
      experiment_id: "exp-mix",
      candidate,
      mode: "fixture",
      baseline_ref: { kind: "fixture", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "fixture", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "x", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "x", value: 1, provenance: "production" }]
    })).toThrow(/must not mix production metrics/);
  });

  it("requires human approval before apply and binds only to new missions", () => {
    const candidate = makeCandidate();
    const experiment = runLearningExperiment({
      experiment_id: "exp-ok",
      candidate,
      mode: "fixture",
      baseline_ref: { kind: "fixture", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "fixture", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "caption-overflow-count", comparator: "lte", threshold: 0 }],
      safety_invariants: ["silent_paid_spend=0"],
      metric_samples: [{
        metric_id: "caption-overflow-count",
        value: 0,
        provenance: "fixture"
      }]
    });

    const pending = createPromotionProposal({
      proposal_id: "prop-1",
      candidate,
      experiments: [experiment],
      proposed_patch_digest: DIGEST_A,
      rollback_ref: "src/qa/caption-bounds.ts.prev",
      compatibility_impact: "additive"
    });
    expect(pending.status).toBe("pending-human");
    expect(() => assertProposalNotBindableToMission(pending)).toThrow(/cannot bind/);

    const subject = proposalSubjectDigest(pending);
    const approved = decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human("approve-promotion", subject)
    });
    expect(approved.status).toBe("approved");

    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human("approve-promotion", subject, "learning")
    })).toThrow(/cannot approve/);

    const applied = applyApprovedPromotion({
      proposal: approved,
      rule_id: "rule-caption-margin",
      revision: 1,
      created_at: NOW,
      target_kind: "validator",
      change_summary: "enforce vertical caption margin"
    });
    expect(applied.proposal.status).toBe("applied");
    expect(applied.rule_revision.digest).toMatch(/^[a-f0-9]{64}$/);

    const ruleSet = compileRuleSetForNewMission({
      rule_set_id: "ruleset-1",
      production_id: "prod-new",
      applied_revisions: [applied.rule_revision],
      compiled_at: NOW
    });
    expect(ruleSet.rule_revisions).toHaveLength(1);

    expect(() => assertDoesNotMutatePinnedMission({
      pinned_rule_set_digest: DIGEST_A,
      existing_mission_ids: ["prod-old"],
      new_rule_set: {
        ...ruleSet,
        production_id: "prod-old",
        digest: sha256Canonical({
          schema_version: 1,
          rule_set_id: ruleSet.rule_set_id,
          production_id: "prod-old",
          rule_revisions: ruleSet.rule_revisions,
          compiled_at: ruleSet.compiled_at
        })
      }
    })).toThrow(/retroactively/);
  });

  it("persists learning artifacts append-only with digest and refuses overwrite", async () => {
    const root = await realTempDir("tsugite-po7-learning-");
    try {
      const store = new LearningArtifactStore(root);
      const candidate = makeCandidate();
      const first = await store.append("candidate", candidate);
      expect(first.digest).toBe(candidate.digest);
      await expect(store.append("candidate", candidate)).rejects.toThrow(/already exists/);
      const loaded = await store.read("candidate", candidate.candidate_id);
      expect(parseLearningCandidate(loaded).digest).toBe(candidate.digest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-7 deterministic metrics", () => {
  it("keeps unknown values null and never coerces them to 0", () => {
    const metrics = projectMissionMetrics({
      production_id: "prod-metrics",
      tree_revision: 2,
      source_event_sequence: 5,
      computed_at: NOW,
      evaluation_window: {
        period: "2026-08-01/2026-08-12",
        population: "fixture lyric-mv",
        provenance: "fixture"
      },
      observations: {
        cost: {
          actual_generation_credits: null,
          zero_credit_local: false
        }
      }
    });
    expect(metrics.cost.actual_generation_credits.value).toBeNull();
    expect(metrics.cost.actual_generation_credits.value).not.toBe(0);
    expect(metrics.flow.resume_success_rate.value).toBeNull();
    expect(metrics.recovery.automatic_recovery_success_rate.value).toBeNull();
  });

  it("emits safety SLO zeros only with proof and flags unknown/nonzero", () => {
    const withProof = projectMissionMetrics({
      production_id: "prod-safe",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "fixture-run",
        population: "recovery suite",
        provenance: "fixture"
      },
      safety_proof: { observed: true }
    });
    expect(() => assertSafetySlosZero(withProof)).not.toThrow();
    expect(safetySloViolations(withProof)).toEqual([]);
    expect(withProof.safety.silent_paid_spend.value).toBe(0);
    expect(withProof.safety.unauthorized_auto_approval.value).toBe(0);
    expect(withProof.safety.unauthorized_submit.value).toBe(0);
    expect(withProof.safety.over_budget_execution.value).toBe(0);

    const unknown = projectMissionMetrics({
      production_id: "prod-unknown-safety",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "historical",
        population: "legacy",
        provenance: "legacy_not_recorded"
      }
    });
    expect(unknown.safety.silent_paid_spend.provenance).toBe("legacy_not_recorded");
    expect(unknown.safety.silent_paid_spend.value).toBeNull();
    expect(safetySloViolations(unknown).some((item) => item.includes("unknown"))).toBe(true);

    const bad = projectMissionMetrics({
      production_id: "prod-bad-safety",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "fixture-run",
        population: "adversarial",
        provenance: "fixture"
      },
      observations: {
        safety: { silent_paid_spend: 1 }
      }
    });
    expect(safetySloViolations(bad)).toContain("silent_paid_spend:1");
  });

  it("refuses mixing fixture/replay metrics with production provenance", () => {
    const fixture = projectMissionMetrics({
      production_id: "prod-a",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "p1",
        population: "fixture",
        provenance: "fixture"
      },
      safety_proof: { observed: true }
    });
    const production = projectMissionMetrics({
      production_id: "prod-b",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "p1",
        population: "production",
        provenance: "production"
      },
      safety_proof: { observed: true }
    });
    expect(() => assertSingleProvenanceWindow([fixture, production])).toThrow(/must not be mixed/);
    expect(assertSingleProvenanceWindow([fixture])).toBe("fixture");
  });

  it("preserves legacy_not_recorded semantics for historical gaps", () => {
    const measured = legacyNotRecorded("pre-v0.10");
    expect(measured.value).toBeNull();
    expect(measured.provenance).toBe("legacy_not_recorded");
    const metrics = parseMissionMetrics(projectMissionMetrics({
      production_id: "prod-legacy",
      tree_revision: 0,
      source_event_sequence: 0,
      computed_at: NOW,
      evaluation_window: {
        period: "pre-v0.10",
        population: "historical",
        provenance: "legacy_not_recorded"
      }
    }));
    expect(metrics.intervention.human_interventions_total.provenance).toBe("legacy_not_recorded");
  });
});

describe("PO-7 Mission Tree public projection", () => {
  it("projects current decision states without secrets or Gate subject pollution", () => {
    const state = missionWithStatuses("prod-tree", [
      { id: "task-edit", status: "completed" },
      { id: "task-gate", status: "awaiting_human" }
    ]);
    state.gate_bindings.g1 = {
      binding_id: "g1",
      gate: "gate_1",
      subject_digest: DIGEST_A,
      decision_digest: DIGEST_B,
      stale: false
    };

    const learning = projectLearningStatus({
      production_id: "prod-tree",
      candidates: [makeCandidate()],
      proposals: []
    });

    const projection = projectMissionTree({
      production_id: "prod-tree",
      mode: "active",
      mission_state: state,
      learning,
      recovery: { active: false, attempts: 0, limit: 2 },
      legacy_workflow_preserved: true
    });

    expect(projection.task_tree_read_only).toBe(true);
    expect(projection.legacy_workflow_preserved).toBe(true);
    expect(projection.current_decision.kind).toBe("awaiting_human");
    expect(projection.nodes.find((node) => node.node_id === "task-gate")?.status).toBe("awaiting_human");
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/"prompt"\s*:/);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toMatch(/provider_response/);

    const strict = parseMissionTreePublicProjection(projection);
    expect(strict.digest).toBe(projection.digest);

    const viewer = missionTreeToViewerWorkflow(projection, { name: "Active Mission" });
    expect(viewer.mission_tree.task_tree_read_only).toBe(true);
    expect(viewer.nodes.some((node) => node.status === "waiting_approval")).toBe(true);
    // Gate subject must not be derived from TaskTree projection.
    expect(viewer.nodes.every((node) => node.details && (node.details as { approval?: unknown }).approval === undefined)).toBe(true);
  });

  it("surfaces outcome_unknown and stale gate before generic progress", () => {
    const state = missionWithStatuses("prod-unknown", [
      { id: "gen-1", status: "outcome_unknown" },
      { id: "edit-1", status: "ready" }
    ]);
    state.gate_bindings.g2 = {
      binding_id: "g2",
      gate: "gate_2",
      subject_digest: DIGEST_A,
      decision_digest: DIGEST_B,
      stale: true
    };
    const projection = projectMissionTree({
      production_id: "prod-unknown",
      mode: "active",
      mission_state: state
    });
    expect(projection.current_decision.kind).toBe("outcome_unknown");
    expect(projection.gates.find((gate) => gate.gate === "gate_2")?.status).toBe("stale");
  });
});

describe("PO-7 finalize retention (preview only)", () => {
  it("keeps plan_digest independent from production_completion_digest", () => {
    const planDigest = buildPlanDigest({
      projectRoot: "/tmp/project",
      configPath: "/tmp/project/project.yaml",
      manifestPath: "/tmp/project/manifest.json",
      stateDir: "/tmp/project/dist",
      projectsHome: "/tmp/projects-home",
      destinationRoot: "/tmp/projects-home/project",
      alreadyHome: true,
      runId: "run-1",
      finalOutputDigest: DIGEST_A,
      gate3ApprovedInputDigest: DIGEST_A,
      retainedMedia: ["dist/run-1/final.mp4"],
      candidates: []
    });
    const completion = buildProductionCompletionDigest({
      production_id: "prod-final",
      plan_digest: planDigest,
      evidence_refs: [{
        kind: "metrics",
        relative_path: "coordination/metrics/mission-metrics.json",
        digest: DIGEST_B,
        retained: true
      }]
    });
    expect(completion).toMatch(/^[a-f0-9]{64}$/);
    expect(completion).not.toBe(planDigest);

    const record = buildProductionCompletionRecord({
      production_id: "prod-final",
      plan_digest: planDigest,
      evidence_refs: [{
        kind: "learning",
        relative_path: "coordination/learning/index.jsonl",
        retained: true
      }],
      metrics_digest: DIGEST_B
    });
    expect(record.plan_digest).toBe(planDigest);
    expect(record.production_completion_digest).toBe(
      buildProductionCompletionDigest({
        production_id: "prod-final",
        plan_digest: planDigest,
        metrics_digest: DIGEST_B,
        evidence_refs: record.control_plane_evidence
      })
    );
    expect(record.retained_classes).toEqual(expect.arrayContaining([
      "final-run", "manifest", "state", "run-log", "qa", "review",
      "feedback", "learning", "metrics", "completion-record", "contract", "events"
    ]));
  });

  it("never marks control-plane paths as deletion candidates", () => {
    expect(isControlPlaneRetainedPath("coordination/events.jsonl")).toBe(true);
    expect(isControlPlaneRetainedPath("feedback.jsonl")).toBe(true);
    expect(isControlPlaneRetainedPath("media/unused.mp4")).toBe(false);
    const filtered = excludeControlPlaneFromDeletionCandidates([
      "media/unused.mp4",
      "coordination/metrics/mission-metrics.json",
      "qa/old.jpg"
    ]);
    expect(filtered.candidates).toEqual(["media/unused.mp4", "qa/old.jpg"]);
    expect(filtered.retained_extra).toEqual(["coordination/metrics/mission-metrics.json"]);
  });

  it("lists retained control-plane files under a fixture project root", async () => {
    const root = await realTempDir("tsugite-po7-finalize-");
    try {
      await mkdir(join(root, "coordination", "metrics"), { recursive: true });
      await writeFile(join(root, "coordination", "metrics", "mission-metrics.json"), "{}\n");
      await writeFile(join(root, "feedback.jsonl"), "{}\n");
      const { listRetainedControlPlanePaths } = await import("../src/productionControl/finalizeRetention.js");
      const retained = await listRetainedControlPlanePaths(root);
      expect(retained).toEqual(expect.arrayContaining([
        "coordination/metrics/mission-metrics.json",
        "feedback.jsonl"
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-7 golden / migration fixtures", () => {
  it("matches checked-in learning and metrics golden fixtures", async () => {
    const fixtureRoot = join(process.cwd(), "test/fixtures/production-control/po7");
    const learningGolden = JSON.parse(
      await readFile(join(fixtureRoot, "learning-loop.golden.json"), "utf8")
    ) as {
      candidate_lifecycle: string[];
      validated_is_not_apply: boolean;
      approved_binds_new_mission_only: boolean;
    };
    expect(learningGolden.candidate_lifecycle).toEqual([
      "observed", "candidate", "awaiting-experiment", "experimenting",
      "validated", "rejected", "inconclusive", "awaiting-human",
      "approved", "declined", "applied", "monitored"
    ]);
    expect(learningGolden.validated_is_not_apply).toBe(true);
    expect(learningGolden.approved_binds_new_mission_only).toBe(true);

    const metricsGolden = JSON.parse(
      await readFile(join(fixtureRoot, "metrics.golden.json"), "utf8")
    ) as {
      safety_slo_target: number;
      unknown_is_not_zero: boolean;
      families: string[];
    };
    expect(metricsGolden.safety_slo_target).toBe(0);
    expect(metricsGolden.unknown_is_not_zero).toBe(true);
    expect(metricsGolden.families).toEqual(expect.arrayContaining([
      "flow", "intervention", "recovery", "consistency", "cost", "mv", "safety"
    ]));

    const finalizeGolden = JSON.parse(
      await readFile(join(fixtureRoot, "finalize-retention.golden.json"), "utf8")
    ) as {
      plan_digest_semantics_unchanged: boolean;
      production_completion_digest: string;
      retained_classes: string[];
    };
    expect(finalizeGolden.plan_digest_semantics_unchanged).toBe(true);
    expect(finalizeGolden.production_completion_digest).toBe("additive");
    expect(finalizeGolden.retained_classes).toEqual(expect.arrayContaining([
      "learning", "metrics", "completion-record"
    ]));
  });

  it("parses migration fixture without inventing identity confirmation", async () => {
    const fixture = JSON.parse(
      await readFile(
        join(process.cwd(), "test/fixtures/production-control/po7/migration-active.fixture.json"),
        "utf8"
      )
    ) as {
      mode: string;
      identity_definition_status: string;
      identity_verification_status: string;
      identity_locked_true_implies_verified: boolean;
    };
    expect(fixture.mode).toBe("active");
    expect(fixture.identity_definition_status).toBe("awaiting_human");
    expect(fixture.identity_verification_status).toBe("not-evaluable");
    expect(fixture.identity_locked_true_implies_verified).toBe(false);
  });
});

describe("PO-7 schema adversarial", () => {
  it("rejects promotion proposal schema with unknown fields and digest mismatch", () => {
    const candidate = makeCandidate();
    const experiment = runLearningExperiment({
      experiment_id: "exp-schema",
      candidate,
      mode: "fixture",
      baseline_ref: { kind: "fixture", id: "base", digest: DIGEST_A },
      candidate_ref: { kind: "fixture", id: "cand", digest: DIGEST_B },
      success_criteria: [{ metric_id: "x", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "x", value: 1, provenance: "fixture" }]
    });
    const pending = createPromotionProposal({
      proposal_id: "prop-schema",
      candidate,
      experiments: [experiment],
      proposed_patch_digest: DIGEST_A,
      rollback_ref: "rollback-ref",
      compatibility_impact: "none"
    });
    expect(() => parsePromotionProposal({ ...pending, extra: true })).toThrow();
    expect(() => parsePromotionProposal({ ...pending, digest: DIGEST_B })).toThrow();
    expect(() => parseLearningExperiment({ ...experiment, digest: DIGEST_A })).toThrow();
  });
});
