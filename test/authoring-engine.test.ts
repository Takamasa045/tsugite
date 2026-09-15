import { describe, expect, it } from "vitest";
import {
  acceptAuthoringBuild,
  approveAuthoringPlan,
  assertLocalRenderAllowed,
  assertPaidBuildAllowed,
  bindAuthoringPlan,
  createAuthoringEngineRun,
  markAuthoringIntentUnknown,
  persistAuthoringSubmissionIntent,
  recordAuthoringBuildOutcome,
  reviseAuthoringRun,
  unknownAuthoringCost,
  assertAuthoringRunIdle,
  invalidateAuthoringPlan
} from "../src/productionControl/authoringEngine.js";
import { ProductionControlError } from "../src/productionControl/errors.js";

const digest = "a".repeat(64);
const later = "b".repeat(64);

function run() {
  return createAuthoringEngineRun({
    production_id: "lab1",
    adapter_id: "authoring-adapter",
    brief_digest: digest,
    import_allowlist_digest: digest
  });
}

function plan(base = run(), extras: Record<string, unknown> = {}) {
  return bindAuthoringPlan(base, {
    source_files: [{ relative_path: "main.svml", sha256: digest, bytes: 12 }],
    asset_files: [],
    plan_output_digest: later,
    import_allowlist_digest: digest,
    runtime_digest: digest,
    distribution_digest: digest,
    cost: unknownAuthoringCost(1),
    ...extras
  });
}

function bindingFor(planned: ReturnType<typeof plan>, argv = digest) {
  const bound = planned.plan_binding!;
  return {
    plan_digest: planned.plan_digest!,
    argv_digest: argv,
    import_allowlist_digest: bound.import_allowlist_digest,
    runtime_digest: bound.runtime_digest,
    distribution_digest: bound.distribution_digest,
    runtime_pointer_digest: bound.runtime_pointer_digest ?? null,
    runtime_profile_digest: bound.runtime_profile_digest ?? null,
    package_manifest_digest: bound.package_manifest_digest ?? null,
    source_files: bound.source_files,
    asset_files: bound.asset_files
  };
}

function decision(planned: ReturnType<typeof plan>, value = "approve-plan") {
  return {
    decision_id: "d1",
    decision: value,
    actor: "human",
    decided_at: "2026-09-15T00:00:00.000Z",
    subject_digest: planned.plan_digest!
  };
}

describe("authoring engine run records", () => {
  it("creates unknown cost with a null amount", () => {
    const created = run();
    expect(created.cost.status).toBe("unknown");
    expect(created.cost.amount).toBeNull();
    expect(created.plan_digest).toBeNull();
    expect(created.plan_binding).toBeNull();
  });

  it("rejects reject/abort and requires a current plan digest", () => {
    const planned = plan();
    expect(() => approveAuthoringPlan(planned, { ...decision(planned), decision: "reject" })).toThrow(ProductionControlError);
    expect(() => approveAuthoringPlan(planned, { ...decision(planned), decision: "abort" })).toThrow(ProductionControlError);
    expect(() => approveAuthoringPlan(planned, { ...decision(planned), subject_digest: "c".repeat(64) })).toThrow(/subject_digest/);
  });

  it("binds source closure into plan_digest so later file drift is rejected", () => {
    const planned = plan();
    const approved = approveAuthoringPlan(planned, decision(planned));
    const live = bindingFor(planned);
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: live
    });
    expect(() => assertPaidBuildAllowed(intent, true, live)).toThrow(/cost is not known/);
    expect(() => persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: {
        ...live,
        source_files: [{ relative_path: "main.svml", sha256: "c".repeat(64), bytes: 12 }]
      }
    })).toThrow(/drifted from approved plan/);
  });

  it("keeps unknown intent across revise and refuses auto-resubmit", () => {
    const planned = plan();
    const approved = approveAuthoringPlan(planned, decision(planned));
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: bindingFor(planned)
    });
    const unknown = markAuthoringIntentUnknown(intent);
    const revised = reviseAuthoringRun(unknown);
    expect(revised.submission_intent?.status).toBe("unknown");
    expect(revised.intent_history).toEqual([]);
    expect(() => persistAuthoringSubmissionIntent(revised, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:02.000Z",
      execution_binding: bindingFor(planned)
    })).toThrow(/cannot spawn again/);
  });

  it("archives consumed intent on revise so a new approved plan can submit", () => {
    const planned = plan(run(), {
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, decision(planned, "approve-local-render"));
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: bindingFor(planned)
    });
    const complete = recordAuthoringBuildOutcome(intent, { build_id: "bld_ok", outcome: "complete" });
    expect(complete.accepted_build_ids).toEqual([]);
    const accepted = acceptAuthoringBuild(complete, "bld_ok");
    const revised = reviseAuthoringRun(accepted);
    expect(revised.approval).toBeUndefined();
    expect(revised.plan_digest).toBeNull();
    expect(revised.submission_intent).toBeUndefined();
    expect(revised.intent_history).toHaveLength(1);
    expect(revised.intent_history[0]?.digest).toBe(accepted.submission_intent?.digest);
    expect(revised.accepted_build_ids).toEqual(["bld_ok"]);
    const replanned = plan(revised, {
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const reapproved = approveAuthoringPlan(replanned, decision(replanned, "approve-local-render"));
    const again = persistAuthoringSubmissionIntent(reapproved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:03.000Z",
      execution_binding: bindingFor(replanned)
    });
    expect(again.submission_intent?.status).toBe("pending");
    expect(() => assertLocalRenderAllowed(again, true, {
      ...bindingFor(replanned),
      argv_digest: "c".repeat(64)
    })).toThrow(/binding mismatch/);
  });

  it("keeps a live pending submission on revise and does not archive it", () => {
    const planned = plan(run(), {
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, decision(planned, "approve-local-render"));
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: bindingFor(planned)
    });
    const pending = recordAuthoringBuildOutcome(intent, { build_id: "bld_live", outcome: "pending" });
    expect(pending.submission_intent?.status).toBe("consumed");
    const revised = reviseAuthoringRun(pending);
    expect(revised.submission_intent?.digest).toBe(pending.submission_intent?.digest);
    expect(revised.intent_history).toEqual([]);
    expect(revised.build?.outcome).toBe("pending");
    expect(() => persistAuthoringSubmissionIntent(revised, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:04.000Z",
      execution_binding: bindingFor(planned)
    })).toThrow(/cannot spawn again/);
  });

  it("refuses to invalidate a pending or unknown submission and a terminal accepted run", () => {
    const planned = plan(run(), {
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, decision(planned, "approve-local-render"));
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: bindingFor(planned)
    });
    expect(() => assertAuthoringRunIdle(intent, "set instruction")).toThrow(/pending/);
    expect(() => invalidateAuthoringPlan(intent)).toThrow(/pending/);
    const unknown = markAuthoringIntentUnknown(intent);
    expect(() => invalidateAuthoringPlan(unknown)).toThrow(/unknown/);
    const complete = recordAuthoringBuildOutcome(intent, { build_id: "bld_ok", outcome: "complete" });
    const accepted = acceptAuthoringBuild(complete, "bld_ok");
    expect(() => invalidateAuthoringPlan(accepted)).toThrow(/revise/);
    const idle = invalidateAuthoringPlan(approved);
    expect(idle.plan_digest).toBeNull();
    expect(idle.approval).toBeUndefined();
    expect(idle.revision_count).toBe(0);
  });

  it("archives failed terminal intent so a later approved plan can submit", () => {
    const planned = plan(run(), {
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, decision(planned, "approve-local-render"));
    const intent = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: bindingFor(planned)
    });
    const failed = recordAuthoringBuildOutcome(intent, { build_id: "bld_fail", outcome: "failed" });
    const revised = reviseAuthoringRun(failed);
    expect(revised.submission_intent).toBeUndefined();
    expect(revised.intent_history).toHaveLength(1);
  });
});
