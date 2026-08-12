/**
 * PO-7 branch / adversarial coverage for learning, metrics, projection, retention.
 * Fixture-only.
 */
import { mkdtemp, realpath, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyApprovedPromotion,
  assertDoesNotMutatePinnedMission,
  assertExperimentDigest,
  assertCandidateDigest,
  assertProposalDigest,
  assertProposalNotBindableToMission,
  assertProductionCompletionDigestMatch,
  assertRuleSetDigest,
  assertValidatedDoesNotApply,
  buildProductionCompletionDigest,
  buildProductionCompletionRecord,
  compileRuleSetForNewMission,
  createInitialMissionState,
  createLearningCandidate,
  createPromotionProposal,
  decidePromotionProposal,
  excludeControlPlaneFromDeletionCandidates,
  isControlPlaneRetainedPath,
  isExactKeyRecurring,
  LearningArtifactStore,
  listRetainedControlPlanePaths,
  missionTreeToViewerWorkflow,
  parseLearningPublicProjection,
  parseMissionMetrics,
  parseMissionTreePublicProjection,
  parseProductionCompletionRecord,
  parseRuleRevision,
  parseRuleSetSnapshot,
  projectLearningStatus,
  projectMissionMetrics,
  projectMissionTree,
  proposalSubjectDigest,
  runLearningExperiment,
  ruleSetDigest,
  safetySloViolations,
  sha256Canonical,
  type HumanDecisionRef,
  type LearningCandidateV1,
  type LearningExperimentV1,
  type PromotionProposalV1
} from "../src/productionControl/index.js";

const NOW = "2026-08-12T15:00:00.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

async function tempRoot(): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, "tsugite-po7-cov-")));
}

function human(subject: string, actor = "human"): HumanDecisionRef {
  return {
    decision_id: "d1",
    decision: "approve",
    actor,
    decided_at: NOW,
    subject_digest: subject
  };
}

function candidate(id = "cand-cov", key = "key-cov", count = 2): LearningCandidateV1 {
  const observations = Array.from({ length: count }, (_, i) => ({
    id: `o${i + 1}`,
    key,
    summary: `s${i + 1}`,
    stage: "recurring" as const,
    evidence: [`qa/e${i + 1}.json`]
  }));
  const created = createLearningCandidate({
    candidate_id: id,
    observations,
    feedback_keys: [key],
    symptom: "symptom text",
    hypothesized_cause: "cause text",
    proposed_rule: {
      target_kind: "lesson",
      target_ref: "LESSONS.md",
      scope: "scope",
      minimal_change: "change"
    },
    invariants: ["inv"],
    experiment_requirements: ["req"]
  });
  if (created.status !== "created") throw new Error(created.reasons.join(","));
  return created.candidate;
}

function validatedExperiment(c: LearningCandidateV1, id: string): LearningExperimentV1 {
  return runLearningExperiment({
    experiment_id: id,
    candidate: c,
    mode: "fixture",
    baseline_ref: { kind: "fixture", id: "b", digest: A },
    candidate_ref: { kind: "fixture", id: "c", digest: B },
    success_criteria: [{ metric_id: "m1", comparator: "eq", threshold: 1 }],
    safety_invariants: ["s"],
    metric_samples: [{ metric_id: "m1", value: 1, provenance: "fixture" }]
  });
}

describe("PO-7 branch coverage — learning", () => {
  it("covers candidate validation failure branches", () => {
    expect(createLearningCandidate({
      candidate_id: "",
      observations: [{ id: "o1", key: "k", summary: "s", stage: "observed" }],
      feedback_keys: [],
      symptom: " ",
      hypothesized_cause: "",
      proposed_rule: { target_kind: "lesson", target_ref: "", scope: "", minimal_change: "" },
      invariants: [],
      experiment_requirements: []
    }).status).toBe("insufficient");

    expect(createLearningCandidate({
      candidate_id: "c1",
      observations: [{ id: "o1", key: "other", summary: "s", stage: "observed", evidence: ["../escape"] }],
      feedback_keys: ["k"],
      symptom: "s",
      hypothesized_cause: "c",
      proposed_rule: { target_kind: "template", target_ref: "templates/x.yaml", scope: "s", minimal_change: "m" },
      invariants: ["i"],
      experiment_requirements: ["e"]
    }).status).toBe("insufficient");

    expect(createLearningCandidate({
      candidate_id: "c2",
      observations: [{
        id: "o1",
        key: "k",
        summary: "s",
        stage: "observed",
        evidence: ["ok.json"],
        observation_digest: A
      }],
      feedback_keys: ["k"],
      symptom: "raw_prompt leaked",
      hypothesized_cause: "provider_response",
      proposed_rule: { target_kind: "runbook", target_ref: "docs/x.md", scope: "s", minimal_change: "m" },
      invariants: ["i"],
      experiment_requirements: ["e"]
    }).status).toBe("insufficient");

    const c = candidate("cand-assert");
    assertCandidateDigest(c);
    expect(isExactKeyRecurring(c)).toBe(true);
  });

  it("covers experiment comparators, safety reject, live authority, digests", () => {
    const c = candidate("cand-exp");
    for (const comparator of ["eq", "lte", "gte"] as const) {
      const exp = runLearningExperiment({
        experiment_id: `exp-${comparator}`,
        candidate: c,
        mode: "replay",
        baseline_ref: { kind: "r", id: "b", digest: A },
        candidate_ref: { kind: "r", id: "c", digest: B },
        success_criteria: [{ metric_id: "m", comparator, threshold: 5 }],
        safety_invariants: ["s"],
        metric_samples: [{ metric_id: "m", value: 5, provenance: "replay" }]
      });
      expect(exp.result?.status).toBe("validated");
      assertExperimentDigest(exp);
    }

    const safety = runLearningExperiment({
      experiment_id: "exp-safety",
      candidate: c,
      mode: "shadow",
      baseline_ref: { kind: "s", id: "b", digest: A },
      candidate_ref: { kind: "s", id: "c", digest: B },
      success_criteria: [{ metric_id: "m", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "m", value: 1, provenance: "shadow" }],
      safety_violations: ["silent_paid_spend"]
    });
    expect(safety.result?.status).toBe("rejected");

    expect(() => runLearningExperiment({
      experiment_id: "exp-live",
      candidate: c,
      mode: "live-approved",
      baseline_ref: { kind: "l", id: "b", digest: A },
      candidate_ref: { kind: "l", id: "c", digest: B },
      success_criteria: [{ metric_id: "m", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "m", value: 1, provenance: "production" }]
    })).toThrow(/authority/);

    const live = runLearningExperiment({
      experiment_id: "exp-live-ok",
      candidate: c,
      mode: "live-approved",
      baseline_ref: { kind: "l", id: "b", digest: A },
      candidate_ref: { kind: "l", id: "c", digest: B },
      success_criteria: [{ metric_id: "m", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "m", value: 1, provenance: "production" }],
      authority: human(A),
      includes_production_metrics: true
    });
    expect(live.mode).toBe("live-approved");
    assertValidatedDoesNotApply([live]);
  });

  it("covers promotion decline, self-approve forbid, mismatch, digests", () => {
    const c = candidate("cand-prom");
    const exp = validatedExperiment(c, "exp-prom");
    const pending = createPromotionProposal({
      proposal_id: "p1",
      candidate: c,
      experiments: [exp],
      proposed_patch_digest: A,
      rollback_ref: "rollback",
      compatibility_impact: "breaking"
    });
    assertProposalDigest(pending);
    expect(() => createPromotionProposal({
      proposal_id: "p-bad",
      candidate: c,
      experiments: [],
      proposed_patch_digest: A,
      rollback_ref: "r",
      compatibility_impact: "none"
    })).toThrow();

    const rejectedExp = runLearningExperiment({
      experiment_id: "exp-rej",
      candidate: c,
      mode: "fixture",
      baseline_ref: { kind: "f", id: "b", digest: A },
      candidate_ref: { kind: "f", id: "c", digest: B },
      success_criteria: [{ metric_id: "m", comparator: "eq", threshold: 1 }],
      safety_invariants: ["s"],
      metric_samples: [{ metric_id: "m", value: 2, provenance: "fixture" }]
    });
    expect(() => createPromotionProposal({
      proposal_id: "p-rej",
      candidate: c,
      experiments: [rejectedExp],
      proposed_patch_digest: A,
      rollback_ref: "r",
      compatibility_impact: "none"
    })).toThrow(/validated/);

    const subject = proposalSubjectDigest(pending);
    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human(B)
    })).toThrow(/subject_digest/);

    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human(subject, "critic")
    })).toThrow(/cannot self-approve|cannot approve/);
    expect(() => decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human(subject, "coordinator")
    })).toThrow(/cannot self-approve/);

    const declined = decidePromotionProposal({
      proposal: pending,
      outcome: "declined",
      decision: human(subject)
    });
    expect(declined.status).toBe("declined");
    expect(() => assertProposalNotBindableToMission(declined)).toThrow();
    expect(() => applyApprovedPromotion({
      proposal: declined,
      rule_id: "r1",
      revision: 1,
      created_at: NOW,
      target_kind: "lesson"
    })).toThrow();

    const approved = decidePromotionProposal({
      proposal: pending,
      outcome: "approved",
      decision: human(subject)
    });
    const applied = applyApprovedPromotion({
      proposal: approved,
      rule_id: "rule-1",
      revision: 2,
      created_at: NOW,
      target_kind: "compiler",
      change_summary: "patch",
      supersedes_revision: 1
    });
    expect(applied.rule_revision.supersedes_revision).toBe(1);
    parseRuleRevision(applied.rule_revision);

    const set = compileRuleSetForNewMission({
      rule_set_id: "set-1",
      applied_revisions: [applied.rule_revision],
      compiled_at: NOW
    });
    assertRuleSetDigest(set);
    expect(ruleSetDigest(set)).toBe(set.digest);
    assertDoesNotMutatePinnedMission({
      pinned_rule_set_digest: set.digest,
      existing_mission_ids: ["m1"],
      new_rule_set: set
    });
    assertDoesNotMutatePinnedMission({
      pinned_rule_set_digest: A,
      existing_mission_ids: [],
      new_rule_set: set
    });
    parseRuleSetSnapshot(set);
  });

  it("covers learning store list/read, unsafe id, and public projection statuses", async () => {
    const root = await tempRoot();
    try {
      const store = new LearningArtifactStore(root);
      const c = candidate("cand-store");
      await store.append("candidate", c);
      expect(await store.listIds("candidate")).toEqual(["cand-store"]);
      expect(await store.listIds("experiment")).toEqual([]);
      await expect(store.read("candidate", "../x")).rejects.toThrow();
      await expect(store.read("candidate", "missing")).rejects.toThrow();

      const exp = validatedExperiment(c, "exp-store");
      await store.append("experiment", exp);
      const pending = createPromotionProposal({
        proposal_id: "prop-store",
        candidate: c,
        experiments: [exp],
        proposed_patch_digest: A,
        rollback_ref: "rb",
        compatibility_impact: "additive"
      });
      await store.append("proposal", pending);
      const approved = decidePromotionProposal({
        proposal: pending,
        outcome: "approved",
        decision: human(proposalSubjectDigest(pending))
      });
      const applied = applyApprovedPromotion({
        proposal: approved,
        rule_id: "rule-store",
        revision: 1,
        created_at: NOW,
        target_kind: "lesson"
      });
      await store.append("rule-revision", applied.rule_revision);
      const set = compileRuleSetForNewMission({
        rule_set_id: "set-store",
        production_id: "prod-store",
        applied_revisions: [applied.rule_revision],
        compiled_at: NOW
      });
      await store.append("rule-set", set);

      const learningNone = projectLearningStatus({});
      expect(learningNone.status).toBe("none");
      const learningCand = projectLearningStatus({ candidates: [c] });
      expect(learningCand.status).toBe("candidate");
      const learningExp = projectLearningStatus({ experiments: [exp] });
      expect(learningExp.status).toBe("validated");
      const learningPending = projectLearningStatus({ proposals: [pending] });
      expect(learningPending.status).toBe("awaiting-human");
      const learningApplied = projectLearningStatus({
        production_id: "prod-store",
        candidates: [c],
        experiments: [exp],
        proposals: [applied.proposal],
        bound_rule_set: set
      });
      expect(learningApplied.status).toBe("applied");
      parseLearningPublicProjection(learningApplied);

      const declined = decidePromotionProposal({
        proposal: pending,
        outcome: "declined",
        decision: human(proposalSubjectDigest(pending))
      });
      expect(projectLearningStatus({ proposals: [declined] }).status).toBe("declined");

      const rejected = runLearningExperiment({
        experiment_id: "exp-r",
        candidate: c,
        mode: "fixture",
        baseline_ref: { kind: "f", id: "b", digest: A },
        candidate_ref: { kind: "f", id: "c", digest: B },
        success_criteria: [{ metric_id: "m", comparator: "eq", threshold: 0 }],
        safety_invariants: ["s"],
        metric_samples: [{ metric_id: "m", value: 1, provenance: "fixture" }]
      });
      expect(projectLearningStatus({ experiments: [rejected] }).status).toBe("rejected");

      const incomplete = {
        ...exp,
        result: undefined
      } as LearningExperimentV1;
      // incomplete experiment without result: projectLearningStatus sees experimenting only if result missing on object from store
      expect(projectLearningStatus({
        experiments: [{ ...exp, result: undefined } as unknown as LearningExperimentV1]
      }).status).toBe("experimenting");
      void incomplete;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PO-7 branch coverage — metrics and projection", () => {
  it("covers recovery rate zero denominator and MV optional path", () => {
    const metrics = projectMissionMetrics({
      production_id: "prod-m",
      tree_revision: 1,
      source_event_sequence: 2,
      computed_at: NOW,
      evaluation_window: { period: "p", population: "pop", provenance: "fixture" },
      mission_state: (() => {
        const s = createInitialMissionState("prod-m");
        s.mission_status = "ready";
        s.nodes.n1 = {
          node_id: "n1",
          status: "stale",
          task_revision: 1,
          input_digest: A,
          dependency_closure_digest: B,
          stale: true
        };
        s.nodes.n2 = {
          node_id: "n2",
          status: "awaiting_human",
          task_revision: 1,
          input_digest: A,
          dependency_closure_digest: B,
          stale: false
        };
        s.nodes.n3 = {
          node_id: "n3",
          status: "outcome_unknown",
          task_revision: 1,
          input_digest: A,
          dependency_closure_digest: B,
          stale: false
        };
        return s;
      })(),
      observations: {
        recovery: {
          eligible_recovery_attempts: 0,
          successful_recovery_attempts: 0
        },
        cost: { zero_credit_local: true, actual_generation_credits: 0 },
        mv: {
          lyric_timing_coverage: 1,
          beat_anchor_coverage: 0.5
        },
        consistency: {
          identity: {
            basis: "not-run",
            evidence_artifact_ids: [],
            ambiguity_codes: ["not-run"]
          },
          coverage: { evaluated_shots: 0, expected_shots: 2 }
        }
      },
      safety_proof: {
        observed: true,
        event_store_digest: A,
        grant_ledger_digest: B,
        source_event_sequence: 2
      }
    });
    expect(metrics.recovery.automatic_recovery_success_rate.value).toBeNull();
    expect(metrics.mv?.lyric_timing_coverage.value).toBe(1);
    expect(metrics.cost.zero_credit_local).toBe(true);
    // awaiting nodes must not become intervention counts without decision events
    expect(metrics.intervention.human_interventions_total.value).toBeNull();
    parseMissionMetrics(metrics);
    expect(safetySloViolations(metrics)).toEqual([]);
  });

  it("covers mission tree edges, blocked, completed, learning decision, viewer map", () => {
    const state = createInitialMissionState("prod-tree-2");
    state.mission_status = "completed";
    state.tree_revision = 2;
    state.applied_event_sequence = 2;
    state.applied_event_digest = A;
    state.nodes.t1 = {
      node_id: "t1",
      status: "blocked",
      task_revision: 1,
      input_digest: A,
      dependency_closure_digest: B,
      stale: false
    };
    state.nodes.t2 = {
      node_id: "t2",
      status: "completed",
      task_revision: 1,
      input_digest: A,
      dependency_closure_digest: B,
      stale: false
    };

    const tree = {
      schema_version: 1 as const,
      production_id: "prod-tree-2",
      tree_revision: 2,
      root_node_id: "mission-root",
      nodes: [
        {
          node_type: "mission" as const,
          node_id: "mission-root",
          aggregation: { kind: "all" as const },
          child_ids: ["t1", "t2"]
        },
        {
          node_type: "task" as const,
          node_id: "t1",
          parent_id: "mission-root",
          kind: "edit-and-compose" as const,
          role: "editor" as const,
          effect: "propose" as const,
          dependencies: [],
          required_contract_fragments: [],
          required_artifacts: [],
          output_schema: "CompositionPlan",
          risk_class: "low" as const,
          invalidation_tags: []
        },
        {
          node_type: "task" as const,
          node_id: "t2",
          parent_id: "mission-root",
          kind: "output-qa" as const,
          role: "critic" as const,
          effect: "propose" as const,
          dependencies: ["t1"],
          required_contract_fragments: [],
          required_artifacts: [],
          output_schema: "QaReport",
          risk_class: "low" as const,
          invalidation_tags: []
        }
      ],
      digest: A
    };
    // digest will be revalidated only if we parse; projectMissionTree uses tree as-is
    const blocked = projectMissionTree({
      production_id: "prod-tree-2",
      mode: "active",
      mission_state: state,
      task_tree: tree as never
    });
    expect(blocked.current_decision.kind).toBe("blocked");
    expect(blocked.edges.length).toBeGreaterThan(0);

    state.nodes.t1.status = "completed";
    const learning = projectLearningStatus({
      proposals: [{
        schema_version: 1,
        proposal_id: "p-wait",
        candidate_digest: A,
        experiment_digests: [B],
        proposed_patch_digest: C,
        target_ref: "t",
        compatibility_impact: "none",
        rollback_ref: "r",
        status: "pending-human",
        digest: A
      } as PromotionProposalV1]
    });
    // force learning pending for decision
    const done = projectMissionTree({
      production_id: "prod-tree-2",
      mode: "active",
      mission_state: state,
      learning
    });
    // blocked cleared → completed mission with learning may still show learning
    expect(["learning", "none"]).toContain(done.current_decision.kind);

    const viewer = missionTreeToViewerWorkflow(done);
    expect(viewer.id).toContain("mission-tree");
    expect(viewer.missionTree.taskTreeReadOnly).toBe(true);
    expect(JSON.stringify(viewer)).not.toMatch(/"mission_tree"/);
    parseMissionTreePublicProjection(done);

    const shadow = projectMissionTree({
      production_id: "prod-tree-2",
      mode: "shadow",
      mission_state: state
    });
    expect(() => missionTreeToViewerWorkflow(shadow)).toThrow(/active-mode only/);

    expect(() => projectMissionTree({
      production_id: "other",
      mode: "active",
      mission_state: state
    })).toThrow();
  });
});

describe("PO-7 branch coverage — finalize retention", () => {
  it("covers retention helpers and digest match matrix", async () => {
    expect(isControlPlaneRetainedPath("../x")).toBe(false);
    expect(isControlPlaneRetainedPath("/abs")).toBe(false);
    expect(isControlPlaneRetainedPath("coordination/learning/x.json")).toBe(true);
    expect(isControlPlaneRetainedPath("dist/run/mission-metrics.json")).toBe(true);
    expect(excludeControlPlaneFromDeletionCandidates([]).candidates).toEqual([]);

    assertProductionCompletionDigestMatch({ has_control_plane: false });
    expect(() => assertProductionCompletionDigestMatch({
      has_control_plane: false,
      expected: A
    })).toThrow();
    expect(() => assertProductionCompletionDigestMatch({
      has_control_plane: true
    })).toThrow();
    expect(() => assertProductionCompletionDigestMatch({
      has_control_plane: true,
      actual: A
    })).toThrow();
    expect(() => assertProductionCompletionDigestMatch({
      has_control_plane: true,
      actual: A,
      expected: B
    })).toThrow();
    assertProductionCompletionDigestMatch({
      has_control_plane: true,
      actual: A,
      expected: A
    });

    const record = buildProductionCompletionRecord({
      production_id: "p",
      plan_digest: A,
      evidence_refs: [{
        kind: "events",
        relative_path: "coordination/events.jsonl",
        retained: true
      }],
      contract_digest: B,
      task_tree_digest: C,
      event_sequence: 3
    });
    parseProductionCompletionRecord(record);
    expect(buildProductionCompletionDigest({
      production_id: "p",
      plan_digest: A,
      evidence_refs: record.control_plane_evidence,
      contract_digest: B,
      task_tree_digest: C,
      event_sequence: 3
    })).toBe(record.production_completion_digest);

    const root = await tempRoot();
    try {
      await mkdir(join(root, "coordination", "learning"), { recursive: true });
      await writeFile(join(root, "coordination", "learning", "index.jsonl"), "{}\n");
      await writeFile(join(root, "LESSONS.md"), "# x\n");
      // symlink should be skipped
      await symlink(join(root, "LESSONS.md"), join(root, "coordination", "learning", "link.json"));
      const paths = await listRetainedControlPlanePaths(root);
      expect(paths).toEqual(expect.arrayContaining([
        "coordination/learning/index.jsonl",
        "LESSONS.md"
      ]));
      expect(paths.some((p) => p.endsWith("link.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
