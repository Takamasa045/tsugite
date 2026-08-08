/**
 * P1–P4: integrity canonicalization, model/connection profile separation,
 * fail-closed readiness, PixVerse/Kling T2V/I2V planning (no provider calls).
 * Review fixes H1–H4 / M1–M6 + Low L1–L4.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Canonical,
  sha256Text
} from "../src/integrity/canonical.js";
import {
  sha256Canonical as h3Sha256Canonical,
  sha256Text as h3Sha256Text,
  compileH3Request,
  compileProjectH3,
  parseH3CreativeIr,
  renderH3Prompt,
  H3_WORKFLOW_ID,
  H3_WORKFLOW_VERSION,
  type H3CreativeIr
} from "../src/h3/index.js";
import { createDryRun, createPlan } from "../src/orchestrator/plan.js";
import { validateProject } from "../src/project/validateProject.js";
import {
  loadModelPromptProfile,
  modelProfileDigest,
  MODEL_PROFILE_STALE_CODE,
  MODEL_PROFILE_UNKNOWN_CODE,
  MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
  MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE,
  loadConnectionCapabilityProfile,
  connectionCapabilityDigest,
  resolveExactModelRoute,
  CONNECTION_ROUTE_EXACT_MISMATCH_CODE,
  CONNECTION_FAMILY_ONLY_CODE,
  evaluatePlanningReadiness,
  VPD_ADAPTER_MISSING_CODE,
  VPD_CATALOG_NOT_ADAPTER_CODE,
  VPD_PROFILE_CONNECTION_MISMATCH_CODE,
  VPD_RUNTIME_NOT_READY_CODE,
  VPD_ADAPTER_REGISTRY_MISSING_CODE,
  resolveAdapterImplementation,
  compileVideoPromptRequest,
  compileProjectVideoPrompts,
  VIDEO_PROMPT_DUAL_AUTHORING_CODE,
  VIDEO_PROMPT_UNCOMPILED_CODE,
  exclusiveSemanticsForMode,
  parseVideoCreativeIr,
  renderPlainPrompt,
  renderVideoPrompt,
  RENDER_PROFILE_REQUIRED_CODE,
  buildAssetFields,
  applyAssetBinding,
  hashPromptGuideContent,
  verifyModelProfileAgainstKnowledge,
  loadKnowledgeModelLimits,
  resolveKnowledgePinPath,
  MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE,
  MODEL_PROFILE_KNOWLEDGE_PIN_CODE
} from "../src/videoPromptDirector/index.js";
import { projectSchema, type GenerationRequest, type Project } from "../src/project/schema.js";

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

async function loadH3Fixture(name: string): Promise<H3CreativeIr> {
  return parseH3CreativeIr(JSON.parse(await readFile(join("test/fixtures/h3", name), "utf8")));
}

function baseT2V(model: string): Record<string, unknown> {
  return {
    version: 1,
    target: {
      model,
      mode: "text-to-video",
      duration: 5,
      quality: "720p",
      aspect: "16:9",
      audio: true
    },
    subjects: [],
    assets: [],
    shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "A quiet lake at dawn." }],
    sound: { soundscape: "Soft wind.", music: { enabled: false } }
  };
}

function baseI2V(model: string): Record<string, unknown> {
  return {
    ...baseT2V(model),
    target: {
      model,
      mode: "first-frame",
      duration: 5,
      quality: "720p",
      aspect: "16:9",
      audio: true
    },
    assets: [{ id: "start", type: "image", path: "assets/start.png", role: "first_frame" }]
  };
}

describe("P1 integrity + neutral IR", () => {
  it("canonical hash is shared between integrity and h3 shim", () => {
    const value = { b: 2, a: [1, { z: 9, y: 8 }] };
    expect(canonicalJson(value)).toBe(JSON.stringify({ a: [1, { y: 8, z: 9 }], b: 2 }));
    expect(sha256Canonical(value)).toBe(h3Sha256Canonical(value));
    expect(sha256Text("hello")).toBe(h3Sha256Text("hello"));
  });

  it("video_prompt IR accepts non-H3 models while H3 IR stays locked", () => {
    const video = parseVideoCreativeIr(baseT2V("v6"));
    expect(video.target.model).toBe("v6");
    expect(() => parseH3CreativeIr(baseT2V("v6"))).toThrow();
  });

  it("H3 golden prompts remain byte-identical after integrity extraction", async () => {
    const ir = await loadH3Fixture("t2v.json");
    const golden = JSON.parse(await readFile("test/fixtures/h3/goldens/t2v.json", "utf8"));
    expect(sha256Canonical(ir)).toBe(golden.creative_ir_hash);
    expect(renderH3Prompt(ir).text).toBe(golden.canonical_prompt);
    expect(H3_WORKFLOW_ID).toBe("h3-prompt-director");
    expect(H3_WORKFLOW_VERSION).toBe("2");
  });
});

describe("P3 model profile + connection capability separation", () => {
  it("loads distinct digests for model vs connection profiles", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok).toBe(true);
    expect(connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    expect(model.digest).toBe(modelProfileDigest(model.profile));
    expect(connection.digest).toBe(connectionCapabilityDigest(connection.profile));
    expect(model.digest).not.toBe(connection.digest);
    expect(model.profile.renderer).toBe("h3-grammar");
    expect(model.profile.label_dialect).toBe("picture");
    expect(model.profile.exclusive_semantics).toContain("last-frame-only");
  });

  it("rejects unknown model profile", async () => {
    const result = await loadModelPromptProfile("not-a-real-model");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(MODEL_PROFILE_UNKNOWN_CODE);
  });

  it("rejects stale model profile digest", async () => {
    const good = await loadModelPromptProfile("v6");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const dir = await mkdtemp(join(tmpdir(), "vpd-stale-"));
    const stale = {
      ...good.profile,
      source: { ...good.profile.source, digest: "0".repeat(64) }
    };
    await writeFile(join(dir, "v6.yaml"), yamlStringify(stale));
    const result = await loadModelPromptProfile("v6", [dir]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(MODEL_PROFILE_STALE_CODE);
  });

  it("rejects family-only model match without exact route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vpd-family-"));
    await writeFile(
      join(dir, "demo.yaml"),
      yamlStringify({
        schema_version: 1,
        kind: "connection-capability-profile",
        connection_id: "demo",
        transport: "api",
        exact_model_routes: [
          {
            model: "other-model",
            provider_model: "other",
            modes: ["text-to-video"],
            family: "video-3.0"
          }
        ],
        auth_env_names: [],
        submit: false,
        poll: false,
        cancel: false,
        download: false,
        idempotency: "none",
        pricing_status: "unknown",
        runtime_readiness: "planning-only",
        adapter_id: "demo",
        source: { pin: "test", version: "0" }
      })
    );
    const loaded = await loadConnectionCapabilityProfile("demo", [dir]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const resolved = resolveExactModelRoute(loaded.profile, "video-3.0");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe(CONNECTION_FAMILY_ONLY_CODE);
    }
  });

  it("profile supports mode but connection unsupported → reject", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("pixverse");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const readiness = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: connection.profile,
      mode: "last-frame",
      semantics: exclusiveSemanticsForMode("last-frame"),
      adapterImplemented: true,
      intent: "planning"
    });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe(VPD_PROFILE_CONNECTION_MISMATCH_CODE);
    }
  });

  it("catalog present but adapter missing → reject", async () => {
    const model = await loadModelPromptProfile("v6");
    const connection = await loadConnectionCapabilityProfile("catalog-only-demo");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const readiness = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: {
        ...connection.profile,
        exact_model_routes: [
          { model: "v6", provider_model: "v6", modes: ["text-to-video", "first-frame"] }
        ]
      },
      mode: "text-to-video",
      adapterImplemented: false,
      catalogPresent: true,
      intent: "planning"
    });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe(VPD_CATALOG_NOT_ADAPTER_CODE);
  });

  it("family match without exact model → reject", async () => {
    const model = await loadModelPromptProfile("v6");
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    const readiness = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: {
        schema_version: 1,
        kind: "connection-capability-profile",
        connection_id: "demo",
        transport: "cli",
        exact_model_routes: [
          { model: "c1", provider_model: "c1", modes: ["text-to-video"], family: "v6" }
        ],
        auth_env_names: [],
        submit: false,
        poll: false,
        cancel: false,
        download: false,
        idempotency: "none",
        pricing_status: "unknown",
        runtime_readiness: "planning-only",
        adapter_id: "demo",
        source: { pin: "t", version: "0" }
      },
      mode: "text-to-video",
      adapterImplemented: true,
      intent: "planning"
    });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect([CONNECTION_FAMILY_ONLY_CODE, CONNECTION_ROUTE_EXACT_MISMATCH_CODE]).toContain(readiness.code);
    }
  });

  it("H3 last-frame succeeds on minimax-direct; same semantics on v6/video-3.0 reject", async () => {
    const h3Model = await loadModelPromptProfile("minimax-h3");
    const mmx = await loadConnectionCapabilityProfile("minimax-direct");
    expect(h3Model.ok && mmx.ok).toBe(true);
    if (!h3Model.ok || !mmx.ok) return;

    const ok = evaluatePlanningReadiness({
      modelProfile: h3Model.profile,
      connectionProfile: mmx.profile,
      mode: "last-frame",
      semantics: exclusiveSemanticsForMode("last-frame"),
      adapterImplemented: true,
      intent: "planning"
    });
    expect(ok.ok).toBe(true);

    for (const modelId of ["v6", "c1", "video-3.0", "video-3.0-omni", "o1"] as const) {
      const model = await loadModelPromptProfile(modelId);
      expect(model.ok).toBe(true);
      if (!model.ok) continue;
      const semantics = evaluatePlanningReadiness({
        modelProfile: model.profile,
        connectionProfile: {
          schema_version: 1,
          kind: "connection-capability-profile",
          connection_id: "x",
          transport: "cli",
          exact_model_routes: [
            {
              model: modelId,
              provider_model: modelId,
              modes: ["text-to-video", "first-frame", "last-frame"]
            }
          ],
          auth_env_names: [],
          submit: false,
          poll: false,
          cancel: false,
          download: false,
          idempotency: "none",
          pricing_status: "unknown",
          runtime_readiness: "planning-only",
          adapter_id: "x",
          source: { pin: "t", version: "0" }
        },
        mode: "last-frame",
        semantics: exclusiveSemanticsForMode("last-frame"),
        adapterImplemented: true,
        intent: "planning"
      });
      expect(semantics.ok).toBe(false);
      if (!semantics.ok) {
        expect([
          MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
          MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE
        ]).toContain(semantics.code);
      }
    }
  });

  it("H3 via PixVerse last-frame-only rejects (no silent fallback)", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("pixverse");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const readiness = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: connection.profile,
      mode: "last-frame",
      semantics: ["last-frame-only", "l2va"],
      adapterImplemented: true,
      intent: "planning"
    });
    expect(readiness.ok).toBe(false);
  });

  it("minimax-direct stays preflight-only and does not fallback to another connection", async () => {
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(connection.ok).toBe(true);
    if (!connection.ok) return;
    expect(connection.profile.runtime_readiness).toBe("preflight-only");
    expect(connection.profile.exact_model_routes.map((r) => r.model)).toEqual(["minimax-h3"]);
    const model = await loadModelPromptProfile("minimax-h3");
    const pix = await loadConnectionCapabilityProfile("pixverse");
    if (!model.ok || !pix.ok) return;
    const failed = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: pix.profile,
      mode: "last-frame",
      semantics: exclusiveSemanticsForMode("last-frame"),
      adapterImplemented: true,
      intent: "planning"
    });
    expect(failed.ok).toBe(false);
    const direct = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: connection.profile,
      mode: "last-frame",
      semantics: exclusiveSemanticsForMode("last-frame"),
      adapterImplemented: true,
      intent: "dry-run"
    });
    expect(direct.ok).toBe(true);
  });

  it("rejects request.h3 and video_prompt together at schema and all compile entrypoints (H1)", async () => {
    const h3Ir = await loadH3Fixture("t2v.json");
    const dual = {
      id: "r1",
      prompt: "",
      h3: h3Ir,
      video_prompt: baseT2V("v6"),
      params: {}
    };
    const projectParse = projectSchema.safeParse({
      slug: "dual-authoring",
      name: "dual",
      run_id: "dual-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "pixverse",
        connection: "pixverse",
        requests: [dual]
      }
    });
    expect(projectParse.success).toBe(false);
    if (!projectParse.success) {
      const messages = projectParse.error.issues.map((item) => item.message).join("\n");
      expect(messages).toMatch(/h3 and request\.video_prompt cannot be specified together|video_prompt/);
    }

    // schema-independent programmatic entrypoints
    const h3Compile = compileH3Request(dual as GenerationRequest);
    expect(h3Compile.ok).toBe(false);
    expect(h3Compile.issues.some((item) => item.code === VIDEO_PROMPT_DUAL_AUTHORING_CODE)).toBe(true);

    const projectCompile = compileProjectH3({
      slug: "dual",
      name: "dual",
      run_id: "dual-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "pixverse",
        connection: "pixverse",
        requests: [dual as GenerationRequest]
      }
    } as Project);
    expect(projectCompile.ok).toBe(false);
    expect(projectCompile.issues.some((item) => item.code === VIDEO_PROMPT_DUAL_AUTHORING_CODE)).toBe(true);

    const compileReject = await compileVideoPromptRequest(
      dual as GenerationRequest,
      parseVideoCreativeIr(baseT2V("v6")),
      { connectionId: "pixverse" }
    );
    expect(compileReject.ok).toBe(false);
    if (!compileReject.ok) {
      expect(compileReject.issues.some((item) => item.code === VIDEO_PROMPT_DUAL_AUTHORING_CODE)).toBe(true);
    }
  });
});

describe("P4 PixVerse / Kling T2V I2V planning dry-run", () => {
  it("plans T2V/I2V for v6 and c1 without provider calls", async () => {
    for (const model of ["v6", "c1"] as const) {
      for (const factory of [baseT2V, baseI2V] as const) {
        const ir = parseVideoCreativeIr(factory(model));
        const request: GenerationRequest = {
          id: `${model}-plan`,
          prompt: "",
          params: {},
          video_prompt: ir
        };
        const result = await compileVideoPromptRequest(request, ir, {
          connectionId: "pixverse",
          intent: "dry-run"
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.plan.compilation.canonical_prompt.includes("Picture")).toBe(false);
        expect(result.plan.model_profile.renderer).toBe("plain-prompt");
        expect(result.plan.readiness.planning_only).toBe(true);
        // H3: authoring IR stripped from execution_request
        expect((result.plan.compilation.execution_request as { video_prompt?: unknown }).video_prompt)
          .toBeUndefined();
        expect(result.plan.compilation.execution_request.h3).toBeUndefined();
        expect(result.plan.compilation.execution_request.prompt_guide).toBeUndefined();
        expect(result.plan.compilation.execution_request.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it("plans T2V/I2V for Kling video-3.0 / omni / o1 without provider calls", async () => {
    for (const model of ["video-3.0", "video-3.0-omni", "o1"] as const) {
      for (const factory of [baseT2V, baseI2V] as const) {
        const ir = parseVideoCreativeIr(factory(model));
        const request: GenerationRequest = {
          id: `${model}-plan`,
          prompt: "",
          params: {},
          video_prompt: ir
        };
        const result = await compileVideoPromptRequest(request, ir, {
          connectionId: "kling-direct",
          intent: "planning"
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.plan.compilation.lineage.workflow_id).not.toBe(H3_WORKFLOW_ID);
        expect(result.plan.compilation.canonical_prompt).toContain("shots:");
      }
    }
  });

  it("marks unsupported modes for PixVerse/Kling as fail-closed", async () => {
    const ir = parseVideoCreativeIr({
      ...baseT2V("v6"),
      target: {
        model: "v6",
        mode: "reference",
        duration: 5,
        quality: "720p",
        aspect: "16:9",
        audio: true
      },
      assets: [{ id: "ref", type: "image", path: "assets/ref.png", role: "subject_reference" }]
    });
    const result = await compileVideoPromptRequest(
      { id: "bad", prompt: "", params: {}, video_prompt: ir },
      ir,
      { connectionId: "pixverse" }
    );
    expect(result.ok).toBe(false);
  });

  it("plain renderer never emits H3 Picture / FL2VA alignment prose", async () => {
    const ir = parseVideoCreativeIr(baseI2V("v6"));
    const text = renderPlainPrompt(ir).text;
    expect(text).not.toMatch(/<Picture\s+\d+>/);
    expect(text).not.toMatch(/aligns with the/);
    expect(text).not.toMatch(/fully referenced/);
    // neutral asset labels
    expect(text).toMatch(/role=first_frame/);
    expect(renderPlainPrompt(ir).labels.orderedAssets[0]?.h3).toBe("asset:first_frame");
  });

  it("adapter missing rejects even when connection has exact route", async () => {
    // Force registry miss with explicit empty implemented set and fake adapter dirs.
    const ir = parseVideoCreativeIr(baseT2V("v6"));
    const result = await compileVideoPromptRequest(
      { id: "no-adapter", prompt: "", params: {}, video_prompt: ir },
      ir,
      {
        connectionId: "pixverse",
        implementedAdapterIds: [],
        adapterDirs: [join(tmpdir(), "no-adapters-here")],
        catalogPresent: false
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) =>
        i.code === VPD_ADAPTER_MISSING_CODE || i.code === VPD_ADAPTER_REGISTRY_MISSING_CODE
      )).toBe(true);
    }
  });

  it("caller adapterImplemented=true alone is ignored without registry match (M2)", async () => {
    const ir = parseVideoCreativeIr(baseT2V("v6"));
    const result = await compileVideoPromptRequest(
      { id: "claim-only", prompt: "", params: {}, video_prompt: ir },
      ir,
      {
        connectionId: "pixverse",
        adapterImplemented: true,
        implementedAdapterIds: [],
        adapterDirs: [join(tmpdir(), "empty-adapters")]
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === VPD_ADAPTER_REGISTRY_MISSING_CODE)).toBe(true);
    }
  });

  it("compileProjectVideoPrompts fills prompts and never silent-pass empty (H2)", async () => {
    const ir = parseVideoCreativeIr(baseT2V("v6"));
    const project = {
      slug: "vp-plan",
      name: "vp",
      run_id: "vp-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" as const },
      generation: {
        adapter: "pixverse",
        connection: "pixverse",
        requests: [{
          id: "vp1",
          prompt: "",
          params: {},
          video_prompt: ir
        } as GenerationRequest]
      }
    } as Project;

    const result = await compileProjectVideoPrompts(project, { intent: "planning" });
    expect(result.ok).toBe(true);
    expect(result.plans.length).toBe(1);
    const filled = result.project.generation!.requests[0]!;
    expect(filled.prompt.length).toBeGreaterThan(0);
    expect((filled as { video_prompt?: unknown }).video_prompt).toBeDefined();
  });

  it("compileProjectVideoPrompts fail-closed without connection (H2)", async () => {
    const ir = parseVideoCreativeIr(baseT2V("v6"));
    const project = {
      slug: "vp-fail",
      name: "vp",
      run_id: "vp-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" as const },
      generation: {
        requests: [{
          id: "vp1",
          prompt: "",
          params: {},
          video_prompt: ir
        } as GenerationRequest]
      }
    } as Project;

    const result = await compileProjectVideoPrompts(project, { intent: "planning" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === VIDEO_PROMPT_UNCOMPILED_CODE)).toBe(true);
  });
});

describe("assetBinding + execute readiness branches", () => {
  it("builds asset fields for first-last and last-frame", async () => {
    const firstLast = await loadH3Fixture("first-last.json");
    const last = await loadH3Fixture("last-frame.json");
    expect(buildAssetFields(firstLast)).toEqual({
      first_frame: firstLast.assets.find((a) => a.role === "first_frame")?.path,
      last_frame: firstLast.assets.find((a) => a.role === "last_frame")?.path
    });
    expect(buildAssetFields(last).last_frame).toBeTruthy();
    expect(buildAssetFields(last).first_frame).toBeUndefined();
  });

  it("applyAssetBinding covers none/first/last/first_and_last/input_images/reference", () => {
    const base: GenerationRequest = {
      id: "bind",
      prompt: "x",
      params: {},
      first_frame: "a.png",
      last_frame: "b.png",
      input_images: ["r1.png"],
      input_videos: ["m.mp4"],
      input_audios: ["v.wav"]
    };
    expect(applyAssetBinding(base, {
      operation: "video",
      input_mode: "text-to-video",
      asset_binding: "none"
    }).issues).toHaveLength(0);

    expect(applyAssetBinding({ ...base, first_frame: undefined }, {
      operation: "video",
      input_mode: "image-to-video",
      asset_binding: "first_frame"
    }).issues.length).toBeGreaterThan(0);

    expect(applyAssetBinding({ ...base, last_frame: undefined }, {
      operation: "video",
      input_mode: "last-frame-to-video",
      asset_binding: "last_frame"
    }).issues.length).toBeGreaterThan(0);

    expect(applyAssetBinding(base, {
      operation: "video",
      input_mode: "last-frame-to-video",
      asset_binding: "last_frame"
    }).issues.some((i) => i.message.includes("must not include first_frame"))).toBe(true);

    expect(applyAssetBinding({ ...base, last_frame: undefined }, {
      operation: "video",
      input_mode: "first-last-frame-to-video",
      asset_binding: "first_and_last_frame"
    }).issues.length).toBeGreaterThan(0);

    const packed = applyAssetBinding(base, {
      operation: "transition",
      input_mode: "transition",
      asset_binding: "first_last_as_input_images"
    });
    expect(packed.request.input_images).toEqual(["a.png", "b.png"]);
    expect(packed.request.first_frame).toBeUndefined();

    expect(applyAssetBinding({ id: "x", prompt: "", params: {} }, {
      operation: "transition",
      input_mode: "transition",
      asset_binding: "first_last_as_input_images"
    }).issues.length).toBeGreaterThan(0);

    expect(applyAssetBinding({ id: "x", prompt: "", params: {} }, {
      operation: "reference",
      input_mode: "reference",
      asset_binding: "reference_lists"
    }).issues.length).toBeGreaterThan(0);

    expect(applyAssetBinding(base, {
      operation: "reference",
      input_mode: "reference",
      asset_binding: "reference_lists"
    }).issues).toHaveLength(0);
  });

  it("execute intent always fail-closed in P0–P4 (M3)", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;

    const readyFlags = {
      modelProfile: model.profile,
      connectionProfile: {
        ...connection.profile,
        runtime_readiness: "integrated" as const
      },
      mode: "text-to-video" as const,
      adapterImplemented: true,
      intent: "execute" as const,
      runtimePreflightOk: true,
      authVerified: true,
      entitlementOk: true,
      priceKnown: true,
      costApprovalMatches: true
    };
    const blocked = evaluatePlanningReadiness(readyFlags);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(VPD_RUNTIME_NOT_READY_CODE);

    // planning still ok
    const planOk = evaluatePlanningReadiness({ ...readyFlags, intent: "planning" });
    expect(planOk.ok).toBe(true);
  });

  it("adapter registry cross-check rejects missing adapter_id (M2)", async () => {
    const missing = await resolveAdapterImplementation({
      adapterId: undefined,
      callerClaimsImplemented: true
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe(VPD_ADAPTER_REGISTRY_MISSING_CODE);

    const present = await resolveAdapterImplementation({
      adapterId: "pixverse"
    });
    expect(present.ok).toBe(true);
    if (present.ok) expect(present.source).toBe("registry");

    const explicit = await resolveAdapterImplementation({
      adapterId: "synthetic",
      implementedAdapterIds: ["synthetic"]
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.source).toBe("explicit-set");
  });

  it("hashes prompt guide content without root/path", () => {
    const hash = hashPromptGuideContent({
      catalog_id: "demo",
      root: "/tmp/local",
      path: "/tmp/local/guide.yaml",
      revision: 1
    });
    expect(hash).toBe(hashPromptGuideContent({
      catalog_id: "demo",
      root: "/other",
      path: "/other/guide.yaml",
      revision: 1
    }));
  });
});

describe("H4 o1 knowledge bounds + M4 profile pin verification", () => {
  it("o1 profile matches knowledge video-o1 (max 10, 720p/1080p, no 4k)", async () => {
    const model = await loadModelPromptProfile("o1");
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.profile.knowledge_model_id).toBe("video-o1");
    expect(model.profile.aliases).toEqual(expect.arrayContaining(["kling-video-o1", "kling-o1"]));
    expect(Math.max(...model.profile.durations)).toBe(10);
    expect(model.profile.resolutions).toEqual(["720p", "1080p"]);
    expect(model.profile.resolutions).not.toContain("4k");
    const bounds = await verifyModelProfileAgainstKnowledge(model.profile);
    expect(bounds.ok).toBe(true);
  });

  it("machine-checks all knowledge-pinned model profiles do not exceed knowledge bounds", async () => {
    const ids = ["v6", "c1", "video-3.0", "video-3.0-omni", "o1", "minimax-h3"];
    for (const id of ids) {
      const loaded = await loadModelPromptProfile(id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      if (!loaded.profile.source.pin.startsWith("knowledge/")) continue;
      const bounds = await verifyModelProfileAgainstKnowledge(loaded.profile);
      expect(bounds.ok, `${id}: ${!bounds.ok ? bounds.message : "ok"}`).toBe(true);
    }
  });

  it("detects profile that exceeds knowledge duration max", async () => {
    const model = await loadModelPromptProfile("o1");
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    const inflated = {
      ...model.profile,
      durations: [...model.profile.durations, 15]
    };
    const bounds = await verifyModelProfileAgainstKnowledge(inflated);
    expect(bounds.ok).toBe(false);
    if (!bounds.ok) expect(bounds.code).toBe(MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE);
  });
});

describe("M1 renderVideoPrompt profile required", () => {
  it("throws explicit error when profile is omitted (no H3 fallback)", async () => {
    const ir = parseVideoCreativeIr(baseT2V("v6"));
    expect(() =>
      // @ts-expect-error intentional missing profile
      renderVideoPrompt(ir)
    ).toThrow(/VPD-E040|requires an explicit model profile/);
    expect(RENDER_PROFILE_REQUIRED_CODE).toBe("VPD-E040");
  });

  it("H3 shim uses h3-grammar only when profile declares it", async () => {
    const h3 = await loadModelPromptProfile("minimax-h3");
    const ir = await loadH3Fixture("t2v.json");
    expect(h3.ok).toBe(true);
    if (!h3.ok) return;
    const rendered = renderVideoPrompt(ir, h3.profile);
    expect(rendered.text).toContain("integrated_multimodal_description");
    const plainProfile = await loadModelPromptProfile("v6");
    expect(plainProfile.ok).toBe(true);
    if (!plainProfile.ok) return;
    const plain = renderVideoPrompt(parseVideoCreativeIr(baseT2V("v6")), plainProfile.profile);
    expect(plain.text).not.toContain("integrated_multimodal_description");
  });
});

describe("P2 H3 shim byte parity via public API", () => {
  it.each([
    "t2v.json",
    "first-frame.json",
    "first-last.json",
    "last-frame.json",
    "reference.json",
    "voiceover.json"
  ] as const)("golden %s still matches compileH3Request", async (name) => {
    const ir = await loadH3Fixture(name);
    const golden = JSON.parse(await readFile(join("test/fixtures/h3/goldens", name), "utf8"));
    const compiled = compileH3Request({
      id: name.replace(/\.json$/, ""),
      prompt: "",
      params: {},
      h3: ir
    });
    expect(compiled.ok).toBe(true);
    expect(compiled.compilation!.canonical_prompt).toBe(golden.canonical_prompt);
    expect(compiled.compilation!.lineage.workflow_id).toBe("h3-prompt-director");
    expect(compiled.compilation!.lineage.workflow_version).toBe("2");
    expect(compiled.compilation!.lineage.creative_ir_hash).toBe(golden.creative_ir_hash);
    // execution_request must not carry authoring IR
    expect(compiled.compilation!.execution_request.h3).toBeUndefined();
    expect(compiled.compilation!.execution_request.prompt_guide).toBeUndefined();
  });
});

/** Shared tmp project.yaml for video_prompt-only validate/plan/dry-run paths (L1/L2/L4). */
async function writeVideoPromptOnlyProject(options?: {
  connection?: string;
  adapter?: string;
  model?: string;
  omitConnection?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-vpd-e2e-"));
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "manifests"), { recursive: true });
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media/clip.mp4"), "fixture video");
  await writeFile(
    join(root, "manifests/manifest.json"),
    `${JSON.stringify({
      meta: {
        aspect: "16:9",
        fps: 30,
        target_duration_seconds: 5,
        slug: "vpd-e2e"
      },
      clips: [{
        id: "clip-1",
        src: "../media/clip.mp4",
        in: 0,
        out: 1,
        duration: 1,
        fps: 30,
        resolution: { width: 320, height: 180 },
        audio: false
      }],
      audio: { bgm: [], narration: [], sfx: [] },
      captions: [],
      chapters: [],
      provenance: []
    }, null, 2)}\n`
  );

  const model = options?.model ?? "v6";
  const ir = parseVideoCreativeIr(baseT2V(model));
  const generation: Record<string, unknown> = {
    requests: [{
      id: "vp-e2e",
      prompt: "",
      params: {},
      video_prompt: ir
    }]
  };
  if (!options?.omitConnection) {
    generation.connection = options?.connection ?? "pixverse";
    generation.adapter = options?.adapter ?? "pixverse";
  }

  const project = {
    slug: "vpd-e2e",
    name: "video_prompt e2e",
    run_id: "vpd-e2e-run",
    manifest: "../manifests/manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    generation
  };
  const configPath = join(root, "projects/project.yaml");
  await writeFile(configPath, yamlStringify(project));
  return configPath;
}

describe("L1 createDryRun / CLI dry-run video_prompt_plans observability", () => {
  it("passes video_prompt_plans into createDryRun so dry-run JSON is observable", async () => {
    const configPath = await writeVideoPromptOnlyProject();
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.video_prompt_plans?.length).toBe(1);
    const planPrompt = validation.video_prompt_plans![0]!.compilation.canonical_prompt;
    expect(planPrompt.length).toBeGreaterThan(0);

    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.backend,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    expect(dryRun.executed).toBe(false);
    expect(dryRun.plan.video_prompt_plans).toHaveLength(1);
    expect(dryRun.plan.video_prompt_plans![0]!.compilation.canonical_prompt).toBe(planPrompt);
    // JSON-serializable surface for CLI run --dry-run
    const asJson = JSON.parse(JSON.stringify(dryRun));
    expect(asJson.plan.video_prompt_plans).toHaveLength(1);
    expect(asJson.plan.video_prompt_plans[0].compilation.canonical_prompt).toBe(planPrompt);
    expect(asJson.executed).toBe(false);
  });

  it("omits video_prompt_plans from dry-run when not provided (no silent invent)", async () => {
    const configPath = await writeVideoPromptOnlyProject();
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      undefined,
      validation.backend,
      validation.promptGuides,
      undefined,
      undefined,
      undefined,
      validation.h3_compilations
    );
    expect(dryRun.plan).not.toHaveProperty("video_prompt_plans");
  });
});

describe("L2 viewer launcher createPlan metadata parity with CLI", () => {
  it("preserves h3_compilations and video_prompt_plans when createPlan mirrors launcher args", async () => {
    // video_prompt path
    const vpPath = await writeVideoPromptOnlyProject();
    const vpValidation = await validateProject(vpPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(vpValidation.ok).toBe(true);
    expect(vpValidation.video_prompt_plans?.length).toBe(1);

    // Mirrors src/viewer/launcher.ts + src/cli.ts viewer createPlan argument list.
    const launcherPlanArgs = [
      vpValidation.project!,
      vpValidation.manifest!,
      vpValidation.adapter,
      vpValidation.analysisAdapters ?? vpValidation.analysisAdapter,
      vpValidation.promptGuides,
      vpValidation.audioAdapter,
      vpValidation.generationConnection,
      vpValidation.audioConnection,
      vpValidation.backend
    ] as const;

    const withoutMeta = createPlan(...launcherPlanArgs);
    expect(withoutMeta).not.toHaveProperty("video_prompt_plans");

    const withMeta = createPlan(
      ...launcherPlanArgs,
      vpValidation.h3_compilations,
      vpValidation.video_prompt_plans
    );
    expect(withMeta.video_prompt_plans).toHaveLength(1);
    expect(withMeta.video_prompt_plans![0]!.compilation.canonical_prompt)
      .toBe(vpValidation.video_prompt_plans![0]!.compilation.canonical_prompt);
    expect(withMeta.video_prompt_plans![0]!.model_profile_digest)
      .toBe(vpValidation.video_prompt_plans![0]!.model_profile_digest);

    // H3 path regression: launcher must keep validate-time lineage metadata.
    const h3Ir = await loadH3Fixture("t2v.json");
    const h3Root = await mkdtemp(join(tmpdir(), "tsugite-vpd-h3-launcher-"));
    await mkdir(join(h3Root, "projects"), { recursive: true });
    await mkdir(join(h3Root, "manifests"), { recursive: true });
    await mkdir(join(h3Root, "media"), { recursive: true });
    await writeFile(join(h3Root, "media/clip.mp4"), "fixture video");
    await writeFile(
      join(h3Root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "h3-launcher" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    await writeFile(
      join(h3Root, "projects/project.yaml"),
      yamlStringify({
        slug: "h3-launcher",
        name: "h3 launcher",
        run_id: "h3-launcher-run",
        manifest: "../manifests/manifest.json",
        dist_dir: "dist",
        edit: { backend: "remotion" },
        generation: {
          adapter: "mock-cli",
          requests: [{
            id: "h3-shot",
            prompt: "",
            params: {},
            h3: h3Ir,
            prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
          }]
        }
      })
    );
    const h3Validation = await validateProject(join(h3Root, "projects/project.yaml"), {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: ["knowledge/video-models"]
    });
    expect(h3Validation.ok).toBe(true);
    const expectedHash = h3Validation.h3_compilations![0]!.lineage.prompt_guide_hash;
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

    const h3LauncherArgs = [
      h3Validation.project!,
      h3Validation.manifest!,
      h3Validation.adapter,
      h3Validation.analysisAdapters ?? h3Validation.analysisAdapter,
      h3Validation.promptGuides,
      h3Validation.audioAdapter,
      h3Validation.generationConnection,
      h3Validation.audioConnection,
      h3Validation.backend
    ] as const;
    const recompiled = createPlan(...h3LauncherArgs);
    expect(recompiled.h3_compilations![0]!.lineage.prompt_guide_hash).toBeUndefined();
    const launcherH3 = createPlan(
      ...h3LauncherArgs,
      h3Validation.h3_compilations,
      h3Validation.video_prompt_plans
    );
    expect(launcherH3.h3_compilations![0]!.lineage.prompt_guide_hash).toBe(expectedHash);
  });
});

describe("L3 knowledge-pinned load enforces bounds even with fresh digest", () => {
  it("rejects knowledge-pinned profile that exceeds knowledge max after digest update", async () => {
    const good = await loadModelPromptProfile("o1");
    expect(good.ok).toBe(true);
    if (!good.ok) return;

    const inflated = {
      ...good.profile,
      durations: [...good.profile.durations, 15]
    };
    const digest = modelProfileDigest(inflated);
    // Digest matches body, but knowledge still caps at 10.
    const body = {
      ...inflated,
      source: {
        ...inflated.source,
        digest
      }
    };
    const dir = await mkdtemp(join(tmpdir(), "vpd-bounds-load-"));
    await writeFile(join(dir, "o1.yaml"), yamlStringify(body));
    const loaded = await loadModelPromptProfile("o1", [dir]);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.code).toBe(MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE);
      expect(loaded.message).toMatch(/exceeds|duration/i);
    }
  });

  it("still rejects non-knowledge pin path for bounds helper (path safety)", async () => {
    const good = await loadModelPromptProfile("o1");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const unsafe = {
      ...good.profile,
      source: {
        ...good.profile.source,
        pin: "/etc/passwd#video-o1@x",
        digest: undefined
      }
    };
    const bounds = await verifyModelProfileAgainstKnowledge(unsafe);
    expect(bounds.ok).toBe(false);
    if (!bounds.ok) {
      expect(bounds.code).toBe(MODEL_PROFILE_KNOWLEDGE_PIN_CODE);
      expect(bounds.message).toMatch(/absolute|knowledge\//i);
    }
  });

  it("rejects knowledge/../package.json#x traversal before read (VPD-E006)", async () => {
    const pin = "knowledge/../package.json#video-o1@x";
    const lexical = resolveKnowledgePinPath("knowledge/../package.json");
    expect(lexical.ok).toBe(false);
    if (!lexical.ok) {
      expect(lexical.code).toBe(MODEL_PROFILE_KNOWLEDGE_PIN_CODE);
    }
    const loaded = await loadKnowledgeModelLimits(pin);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.code).toBe(MODEL_PROFILE_KNOWLEDGE_PIN_CODE);
      expect(loaded.message).toMatch(/knowledge\/|resolve/i);
    }
  });

  it("rejects absolute source.pin paths with VPD-E006 before read", async () => {
    const abs = resolve(process.cwd(), "knowledge/video-models/kling/prompt-guide.yaml");
    const loaded = await loadKnowledgeModelLimits(`${abs}#video-o1@x`);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.code).toBe(MODEL_PROFILE_KNOWLEDGE_PIN_CODE);
      expect(loaded.message).toMatch(/absolute/i);
    }
  });

  it("rejects symlink escape out of knowledge root before read (VPD-E006)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vpd-knowledge-symlink-"));
    const knowledgeDir = join(root, "knowledge");
    const outsideDir = join(root, "outside");
    await mkdir(knowledgeDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const outsideGuide = join(outsideDir, "escaped-guide.yaml");
    await writeFile(
      outsideGuide,
      yamlStringify({
        models: [{
          id: "video-o1",
          limits: {
            duration_seconds: { min: 1, max: 99 },
            resolutions: ["720p"]
          }
        }]
      })
    );
    const linkPath = join(knowledgeDir, "escape-link.yaml");
    try {
      await symlink(outsideGuide, linkPath);
    } catch (error) {
      // Some CI sandboxes disallow symlinks; skip only then.
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/EPERM|EACCES|operation not permitted|privilege/i);
      return;
    }

    const loaded = await loadKnowledgeModelLimits(
      "knowledge/escape-link.yaml#video-o1@x",
      undefined,
      { repoRoot: root }
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.code).toBe(MODEL_PROFILE_KNOWLEDGE_PIN_CODE);
      expect(loaded.message).toMatch(/realpath escaped|knowledge\//i);
    }
  });

  it("loads normal knowledge pin successfully under resolve/relative containment", async () => {
    const pin = "knowledge/video-models/kling/prompt-guide.yaml#video-o1@2026-07-10.1";
    const lexical = resolveKnowledgePinPath("knowledge/video-models/kling/prompt-guide.yaml");
    expect(lexical.ok).toBe(true);
    if (lexical.ok) {
      expect(lexical.absolutePath).toBe(
        resolve(process.cwd(), "knowledge/video-models/kling/prompt-guide.yaml")
      );
    }
    const loaded = await loadKnowledgeModelLimits(pin);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.knowledge.modelId).toBe("video-o1");
    expect(loaded.knowledge.durationMax).toBe(10);
    expect(loaded.knowledge.resolutions).toEqual(expect.arrayContaining(["720p", "1080p"]));
  });

  it("load skips knowledge bounds only when pin is not knowledge-rooted", async () => {
    const good = await loadModelPromptProfile("v6");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const localOnly = {
      ...good.profile,
      source: {
        pin: "local/fixture@0",
        version: "0"
      }
    };
    const digest = modelProfileDigest(localOnly);
    const body = {
      ...localOnly,
      source: { ...localOnly.source, digest }
    };
    const dir = await mkdtemp(join(tmpdir(), "vpd-local-pin-"));
    await writeFile(join(dir, "v6.yaml"), yamlStringify(body));
    const loaded = await loadModelPromptProfile("v6", [dir]);
    expect(loaded.ok).toBe(true);
  });
});

describe("L4 video_prompt-only validate → plan → dry-run E2E", () => {
  it("CLI validate --json includes optional video_prompt_plans for video_prompt-only project", async () => {
    const configPath = await writeVideoPromptOnlyProject();
    // Library path first (same observability surface as plan/dry-run feeders).
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.video_prompt_plans?.length).toBe(1);
    const expectedPrompt =
      validation.video_prompt_plans![0]!.compilation.canonical_prompt;
    expect(expectedPrompt.length).toBeGreaterThan(0);

    // CLI surface: validate --json must expose the same optional field (not plan-only).
    const result = runPipeline(["validate", "--config", configPath, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("validate");
    expect(parsed.video_prompt_plans).toHaveLength(1);
    expect(parsed.video_prompt_plans[0].compilation.canonical_prompt).toBe(expectedPrompt);
    expect(parsed.video_prompt_plans[0].readiness.planning_only).toBe(true);
    // Still optional: absent when empty (non-video_prompt projects keep payload lean).
    expect(parsed.h3_compilations).toBeUndefined();
  });

  it("tmp project.yaml video_prompt-only never silent-passes empty prompt", async () => {
    const configPath = await writeVideoPromptOnlyProject();
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.video_prompt_plans).toHaveLength(1);
    const filled = validation.project!.generation!.requests[0]!;
    expect(filled.prompt.length).toBeGreaterThan(0);
    expect((filled as { video_prompt?: unknown }).video_prompt).toBeDefined();
    // No H3 dual path
    expect(validation.h3_compilations ?? []).toEqual([]);

    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.backend,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    expect(plan.video_prompt_plans).toHaveLength(1);
    expect(plan.video_prompt_plans![0]!.compilation.execution_request.prompt.length)
      .toBeGreaterThan(0);
    expect(plan.video_prompt_plans![0]!.compilation.execution_request.h3).toBeUndefined();
    expect(
      (plan.video_prompt_plans![0]!.compilation.execution_request as { video_prompt?: unknown })
        .video_prompt
    ).toBeUndefined();
    expect(plan.video_prompt_plans![0]!.readiness.planning_only).toBe(true);

    const dryRun = createDryRun(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.backend,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.h3_compilations,
      validation.video_prompt_plans
    );
    expect(dryRun.executed).toBe(false);
    expect(dryRun.plan.video_prompt_plans).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(dryRun.plan.video_prompt_plans)).length).toBe(1);

    // execute intent remains fail-closed on planning readiness
    const model = await loadModelPromptProfile("v6");
    const connection = await loadConnectionCapabilityProfile("pixverse");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const executeBlocked = evaluatePlanningReadiness({
      modelProfile: model.profile,
      connectionProfile: {
        ...connection.profile,
        runtime_readiness: "integrated"
      },
      mode: "text-to-video",
      adapterImplemented: true,
      intent: "execute",
      runtimePreflightOk: true,
      authVerified: true,
      entitlementOk: true,
      priceKnown: true,
      costApprovalMatches: true
    });
    expect(executeBlocked.ok).toBe(false);
  });

  it("fails closed when video_prompt has no connection (no empty prompt pass)", async () => {
    const configPath = await writeVideoPromptOnlyProject({ omitConnection: true });
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((item) => item.code === VIDEO_PROMPT_UNCOMPILED_CODE)).toBe(true);
  });
});
