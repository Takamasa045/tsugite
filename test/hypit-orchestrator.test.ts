import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  intakeReference,
  authorSources,
  planProduction,
  approveProduction,
  requestBuild,
  inspectProduction,
  acceptProduction,
  reviseProduction,
  loadProductionState,
  saveProductionState,
  productionStatePath,
  productView,
  setInstruction
} from "../adapters/hypit/orchestrator.mjs";
import {
  acceptAuthoringBuild,
  approveAuthoringPlan,
  bindAuthoringPlan,
  createAuthoringEngineRun,
  markAuthoringIntentUnknown,
  persistAuthoringSubmissionIntent,
  recordAuthoringBuildOutcome
} from "../src/productionControl/authoringEngine.js";
import { writePinnedRuntimeFixture } from "./helpers/hypitPinnedRuntimeFixture.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pinnedAdapter() {
  const adapterRoot = mkdtempSync(join(tmpdir(), "tsugite-hypit-pin-"));
  roots.push(adapterRoot);
  writePinnedRuntimeFixture(adapterRoot);
  return adapterRoot;
}

function readyRuntime() {
  return (input: { workspace: string; productionRoot: string }) => ({
    ok: true,
    ready: true,
    status: "prepared",
    production_root: input.productionRoot,
    host_state_mode: "production",
    init_ran: false,
    up_ran: true,
    child_env: { HYPIT_STATE_HOME: join(input.productionRoot, ".tsugite", "hypit-host-state") }
  });
}

function writeSources(cwd: string) {
  writeFileSync(join(cwd, "main.svml"), `<?svml using="@hypit/markup@1"?><svml></svml>`);
  writeFileSync(join(cwd, "build.svrun"), `<?svml using="@hypit/run-markup@1"?><svrun version="1"><author source="./main.svml"/><target output="final.video"/></svrun>`);
}

function localApprovedRun() {
  const digest = "a".repeat(64);
  const planned = bindAuthoringPlan(createAuthoringEngineRun({
    production_id: "lab1",
    adapter_id: "authoring-adapter",
    brief_digest: digest,
    import_allowlist_digest: digest
  }), {
    source_files: [{ relative_path: "main.svml", sha256: digest, bytes: 12 }],
    asset_files: [],
    plan_output_digest: "b".repeat(64),
    import_allowlist_digest: digest,
    runtime_digest: digest,
    distribution_digest: digest,
    cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
  });
  const approved = approveAuthoringPlan(planned, {
    decision_id: "d1",
    decision: "approve-local-render",
    actor: "human",
    decided_at: "2026-09-15T00:00:00.000Z",
    subject_digest: planned.plan_digest!
  });
  const live = {
    plan_digest: planned.plan_digest!,
    argv_digest: digest,
    import_allowlist_digest: digest,
    runtime_digest: digest,
    distribution_digest: digest,
    runtime_pointer_digest: null,
    runtime_profile_digest: null,
    package_manifest_digest: null,
    source_files: planned.plan_binding!.source_files,
    asset_files: []
  };
  return { planned, approved, live };
}

describe("production orchestrator", () => {
  it("intakes a local mp4, plans with injected CLI, and blocks paid build on unknown cost", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const mp4 = join(tmp, "ref.mp4");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", mp4
    ], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      expect(ffmpeg.status, ffmpeg.stderr).not.toBe(0);
      return;
    }
    const productionRoot = join(tmp, "prod");
    mkdirSync(productionRoot, { recursive: true });
    const adapterRoot = pinnedAdapter();
    await intakeReference(productionRoot, mp4, { production_id: "lab1", adapter_id: "authoring-adapter" });
    const authored = authorSources(productionRoot, {
      runCommand: (_argv: string[], options: { cwd: string }) => {
        writeSources(options.cwd);
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    expect(authored.author.status).toBe("authored");
    const planned = await planProduction(productionRoot, {
      adapterRoot,
      prepareRuntime: readyRuntime(),
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({ format: "hypit.cli-plan@1", ok: true, needs: [{ request: "a" }] }),
        stderr: ""
      })
    });
    expect(planned.run.cost.status).toBe("unknown");
    expect(planned.run.cost.amount).toBeNull();
    const approved = approveProduction(productionRoot, {
      decision_id: "d1",
      decision: "approve-plan",
      actor: "human",
      decided_at: new Date().toISOString()
    });
    expect(approved.run.approval?.decision).toBe("approve-plan");
    const built = requestBuild(productionRoot, { confirmPaid: true, adapterRoot });
    expect(built.run.build?.outcome).toBe("blocked");
    expect(built.run.submission_intent).toBeUndefined();
    const revised = reviseProduction(productionRoot);
    expect(revised.run.approval).toBeUndefined();
    expect(loadProductionState(productionRoot)?.ui.fake).toBe(false);
  });

  it("persists pending intent under lock before spawn and never fabricates a build id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const mp4 = join(tmp, "ref.mp4");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", mp4
    ], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      expect(ffmpeg.status, ffmpeg.stderr).not.toBe(0);
      return;
    }
    const productionRoot = join(tmp, "prod");
    mkdirSync(productionRoot, { recursive: true });
    const adapterRoot = pinnedAdapter();
    await intakeReference(productionRoot, mp4, { production_id: "lab1" });
    authorSources(productionRoot, {
      runCommand: (_argv: string[], options: { cwd: string }) => {
        writeSources(options.cwd);
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    await planProduction(productionRoot, {
      adapterRoot,
      prepareRuntime: readyRuntime(),
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({
          format: "hypit.cli-plan@1",
          ok: true,
          needs: [{ request: "local-render", pricing: { kind: "local" } }]
        }),
        stderr: ""
      })
    });
    approveProduction(productionRoot, {
      decision_id: "d-local",
      decision: "approve-local-render",
      actor: "human",
      decided_at: new Date().toISOString()
    });
    let sawIntent = false;
    const first = requestBuild(productionRoot, {
      adapterRoot,
      confirmLocalRender: true,
      runCli: () => {
        const current = loadProductionState(productionRoot);
        sawIntent = current?.run.submission_intent?.status === "pending";
        throw new Error("network failed after persist");
      }
    });
    expect(sawIntent).toBe(true);
    expect(first.run.build?.outcome).toBe("unknown");
    expect(first.run.build?.build_id).toBeUndefined();
    expect(first.run.submission_intent?.status).toBe("unknown");
    let spawned = 0;
    const second = requestBuild(productionRoot, {
      adapterRoot,
      confirmLocalRender: true,
      runCli: () => {
        spawned += 1;
        return { status: 0, stdout: JSON.stringify({ format: "hypit.cli-build@1", build: { id: "bld_should_not" } }), stderr: "" };
      }
    });
    expect(spawned).toBe(0);
    expect(second.ui.progress).toBe("will-not-auto-repeat");
  });

  it("treats a parsed submission as pending, then complete, then human accepted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const mp4 = join(tmp, "ref.mp4");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", mp4
    ], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      expect(ffmpeg.status, ffmpeg.stderr).not.toBe(0);
      return;
    }
    const productionRoot = join(tmp, "prod");
    mkdirSync(productionRoot, { recursive: true });
    const adapterRoot = pinnedAdapter();
    await intakeReference(productionRoot, mp4, { production_id: "lab1" });
    authorSources(productionRoot, {
      runCommand: (_argv: string[], options: { cwd: string }) => {
        writeSources(options.cwd);
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    await planProduction(productionRoot, {
      adapterRoot,
      prepareRuntime: readyRuntime(),
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({
          format: "hypit.cli-plan@1",
          ok: true,
          needs: [{ request: "local-render", pricing: { kind: "local" } }]
        }),
        stderr: ""
      })
    });
    approveProduction(productionRoot, {
      decision_id: "d-local",
      decision: "approve-local-render",
      actor: "human",
      decided_at: new Date().toISOString()
    });
    const submitted = requestBuild(productionRoot, {
      adapterRoot,
      confirmLocalRender: true,
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({ format: "hypit.cli-build@1", build: { id: "bld_real" } }),
        stderr: ""
      })
    });
    expect(submitted.run.build).toEqual({ build_id: "bld_real", outcome: "pending" });
    expect(submitted.run.accepted_build_ids).toEqual([]);
    const inspected = inspectProduction(productionRoot, {
      runCli: (argv: string[]) => {
        if (argv[0] === "status") {
          return {
            status: 0,
            stdout: JSON.stringify({
              format: "hypit.cli-status@1",
              build: { id: "bld_real", work: { state: "done", outcome: "complete" }, result: { state: "complete" } }
            }),
            stderr: ""
          };
        }
        return { status: 0, stdout: JSON.stringify({ format: "hypit.cli-inspect@1", build: { id: "bld_real" } }), stderr: "" };
      }
    });
    expect(inspected.run.build?.outcome).toBe("complete");
    expect(inspected.run.accepted_build_ids).toEqual([]);
    const accepted = acceptProduction(productionRoot);
    expect(accepted.run.build?.outcome).toBe("accepted");
    expect(accepted.run.accepted_build_ids).toEqual(["bld_real"]);
  });

  it("preserves a named draft brief and instruction across intake", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const mp4 = join(tmp, "ref.mp4");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", mp4
    ], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      expect(ffmpeg.status, ffmpeg.stderr).not.toBe(0);
      return;
    }
    const productionRoot = join(tmp, "draft-named");
    mkdirSync(productionRoot, { recursive: true });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace: join(productionRoot, "hypit-workspace"),
      brief: "連携のブラウザ検証",
      instruction: "keep this instruction",
      run: { production_id: "draft-named", adapter_id: "authoring-adapter" },
      ui: { progress: "draft", fake: false }
    });
    const after = await intakeReference(productionRoot, mp4);
    expect(after.brief).toBe("連携のブラウザ検証");
    expect(after.instruction).toBe("keep this instruction");
    expect(after.run.production_id).toBe("draft-named");
    expect(after.brief).not.toMatch(/AIエージェント創作開発ラボ/);
    expect(after.intake).toBeTruthy();
    expect(loadProductionState(productionRoot)?.instruction).toBe("keep this instruction");
    expect(loadProductionState(productionRoot)?.run.production_id).toBe("draft-named");
  });

  it("uses a generic brief for first intake and allows explicit override", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const mp4 = join(tmp, "ref.mp4");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", mp4
    ], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      expect(ffmpeg.status, ffmpeg.stderr).not.toBe(0);
      return;
    }
    const productionRoot = join(tmp, "fresh");
    mkdirSync(productionRoot, { recursive: true });
    const generic = await intakeReference(productionRoot, mp4);
    expect(generic.brief).not.toMatch(/AIエージェント創作開発ラボ/);
    expect(generic.instruction).toBe("");
    expect(generic.run.production_id).toBe("fresh");
    const overridden = await intakeReference(productionRoot, mp4, {
      brief: "explicit override",
      instruction: "new instruction"
    });
    expect(overridden.brief).toBe("explicit override");
    expect(overridden.instruction).toBe("new instruction");
  });

  it("UI copy says a draft is unplanned instead of presuming silence", () => {
    const html = readFileSync(new URL("../adapters/hypit/ui/index.html", import.meta.url), "utf8");
    expect(html).toContain("計画はまだありません");
    expect(html).toContain("制作環境を準備しています");
    expect(html).toContain("function silentSentence");
    expect(html).not.toContain("view.plan && view.plan.silent_typography ?");
  });

  it("does not claim a silent proposal before a plan exists", () => {
    const view = productView({
      brief: "連携のブラウザ検証",
      instruction: "keep me",
      ui: { progress: "draft", fake: false },
      run: { cost: {} }
    });
    expect(view?.plan.ready).toBe(false);
    expect(view?.plan.silent_typography).toBeNull();
  });

  it("reports an explicit silent proposal only from plan metadata", () => {
    const silent = productView({
      brief: "連携のブラウザ検証",
      ui: { progress: "plan-ready", fake: false },
      run: { plan_digest: "a".repeat(64), cost: {} },
      plan: { json: { silent_typography: true } }
    });
    expect(silent?.plan.ready).toBe(true);
    expect(silent?.plan.silent_typography).toBe(true);
    const unknown = productView({
      brief: "連携のブラウザ検証",
      ui: { progress: "plan-ready", fake: false },
      run: { plan_digest: "a".repeat(64), cost: {} },
      plan: { json: { format: "hypit.cli-plan@1" } }
    });
    expect(unknown?.plan.silent_typography).toBeNull();
  });

  it("no-ops the same instruction and invalidates an approved plan when instruction changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const digest = "a".repeat(64);
    const planned = bindAuthoringPlan(createAuthoringEngineRun({
      production_id: "lab1",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: digest
    }), {
      source_files: [{ relative_path: "main.svml", sha256: digest, bytes: 12 }],
      asset_files: [],
      plan_output_digest: "b".repeat(64),
      import_allowlist_digest: digest,
      runtime_digest: digest,
      distribution_digest: digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, {
      decision_id: "d1",
      decision: "approve-local-render",
      actor: "human",
      decided_at: "2026-09-15T00:00:00.000Z",
      subject_digest: planned.plan_digest!
    });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "keep",
      run: approved,
      author: { status: "authored" },
      ui: { progress: "plan-ready", fake: false }
    });
    const same = setInstruction(productionRoot, "keep");
    expect(same.run.plan_digest).toBe(approved.plan_digest);
    expect(same.run.approval?.decision).toBe("approve-local-render");
    const changed = setInstruction(productionRoot, "new direction");
    expect(changed.instruction).toBe("new direction");
    expect(changed.needs_reauthor).toBe(true);
    expect(changed.author.status).toBe("stale");
    expect(changed.run.plan_digest).toBeNull();
    expect(changed.run.approval).toBeUndefined();
    expect(productView(changed)?.actions.plan.enabled).toBe(false);
    expect(productView(changed)?.actions.build_local.enabled).toBe(false);
    await expect(planProduction(productionRoot, {
      runCli: () => ({ status: 0, stdout: "{}", stderr: "" })
    })).rejects.toMatchObject({ code: "PC_AUTHORITY_DENIED" });
    const built = requestBuild(productionRoot, { confirmLocalRender: true });
    expect(built.run.build?.outcome).toBe("blocked");
    expect(built.run.submission_intent).toBeUndefined();
  });

  it("rejects intake, instruction, and reauthor while a job is running or submission is pending/unknown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const digest = "a".repeat(64);
    const planned = bindAuthoringPlan(createAuthoringEngineRun({
      production_id: "lab1",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: digest
    }), {
      source_files: [{ relative_path: "main.svml", sha256: digest, bytes: 12 }],
      asset_files: [],
      plan_output_digest: "b".repeat(64),
      import_allowlist_digest: digest,
      runtime_digest: digest,
      distribution_digest: digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const approved = approveAuthoringPlan(planned, {
      decision_id: "d1",
      decision: "approve-local-render",
      actor: "human",
      decided_at: "2026-09-15T00:00:00.000Z",
      subject_digest: planned.plan_digest!
    });
    const live = {
      plan_digest: planned.plan_digest!,
      argv_digest: digest,
      import_allowlist_digest: digest,
      runtime_digest: digest,
      distribution_digest: digest,
      runtime_pointer_digest: null,
      runtime_profile_digest: null,
      package_manifest_digest: null,
      source_files: planned.plan_binding!.source_files,
      asset_files: []
    };
    const pending = persistAuthoringSubmissionIntent(approved, {
      argv_digest: digest,
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: live
    });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "old",
      run: pending,
      author: { status: "authored" },
      ui: { progress: "approved", fake: false }
    });
    const before = loadProductionState(productionRoot);
    expect(() => setInstruction(productionRoot, "mutated")).toThrow(/pending/);
    expect(() => authorSources(productionRoot, {
      runCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })).toThrow(/pending/);
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"))).rejects.toThrow(/pending/);
    const afterPending = loadProductionState(productionRoot);
    expect(afterPending.instruction).toBe("old");
    expect(afterPending.run.digest).toBe(before.run.digest);
    expect(afterPending.run.submission_intent.status).toBe("pending");

    const unknown = markAuthoringIntentUnknown(pending);
    saveProductionState(productionRoot, { ...afterPending, run: unknown });
    expect(() => setInstruction(productionRoot, "mutated")).toThrow(/unknown/);
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"))).rejects.toThrow(/unknown/);

    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "old",
      run: approved,
      job: { status: "running", pid: process.pid },
      ui: { progress: "author-running", fake: false }
    });
    expect(() => setInstruction(productionRoot, "mutated")).toThrow(/running/);
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"))).rejects.toMatchObject({ code: "PC_LOCK_CONFLICT" });
    expect(loadProductionState(productionRoot).instruction).toBe("old");
  });

  it("rejects intake of a terminal accepted run before copying a new reference", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    const originalRef = join(workspace, "assets", "reference", "reference.mp4");
    mkdirSync(join(workspace, "assets", "reference"), { recursive: true });
    writeSources(workspace);
    writeFileSync(originalRef, "ORIGINAL-REFERENCE-BYTES");
    const attacker = join(tmp, "attacker.mp4");
    writeFileSync(attacker, "SENTINEL-ATTACKER-BYTES");
    const { approved, live } = localApprovedRun();
    const pending = persistAuthoringSubmissionIntent(approved, {
      argv_digest: "a".repeat(64),
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: live
    });
    const accepted = acceptAuthoringBuild(
      recordAuthoringBuildOutcome(pending, { build_id: "bld_ok", outcome: "complete" }),
      "bld_ok"
    );
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "old",
      run: accepted,
      author: { status: "authored" },
      ui: { progress: "build-accepted", fake: false }
    });
    const statePath = productionStatePath(productionRoot);
    const stateBefore = readFileSync(statePath);
    const refBefore = readFileSync(originalRef);
    await expect(intakeReference(productionRoot, attacker)).rejects.toThrow(/revise/);
    expect(readFileSync(originalRef).equals(refBefore)).toBe(true);
    expect(readFileSync(statePath).equals(stateBefore)).toBe(true);
    expect(readFileSync(originalRef, "utf8")).toBe("ORIGINAL-REFERENCE-BYTES");
    expect(readFileSync(attacker, "utf8")).toBe("SENTINEL-ATTACKER-BYTES");
  });

  it("revise of a terminal run keeps accepted history and rejects plan until a real author", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const { approved, live } = localApprovedRun();
    const pending = persistAuthoringSubmissionIntent(approved, {
      argv_digest: "a".repeat(64),
      created_at: "2026-09-15T00:00:01.000Z",
      execution_binding: live
    });
    const accepted = acceptAuthoringBuild(
      recordAuthoringBuildOutcome(pending, { build_id: "bld_ok", outcome: "complete" }),
      "bld_ok"
    );
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "old",
      run: accepted,
      author: { status: "authored" },
      ui: { progress: "build-accepted", fake: false }
    });
    const revised = reviseProduction(productionRoot, { instruction: "new direction" });
    expect(revised.instruction).toBe("new direction");
    expect(revised.needs_reauthor).toBe(true);
    expect(revised.author.status).toBe("stale");
    expect(revised.run.plan_digest).toBeNull();
    expect(revised.run.accepted_build_ids).toEqual(["bld_ok"]);
    expect(revised.run.intent_history).toHaveLength(1);
    expect(productView(revised)?.actions.plan.enabled).toBe(false);
    await expect(planProduction(productionRoot, {
      runCli: () => ({ status: 0, stdout: "{}", stderr: "" })
    })).rejects.toMatchObject({ code: "PC_AUTHORITY_DENIED" });
    const unchanged = authorSources(productionRoot, {
      runCommand: (_argv: string[], options: { cwd: string }) => {
        writeSources(options.cwd);
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    expect(unchanged.author.status).toBe("noop");
    expect(unchanged.needs_reauthor).toBe(true);
    await expect(planProduction(productionRoot, {
      runCli: () => ({ status: 0, stdout: "{}", stderr: "" })
    })).rejects.toMatchObject({ code: "PC_AUTHORITY_DENIED" });
    const authored = authorSources(productionRoot, {
      runCommand: (_argv: string[], options: { cwd: string }) => {
        writeFileSync(join(options.cwd, "main.svml"), `<?svml using="@hypit/markup@1"?><svml><!-- revised --></svml>`);
        writeFileSync(join(options.cwd, "build.svrun"), `<?svml using="@hypit/run-markup@1"?><svrun version="1"><author source="./main.svml"/><target output="final.video"/></svrun>`);
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    expect(authored.author.status).toBe("authored");
    expect(authored.needs_reauthor).toBe(false);
    const adapterRoot = pinnedAdapter();
    const planned = await planProduction(productionRoot, {
      adapterRoot,
      prepareRuntime: readyRuntime(),
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({
          format: "hypit.cli-plan@1",
          ok: true,
          needs: [{ request: "local-render", pricing: { kind: "local" } }]
        }),
        stderr: ""
      })
    });
    expect(planned.run.plan_digest).toEqual(expect.any(String));
  });

  it("does not mutate state when revise is attempted while an author job is running", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    const { approved } = localApprovedRun();
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "old",
      run: approved,
      author: { status: "authored" },
      job: { status: "running", pid: process.pid },
      ui: { progress: "author-running", fake: false }
    });
    const statePath = productionStatePath(productionRoot);
    const before = readFileSync(statePath);
    expect(() => reviseProduction(productionRoot, { instruction: "hijack" })).toThrow(/running/);
    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(loadProductionState(productionRoot)?.instruction).toBe("old");
  });

  it("prepares local runtime before check/plan and forwards productionRoot", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const adapterRoot = pinnedAdapter();
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "go",
      run: createAuthoringEngineRun({
        production_id: "lab1",
        adapter_id: "authoring-adapter",
        brief_digest: "a".repeat(64),
        import_allowlist_digest: "a".repeat(64)
      }),
      author: { status: "authored" },
      ui: { progress: "authored", fake: false }
    });
    const order: string[] = [];
    const planned = await planProduction(productionRoot, {
      adapterRoot,
      prepareRuntime: (input: { workspace: string; productionRoot: string; env?: NodeJS.ProcessEnv }) => {
        order.push("prepare");
        expect(input.productionRoot).toBe(productionRoot);
        expect(input.workspace).toBe(workspace);
        return readyRuntime()(input);
      },
      runCli: (argv: string[]) => {
        order.push(argv[0]!);
        return {
          status: 0,
          stdout: JSON.stringify({ format: "hypit.cli-plan@1", ok: true, needs: [{ request: "local-render", pricing: { kind: "local" } }] }),
          stderr: ""
        };
      }
    });
    expect(order).toEqual(["prepare", "check", "plan"]);
    expect(planned.runtime?.ready).toBe(true);
    expect(planned.runtime?.child_env?.HYPIT_STATE_HOME).toBe(join(productionRoot, ".tsugite", "hypit-host-state"));
    expect(planned.ui.progress).toBe("plan-ready");
  });

  it("preparation failure prevents plan and drops a stale approval", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const { approved } = localApprovedRun();
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "go",
      run: approved,
      author: { status: "authored" },
      ui: { progress: "plan-ready", fake: false }
    });
    let cli = 0;
    const failed = await planProduction(productionRoot, {
      prepareRuntime: () => ({
        ok: false,
        ready: false,
        status: "not-ready",
        reason: "local runtime missing"
      }),
      runCli: () => {
        cli += 1;
        return { status: 0, stdout: "{}", stderr: "" };
      }
    });
    expect(cli).toBe(0);
    expect(failed.ui.progress).toBe("runtime-not-ready");
    expect(failed.runtime?.ready).toBe(false);
    expect(failed.run.plan_digest).toBeNull();
    expect(failed.run.approval).toBeUndefined();
    expect(productView(failed)?.plan.ready).toBe(false);
    expect(productView(failed)?.actions.approve_local.enabled).toBe(false);
    expect(productView(failed)?.progress_label).toBe("制作環境の準備ができませんでした");
  });

  it("drops a persisted old approval when check or binding throws during replan", async () => {
    const localPlan = {
      status: 0,
      stdout: JSON.stringify({
        format: "hypit.cli-plan@1",
        ok: true,
        needs: [{ request: "local-render", pricing: { kind: "local" } }]
      }),
      stderr: ""
    };

    async function seedApproved() {
      const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
      roots.push(tmp);
      const productionRoot = join(tmp, "prod");
      const workspace = join(productionRoot, "hypit-workspace");
      mkdirSync(workspace, { recursive: true });
      writeSources(workspace);
      const { approved } = localApprovedRun();
      saveProductionState(productionRoot, {
        productionRoot,
        workspace,
        brief: "brief",
        instruction: "go",
        run: approved,
        author: { status: "authored" },
        ui: { progress: "plan-ready", fake: false }
      });
      expect(loadProductionState(productionRoot)?.run.approval?.decision).toBe("approve-local-render");
      return productionRoot;
    }

    const checkRoot = await seedApproved();
    const afterCheckThrow = await planProduction(checkRoot, {
      prepareRuntime: readyRuntime(),
      runCli: (argv: string[]) => {
        if (argv[0] === "check") throw new Error("check exploded");
        return localPlan;
      }
    });
    expect(afterCheckThrow.ui.progress).toBe("plan-failed");
    expect(afterCheckThrow.run.approval).toBeUndefined();
    expect(afterCheckThrow.run.plan_digest).toBeNull();
    expect(afterCheckThrow.run.plan_binding).toBeNull();
    const persistedCheck = loadProductionState(checkRoot);
    expect(persistedCheck?.run.approval).toBeUndefined();
    expect(persistedCheck?.run.plan_digest).toBeNull();
    expect(persistedCheck?.run.plan_binding).toBeNull();
    expect(productView(persistedCheck)?.plan.ready).toBe(false);
    expect(productView(persistedCheck)?.actions.approve_local.enabled).toBe(false);
    expect(productView(persistedCheck)?.actions.build_local.enabled).toBe(false);

    const bindRoot = await seedApproved();
    const afterBindThrow = await planProduction(bindRoot, {
      prepareRuntime: readyRuntime(),
      runCli: () => localPlan,
      collectExecutionBinding: () => {
        throw new Error("binding exploded");
      }
    });
    expect(afterBindThrow.ui.progress).toBe("plan-failed");
    expect(afterBindThrow.run.approval).toBeUndefined();
    expect(afterBindThrow.run.plan_digest).toBeNull();
    expect(afterBindThrow.run.plan_binding).toBeNull();
    const persistedBind = loadProductionState(bindRoot);
    expect(persistedBind?.run.approval).toBeUndefined();
    expect(persistedBind?.run.plan_digest).toBeNull();
    expect(persistedBind?.run.plan_binding).toBeNull();
    expect(productView(persistedBind)?.plan.ready).toBe(false);
    expect(productView(persistedBind)?.actions.approve_local.enabled).toBe(false);
    expect(productView(persistedBind)?.actions.build_local.enabled).toBe(false);
  });

  it("does not bind or enable approve/build when check fails and plan returns local JSON", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    const workspace = join(productionRoot, "hypit-workspace");
    mkdirSync(workspace, { recursive: true });
    writeSources(workspace);
    const { approved } = localApprovedRun();
    saveProductionState(productionRoot, {
      productionRoot,
      workspace,
      brief: "brief",
      instruction: "go",
      run: approved,
      author: { status: "authored" },
      ui: { progress: "plan-ready", fake: false }
    });
    const failed = await planProduction(productionRoot, {
      prepareRuntime: readyRuntime(),
      runCli: (argv: string[]) => {
        if (argv[0] === "check") return { status: 1, stdout: "", stderr: "check failed" };
        return {
          status: 0,
          stdout: JSON.stringify({
            format: "hypit.cli-plan@1",
            ok: true,
            needs: [{ request: "local-render", pricing: { kind: "local" } }]
          }),
          stderr: ""
        };
      }
    });
    expect(failed.ui.progress).toBe("plan-failed");
    expect(failed.check?.status).toBe(1);
    expect(failed.plan?.status).toBe(0);
    expect(failed.run.approval).toBeUndefined();
    expect(failed.run.plan_digest).toBeNull();
    expect(failed.run.plan_binding).toBeNull();
    expect(failed.run.cost.status).not.toBe("local-only");
    expect(productView(failed)?.plan.ready).toBe(false);
    expect(productView(failed)?.actions.approve_local.enabled).toBe(false);
    expect(productView(failed)?.actions.build_local.enabled).toBe(false);
    expect(() => approveProduction(productionRoot, {
      decision_id: "d1",
      decision: "approve-local-render",
      actor: "human",
      decided_at: "2026-09-15T00:00:00.000Z"
    })).toThrow(/plan first/);
    const built = requestBuild(productionRoot, { confirmLocalRender: true });
    expect(built.run.build?.outcome).toBe("blocked");
    expect(built.run.submission_intent).toBeUndefined();
  });

  it("refuses intake when an explicit production_id mismatches the existing id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "draft-named");
    mkdirSync(productionRoot, { recursive: true });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace: join(productionRoot, "hypit-workspace"),
      brief: "keep brief",
      instruction: "keep instruction",
      run: { production_id: "draft-named", adapter_id: "authoring-adapter" },
      ui: { progress: "draft", fake: false }
    });
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"), { production_id: "lab" }))
      .rejects.toMatchObject({ code: "PC_IDENTITY_MISMATCH" });
    const after = loadProductionState(productionRoot);
    expect(after.run.production_id).toBe("draft-named");
    expect(after.brief).toBe("keep brief");
    expect(after.instruction).toBe("keep instruction");
  });

  it("rejects inspect of a non-current or absent build_id before runtime or state changes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-prod-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "prod");
    mkdirSync(join(productionRoot, "hypit-workspace"), { recursive: true });
    const { approved, live } = localApprovedRun();
    const pending = persistAuthoringSubmissionIntent(approved, {
      argv_digest: "a".repeat(64),
      created_at: "2026-09-15T00:00:02.000Z",
      execution_binding: live
    });
    const current = recordAuthoringBuildOutcome(pending, { build_id: "bld_current", outcome: "pending" });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace: join(productionRoot, "hypit-workspace"),
      brief: "brief",
      run: current,
      ui: { progress: "build-pending", fake: false }
    });
    const before = JSON.stringify(loadProductionState(productionRoot).run.build);
    let runtimeCalls = 0;
    const runCli = () => {
      runtimeCalls += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          format: "hypit.cli-status@1",
          build: { id: "bld_other", work: { state: "done", outcome: "complete" }, result: { state: "complete" } }
        }),
        stderr: ""
      };
    };
    try {
      inspectProduction(productionRoot, { buildId: "bld_other", runCli });
      throw new Error("expected non-current inspect to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_BUILD_IDENTITY" });
    }
    expect(runtimeCalls).toBe(0);
    expect(JSON.stringify(loadProductionState(productionRoot).run.build)).toBe(before);

    saveProductionState(productionRoot, {
      productionRoot,
      workspace: join(productionRoot, "hypit-workspace"),
      brief: "brief",
      run: { ...current, build: undefined },
      ui: { progress: "approved", fake: false }
    });
    runtimeCalls = 0;
    try {
      inspectProduction(productionRoot, { buildId: "bld_failed", runCli });
      throw new Error("expected absent current inspect to refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "PC_BUILD_IDENTITY" });
    }
    expect(runtimeCalls).toBe(0);
    expect(loadProductionState(productionRoot).run.build).toBeUndefined();
  });
});
