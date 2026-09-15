import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectExecutionBinding,
  runProductionHypit
} from "../adapters/hypit/productionRuntime.mjs";
import { claimIntentDispatch } from "../adapters/hypit/dispatchClaim.mjs";
import { writeProductionReview } from "../adapters/hypit/productionReview.mjs";
import {
  approveAuthoringPlan,
  bindAuthoringPlan,
  createAuthoringEngineRun,
  persistAuthoringSubmissionIntent
} from "../src/productionControl/authoringEngine.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = "a".repeat(64);
const later = "b".repeat(64);

function writeSources(workspace) {
  writeFileSync(join(workspace, "main.svml"), `<?svml using="@hypit/markup@1"?><svml></svml>`);
  writeFileSync(join(workspace, "recipes.svs"), `<?svml using="@hypit/svs@1"?><sheet version="1"></sheet>`);
  writeFileSync(join(workspace, "build.svrun"), `<?svml using="@hypit/run-markup@1"?><svrun version="1"><author source="./main.svml"/><target output="final.video"/></svrun>`);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
}

function writeProfile(workspace, extra = {}) {
  mkdirSync(join(workspace, ".hypit"), { recursive: true });
  writeFileSync(join(workspace, ".hypit", "runtime"), "hypit.runtime.json\n");
  writeFileSync(join(workspace, "hypit.runtime.json"), `${JSON.stringify({
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/runtimes/local",
    endpoints: {
      "media.local": { use: "@hypit/provider-media-local" },
      "hyperframes.local": { use: "@hypit/provider-hyperframes-local" },
      ...extra.endpoints
    }
  }, null, 2)}\n`);
}

function persistReady(productionRoot, workspace, argv = ["build", "build.svrun"]) {
  writeSources(workspace);
  const probe = collectExecutionBinding(workspace, "0".repeat(64), argv);
  const created = createAuthoringEngineRun({
    production_id: "lab1",
    adapter_id: "authoring-adapter",
    brief_digest: digest,
    import_allowlist_digest: probe.import_allowlist_digest
  });
  const planned = bindAuthoringPlan(created, {
    source_files: probe.source_files,
    asset_files: probe.asset_files,
    plan_output_digest: later,
    import_allowlist_digest: probe.import_allowlist_digest,
    runtime_digest: probe.runtime_digest,
    distribution_digest: probe.distribution_digest,
    runtime_pointer_digest: probe.runtime_pointer_digest,
    runtime_profile_digest: probe.runtime_profile_digest,
    package_manifest_digest: probe.package_manifest_digest,
    cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
  });
  const live = collectExecutionBinding(workspace, planned.plan_digest, argv);
  const approved = approveAuthoringPlan(planned, {
    decision_id: "d1",
    decision: "approve-local-render",
    actor: "human",
    decided_at: "2026-09-15T00:00:00.000Z",
    subject_digest: planned.plan_digest
  });
  const persisted = persistAuthoringSubmissionIntent(approved, {
    argv_digest: live.argv_digest,
    created_at: "2026-09-15T00:00:01.000Z",
    execution_binding: live
  });
  mkdirSync(join(productionRoot, ".tsugite", "authoring"), { recursive: true });
  writeFileSync(join(productionRoot, ".tsugite", "authoring", "state.json"), `${JSON.stringify({ run: persisted, workspace }, null, 2)}\n`);
  return persisted;
}

describe("dispatch claim", () => {
  it("lets only the first matching build spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-claim-"));
    roots.push(root);
    persistReady(root, root);
    const argv = ["build", "build.svrun"];
    let spawns = 0;
    const spawnCli = () => {
      spawns += 1;
      return { status: 0, stdout: JSON.stringify({ format: "hypit.cli-build@1", build: { id: "bld_one" } }), stderr: "" };
    };
    const opts = { productionRoot: root, workspace: root, confirmLocalRender: true, spawnCli };
    const first = runProductionHypit(argv, opts);
    expect(first.status).toBe(0);
    expect(spawns).toBe(1);
    expect(() => runProductionHypit(argv, opts)).toThrow(/already claimed/);
    expect(spawns).toBe(1);
  });

  it("gives one concurrent claim winner", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-claim-c-"));
    roots.push(root);
    const digestA = "c".repeat(64);
    const runtimeUrl = fileURLToPath(new URL("../adapters/hypit/dispatchClaim.mjs", import.meta.url));
    const code = `
      import { claimIntentDispatch } from ${JSON.stringify(runtimeUrl)};
      try {
        claimIntentDispatch(${JSON.stringify(root)}, ${JSON.stringify(digestA)});
        process.stdout.write("ok");
      } catch (error) {
        process.stderr.write(error.message);
        process.exit(2);
      }
    `;
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    const [left, right] = await Promise.all([run(), run()]);
    const ok = [left, right].filter((item) => item.status === 0);
    const denied = [left, right].filter((item) => item.status === 2);
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0].stderr).toMatch(/already claimed/);
  });
});

describe("runtime profile binding", () => {
  it("rejects a changed profile or pointer before spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-profile-"));
    roots.push(root);
    writeProfile(root);
    persistReady(root, root);
    let spawns = 0;
    const spawnCli = () => {
      spawns += 1;
      return { status: 0, stdout: "{}", stderr: "" };
    };
    const opts = { productionRoot: root, workspace: root, confirmLocalRender: true, spawnCli };
    writeFileSync(join(root, "hypit.runtime.json"), `${JSON.stringify({
      format: "hypit.runtime-local@1",
      dataRoot: ".hypit/runtimes/local",
      endpoints: {
        "media.local": { use: "@hypit/provider-media-local" },
        "changed.local": { use: "@hypit/provider-media-local" }
      }
    }, null, 2)}\n`);
    expect(() => runProductionHypit(["build", "build.svrun"], opts)).toThrow(/drifted from approved plan|binding mismatch/);
    expect(spawns).toBe(0);
    writeProfile(root);
    writeFileSync(join(root, ".hypit", "runtime"), "other.runtime.json\n");
    writeFileSync(join(root, "other.runtime.json"), readFileSync(join(root, "hypit.runtime.json")));
    expect(() => runProductionHypit(["build", "build.svrun"], opts)).toThrow(/drifted from approved plan|binding mismatch/);
    expect(spawns).toBe(0);
  });
});

describe("production review pair", () => {
  it("writes identity-bound review files from the current plan", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-"));
    roots.push(root);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), "slug: lab-review\nname: レビュー案件\nrun_id: lab-review-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n");
    writeFileSync(join(root, "TREATMENT.md"), "無音の文字。");
    writeFileSync(join(root, "TIMELINE.md"), "0-30秒");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-review",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      runtime_pointer_digest: probe.runtime_pointer_digest,
      runtime_profile_digest: probe.runtime_profile_digest,
      package_manifest_digest: probe.package_manifest_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 3, notes: ["local"] }
    });
    const state = {
      workspace: root,
      brief: "30秒の縦型。",
      run: planned,
      plan: {
        json: {
          needs: [{
            endpoint: "hyperframes.local",
            summary: { fields: { width: 1080, height: 1920, endFrameExclusive: 900, frameRate: "30/1" } }
          }, { endpoint: "media.local" }]
        }
      }
    };
    const review = writeProductionReview(root, state);
    const data = JSON.parse(readFileSync(review.dataPath, "utf8"));
    const html = readFileSync(review.htmlPath, "utf8");
    expect(review.htmlPath).toBe(join(root, "dist", "lab-review-run", "review", "index.html"));
    expect(data.format).toBe("tsugite.production-review@1");
    expect(data.plan_digest).toBe(planned.plan_digest);
    expect(data.identity.slug).toBe("lab-review");
    expect(data.identity.run_id).toBe("lab-review-run");
    expect(data.approval).toBeNull();
    expect(data.silent).toBe(true);
    expect(data.duration_s).toBe(30);
    expect(data.aspect).toBe("1080x1920");
    expect(data.local_endpoints).toEqual(["hyperframes.local", "media.local"]);
    expect(data.source_files.map((item) => item.relative_path).sort()).toEqual([
      "TIMELINE.md",
      "TREATMENT.md",
      "build.svrun",
      "main.svml",
      "recipes.svs"
    ]);
    expect(html).toContain(planned.plan_digest);
    expect(html).toContain("無音の文字。");
    expect(html).toContain("0-30秒");
    expect(html).toContain("無音の提案");
    expect(html).toContain("technical-hashes");
    expect(html.indexOf("演出")).toBeLessThan(html.indexOf("technical-hashes"));
    expect(html).not.toContain("approve-plan");
    expect(html).not.toContain("storyboard");
    expect(html).not.toContain("remotion");
  });

  it("parses quoted YAML identity and keeps hashes out of the lead", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-q-"));
    roots.push(root);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), [
      "slug: \"lab-quoted\"",
      "name: \"引用された案件\"",
      "run_id: \"lab-quoted-run\"",
      "manifest: manifest.json",
      "dist_dir: \"dist\"",
      "edit:",
      "  backend: remotion",
      ""
    ].join("\n"));
    writeFileSync(join(root, "TREATMENT.md"), "色とリズム。");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-quoted",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      runtime_pointer_digest: probe.runtime_pointer_digest,
      runtime_profile_digest: probe.runtime_profile_digest,
      package_manifest_digest: probe.package_manifest_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const review = writeProductionReview(root, { workspace: root, brief: "30秒。", run: planned, plan: { json: {} } });
    const data = JSON.parse(readFileSync(review.dataPath, "utf8"));
    const html = readFileSync(review.htmlPath, "utf8");
    expect(data.identity.slug).toBe("lab-quoted");
    expect(data.identity.run_id).toBe("lab-quoted-run");
    expect(data.identity.name).toBe("引用された案件");
    expect(data.silent).toBeNull();
    expect(html).toContain("音声は未確定");
    expect(html).not.toContain("無音の提案");
  });

  it("rejects ../ dist_dir before write and keeps existing review", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-esc-"));
    roots.push(root);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), "slug: lab-safe\nname: 既存レビュー\nrun_id: lab-safe-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n");
    writeFileSync(join(root, "TREATMENT.md"), "無音の文字。");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-safe",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const state = { workspace: root, brief: "safe", run: planned, plan: { json: {} } };
    const review = writeProductionReview(root, state);
    const sentinel = "EXISTING-REVIEW-KEEP";
    writeFileSync(review.htmlPath, sentinel);
    writeFileSync(join(root, "project.yaml"), "slug: lab-safe\nname: 既存レビュー\nrun_id: lab-safe-run\nmanifest: manifest.json\ndist_dir: \"../evil\"\nedit:\n  backend: remotion\n");
    expect(() => writeProductionReview(root, state)).toThrow(/invalid|safe relative|escapes|unsafe/i);
    expect(readFileSync(review.htmlPath, "utf8")).toBe(sentinel);
    expect(existsSync(join(root, "..", "evil"))).toBe(false);
  });

  it("rejects a symlink review destination before write", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-sym-"));
    const outside = mkdtempSync(join(tmpdir(), "tsugite-review-out-"));
    roots.push(root, outside);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), "slug: lab-sym\nname: リンク拒否\nrun_id: lab-sym-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n");
    writeFileSync(join(root, "TREATMENT.md"), "無音の文字。");
    symlinkSync(outside, join(root, "dist"));
    writeFileSync(join(outside, "keep.txt"), "outside");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-sym",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    expect(() => writeProductionReview(root, {
      workspace: root,
      brief: "sym",
      run: planned,
      plan: { json: {} }
    })).toThrow(/symlink/);
    expect(existsSync(join(outside, "lab-sym-run"))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
  });

  it("refuses a changed TREATMENT.md instead of serving a stale plan", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-stale-"));
    roots.push(root);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), "slug: lab-stale\nname: 束縛\nrun_id: lab-stale-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n");
    writeFileSync(join(root, "TREATMENT.md"), "無音の文字。");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-stale",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const state = { workspace: root, brief: "stale", run: planned, plan: { json: {} } };
    const review = writeProductionReview(root, state);
    const before = readFileSync(review.htmlPath, "utf8");
    writeFileSync(join(root, "TREATMENT.md"), "差し替えた演出。");
    expect(() => writeProductionReview(root, state)).toThrow(/drifted from the approved source closure/);
    expect(readFileSync(review.htmlPath, "utf8")).toBe(before);
    expect(before).toContain("無音の文字。");
    expect(before).not.toContain("差し替えた演出。");
  });

  it("does not follow a preexisting review .tmp symlink outside the production root", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-review-tmp-"));
    const outside = mkdtempSync(join(tmpdir(), "tsugite-review-tmp-out-"));
    roots.push(root, outside);
    writeSources(root);
    writeFileSync(join(root, "project.yaml"), "slug: lab-tmp\nname: 一時ファイル\nrun_id: lab-tmp-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n");
    writeFileSync(join(root, "TREATMENT.md"), "無音の文字。");
    const probe = collectExecutionBinding(root, "0".repeat(64), ["plan"]);
    const created = createAuthoringEngineRun({
      production_id: "lab-tmp",
      adapter_id: "authoring-adapter",
      brief_digest: digest,
      import_allowlist_digest: probe.import_allowlist_digest
    });
    const planned = bindAuthoringPlan(created, {
      source_files: probe.source_files,
      asset_files: probe.asset_files,
      plan_output_digest: later,
      import_allowlist_digest: probe.import_allowlist_digest,
      runtime_digest: probe.runtime_digest,
      distribution_digest: probe.distribution_digest,
      cost: { status: "local-only", amount: null, currency: null, request_count: 1, notes: ["local"] }
    });
    const reviewDir = join(root, "dist", "lab-tmp-run", "review");
    mkdirSync(reviewDir, { recursive: true });
    const sentinelPath = join(outside, "sentinel.txt");
    writeFileSync(sentinelPath, "OUTSIDE-SENTINEL");
    symlinkSync(sentinelPath, join(reviewDir, "index.html.tmp"));
    symlinkSync(sentinelPath, join(reviewDir, "review-data.json.tmp"));
    const review = writeProductionReview(root, {
      workspace: root,
      brief: "tmp",
      run: planned,
      plan: { json: {} }
    });
    expect(readFileSync(sentinelPath, "utf8")).toBe("OUTSIDE-SENTINEL");
    expect(lstatSync(join(reviewDir, "index.html.tmp")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(reviewDir, "review-data.json.tmp")).isSymbolicLink()).toBe(true);
    expect(readFileSync(review.htmlPath, "utf8")).toContain("無音の文字。");
    expect(readFileSync(review.htmlPath, "utf8")).not.toContain("OUTSIDE-SENTINEL");
  });
});
