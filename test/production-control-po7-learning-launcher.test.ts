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
  assertProductionCompletionDigestMatch,
  assertProposalNotBindableToMission,
  assertSafetySlosZero,
  assertSingleProvenanceWindow,
  buildProductionCompletionDigest,
  buildProductionCompletionRecord,
  compileRuleSetForNewMission,
  coordinationEvidenceOnly,
  createLearningCandidate,
  createPromotionProposal,
  decidePromotionProposal,
  excludeControlPlaneFromDeletionCandidates,
  FEEDBACK_API_BRIDGE_ONLY,
  hasCoordinationControlPlane,
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
  resolveAuthoritativeProductionId,
  runLearningExperiment,
  safetySloViolations,
  sanitizeMissionTreePublicProjection,
  sha256Canonical,
  createInitialMissionState,
  SnapshotStore,
  type HumanDecisionRef,
  type LearningCandidateV1,
  type MissionState
} from "../src/productionControl/index.js";
import { buildPlanDigest } from "../src/orchestrator/finalizePlanHelpers.js";
import { createViewerWorkflow } from "../src/viewer/workflow.js";

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
    })).toThrow(/cannot self-approve|cannot approve/);
    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human("approve-promotion", subject, "coordinator")
    })).toThrow(/cannot self-approve/);
    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human("approve-promotion", subject, "coordinator-self")
    })).toThrow(/cannot self-approve/);

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

  it("emits safety SLO zeros only with digest-backed proof and flags unknown/nonzero", () => {
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
      safety_proof: {
        observed: true,
        event_store_digest: DIGEST_A,
        grant_ledger_digest: DIGEST_B,
        gate_evidence_digest: DIGEST_A,
        source_event_sequence: 1
      }
    });
    expect(() => assertSafetySlosZero(withProof)).not.toThrow();
    expect(safetySloViolations(withProof)).toEqual([]);
    expect(withProof.safety.silent_paid_spend.value).toBe(0);
    expect(withProof.safety.unauthorized_auto_approval.value).toBe(0);
    expect(withProof.safety.unauthorized_submit.value).toBe(0);
    expect(withProof.safety.over_budget_execution.value).toBe(0);

    // observed:true alone is NOT proof of zero.
    const observedOnly = projectMissionMetrics({
      production_id: "prod-observed-only",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "fixture-run",
        population: "adversarial",
        provenance: "fixture"
      },
      safety_proof: { observed: true } as never
    });
    expect(observedOnly.safety.silent_paid_spend.value).toBeNull();
    expect(safetySloViolations(observedOnly).some((item) => item.includes("unknown"))).toBe(true);

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

  it("derives human interventions from decision events, not awaiting nodes", () => {
    const state = missionWithStatuses("prod-int", [
      { id: "await-1", status: "awaiting_human" },
      { id: "await-2", status: "awaiting_human" }
    ]);
    const fromEvents = projectMissionMetrics({
      production_id: "prod-int",
      tree_revision: 1,
      source_event_sequence: 2,
      computed_at: NOW,
      evaluation_window: {
        period: "fixture-run",
        population: "decision events",
        provenance: "fixture"
      },
      mission_state: state,
      intervention_events: [
        {
          kind: "gate",
          decision_id: "g1",
          subject_digest: DIGEST_A,
          category: "mandatory_safety"
        },
        {
          kind: "gate",
          decision_id: "g1",
          subject_digest: DIGEST_A,
          category: "mandatory_safety"
        },
        {
          kind: "recovery",
          decision_id: "r1",
          subject_digest: DIGEST_B,
          category: "operational"
        }
      ]
    });
    expect(fromEvents.intervention.human_interventions_total.value).toBe(2);
    expect(fromEvents.intervention.mandatory_safety_interventions.value).toBe(1);
    expect(fromEvents.intervention.operational_interventions.value).toBe(1);

    const awaitingOnly = projectMissionMetrics({
      production_id: "prod-int-2",
      tree_revision: 1,
      source_event_sequence: 1,
      computed_at: NOW,
      evaluation_window: {
        period: "fixture-run",
        population: "awaiting nodes",
        provenance: "fixture"
      },
      mission_state: state
    });
    expect(awaitingOnly.intervention.human_interventions_total.value).toBeNull();
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
      safety_proof: {
        observed: true,
        event_store_digest: DIGEST_A,
        source_event_sequence: 1
      }
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
      safety_proof: {
        observed: true,
        event_store_digest: DIGEST_B,
        source_event_sequence: 1
      }
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
    expect(viewer.missionTree.taskTreeReadOnly).toBe(true);
    expect(viewer.missionTree.productionId).toBe("prod-tree");
    expect(viewer.missionTree.currentDecision.kind).toBe("awaiting_human");
    expect(viewer.nodes.some((node) => node.status === "waiting_approval")).toBe(true);
    // Gate subject must not be derived from TaskTree projection.
    expect(viewer.nodes.every((node) => node.details && (node.details as { approval?: unknown }).approval === undefined)).toBe(true);
    expect(JSON.stringify(viewer)).not.toMatch(/"mission_tree"/);
    expect(JSON.stringify(viewer)).toMatch(/"missionTree"/);
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
  it("matches actual production-path digests and DTO goldens", async () => {
    const fixtureRoot = join(process.cwd(), "test/fixtures/production-control/po7");
    const candidate = makeCandidate({ candidate_id: "cand-golden", key: "caption-overflow" });
    const experiment = runLearningExperiment({
      experiment_id: "exp-golden",
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
    const proposal = createPromotionProposal({
      proposal_id: "prop-golden",
      candidate,
      experiments: [experiment],
      proposed_patch_digest: DIGEST_A,
      rollback_ref: "src/qa/caption-bounds.ts.prev",
      compatibility_impact: "additive"
    });

    const learningGolden = JSON.parse(
      await readFile(join(fixtureRoot, "learning-loop.golden.json"), "utf8")
    ) as {
      candidate_digest: string;
      experiment_digest: string;
      proposal_digest: string;
      proposal_subject_digest: string;
      feedback_api_bridge_only: boolean;
    };
    expect(learningGolden.candidate_digest).toBe(candidate.digest);
    expect(learningGolden.experiment_digest).toBe(experiment.digest);
    expect(learningGolden.proposal_digest).toBe(proposal.digest);
    expect(learningGolden.proposal_subject_digest).toBe(proposalSubjectDigest(proposal));
    expect(learningGolden.feedback_api_bridge_only).toBe(true);

    const state = missionWithStatuses("fixture-mission", [
      { id: "task-closeout", status: "awaiting_human" }
    ]);
    const learning = projectLearningStatus({
      production_id: "fixture-mission",
      candidates: [candidate],
      proposals: [proposal]
    });
    const projection = projectMissionTree({
      production_id: "fixture-mission",
      mode: "active",
      mission_state: state,
      learning,
      recovery: { active: false, attempts: 0, limit: 2 },
      legacy_workflow_preserved: true
    });
    const viewer = missionTreeToViewerWorkflow(projection, { name: "fixture" });
    const launcherGolden = JSON.parse(
      await readFile(join(fixtureRoot, "launcher-mission-tree.dto.json"), "utf8")
    ) as {
      missionTree: { productionId: string; mode: string; digest: string; taskTreeReadOnly: true };
      node_count: number;
    };
    expect(launcherGolden.missionTree.productionId).toBe(viewer.missionTree.productionId);
    expect(launcherGolden.missionTree.mode).toBe("active");
    expect(launcherGolden.missionTree.digest).toBe(viewer.missionTree.digest);
    expect(launcherGolden.missionTree.taskTreeReadOnly).toBe(true);
    expect(launcherGolden.node_count).toBe(viewer.nodes.length);
    // Payload must use camelCase missionTree key only (snake mission_tree is forbidden).
    expect(JSON.stringify(viewer)).toMatch(/"missionTree"/);
    expect(JSON.stringify(viewer)).not.toMatch(/"mission_tree"\s*:/);

    const metrics = projectMissionMetrics({
      production_id: "fixture-metrics",
      tree_revision: 1,
      source_event_sequence: 3,
      computed_at: NOW,
      evaluation_window: {
        period: "2026-08-01/2026-08-12",
        population: "fixture lyric-mv",
        provenance: "fixture"
      },
      intervention_events: [
        { kind: "gate", decision_id: "g1", subject_digest: DIGEST_A, category: "mandatory_safety" }
      ],
      safety_proof: {
        observed: true,
        event_store_digest: DIGEST_A,
        source_event_sequence: 3
      }
    });
    const metricsGolden = JSON.parse(
      await readFile(join(fixtureRoot, "metrics.golden.json"), "utf8")
    ) as {
      metrics_digest: string;
      safety_silent_paid_spend: number;
      human_interventions_total: number;
      unknown_is_not_zero: boolean;
    };
    expect(metricsGolden.metrics_digest).toBe(metrics.digest);
    expect(metricsGolden.safety_silent_paid_spend).toBe(0);
    expect(metricsGolden.human_interventions_total).toBe(1);
    expect(metricsGolden.unknown_is_not_zero).toBe(true);

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
    const finalizeGolden = JSON.parse(
      await readFile(join(fixtureRoot, "finalize-retention.golden.json"), "utf8")
    ) as {
      plan_digest: string;
      production_completion_digest: string;
      retained_classes: string[];
    };
    expect(finalizeGolden.plan_digest).toBe(planDigest);
    expect(finalizeGolden.production_completion_digest).toBe(completion);
    expect(finalizeGolden.production_completion_digest).not.toBe(planDigest);
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

describe("PO-7 production path wiring", () => {
  it("keeps feedback-only evidence from flipping control-plane finalize gate", () => {
    expect(FEEDBACK_API_BRIDGE_ONLY).toBe(true);
    const feedbackOnly = [
      { kind: "feedback" as const, relative_path: "feedback.jsonl", retained: true as const },
      { kind: "feedback" as const, relative_path: "LESSONS.md", retained: true as const }
    ];
    expect(hasCoordinationControlPlane(feedbackOnly)).toBe(false);
    expect(coordinationEvidenceOnly(feedbackOnly)).toEqual([]);
    assertProductionCompletionDigestMatch({ has_control_plane: false });
    expect(() => assertProductionCompletionDigestMatch({
      has_control_plane: false,
      expected: DIGEST_A
    })).toThrow();

    const withCoordination = [
      ...feedbackOnly,
      { kind: "events" as const, relative_path: "coordination/events.jsonl", retained: true as const }
    ];
    expect(hasCoordinationControlPlane(withCoordination)).toBe(true);
    expect(coordinationEvidenceOnly(withCoordination)).toEqual([
      { kind: "events", relative_path: "coordination/events.jsonl", retained: true }
    ]);
  });

  it("wires active Mission Tree through createViewerWorkflow camelCase DTO only", async () => {
    const state = missionWithStatuses("prod-viewer", [
      { id: "task-a", status: "awaiting_human" }
    ]);
    const projection = projectMissionTree({
      production_id: "prod-viewer",
      mode: "active",
      mission_state: state,
      legacy_workflow_preserved: true
    });
    // Minimal plan: active path only needs run_id; legacy byte-stability covered by viewer-workflow tests.
    const plan = { run_id: "run-viewer" } as never;
    const project = {
      slug: "prod-viewer",
      name: "Viewer Active",
      version: 1,
      dist_dir: "dist",
      manifest: "manifest.json",
      run_id: "run-viewer"
    } as never;

    const active = createViewerWorkflow(project, plan, undefined, {}, { missionTree: projection });
    expect(active.missionTree?.mode).toBe("active");
    expect(active.missionTree?.taskTreeReadOnly).toBe(true);
    expect(active.missionTree?.currentDecision.kind).toBe("awaiting_human");
    expect(active.nodes.some((node) => node.id === "task-a")).toBe(true);
    expect(JSON.stringify(active)).toMatch(/"missionTree"/);
    expect(JSON.stringify(active)).not.toMatch(/"mission_tree"\s*:/);
    // TaskTree must not inject Gate approval subjects.
    expect(JSON.stringify(active.nodes)).not.toMatch(/decision_digest|approved_input_digest/);

    // Shadow projection must not rewrite legacy createViewerWorkflow path.
    const shadow = projectMissionTree({
      production_id: "prod-viewer",
      mode: "shadow",
      mission_state: state
    });
    // createViewerWorkflow ignores non-active mission trees (no throw, no rewrite).
    // Use a real plan fixture from viewer-workflow when testing legacy; here only assert active-only helper.
    expect(() => missionTreeToViewerWorkflow(shadow)).toThrow(/active-mode only/);
  });

  it("sanitizes Gate subject/decision digests from public MissionTree projection only", () => {
    const state = missionWithStatuses("prod-sanitize", [
      { id: "task-a", status: "ready" }
    ]);
    state.gate_bindings.g1 = {
      binding_id: "g1",
      gate: "gate_1",
      subject_digest: DIGEST_A,
      decision_digest: DIGEST_B,
      stale: false
    };
    const projection = projectMissionTree({
      production_id: "prod-sanitize",
      mode: "active",
      mission_state: state
    });
    expect(projection.gates.find((gate) => gate.gate === "gate_1")?.status).toBe("current");
    expect(projection.gates.every((gate) =>
      !("subject_digest" in gate) && !("decision_digest" in gate)
    )).toBe(true);
    expect(JSON.stringify(projection)).not.toMatch(/subject_digest|decision_digest/);
    // Sanitizer is idempotent and never rewrites Gate approval algorithms (digests stay as authority-plane data).
    const again = sanitizeMissionTreePublicProjection(projection);
    expect(again.digest).toBe(projection.digest);
    // Authority-plane digests on state remain untouched.
    expect(state.gate_bindings.g1.subject_digest).toBe(DIGEST_A);
    expect(state.gate_bindings.g1.decision_digest).toBe(DIGEST_B);

    const viewer = missionTreeToViewerWorkflow(projection);
    expect(JSON.stringify(viewer)).not.toMatch(/subject_digest|decision_digest|approved_input_digest/);
  });

  it("binds finalize production_id to coordination snapshot over project.slug", async () => {
    const root = await realTempDir("tsugite-po7-prod-id-");
    try {
      const state = createInitialMissionState("coord-production-id");
      state.mission_status = "ready";
      state.tree_revision = 1;
      state.applied_event_sequence = 1;
      state.applied_event_digest = DIGEST_A;
      await new SnapshotStore(join(root, "coordination")).write(state, null);

      const resolved = await resolveAuthoritativeProductionId(root, { slug: "project-slug-only" });
      expect(resolved).toBe("coord-production-id");
      expect(resolved).not.toBe("project-slug-only");

      const planDigest = DIGEST_A;
      const evidence = [{
        kind: "events" as const,
        relative_path: "coordination/events.jsonl",
        retained: true as const
      }];
      const fromCoordination = buildProductionCompletionDigest({
        production_id: resolved,
        plan_digest: planDigest,
        evidence_refs: evidence
      });
      const fromSlug = buildProductionCompletionDigest({
        production_id: "project-slug-only",
        plan_digest: planDigest,
        evidence_refs: evidence
      });
      // Adversarial: wrong identity produces a different completion digest (fail-closed on apply).
      expect(fromCoordination).not.toBe(fromSlug);

      // Legacy fallback when coordination is absent.
      const emptyRoot = await realTempDir("tsugite-po7-prod-id-legacy-");
      try {
        const legacy = await resolveAuthoritativeProductionId(emptyRoot, { slug: "legacy-slug" });
        expect(legacy).toBe("legacy-slug");
      } finally {
        await rm(emptyRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
