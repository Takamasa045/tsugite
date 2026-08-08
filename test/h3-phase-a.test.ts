/**
 * H3 Prompt Director Phase A — last-frame-only, provider-neutral routes,
 * MiniMax direct preflight-only, and official prompt catalog pins.
 *
 * TDD entry for Phase A. Does not call provider APIs or submit generation.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyH3ExecutionRouteProfile,
  compileH3Request,
  h3ModeUiLabel,
  H3_WORKFLOW_VERSION,
  mapMode,
  parseH3CreativeIr,
  renderH3Prompt,
  safeParseH3CreativeIr,
  sha256Canonical,
  sha256Text,
  validateH3AdapterRoute,
  writeH3RunArtifacts,
  type H3CreativeIr,
  type H3ExecutionRouteProfile
} from "../src/h3/index.js";
import {
  loadH3ExecutionRouteProfile,
  validateGenerationConstraints
} from "../src/adapters/constraints.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import {
  loadPromptGuideById,
  resolvePromptGuidance
} from "../src/adapters/promptKnowledge.js";
import {
  listConnectionOptions,
  loadConnectionCatalog
} from "../src/connections/registry.js";
import {
  pinGenerationAssets,
  projectAssetRoot
} from "../src/project/generationAssets.js";
import {
  generationRequestCapability,
  projectSchema,
  type GenerationRequest
} from "../src/project/schema.js";
import {
  buildMinimaxDryRunArgv,
  MINIMAX_H3_PROVIDER_MODEL,
  MINIMAX_MIN_CLI_VERSION,
  preflightMinimaxConnection,
  resolveMinimaxProviderModel
} from "../adapters/minimax/minimaxCli.mjs";

function h3Request(id: string, ir: H3CreativeIr, overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    id,
    prompt: "",
    params: {},
    h3: ir,
    ...overrides
  };
}

async function loadFixture(name: string): Promise<H3CreativeIr> {
  const raw = JSON.parse(await readFile(join("test/fixtures/h3", name), "utf8"));
  return parseH3CreativeIr(raw);
}

async function loadPixverseRouteProfile(): Promise<H3ExecutionRouteProfile> {
  const adapter = await loadAdapterDefinition("pixverse", ["adapters"]);
  const profile = await loadH3ExecutionRouteProfile(adapter.root);
  if (!profile) throw new Error("expected pixverse h3_execution_route");
  return profile;
}

async function loadMinimaxRouteProfile(): Promise<H3ExecutionRouteProfile> {
  const adapter = await loadAdapterDefinition("minimax", ["adapters"]);
  const profile = await loadH3ExecutionRouteProfile(adapter.root);
  if (!profile) throw new Error("expected minimax h3_execution_route");
  return profile;
}

describe("Phase A — last-frame schema and labels", () => {
  it("accepts last-frame mode with exactly one last_frame image", async () => {
    const ir = await loadFixture("last-frame.json");
    expect(ir.target.mode).toBe("last-frame");
    expect(ir.assets).toHaveLength(1);
    expect(ir.assets[0]).toMatchObject({ role: "last_frame", type: "image" });
  });

  it("exposes last-frame-only as the UI label for mode last-frame", () => {
    // Mode enum value is last-frame; product label is last-frame-only.
    expect(h3ModeUiLabel("last-frame")).toBe("last-frame-only");
  });

  it("rejects last-frame cardinality / foreign roles / media types", () => {
    const base = {
      version: 1 as const,
      target: {
        model: "minimax-h3" as const,
        mode: "last-frame" as const,
        duration: 5,
        quality: "768p",
        aspect: "16:9" as const,
        audio: true
      },
      subjects: [],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "End pose." }],
      sound: { soundscape: "Silence.", music: { enabled: false } }
    };

    expect(safeParseH3CreativeIr({
      ...base,
      assets: []
    }).success).toBe(false);

    expect(safeParseH3CreativeIr({
      ...base,
      assets: [
        { id: "a", type: "image", path: "assets/a.png", role: "last_frame" },
        { id: "b", type: "image", path: "assets/b.png", role: "last_frame" }
      ]
    }).success).toBe(false);

    expect(safeParseH3CreativeIr({
      ...base,
      assets: [
        { id: "start", type: "image", path: "assets/start.png", role: "first_frame" },
        { id: "end", type: "image", path: "assets/end.png", role: "last_frame" }
      ]
    }).success).toBe(false);

    expect(safeParseH3CreativeIr({
      ...base,
      assets: [
        { id: "end", type: "image", path: "assets/end.png", role: "last_frame" },
        { id: "ref", type: "image", path: "assets/ref.png", role: "subject_reference" }
      ]
    }).success).toBe(false);

    expect(safeParseH3CreativeIr({
      ...base,
      assets: [{ id: "end", type: "video", path: "assets/end.mp4", role: "last_frame" }]
    }).success).toBe(false);

    expect(safeParseH3CreativeIr({
      ...base,
      assets: [
        { id: "end", type: "image", path: "assets/end.png", role: "last_frame" },
        { id: "voice", type: "audio", path: "assets/v.wav", role: "voice_reference" }
      ]
    }).success).toBe(false);
  });

  it("rejects unsafe relative paths in last-frame assets", () => {
    const result = safeParseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "last-frame",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [{ id: "end", type: "image", path: "../escape/end.png", role: "last_frame" }],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "End." }],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    expect(result.success).toBe(false);
  });
});

describe("Phase A — official FL2VA / L2VA alignment goldens", () => {
  it("renders L2VA end-mark alignment with final shot number and two-decimal duration", async () => {
    const ir = await loadFixture("last-frame.json");
    const rendered = renderH3Prompt(ir);
    const description = rendered.sections.integrated_multimodal_description;
    expect(description).toContain(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 5.00-second mark of the target video."
    );
    expect(description).toContain("<Picture 1>");
    expect(rendered.labels.assets.end_image).toMatchObject({
      h3: "<Picture 1>",
      adapter: "@image1"
    });
  });

  it("renders FL2VA start and end official alignment anchors", async () => {
    const ir = await loadFixture("first-last.json");
    const rendered = renderH3Prompt(ir);
    const description = rendered.sections.integrated_multimodal_description;
    expect(description).toContain(
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video. <Picture 2> (from [Shot 1]) aligns with the 5.00-second mark of the target video."
    );
  });
});

describe("Phase A — provider-neutral compile + route binding", () => {
  it("maps last-frame and first-last to provider-neutral intents", async () => {
    expect(mapMode("last-frame")).toEqual({
      operation: "video",
      input_mode: "last-frame-to-video"
    });
    expect(mapMode("first-last")).toEqual({
      operation: "video",
      input_mode: "first-last-frame-to-video"
    });

    const last = compileH3Request(h3Request("lf", await loadFixture("last-frame.json")));
    expect(last.ok).toBe(true);
    expect(last.compilation!.execution_request).toMatchObject({
      operation: "video",
      input_mode: "last-frame-to-video",
      last_frame: "assets/end.png"
    });
    expect(last.compilation!.execution_request).not.toHaveProperty("first_frame");
    expect(last.compilation!.execution_request).not.toHaveProperty("input_images");
    expect(generationRequestCapability(last.compilation!.execution_request)).toBe(
      "video.last-frame-to-video"
    );

    const fl = compileH3Request(h3Request("fl", await loadFixture("first-last.json")));
    expect(fl.ok).toBe(true);
    expect(fl.compilation!.execution_request).toMatchObject({
      operation: "video",
      input_mode: "first-last-frame-to-video",
      first_frame: "assets/start.png",
      last_frame: "assets/end.png"
    });
    expect(fl.compilation!.execution_request).not.toHaveProperty("input_images");
  });

  it("uses workflow version 2 and keeps deterministic lineage hashes", async () => {
    expect(H3_WORKFLOW_VERSION).toBe("2");
    const ir = await loadFixture("last-frame.json");
    const a = compileH3Request(h3Request("lf", ir));
    const b = compileH3Request(h3Request("lf", ir));
    expect(a.ok && b.ok).toBe(true);
    expect(a.compilation!.lineage.workflow_version).toBe("2");
    expect(a.compilation!.lineage.creative_ir_hash).toBe(sha256Canonical(ir));
    expect(a.compilation!.lineage.canonical_prompt_hash).toBe(
      sha256Text(a.compilation!.canonical_prompt)
    );
    expect(a.compilation).toEqual(b.compilation);
  });

  it("fails closed with H3-C007 when PixVerse is selected for last-frame (no silent fallback)", async () => {
    const profile = await loadPixverseRouteProfile();
    expect(profile.modes?.["last-frame"]).toBeUndefined();

    const compiled = compileH3Request(h3Request("lf", await loadFixture("last-frame.json")));
    expect(compiled.ok).toBe(true);
    const bound = applyH3ExecutionRouteProfile([compiled.compilation!], profile, {
      project: projectSchema.parse({
        slug: "lf-pixverse",
        name: "lf-pixverse",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "pixverse",
          requests: [h3Request("lf", await loadFixture("last-frame.json"))]
        }
      }),
      adapterName: "pixverse"
    });
    expect(bound.ok).toBe(false);
    expect(bound.issues.some((item) => item.code === "H3-C007")).toBe(true);
    // No silent transition/T2V downgrade.
    expect(bound.compilations[0]!.execution_request.input_mode).toBe("last-frame-to-video");
    expect(bound.compilations[0]!.execution_request).not.toHaveProperty("input_images");
  });

  it("binds first-last to PixVerse transition route without inventing last-frame support", async () => {
    const profile = await loadPixverseRouteProfile();
    const compiled = compileH3Request(h3Request("fl", await loadFixture("first-last.json")));
    expect(compiled.ok).toBe(true);
    const bound = applyH3ExecutionRouteProfile([compiled.compilation!], profile, {
      project: projectSchema.parse({
        slug: "fl-pixverse",
        name: "fl-pixverse",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "pixverse",
          requests: [h3Request("fl", await loadFixture("first-last.json"))]
        }
      }),
      adapterName: "pixverse"
    });
    expect(bound.ok).toBe(true);
    expect(bound.compilations[0]!.execution_request).toMatchObject({
      operation: "transition",
      input_mode: "transition",
      input_images: ["assets/start.png", "assets/end.png"]
    });
  });

  it("maps MiniMax route with explicit ir_model → provider_model MiniMax-H3", async () => {
    const profile = await loadMinimaxRouteProfile();
    expect(profile.model).toBe("minimax-h3");
    expect(profile.provider_model).toBe(MINIMAX_H3_PROVIDER_MODEL);
    expect(resolveMinimaxProviderModel("minimax-h3")).toBe("MiniMax-H3");
    expect(() => resolveMinimaxProviderModel("unknown-model")).toThrow(/H3-C009|provider model/);

    const compiled = compileH3Request(h3Request("lf", await loadFixture("last-frame.json")));
    const bound = applyH3ExecutionRouteProfile([compiled.compilation!], profile, {
      project: projectSchema.parse({
        slug: "lf-minimax",
        name: "lf-minimax",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "minimax",
          requests: [h3Request("lf", await loadFixture("last-frame.json"))]
        }
      }),
      adapterName: "minimax"
    });
    expect(bound.ok).toBe(true);
    expect(bound.compilations[0]!.execution_request).toMatchObject({
      operation: "video",
      input_mode: "last-frame-to-video",
      last_frame: "assets/end.png",
      model: "minimax-h3"
    });
    expect(bound.compilations[0]!.execution_request.params).toMatchObject({
      provider_model: "MiniMax-H3"
    });
  });

  it("emits H3-C008 on asset binding mismatch and H3-C009 when provider model mapping is missing", async () => {
    const profile = await loadMinimaxRouteProfile();
    const ir = await loadFixture("last-frame.json");
    const compiled = compileH3Request(h3Request("lf", ir));
    expect(compiled.ok).toBe(true);

    // Strip last_frame to force binding mismatch after route apply.
    const stripped = {
      ...compiled.compilation!,
      execution_request: {
        ...compiled.compilation!.execution_request,
        last_frame: undefined
      }
    };
    const mismatch = applyH3ExecutionRouteProfile([stripped], profile, {
      project: projectSchema.parse({
        slug: "bind-mismatch",
        name: "bind-mismatch",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "minimax",
          requests: [h3Request("lf", ir)]
        }
      }),
      adapterName: "minimax"
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues.some((item) => item.code === "H3-C008")).toBe(true);

    const noProvider = {
      ...profile,
      provider_model: undefined
    };
    const missingMap = applyH3ExecutionRouteProfile([compiled.compilation!], noProvider, {
      project: projectSchema.parse({
        slug: "no-provider-model",
        name: "no-provider-model",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "minimax",
          requests: [h3Request("lf", ir)]
        }
      }),
      adapterName: "minimax"
    });
    expect(missingMap.ok).toBe(false);
    expect(missingMap.issues.some((item) => item.code === "H3-C009")).toBe(true);
  });
});

describe("Phase A — last_frame pinning, tamper, symlink, path escape", () => {
  it("pins last_frame under run dir and hashes through H3 artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-lf-pin-"));
    const assetsDir = join(root, "assets");
    await mkdir(assetsDir, { recursive: true });
    const endPath = join(assetsDir, "end.png");
    await writeFile(endPath, "last-frame-bytes");
    const runDir = join(root, "dist", "run-1");
    await mkdir(runDir, { recursive: true });

    const ir = await loadFixture("last-frame.json");
    const compiled = compileH3Request(h3Request("lf", ir));
    expect(compiled.ok).toBe(true);

    const pinned = await pinGenerationAssets(
      [compiled.compilation!.execution_request],
      root,
      projectAssetRoot(root, "manifest.json"),
      runDir
    );
    expect(pinned.ok).toBe(true);
    expect(pinned.requests[0]!.last_frame).toContain("generation-inputs");
    expect(pinned.requests[0]!.last_frame).toContain("last-frame");

    const written = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled.compilation!],
      pinnedRequests: pinned.requests,
      adapterId: "minimax"
    });
    expect(written.ok).toBe(true);
    expect(written.artifacts[0]!.compilation.lineage.asset_hashes?.end_image).toBe(
      createHash("sha256").update("last-frame-bytes").digest("hex")
    );
  });

  it("rejects symlink last_frame pins fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-lf-symlink-"));
    const assetsDir = join(root, "assets");
    await mkdir(assetsDir, { recursive: true });
    const real = join(assetsDir, "real.png");
    await writeFile(real, "real");
    const link = join(assetsDir, "end.png");
    await symlink(real, link);

    const ir = parseH3CreativeIr({
      ...(await loadFixture("last-frame.json")),
      assets: [{ id: "end_image", type: "image", path: "assets/end.png", role: "last_frame" }]
    });
    const compiled = compileH3Request(h3Request("lf", ir));
    const runDir = join(root, "dist", "run-1");
    await mkdir(runDir, { recursive: true });
    const pinned = await pinGenerationAssets(
      [compiled.compilation!.execution_request],
      root,
      projectAssetRoot(root, "manifest.json"),
      runDir
    );
    expect(pinned.ok).toBe(false);
    expect(pinned.issues.some((item) => item.code.includes("symlink"))).toBe(true);
  });

  it("rejects path escape outside asset root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-lf-escape-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-h3-outside-"));
    await writeFile(join(outside, "end.png"), "outside");
    const runDir = join(root, "dist", "run-1");
    await mkdir(runDir, { recursive: true });

    const request: GenerationRequest = {
      id: "lf",
      prompt: "x",
      params: {},
      input_mode: "last-frame-to-video",
      last_frame: join(outside, "end.png")
    };
    const pinned = await pinGenerationAssets(
      [request],
      root,
      projectAssetRoot(root, "manifest.json"),
      runDir
    );
    expect(pinned.ok).toBe(false);
    expect(pinned.issues.some((item) => item.code.includes("safe") || item.message.includes("within"))).toBe(true);
  });
});

describe("Phase A — MiniMax direct connection / dry-run (no send)", () => {
  it("reports needs-setup when mmx CLI is missing", async () => {
    const result = await preflightMinimaxConnection({
      commandExists: async () => false,
      environment: {},
      resolveVersion: async () => null
    });
    expect(result.status).toBe("needs-setup");
    expect(result.billing_action).toBe(false);
    expect(result.generation_submitted).toBe(false);
  });

  it("reports adapter.cli.version_unsupported when mmx is older than 1.0.19", async () => {
    const result = await preflightMinimaxConnection({
      commandExists: async () => true,
      environment: { MINIMAX_API_KEY: "secret-value-must-not-leak" },
      resolveVersion: async () => "1.0.18"
    });
    expect(result.status).toBe("needs-setup");
    expect(result.issues.some((item) => item.code === "adapter.cli.version_unsupported")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value-must-not-leak");
    expect(result.min_cli_version).toBe(MINIMAX_MIN_CLI_VERSION);
  });

  it("builds dry-run argv with --last-frame only (no --image / first-frame) and never bills", async () => {
    const safePath = join(tmpdir(), "pinned-end.png");
    const argv = buildMinimaxDryRunArgv({
      providerModel: "MiniMax-H3",
      prompt: "End locked pose.",
      lastFramePath: safePath,
      duration: 5,
      ratio: "16:9"
    });
    expect(argv[0]).toBe("video");
    expect(argv[1]).toBe("generate");
    expect(argv).toContain("--model");
    expect(argv).toContain("MiniMax-H3");
    expect(argv).toContain("--last-frame");
    expect(argv).toContain(safePath);
    expect(argv).toContain("--dry-run");
    expect(argv).not.toContain("--image");
    expect(argv.join(" ")).not.toMatch(/first-frame/i);
    // No shell string concatenation API — callers must pass argv arrays.
    expect(Array.isArray(argv)).toBe(true);

    const result = await preflightMinimaxConnection({
      commandExists: async () => true,
      environment: { MINIMAX_API_KEY: "do-not-print" },
      resolveVersion: async () => "1.0.19",
      // Generation route not integrated in Phase A.
      generationIntegrated: false
    });
    expect(result.billing_action).toBe(false);
    expect(result.generation_submitted).toBe(false);
    expect(["not-integrated", "needs-verification", "preflight-only"]).toContain(result.status);
    expect(result.status).not.toBe("ready");
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(result.secret_env_names).toEqual(["MINIMAX_API_KEY"]);
  });

  it("registers minimax-direct connection without claiming ready generation", async () => {
    const catalog = await loadConnectionCatalog();
    const connection = catalog.connections.find((item) => item.id === "minimax-direct");
    expect(connection).toBeDefined();
    expect(connection!.adapter).toBe("minimax");
    expect(connection!.capabilities).toEqual(expect.arrayContaining(["video.last-frame-to-video"]));
    expect(connection!.route_note.toLowerCase()).toMatch(/preflight|not integrated|mmx/);

    const options = await listConnectionOptions({
      commandExists: async () => false,
      environment: {}
    });
    const option = options.find((item) => item.id === "minimax-direct");
    expect(option).toBeDefined();
    // CLI missing → needs-setup when integrated, or not-integrated when still available-to-add.
    expect(["needs-setup", "not-integrated"]).toContain(option!.setup.status);
    expect(option!.setup.status).not.toBe("ready");
  });
});

describe("Phase A — official minimax-h3 prompt catalog source pins", () => {
  it("loads minimax-h3 catalog with source pin, license link-only, and review_after", async () => {
    const guide = await loadPromptGuideById("minimax-h3");
    expect(guide.catalog_id).toBe("minimax-h3");
    expect(guide.models.some((model) => model.id === "minimax-h3")).toBe(true);
    expect(guide.modes).toHaveProperty("last-frame-to-video");
    expect(guide.modes).toHaveProperty("first-last-frame-to-video");

    for (const source of guide.sources) {
      expect(source.url.startsWith("https://")).toBe(true);
      expect(source.accessed_at).toBe("2026-08-08");
      expect(source.license_status).toBe("unverified");
      expect(source.redistribution).toBe("link-only");
      expect(source.review_after).toBe("2026-09-07");
    }

    const h3Skill = guide.sources.find((source) => source.id === "minimax-h3-skill");
    expect(h3Skill?.url).toContain("github.com/MiniMax-AI/MiniMax-H3");
    expect(h3Skill?.commit).toBe("8d8824efaf94586c0cc9ac7ad8d0723d4d6420ea");

    // Official Skill body is not vendored into the repository.
    const skillBodyHits = await import("node:fs/promises").then(async (fs) => {
      const entries = await fs.readdir("knowledge/video-models/minimax-h3");
      return entries;
    });
    expect(skillBodyHits.every((name) => !/SKILL\.md|prompt-skill/i.test(name))).toBe(true);

    const matched = resolvePromptGuidance(
      {
        id: "lf",
        prompt: "end locked",
        model: "minimax-h3",
        input_mode: "last-frame-to-video",
        prompt_guide: { catalog: "minimax-h3" },
        params: {}
      },
      guide
    );
    expect(matched.status).toBe("matched");
  });

  it("does not mix PixVerse prompt limits into minimax-h3 catalog", async () => {
    const minimax = await loadPromptGuideById("minimax-h3");
    const pixverse = await loadPromptGuideById("pixverse");
    expect(minimax.catalog_id).not.toBe(pixverse.catalog_id);
    expect(minimax.sources.every((source) => !/pixverse/i.test(source.publisher + source.url))).toBe(true);
  });
});

describe("Phase A — route validation keeps PV-E codes inside PixVerse profile", () => {
  it("still surfaces PV-E codes only when a PixVerse route profile is injected", async () => {
    const ir = await loadFixture("t2v.json");
    const profile = await loadPixverseRouteProfile();
    const badDuration = parseH3CreativeIr({
      ...ir,
      target: { ...ir.target, duration: 7 }
    });
    const result = validateH3AdapterRoute(badDuration, profile);
    expect(result.errors.some((item) => item.code === "PV-E001")).toBe(true);

    const minimax = await loadMinimaxRouteProfile();
    // MiniMax profile may accept different durations; codes stay adapter-scoped.
    expect(minimax.model).toBe("minimax-h3");
  });
});
