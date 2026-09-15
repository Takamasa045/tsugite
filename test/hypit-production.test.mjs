import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeAuthorAgent } from "../adapters/hypit/agentBridge.mjs";
import { defaultCodexExecArgv, CODEX_BIN, AUTHOR_DISABLE_FEATURES } from "../adapters/hypit/authorProfile.mjs";
import {
  classifyImport,
  extractImportSpecs,
  assertAuthoredWorkspace,
  assertContainedExportPath,
  assertNoOverrideFlags,
  loadAllowlist
} from "../adapters/hypit/authoredTrust.mjs";
import { collectRuntimeSelection } from "../adapters/hypit/runtimeSelection.mjs";
import { mkdirSync as mkdirSyncFs } from "node:fs";
import { collectExecutionBinding, runProductionHypit } from "../adapters/hypit/productionRuntime.mjs";
import {
  approveAuthoringPlan,
  bindAuthoringPlan,
  createAuthoringEngineRun,
  digestAuthoringRun,
  markAuthoringIntentUnknown,
  persistAuthoringSubmissionIntent,
  recordAuthoringBuildOutcome
} from "../src/productionControl/authoringEngine.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authored source allowlist", () => {
  it("allows official @hypit packages and relative sources; project packages are denied", () => {
    const allowlist = loadAllowlist();
    expect(allowlist.projectPackages).toEqual([]);
    expect(classifyImport("@hypit/markup@1", allowlist).kind).toBe("distribution");
    expect(classifyImport("@example/chat-scene@1", allowlist).kind).toBe("denied");
    expect(classifyImport("@evil/payload@1", allowlist).kind).toBe("denied");
    expect(classifyImport("@example/chat-scene@1", {
      ...allowlist,
      projectPackages: ["@example/chat-scene"]
    }).kind).toBe("denied");
    expect(extractImportSpecs(`<import from="@hypit/film@1"/>`).specs).toEqual(["@hypit/film@1"]);
    expect(extractImportSpecs(`<import from = "./look.svs"/>`).specs).toEqual(["./look.svs"]);
    expect(extractImportSpecs(`<film:Track source={typography.track}/>`).unsupported).toEqual([]);
    expect(extractImportSpecs(`<import from=unquoted/>`).unsupported.length).toBeGreaterThan(0);
  });

  it("rejects an unbound project package in authored sources", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-authored-"));
    roots.push(root);
    writeFileSync(join(root, "main.svml"), `<import from="@example/chat-scene@1"/>`);
    expect(() => assertAuthoredWorkspace(root)).toThrow(/Untrusted authored imports/);
  });

  it("rejects untrusted imports in an authored workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-authored-"));
    roots.push(root);
    writeFileSync(join(root, "main.svml"), `<import from="@evil/x@1"/>`);
    expect(() => assertAuthoredWorkspace(root)).toThrow(/Untrusted authored imports/);
  });

  it("recurses relative imports including from = whitespace", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-authored-"));
    roots.push(root);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "main.svml"), `<import from = "./lib/look.svs"/>`);
    writeFileSync(join(root, "lib", "look.svs"), `<import from="./nested.svs"/>`);
    writeFileSync(join(root, "lib", "nested.svs"), `<import from="@evil/x@1"/>`);
    expect(() => assertAuthoredWorkspace(root)).toThrow(/nested.svs:@evil\/x@1/);
  });

  it("rejects symlink export escape", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-authored-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "tsugite-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "no");
    symlinkSync(join(outside, "secret.txt"), join(root, "out.mp4"));
    expect(() => assertContainedExportPath(root, join(root, "out.mp4"))).toThrow(/symlink/);
  });

  it("rejects --package-root on authored check/plan", () => {
    expect(() => assertNoOverrideFlags(["check", "main.svml", "--package-root", "/tmp/evil"])).toThrow(/package-root/);
  });
});

describe("agent bridge invocation", () => {
  it("uses a fixed Codex exec profile from installed CLI help", () => {
    const argv = defaultCodexExecArgv({
      workspace: "/tmp/ws",
      schemaPath: "/tmp/schema.json",
      lastMessagePath: "/tmp/last.txt"
    });
    expect(argv[0]).toBe(CODEX_BIN);
    expect(argv).toContain("exec");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--ephemeral");
    expect(argv).toContain("workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=false");
    for (const name of AUTHOR_DISABLE_FEATURES) {
      expect(argv).toContain(name);
    }
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe("-");
  });

  it("stages the official skill and treats preexisting files as noop", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tsugite-author-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "main.svml"), `<import from="@hypit/markup@1"/>`);
    writeFileSync(join(workspace, "build.svrun"), `<svrun/>`);
    const result = invokeAuthorAgent({
      workspace,
      brief: "synthetic",
      runCommand: () => ({ status: 0, stdout: "ok", stderr: "" })
    });
    expect(result.status).toBe("noop");
    expect(result.argv[0]).toBe(CODEX_BIN);
    expect(existsSync(join(workspace, ".agents/skills/hypit/SKILL.md"))).toBe(true);
  });

  it("records authored only when new source bytes are written", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tsugite-author-"));
    roots.push(workspace);
    const result = invokeAuthorAgent({
      workspace,
      brief: "synthetic",
      runCommand: (_argv, options) => {
        writeFileSync(join(options.cwd, "main.svml"), `<import from="@hypit/markup@1"/>`);
        writeFileSync(join(options.cwd, "build.svrun"), `<svrun/>`);
        return { status: 0, stdout: "ok", stderr: "" };
      }
    });
    expect(result.status).toBe("authored");
    expect(result.written).toHaveLength(2);
  });
});

const digest = "a".repeat(64);
const later = "b".repeat(64);

function persistLocalRun() {
  const created = createAuthoringEngineRun({
    production_id: "lab1",
    adapter_id: "authoring-adapter",
    brief_digest: digest,
    import_allowlist_digest: digest
  });
  const planned = bindAuthoringPlan(created, {
    source_files: [{ relative_path: "main.svml", sha256: digest, bytes: 12 }],
    asset_files: [],
    plan_output_digest: later,
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
    subject_digest: planned.plan_digest
  });
  const live = {
    plan_digest: planned.plan_digest,
    argv_digest: digest,
    import_allowlist_digest: digest,
    runtime_digest: digest,
    distribution_digest: digest,
    runtime_pointer_digest: null,
    runtime_profile_digest: null,
    package_manifest_digest: null,
    source_files: planned.plan_binding.source_files,
    asset_files: []
  };
  return persistAuthoringSubmissionIntent(approved, {
    argv_digest: digest,
    created_at: "2026-09-15T00:00:01.000Z",
    execution_binding: live
  });
}

function writeRun(root, run) {
  const dir = join(root, ".tsugite", "authoring");
  mkdirSyncFs(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), `${JSON.stringify({ run }, null, 2)}\n`);
}

describe("production runtime gating", () => {
  it("refuses digest-string and confirm flag bypass", () => {
    expect(() => runProductionHypit(["build", "build.svrun"], {
      confirmPaid: true,
      submissionIntentDigest: "x"
    })).toThrow(/caller-supplied intent|productionRoot/);
    expect(() => runProductionHypit(["build", "build.svrun"], {
      confirmLocalRender: true,
      productionRoot: "/tmp/missing-production"
    })).toThrow(/missing persisted authoring state/);
  });

  it("rejects consumed and unknown persisted intents before spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-runtime-"));
    roots.push(root);
    const pending = persistLocalRun();
    writeRun(root, recordAuthoringBuildOutcome(pending, { build_id: "bld_live", outcome: "pending" }));
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      confirmLocalRender: true
    })).toThrow(/cannot dispatch again/);
    writeRun(root, markAuthoringIntentUnknown(pending));
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      confirmLocalRender: true
    })).toThrow(/cannot dispatch again/);
  });

  it("rejects missing approval and cost mismatch before spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-runtime-"));
    roots.push(root);
    const pending = persistLocalRun();
    const { digest: _d, approval: _a, ...rest } = pending;
    writeRun(root, digestAuthoringRun(rest));
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      confirmLocalRender: true
    })).toThrow(/approve-local-render/);
    writeRun(root, pending);
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      confirmPaid: true
    })).toThrow(/approve-plan/);
    const { digest: _d2, cost: _c, ...rest2 } = pending;
    writeRun(root, digestAuthoringRun({
      ...rest2,
      cost: { status: "unknown", amount: null, currency: null, request_count: 1, notes: ["drift"] }
    }));
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      confirmLocalRender: true
    })).toThrow(/local-only/);
  });
});

function writeOfficialSources(workspace, importSpec = "@hypit/markup@1") {
  writeFileSync(join(workspace, "main.svml"), `<?svml using="${importSpec}"?><svml></svml>`);
  writeFileSync(join(workspace, "recipes.svs"), `<?svml using="@hypit/svs@1"?><sheet version="1"></sheet>`);
  writeFileSync(join(workspace, "build.svrun"), `<?svml using="@hypit/run-markup@1"?><svrun version="1"><author source="./main.svml"/><target output="final.video"/></svrun>`);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
}

describe("authored production package binding", () => {
  it("rejects unbound project-package imports before spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-pkg-"));
    roots.push(root);
    writeOfficialSources(root);
    const pending = persistLocalRun();
    writeRun(root, pending);
    writeOfficialSources(root, "@example/chat-scene@1");
    let spawns = 0;
    expect(() => runProductionHypit(["build", "build.svrun"], {
      productionRoot: root,
      workspace: root,
      confirmLocalRender: true,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "{}", stderr: "" };
      }
    })).toThrow(/Untrusted authored imports|@example\/chat-scene/);
    expect(spawns).toBe(0);
  });

  it("rejects custom package.json activation instead of hashing it", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-activation-"));
    roots.push(root);
    writeOfficialSources(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      hypit: { activation: "./packages/chat-scene/dist/activation.js" },
      dependencies: { "@example/chat-scene": "file:./packages/chat-scene" }
    }));
    expect(() => collectRuntimeSelection(root)).toThrow(/activation|override|hypit/);
    expect(() => collectExecutionBinding(root, "0".repeat(64), ["plan"])).toThrow(/activation|override|hypit/);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      dependencies: { "@example/chat-scene": "file:./packages/chat-scene" }
    }));
    expect(() => collectRuntimeSelection(root)).toThrow(/dependencies|override/);
  });
});
