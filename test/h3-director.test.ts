import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_SECTION_ORDER,
  REFERENCE_SECTION_ORDER,
  applyH3ExecutionRouteProfile,
  compileH3Request,
  compileProjectH3,
  formatCutTimestamp,
  h3AdapterPromptFileName,
  H3_ROUTE_MODEL_MISMATCH_CODE,
  H3_ROUTE_PROFILE_REQUIRED_CODE,
  H3_WORKFLOW_ID,
  H3_WORKFLOW_VERSION,
  inspectH3RunArtifacts,
  mapH3AssetLabels,
  parseH3CreativeIr,
  renderH3Prompt,
  renderH3ReferencePrompt,
  safeParseH3CreativeIr,
  sha256Canonical,
  sha256Text,
  stablePrettyJson,
  validateH3CreativeIr,
  validateH3Format,
  validateH3AdapterRoute,
  validateH3Warnings,
  writeH3RunArtifacts,
  type H3Compilation,
  type H3CreativeIr,
  type H3ExecutionRouteProfile
} from "../src/h3/index.js";
import {
  loadH3ExecutionRouteProfile,
  validateGenerationConstraints
} from "../src/adapters/constraints.js";
import {
  loadPromptGuide,
  resolvePromptGuidance
} from "../src/adapters/promptKnowledge.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { createDryRun, createPlan } from "../src/orchestrator/plan.js";
import { loadProject } from "../src/project/loadProject.js";
import {
  projectSchema,
  toAdapterGenerationRequest,
  toExecutionGenerationRequest,
  type GenerationRequest
} from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

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

/** Load real PixVerse adapter route profile — never duplicate values in tests. */
async function loadPixverseRouteProfile(): Promise<H3ExecutionRouteProfile> {
  const adapter = await loadAdapterDefinition("pixverse", ["adapters"]);
  const profile = await loadH3ExecutionRouteProfile(adapter.root);
  if (!profile) {
    throw new Error("expected adapters/pixverse/constraints.yaml to declare h3_execution_route");
  }
  return profile;
}

describe("H3 Creative IR schema", () => {
  it("parses version-1 fixtures for each supported mode", async () => {
    for (const name of ["t2v.json", "first-frame.json", "first-last.json", "reference.json", "voiceover.json"]) {
      const ir = await loadFixture(name);
      expect(ir.version).toBe(1);
      expect(["text-to-video", "first-frame", "first-last", "reference"]).toContain(ir.target.mode);
    }
  });

  it("accepts model-general aspect 4:3 and free-form quality without route checks", () => {
    const result = safeParseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "text-to-video",
        duration: 12,
        quality: "1080p",
        aspect: "4:3",
        audio: true
      },
      subjects: [],
      assets: [],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "A quiet lake." }],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target.aspect).toBe("4:3");
      expect(result.data.target.quality).toBe("1080p");
    }
  });

  it("rejects manual numbered reference-section overrides", () => {
    const result = safeParseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "reference",
        duration: 10,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [{ id: "hero", type: "image", path: "assets/hero.png", role: "subject_reference" }],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "A quiet lake." }],
      sound: { soundscape: "Wind.", music: { enabled: false } },
      reference: {
        subject_definitions: "<Subject 1> is the hero shown in <Picture 1> (@image1).",
        summary: "manual",
        retention_analysis: "manual",
        detailed_description: "manual"
      }
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsafe ids and path traversal", () => {
    const base = {
      version: 1 as const,
      target: {
        model: "minimax-h3",
        mode: "text-to-video" as const,
        duration: 5,
        quality: "768p" as const,
        aspect: "16:9" as const,
        audio: true
      },
      subjects: [],
      assets: [{ id: "../escape", type: "image" as const, path: "assets/x.png", role: "other" as const }],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "A quiet lake." }],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    };
    expect(safeParseH3CreativeIr(base).success).toBe(false);

    const pathTraversal = {
      ...base,
      assets: [{ id: "hero", type: "image" as const, path: "../secrets/x.png", role: "other" as const }]
    };
    expect(safeParseH3CreativeIr(pathTraversal).success).toBe(false);

    const absolute = {
      ...base,
      assets: [{ id: "hero", type: "image" as const, path: "/tmp/x.png", role: "other" as const }]
    };
    expect(safeParseH3CreativeIr(absolute).success).toBe(false);
  });

  it("does not accept last-frame-only as a mode", () => {
    const result = safeParseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "last-frame-only",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "End pose." }],
      sound: { soundscape: "Silence.", music: { enabled: false } }
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown target.model without alias or fallback", () => {
    const result = safeParseH3CreativeIr({
      version: 1,
      target: {
        model: "not-h3",
        mode: "text-to-video",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "A quiet lake." }],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    expect(result.success).toBe(false);
  });
});

describe("H3 asset label mapping", () => {
  it("assigns deterministic type-specific H3 and adapter labels without caller numbers", async () => {
    const ir = await loadFixture("reference.json");
    const labels = mapH3AssetLabels(ir);

    expect(labels.assets.character_image).toMatchObject({
      h3: "<Picture 1>",
      adapter: "@image1",
      index: 1
    });
    expect(labels.assets.motion_video).toMatchObject({
      h3: "<Video 1>",
      adapter: "@video1",
      index: 1
    });
    expect(labels.assets.voice_audio).toMatchObject({
      h3: "<Audio 1>",
      adapter: "@audio1",
      index: 1
    });
    expect(labels.subjects.hero.h3).toBe("<Subject 1>");

    // Reordering types does not renumber across types.
    const reordered = parseH3CreativeIr({
      ...ir,
      assets: [ir.assets[2], ir.assets[0], ir.assets[1]]
    });
    const relabeled = mapH3AssetLabels(reordered);
    expect(relabeled.assets.voice_audio.adapter).toBe("@audio1");
    expect(relabeled.assets.character_image.adapter).toBe("@image1");
    expect(relabeled.assets.motion_video.adapter).toBe("@video1");
  });
});

describe("H3 deterministic renderers", () => {
  it("renders base T2V sections in exact order with shot timestamp rules", async () => {
    const ir = await loadFixture("t2v.json");
    const rendered = renderH3Prompt(ir);

    expect(rendered.format).toBe("base");
    expect(Object.keys(rendered.sections)).toEqual([...BASE_SECTION_ORDER]);
    expect(rendered.text.indexOf("integrated_multimodal_description:"))
      .toBeLessThan(rendered.text.indexOf("overall_soundscape:"));
    expect(rendered.text.indexOf("overall_soundscape:"))
      .toBeLessThan(rendered.text.indexOf("non_diegetic_music:"));

    expect(rendered.sections.integrated_multimodal_description).toContain("[Shot 1]");
    expect(rendered.sections.integrated_multimodal_description).not.toMatch(/\[Shot 1\].*At \d{2}:\d{2}\.\d{3}/);
    expect(rendered.sections.integrated_multimodal_description).toContain(`[Shot 2] At ${formatCutTimestamp(5000)},`);
    expect(rendered.sections.integrated_multimodal_description).toContain(
      "<d>[Japanese]AIと自然が、やっと同じ場所で動き始めた。</d>"
    );
    expect(rendered.sections.integrated_multimodal_description).toContain("(S1)");
    expect(rendered.sections.non_diegetic_music).toContain("acoustic guitar");
  });

  it("starts first-frame output with the supplied reference instruction and supports music N/A", async () => {
    const ir = await loadFixture("first-frame.json");
    const rendered = renderH3Prompt(ir);
    const description = rendered.sections.integrated_multimodal_description;

    expect(description.startsWith("For the target video, at 0.00 seconds into the target video,")).toBe(true);
    expect(description).toContain("<Picture 1> (from [Shot 1]) is fully referenced.");
    expect(rendered.sections.non_diegetic_music).toBe("N/A");
  });

  it("renders first-last with first-frame alignment and continuous visual prose", async () => {
    const ir = await loadFixture("first-last.json");
    const rendered = renderH3Prompt(ir);
    expect(rendered.format).toBe("base");
    expect(rendered.sections.integrated_multimodal_description).toContain("<Picture 1>");
    expect(rendered.sections.integrated_multimodal_description).toContain("Continuously transform");
  });

  it("renders reference sections in exact order with subject and media bindings", async () => {
    const ir = await loadFixture("reference.json");
    const rendered = renderH3Prompt(ir);

    expect(rendered.format).toBe("reference");
    expect(Object.keys(rendered.sections)).toEqual([...REFERENCE_SECTION_ORDER]);
    const order = REFERENCE_SECTION_ORDER.map((section) => rendered.text.indexOf(`${section}:`));
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }
    expect(rendered.sections.subject_definitions).toContain("<Subject 1>");
    expect(rendered.sections.subject_definitions).toContain("<Picture 1>");
    expect(rendered.sections.subject_definitions).toContain("@image1");
    expect(rendered.sections.subject_definitions).toContain("@video1");
    expect(rendered.sections.subject_definitions).toContain("@audio1");
    expect(rendered.sections.detailed_description).toContain("[Shot 1]");
    expect(rendered.sections.detailed_description).toContain("At 00:05.000");
  });

  it("locks dialogue byte-for-byte and adds voiceover lip closure instruction", async () => {
    const ir = await loadFixture("voiceover.json");
    const rendered = renderH3Prompt(ir);
    const body = rendered.sections.integrated_multimodal_description;

    expect(body).toContain("says in an off-screen voiceover:");
    expect(body).toContain("<d>[Japanese]あの日から、すべてが変わった。</d>");
    expect(body).toContain("while his lips remain completely closed.");
    expect(body).toContain("On-screen text: DAY 01");
    expect(rendered.sections.non_diegetic_music).toBe("N/A");
  });

  it("preserves leading/trailing spaces and embedded newlines in locked text payloads", async () => {
    const ir = await loadFixture("t2v.json");
    const dialogueText = "  日本語  \n二行目  ";
    const onScreen = "  字幕  \n続き  ";
    const lyrics = "  歌詞  \nサビ  ";
    const withPayloads = parseH3CreativeIr({
      ...ir,
      shots: [
        {
          ...ir.shots[0],
          dialogue: {
            speaker: "hero",
            language: "Japanese",
            text: dialogueText,
            lock_text: true
          },
          on_screen_text: onScreen,
          lyrics
        },
        ir.shots[1]
      ]
    });
    const rendered = renderH3Prompt(withPayloads);
    const body = rendered.sections.integrated_multimodal_description;
    const full = rendered.text;

    expect(body).toContain(`<d>[Japanese]${dialogueText}</d>`);
    expect(body).toContain(`On-screen text: ${onScreen}`);
    expect(body).toContain(`Lyrics: ${lyrics}`);
    // Exact payloads must survive into the final joined prompt, including trailing spaces.
    expect(full).toContain(`<d>[Japanese]${dialogueText}</d>`);
    expect(full).toContain(`On-screen text: ${onScreen}`);
    expect(full).toContain(`Lyrics: ${lyrics}`);
    // Leading spaces on the locked payload remain after the fixed labels.
    expect(full.includes(`On-screen text: ${onScreen}`)).toBe(true);
    expect(full.includes("On-screen text:   字幕")).toBe(true);
    expect(full.includes("Lyrics:   歌詞")).toBe(true);
    expect(full).toContain("  日本語  \n二行目  ");
    expect(full).toContain("  字幕  \n続き  ");
    expect(full).toContain("  歌詞  \nサビ  ");
  });
});

describe("H3 static validation", () => {
  it("accepts a valid rendered T2V prompt", async () => {
    const ir = await loadFixture("t2v.json");
    const rendered = renderH3Prompt(ir);
    const pixverseRoute = await loadPixverseRouteProfile();
    const result = validateH3CreativeIr(ir, {
      renderedText: rendered.text,
      routeProfile: pixverseRoute
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags invalid timeline and undefined refs with stable codes", async () => {
    const ir = await loadFixture("t2v.json");
    const invalid = parseH3CreativeIr({
      ...ir,
      shots: [
        { ...ir.shots[0], start_ms: 0, end_ms: 4000 },
        { ...ir.shots[1], start_ms: 0, end_ms: 15000 }
      ]
    });
    const timeline = validateH3Format(invalid);
    expect(timeline.errors.some((item) => item.code === "H3-E004")).toBe(true);
    expect(timeline.errors.some((item) => item.code === "H3-E005")).toBe(true);

    const rendered = renderH3Prompt(ir).text.replaceAll("<d>[Japanese]", "<d>[English]");
    const lock = validateH3Format(ir, rendered);
    expect(lock.errors.some((item) => item.code === "H3-E007")).toBe(true);

    const withGhostLabel = `${renderH3Prompt(ir).text}\n<Picture 9>`;
    const refs = validateH3Format(ir, withGhostLabel);
    expect(refs.errors.some((item) => item.code === "H3-E008")).toBe(true);
  });

  it("rejects Shot 1 timestamps and missing required sections", async () => {
    const ir = await loadFixture("t2v.json");
    const badShot1 = validateH3Format(ir, "integrated_multimodal_description:\n[Shot 1] At 00:00.000, hello\n\noverall_soundscape:\nWind.\n\nnon_diegetic_music:\nN/A");
    expect(badShot1.errors.some((item) => item.code === "H3-E002")).toBe(true);

    const missing = validateH3Format(ir, "integrated_multimodal_description:\n[Shot 1] hello");
    expect(missing.errors.some((item) => item.code === "H3-E001")).toBe(true);
  });

  it("keeps adapter route checks separate and enforces PixVerse profile limits from constraints.yaml", async () => {
    const route = await loadPixverseRouteProfile();
    expect(route.model).toBe("minimax-h3");
    const ir = await loadFixture("reference.json");
    expect(validateH3AdapterRoute(ir, route).ok).toBe(true);

    const badDuration = parseH3CreativeIr({
      ...ir,
      target: { ...ir.target, duration: 7 }
    });
    expect(validateH3AdapterRoute(badDuration, route).errors.map((item) => item.code)).toContain("PV-E001");

    // Model-general 4:3 parses as IR knowledge, then fails the narrower adapter route.
    const aspect43 = parseH3CreativeIr({
      ...ir,
      target: { ...ir.target, aspect: "4:3" }
    });
    expect(aspect43.target.aspect).toBe("4:3");
    expect(validateH3AdapterRoute(aspect43, route).errors.map((item) => item.code)).toContain("PV-E008");

    const unsupportedQuality = parseH3CreativeIr({
      ...ir,
      target: { ...ir.target, quality: "1080p" }
    });
    expect(validateH3AdapterRoute(unsupportedQuality, route).errors.map((item) => item.code)).toContain("PV-E002");

    const tooManyImages = parseH3CreativeIr({
      ...ir,
      subjects: ir.subjects.map((subject) => ({
        ...subject,
        source_asset: "img_1",
        voice: subject.voice ? { ...subject.voice, source_asset: "voice_audio" } : undefined
      })),
      assets: [
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `img_${index + 1}`,
          type: "image" as const,
          path: `assets/img-${index + 1}.png`,
          role: "subject_reference" as const
        })),
        ir.assets[1],
        ir.assets[2]
      ]
    });
    const imageLimit = validateH3AdapterRoute(tooManyImages, route);
    expect(imageLimit.errors.some((item) => item.code === "PV-E003")).toBe(true);

    const tooManyVideos = parseH3CreativeIr({
      ...ir,
      assets: [
        ir.assets[0],
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `vid_${index + 1}`,
          type: "video" as const,
          path: `assets/vid-${index + 1}.mp4`,
          role: "motion_reference" as const
        })),
        ir.assets[2]
      ]
    });
    expect(validateH3AdapterRoute(tooManyVideos, route).errors.map((item) => item.code)).toContain("PV-E004");

    const tooManyAudios = parseH3CreativeIr({
      ...ir,
      assets: [
        ir.assets[0],
        ir.assets[1],
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `aud_${index + 1}`,
          type: "audio" as const,
          path: `assets/aud-${index + 1}.wav`,
          role: "voice_reference" as const
        }))
      ],
      subjects: ir.subjects.map((subject) => ({
        ...subject,
        voice: subject.voice ? { ...subject.voice, source_asset: "aud_1" } : undefined
      }))
    });
    expect(validateH3AdapterRoute(tooManyAudios, route).errors.map((item) => item.code)).toContain("PV-E005");

    const audioOnly = parseH3CreativeIr({
      ...ir,
      subjects: ir.subjects.map((subject) => ({
        ...subject,
        source_asset: undefined,
        voice: subject.voice ? { ...subject.voice, source_asset: "voice_audio" } : undefined
      })),
      assets: [ir.assets[2]]
    });
    expect(validateH3AdapterRoute(audioOnly, route).errors.map((item) => item.code)).toContain("PV-E006");

    const mixed = parseH3CreativeIr({
      ...ir,
      assets: [
        ...ir.assets,
        { id: "start", type: "image", path: "assets/start.png", role: "first_frame" }
      ]
    });
    expect(validateH3AdapterRoute(mixed, route).errors.map((item) => item.code)).toContain("PV-E007");
  });

  it("applies only the injected alternate route profile (PixVerse 3/5/10 and 16:9/9:16 are not core defaults)", async () => {
    const alternate: H3ExecutionRouteProfile = {
      model: "minimax-h3",
      durations: [4, 7, 12],
      qualities: ["480p", "1080p"],
      aspects: ["1:1", "4:3"],
      maxImages: 2,
      maxVideos: 1,
      maxAudios: 1,
      audioRequiresImageOrVideo: true,
      forbidFirstLastReferenceMix: true
    };
    const ir = await loadFixture("t2v.json");
    // Values that fail PixVerse but pass the alternate profile.
    const alternateOk = parseH3CreativeIr({
      ...ir,
      target: {
        ...ir.target,
        duration: 7,
        quality: "1080p",
        aspect: "4:3"
      },
      shots: [
        { ...ir.shots[0], start_ms: 0, end_ms: 3500 },
        { ...ir.shots[1], start_ms: 3500, end_ms: 7000 }
      ]
    });
    expect(validateH3AdapterRoute(alternateOk, alternate).ok).toBe(true);

    // Common PixVerse route values fail under the alternate profile (not core defaults).
    const pixverseClassic = parseH3CreativeIr({
      ...ir,
      target: {
        ...ir.target,
        duration: 5,
        quality: "768p",
        aspect: "16:9"
      },
      shots: [
        { ...ir.shots[0], start_ms: 0, end_ms: 2500 },
        { ...ir.shots[1], start_ms: 2500, end_ms: 5000 }
      ]
    });
    const classicErrors = new Set(
      validateH3AdapterRoute(pixverseClassic, alternate).errors.map((item) => item.code)
    );
    expect(classicErrors.has("PV-E001")).toBe(true);
    expect(classicErrors.has("PV-E002")).toBe(true);
    expect(classicErrors.has("PV-E008")).toBe(true);

    // Format-only compile does not invent vendor route failures.
    const formatOnly = compileH3Request(h3Request("shot", alternateOk));
    expect(formatOnly.ok).toBe(true);
    expect(formatOnly.issues.some((item) => item.code.startsWith("PV-E"))).toBe(false);
  });

  it("fails closed with H3-C006 when route profile model mismatches IR target.model (not PV-E002)", async () => {
    const ir = await loadFixture("t2v.json");
    const mismatched: H3ExecutionRouteProfile = {
      model: "typo-or-other-model",
      durations: [3, 5, 10],
      qualities: ["768p", "1440p"],
      aspects: ["16:9", "9:16"],
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
      audioRequiresImageOrVideo: true,
      forbidFirstLastReferenceMix: true
    };

    const direct = validateH3AdapterRoute(ir, mismatched);
    expect(direct.ok).toBe(false);
    expect(direct.errors.map((item) => item.code)).toContain(H3_ROUTE_MODEL_MISMATCH_CODE);
    expect(direct.errors.map((item) => item.code)).toContain("H3-C006");
    expect(direct.errors.some((item) => item.code === "PV-E002")).toBe(false);
    expect(direct.errors.some((item) =>
      item.code === H3_ROUTE_MODEL_MISMATCH_CODE
      && Array.isArray(item.path)
      && item.path.join(".") === "target.model"
    )).toBe(true);

    // Multiple H3 requests keep correct generation.requests.<index>.h3.target.model paths.
    const multi = projectSchema.parse({
      slug: "h3-model-mismatch",
      name: "H3 model mismatch",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "mock-cli",
        requests: [
          { id: "prompt-only", prompt: "handwritten", params: {} },
          h3Request("h3-a", ir),
          h3Request("h3-b", ir)
        ]
      }
    });
    const pure = compileProjectH3(multi);
    expect(pure.ok).toBe(true);
    expect(pure.compilations).toHaveLength(2);

    const routed = applyH3ExecutionRouteProfile(pure.compilations, mismatched, {
      project: pure.project,
      adapterName: "mock-cli"
    });
    expect(routed.ok).toBe(false);
    const modelIssues = routed.issues.filter((item) => item.code === H3_ROUTE_MODEL_MISMATCH_CODE);
    expect(modelIssues).toHaveLength(2);
    expect(modelIssues.map((item) => item.path).sort()).toEqual([
      "generation.requests.1.h3.target.model",
      "generation.requests.2.h3.target.model"
    ]);
    expect(routed.issues.some((item) => item.code === "PV-E002")).toBe(false);
  });

  it("rejects missing or empty h3_execution_route.model as constraints schema error (no silent fallback)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-route-model-"));
    await writeFile(
      join(root, "constraints.yaml"),
      [
        "checks: []",
        "h3_execution_route:",
        "  durations: [3, 5, 10]",
        '  qualities: ["768p", "1440p"]',
        '  aspects: ["16:9", "9:16"]',
        "  max_images: 9",
        "  max_videos: 3",
        "  max_audios: 3",
        "  audio_requires_image_or_video: true",
        "  forbid_first_last_reference_mix: true",
        ""
      ].join("\n")
    );
    await expect(loadH3ExecutionRouteProfile(root)).rejects.toThrow();

    const emptyModelRoot = await mkdtemp(join(tmpdir(), "tsugite-h3-route-empty-model-"));
    await writeFile(
      join(emptyModelRoot, "constraints.yaml"),
      [
        "checks: []",
        "h3_execution_route:",
        '  model: ""',
        "  durations: [3, 5, 10]",
        '  qualities: ["768p", "1440p"]',
        '  aspects: ["16:9", "9:16"]',
        "  max_images: 9",
        "  max_videos: 3",
        "  max_audios: 3",
        "  audio_requires_image_or_video: true",
        "  forbid_first_last_reference_mix: true",
        ""
      ].join("\n")
    );
    await expect(loadH3ExecutionRouteProfile(emptyModelRoot)).rejects.toThrow();
  });

  it("requires multiplicity for duplicate locked dialogue lines", async () => {
    const ir = await loadFixture("t2v.json");
    const lockedText = "同じ台詞を二回言う。";
    const duplicate = parseH3CreativeIr({
      ...ir,
      shots: [
        {
          ...ir.shots[0],
          dialogue: {
            speaker: "hero",
            language: "Japanese",
            text: lockedText,
            lock_text: true
          }
        },
        {
          ...ir.shots[1],
          dialogue: {
            speaker: "hero",
            language: "Japanese",
            text: lockedText,
            lock_text: true
          }
        }
      ]
    });
    const rendered = renderH3Prompt(duplicate);
    expect(validateH3Format(duplicate, rendered.text).errors.filter((item) => item.code === "H3-E007")).toHaveLength(0);

    // Remove only one of the two identical tags — multiplicity must still fail once.
    const oneRemoved = rendered.text.replace(
      `<d>[Japanese]${lockedText}</d>`,
      "<d>[Japanese]書き換え</d>"
    );
    const missing = validateH3Format(duplicate, oneRemoved);
    expect(missing.errors.filter((item) => item.code === "H3-E007")).toHaveLength(1);
  });

  it("detects unstable speakers across shots", async () => {
    const ir = await loadFixture("t2v.json");
    const unstable = parseH3CreativeIr({
      ...ir,
      shots: [
        ir.shots[0],
        {
          ...ir.shots[1],
          dialogue: {
            ...ir.shots[1]!.dialogue!,
            speaker_id: "S2"
          }
        }
      ]
    });
    const result = validateH3Format(unstable);
    expect(result.errors.some((item) => item.code === "H3-E006")).toBe(true);
  });
});

describe("project.yaml h3 backward compatibility", () => {
  it("allows empty prompt when h3 is present and keeps prompt-only requests working", async () => {
    const ir = await loadFixture("t2v.json");
    const withH3 = projectSchema.safeParse({
      slug: "h3-demo",
      name: "H3 demo",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          {
            id: "shot-h3",
            prompt: "",
            model: "minimax-h3",
            duration: 10,
            aspect: "16:9",
            h3: ir,
            params: {}
          }
        ]
      }
    });
    expect(withH3.success).toBe(true);

    const promptOnly = projectSchema.safeParse({
      slug: "prompt-only",
      name: "prompt only",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          {
            id: "shot-prompt",
            prompt: "A quiet trail at dawn",
            model: "v6",
            duration: 5,
            aspect: "16:9",
            params: {}
          }
        ]
      }
    });
    expect(promptOnly.success).toBe(true);

    const emptyWithoutH3 = projectSchema.safeParse({
      slug: "empty-fail",
      name: "empty fail",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          {
            id: "shot-empty",
            prompt: "",
            model: "v6",
            duration: 5,
            aspect: "16:9",
            params: {}
          }
        ]
      }
    });
    expect(emptyWithoutH3.success).toBe(false);
  });

  it("rejects h3 combined with non-video generation operations", async () => {
    const ir = await loadFixture("t2v.json");
    const incompatible = [
      "image",
      "voice",
      "music",
      "extend",
      "modify",
      "upscale",
      "motion-control",
      "template"
    ] as const;

    for (const operation of incompatible) {
      const result = projectSchema.safeParse({
        slug: `h3-${operation}`,
        name: `h3 ${operation}`,
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "pixverse",
          requests: [
            {
              id: `shot-${operation}`,
              operation,
              prompt: operation === "voice" || operation === "music" ? "spoken" : "",
              model: "minimax-h3",
              duration: 5,
              aspect: "16:9",
              h3: ir,
              input_video: ["extend", "modify", "upscale", "motion-control"].includes(operation)
                ? "media/in.mp4"
                : undefined,
              first_frame: operation === "motion-control" ? "media/a.png" : undefined,
              params: operation === "template" ? { template_id: "t1" } : {}
            }
          ]
        }
      });
      expect(result.success, `expected reject for operation=${operation}`).toBe(false);
    }

    for (const operation of [undefined, "video", "transition", "reference"] as const) {
      const result = projectSchema.safeParse({
        slug: `h3-ok-${operation ?? "default"}`,
        name: "h3 ok",
        manifest: "manifest.json",
        edit: { backend: "fixture" },
        generation: {
          adapter: "pixverse",
          requests: [
            {
              id: `shot-ok-${operation ?? "default"}`,
              ...(operation ? { operation } : {}),
              prompt: "",
              model: "minimax-h3",
              duration: 5,
              aspect: "16:9",
              h3: ir,
              input_images: operation === "transition" ? ["a.png", "b.png"] : undefined,
              input_videos: operation === "reference" ? ["motion.mp4"] : undefined,
              params: {}
            }
          ]
        }
      });
      expect(result.success, `expected accept for operation=${operation}`).toBe(true);
    }
  });
});

describe("H3 request compiler (phase 2A)", () => {
  it("maps all four modes to execution fields", async () => {
    const t2v = compileH3Request(h3Request("t2v", await loadFixture("t2v.json")));
    expect(t2v.ok).toBe(true);
    expect(t2v.compilation!.execution_request).toMatchObject({
      id: "t2v",
      operation: "video",
      input_mode: "text-to-video",
      model: "minimax-h3",
      duration: 10,
      aspect: "16:9",
      params: expect.objectContaining({ quality: "1440p", audio: true })
    });
    expect(t2v.compilation!.execution_request).not.toHaveProperty("first_frame");
    expect(t2v.compilation!.execution_request).not.toHaveProperty("input_images");
    expect(t2v.compilation!.execution_request).not.toHaveProperty("h3");
    expect(t2v.compilation!.execution_request.prompt.length).toBeGreaterThan(20);

    const firstFrame = compileH3Request(h3Request("ff", await loadFixture("first-frame.json")));
    expect(firstFrame.ok).toBe(true);
    expect(firstFrame.compilation!.execution_request).toMatchObject({
      operation: "video",
      input_mode: "image-to-video",
      first_frame: "assets/start.png",
      params: expect.objectContaining({ quality: "768p", audio: true })
    });
    expect(firstFrame.compilation!.execution_request).not.toHaveProperty("input_images");

    const firstLast = compileH3Request(h3Request("fl", await loadFixture("first-last.json")));
    expect(firstLast.ok).toBe(true);
    expect(firstLast.compilation!.execution_request).toMatchObject({
      operation: "transition",
      input_mode: "transition",
      input_images: ["assets/start.png", "assets/end.png"]
    });
    expect(firstLast.compilation!.execution_request).not.toHaveProperty("first_frame");

    const reference = compileH3Request(h3Request("ref", await loadFixture("reference.json")));
    expect(reference.ok).toBe(true);
    expect(reference.compilation!.execution_request).toMatchObject({
      operation: "reference",
      input_mode: "reference",
      input_images: ["assets/hero.png"],
      input_videos: ["assets/lakeside-motion.mp4"],
      input_audios: ["assets/voice.wav"]
    });
  });

  it("is deterministic and records separate prompt hashes", async () => {
    const ir = await loadFixture("t2v.json");
    const a = compileH3Request(h3Request("shot", ir));
    const b = compileH3Request(h3Request("shot", ir));
    expect(a.ok && b.ok).toBe(true);
    expect(a.compilation).toEqual(b.compilation);
    expect(a.compilation!.lineage.creative_ir_hash).toBe(sha256Canonical(ir));
    expect(a.compilation!.lineage.canonical_prompt_hash).toBe(sha256Text(a.compilation!.canonical_prompt));
    expect(a.compilation!.lineage.adapter_prompt_hash).toBe(sha256Text(a.compilation!.adapter_prompt));
    expect(a.compilation!.canonical_prompt).toBe(a.compilation!.adapter_prompt);
    expect(a.compilation!.lineage.workflow_id).toBe(H3_WORKFLOW_ID);
    expect(a.compilation!.lineage.workflow_version).toBe(H3_WORKFLOW_VERSION);
    expect(a.compilation!.lineage).not.toHaveProperty("prompt_guide_hash");
  });

  it("writes adapter-named prompt artifacts from a safe adapter id (PixVerse keeps prompt.pixverse.txt)", async () => {
    // Adapter id is a runtime value; core never hardcodes provider filename segments.
    const adapterId = ["pix", "verse"].join("");
    expect(h3AdapterPromptFileName(adapterId)).toBe("prompt.pixverse.txt");
    expect(() => h3AdapterPromptFileName("../escape")).toThrow(/safe path segment/);

    const ir = await loadFixture("t2v.json");
    const compiled = compileH3Request(h3Request("shot-1", ir));
    expect(compiled.ok).toBe(true);
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-h3-artifact-"));
    const written = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled.compilation!],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.compilation!.adapter_prompt })],
      adapterId
    });
    expect(written.ok).toBe(true);
    expect(written.artifacts[0]!.adapter_id).toBe(adapterId);
    expect(written.artifacts[0]!.relative_paths.prompt_adapter).toBe("h3/shot-1/prompt.pixverse.txt");

    const promptPath = join(runDir, "h3", "shot-1", "prompt.pixverse.txt");
    const promptText = await readFile(promptPath, "utf8");
    expect(promptText).toBe(`${compiled.compilation!.adapter_prompt}\n`);

    const inspected = await inspectH3RunArtifacts({
      runDir,
      compilations: [compiled.compilation!],
      adapterId
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.artifacts[0]!.relative_paths.prompt_adapter).toBe("h3/shot-1/prompt.pixverse.txt");
  });

  it("fails closed on conflicting duplicated author fields", async () => {
    const ir = await loadFixture("t2v.json");
    const result = compileH3Request(h3Request("shot", ir, {
      model: "v5",
      duration: 5,
      aspect: "9:16",
      operation: "reference",
      input_mode: "reference",
      params: { quality: "720p", audio: false }
    }));
    expect(result.ok).toBe(false);
    const codes = result.issues.map((item) => item.code);
    expect(codes.every((code) => code === "H3-C001")).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("model"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("duration"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("aspect"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("operation"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("input_mode"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("quality"))).toBe(true);
    expect(result.issues.some((item) => item.path?.includes("audio"))).toBe(true);
  });

  it("allows matching duplicated author fields", async () => {
    const ir = await loadFixture("first-frame.json");
    const result = compileH3Request(h3Request("shot", ir, {
      model: "minimax-h3",
      duration: 5,
      aspect: "16:9",
      operation: "video",
      input_mode: "image-to-video",
      first_frame: "assets/start.png",
      params: { quality: "768p", audio: true }
    }));
    expect(result.ok).toBe(true);
  });

  it("rejects non-empty manual prompts on h3 requests", async () => {
    const result = compileH3Request(h3Request("shot", await loadFixture("t2v.json"), {
      prompt: "handwritten override"
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "H3-C002")).toBe(true);
  });

  it("recompiling a compiled project is idempotent (no H3-C002)", async () => {
    const ir = await loadFixture("t2v.json");
    const project = projectSchema.parse({
      slug: "idempotent",
      name: "idempotent",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          h3Request("t2v", ir),
          h3Request("ff", await loadFixture("first-frame.json")),
          h3Request("fl", await loadFixture("first-last.json")),
          h3Request("ref", await loadFixture("reference.json"))
        ]
      }
    });

    const first = compileProjectH3(project);
    expect(first.ok).toBe(true);
    expect(first.compilations).toHaveLength(4);
    expect(first.project.generation!.requests.every((request) => request.prompt.length > 0)).toBe(true);

    const second = compileProjectH3(first.project);
    expect(second.ok).toBe(true);
    expect(second.issues).toEqual([]);
    expect(second.project).toEqual(first.project);
    expect(second.compilations).toEqual(first.compilations);
  });

  it("passes PixVerse adapter input-mode constraints after H3 compile for all four modes", async () => {
    const project = projectSchema.parse({
      slug: "h3-adapter-constraints",
      name: "h3-adapter-constraints",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          h3Request("t2v", await loadFixture("t2v.json")),
          h3Request("ff", await loadFixture("first-frame.json")),
          h3Request("fl", await loadFixture("first-last.json")),
          h3Request("ref", await loadFixture("reference.json"))
        ]
      }
    });

    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.project.generation!.requests.map((request) => request.input_mode)).toEqual([
      "text-to-video",
      "image-to-video",
      "transition",
      "reference"
    ]);
    expect(compiled.project.generation!.requests[1]).toMatchObject({
      first_frame: "assets/start.png"
    });
    expect(compiled.project.generation!.requests[1]?.params).not.toHaveProperty("image");
    expect(compiled.project.generation!.requests[2]).toMatchObject({
      input_images: ["assets/start.png", "assets/end.png"]
    });
    expect(compiled.project.generation!.requests[3]).toMatchObject({
      input_images: ["assets/hero.png"],
      input_videos: ["assets/lakeside-motion.mp4"],
      input_audios: ["assets/voice.wav"]
    });

    const constraints = await validateGenerationConstraints(compiled.project, ["adapters"]);
    expect(constraints.ok).toBe(true);
    expect(constraints.issues).toEqual([]);
  });

  it("still rejects prompt-only image-to-video without first_frame or params.image on PixVerse", async () => {
    const project = projectSchema.parse({
      slug: "prompt-only-i2v-missing",
      name: "prompt-only-i2v-missing",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          {
            id: "missing-i2v",
            prompt: "prompt only without image input",
            model: "pixverse-v6",
            duration: 5,
            aspect: "16:9",
            input_mode: "image-to-video",
            params: {}
          }
        ]
      }
    });

    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.compilations).toEqual([]);

    const constraints = await validateGenerationConstraints(compiled.project, ["adapters"]);
    expect(constraints.ok).toBe(false);
    expect(constraints.issues.some((issue) => issue.code === "adapter.input_mode.required_any")).toBe(true);
    expect(constraints.issues[0]?.message).toMatch(/first_frame|params\.image/);
  });

  it("rejects params.image and params.video as asset-field backdoors", async () => {
    const ir = await loadFixture("t2v.json");

    const withImage = compileH3Request(h3Request("shot", ir, {
      params: { image: "assets/hidden.png" }
    }));
    expect(withImage.ok).toBe(false);
    expect(withImage.issues.some((item) =>
      item.code === "H3-C001" && item.path?.includes("image")
    )).toBe(true);
    // Must not leave a smuggled image on an otherwise successful-looking payload.
    expect(withImage.compilation?.execution_request.params?.image).toBeUndefined();

    const withVideo = compileH3Request(h3Request("shot", ir, {
      params: { video: "assets/hidden.mp4" }
    }));
    expect(withVideo.ok).toBe(false);
    expect(withVideo.issues.some((item) =>
      item.code === "H3-C001" && item.path?.includes("video")
    )).toBe(true);
    expect(withVideo.compilation?.execution_request.params?.video).toBeUndefined();

    // Prompt-only (no h3) is out of scope for this gate.
    const promptOnly = projectSchema.parse({
      slug: "prompt-only-media-param",
      name: "prompt-only-media-param",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [{
          id: "prompt-only",
          prompt: "A quiet trail at dawn",
          model: "v6",
          duration: 5,
          aspect: "16:9",
          params: { image: "assets/ok-for-prompt-only.png" }
        }]
      }
    });
    const compiled = compileProjectH3(promptOnly);
    expect(compiled.ok).toBe(true);
    expect(compiled.project.generation!.requests[0]!.params).toEqual({
      image: "assets/ok-for-prompt-only.png"
    });
  });

  it("rejects invalid PixVerse route values with stable codes when profile is injected", async () => {
    const route = await loadPixverseRouteProfile();
    const base = await loadFixture("t2v.json");
    // Keep timeline within duration so only route codes fire (not H3-E005).
    const ir = parseH3CreativeIr({
      ...base,
      target: {
        model: "minimax-h3",
        mode: "text-to-video",
        duration: 7,
        quality: "1080p",
        aspect: "4:3",
        audio: true
      },
      shots: [
        { ...base.shots[0], start_ms: 0, end_ms: 3500 },
        { ...base.shots[1], start_ms: 3500, end_ms: 7000 }
      ]
    });
    // Pure format compile stays ok; route failures only appear with the profile.
    const formatOnly = compileH3Request(h3Request("shot", ir));
    expect(formatOnly.ok).toBe(true);
    expect(formatOnly.issues.some((item) => item.code.startsWith("PV-E"))).toBe(false);

    const result = compileH3Request(h3Request("shot", ir), { routeProfile: route });
    expect(result.ok).toBe(false);
    const codes = new Set(result.issues.map((item) => item.code));
    expect(codes.has("PV-E001")).toBe(true);
    expect(codes.has("PV-E002")).toBe(true);
    expect(codes.has("PV-E008")).toBe(true);
  });

  it("enforces mode asset cardinality and types", async () => {
    // Bypass schema superRefine so the compiler itself reports H3-C003/C004.
    const baseFirst = await loadFixture("first-frame.json");
    const noFirst = {
      ...baseFirst,
      subjects: baseFirst.subjects.map((subject) => {
        const { source_asset: _source, ...rest } = subject;
        return rest;
      }),
      assets: [
        {
          id: "end_image",
          type: "image" as const,
          path: "assets/end.png",
          role: "last_frame" as const
        }
      ]
    } as H3CreativeIr;
    const compiledMissing = compileH3Request({
      id: "missing-first",
      prompt: "",
      params: {},
      h3: noFirst
    });
    expect(compiledMissing.ok).toBe(false);
    expect(compiledMissing.issues.some((item) => item.code === "H3-C003")).toBe(true);

    const t2vWithAsset = {
      ...(await loadFixture("t2v.json")),
      assets: [
        {
          id: "extra",
          type: "image" as const,
          path: "assets/extra.png",
          role: "other" as const
        }
      ]
    } as H3CreativeIr;
    const t2vResult = compileH3Request({
      id: "t2v-asset",
      prompt: "",
      params: {},
      h3: t2vWithAsset
    });
    expect(t2vResult.ok).toBe(false);
    expect(t2vResult.issues.some((item) => item.code === "H3-C003")).toBe(true);

    const badType = {
      ...baseFirst,
      assets: [
        {
          id: "start_image",
          type: "video" as const,
          path: "assets/start.mp4",
          role: "first_frame" as const
        }
      ]
    } as H3CreativeIr;
    const typeResult = compileH3Request({
      id: "bad-type",
      prompt: "",
      params: {},
      h3: badType
    });
    expect(typeResult.ok).toBe(false);
    expect(typeResult.issues.some((item) =>
      item.code === "H3-C004" || item.code === "H3-C003" || item.code === "PV-E007"
    )).toBe(true);
  });

  it("leaves prompt-only requests unchanged when compiling a project", async () => {
    const ir = await loadFixture("t2v.json");
    const project = projectSchema.parse({
      slug: "mixed",
      name: "mixed",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [
          h3Request("with-h3", ir),
          {
            id: "prompt-only",
            prompt: "A quiet trail at dawn",
            model: "v6",
            duration: 5,
            aspect: "16:9",
            params: { seed: 1 }
          }
        ]
      }
    });

    const promptOnlyBefore = structuredClone(project.generation!.requests[1]);
    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.compilations).toHaveLength(1);
    expect(compiled.compilations[0]!.request_id).toBe("with-h3");
    expect(compiled.project.generation!.requests[1]).toEqual(promptOnlyBefore);
    expect(compiled.project.generation!.requests[0]!.prompt.length).toBeGreaterThan(0);
    expect(compiled.project.generation!.requests[0]!.h3).toEqual(ir);
  });

  it("strips raw h3 from adapter payload while keeping it for execution digests", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = compileH3Request(h3Request("shot", ir));
    expect(compiled.ok).toBe(true);
    const projectRequest = {
      ...compiled.compilation!.execution_request,
      h3: ir,
      prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
    } as GenerationRequest;

    const execution = toExecutionGenerationRequest(projectRequest);
    expect(execution).toHaveProperty("h3");
    expect(execution).not.toHaveProperty("prompt_guide");

    const adapter = toAdapterGenerationRequest(projectRequest);
    expect(adapter).not.toHaveProperty("h3");
    expect(adapter).not.toHaveProperty("prompt_guide");
    expect(adapter.prompt).toBe(compiled.compilation!.adapter_prompt);
    expect(adapter.input_mode).toBe("text-to-video");
  });
});

describe("validateProject / plan H3 compile integration", () => {
  async function writeH3Project(options: {
    ir: H3CreativeIr;
    assets?: Array<{ relative: string; contents: string }>;
    requestOverrides?: Record<string, unknown>;
  }): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-"));
    await mkdir(join(root, "projects/assets"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    for (const asset of options.assets ?? []) {
      const path = join(root, "projects", asset.relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, asset.contents);
    }
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: {
          aspect: "16:9",
          fps: 30,
          target_duration_seconds: 5,
          slug: "h3-compile"
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

    const request = {
      id: "h3-shot",
      prompt: "",
      h3: options.ir,
      params: {},
      ...options.requestOverrides
    };
    const project = {
      slug: "h3-compile",
      name: "H3 compile",
      run_id: "h3-compile-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [request]
      }
    };
    const configPath = join(root, "projects/project.yaml");
    const YAML = await import("yaml");
    await writeFile(configPath, YAML.stringify(project));
    return configPath;
  }

  it("surfaces H3 asset paths through existing generation asset validation", async () => {
    const ir = await loadFixture("first-frame.json");
    const configPath = await writeH3Project({
      ir,
      assets: [{ relative: "assets/start.png", contents: "image-bytes" }]
    });
    const result = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(result.ok).toBe(true);
    expect(result.h3_compilations).toHaveLength(1);
    expect(result.project?.generation?.requests[0]?.first_frame).toBe("assets/start.png");
    expect(result.project?.generation?.requests[0]?.prompt.length).toBeGreaterThan(0);
    expect(result.h3_compilations![0]!.validation.ok).toBe(true);
    expect(result.h3_compilations![0]!.lineage.creative_ir_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed with H3-C005 when the selected generation adapter omits h3_execution_route", async () => {
    const ir = await loadFixture("t2v.json");
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-no-route-"));
    await mkdir(join(root, "projects"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: {
          aspect: "16:9",
          fps: 30,
          target_duration_seconds: 5,
          slug: "h3-no-route"
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
    const project = {
      slug: "h3-no-route",
      name: "H3 no route",
      run_id: "h3-no-route-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli-no-h3-route",
        requests: [{
          id: "h3-shot",
          prompt: "",
          h3: ir,
          params: {}
        }]
      }
    };
    const YAML = await import("yaml");
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify(project));

    const result = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === H3_ROUTE_PROFILE_REQUIRED_CODE)).toBe(true);
    expect(result.issues.some((item) => item.code === "H3-C005")).toBe(true);
    expect(result.issues.some((item) => item.path === "generation.adapter")).toBe(true);

    // Stage-1 compile still produced compilations; route stage rejected execution.
    expect(result.h3_compilations).toHaveLength(1);
    const pure = compileProjectH3(projectSchema.parse({
      slug: "h3-no-route",
      name: "H3 no route",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "mock-cli-no-h3-route",
        requests: [h3Request("h3-shot", ir)]
      }
    }));
    expect(pure.ok).toBe(true);
    const missing = applyH3ExecutionRouteProfile(pure.compilations, undefined, {
      project: pure.project,
      adapterName: "mock-cli-no-h3-route"
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]?.code).toBe(H3_ROUTE_PROFILE_REQUIRED_CODE);
  });

  it("stops validate with stable H3 issue paths before treating missing assets as success", async () => {
    const ir = await loadFixture("t2v.json");
    const configPath = await writeH3Project({
      ir,
      requestOverrides: { prompt: "manual prompt conflict" }
    });
    const result = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.code === "H3-C002")).toBe(true);
    expect(result.issues.some((item) => item.path?.startsWith("generation.requests.0.h3"))).toBe(true);
  });

  it("exposes compiled prompt/validation/lineage on plan and dry-run", async () => {
    const ir = await loadFixture("t2v.json");
    const configPath = await writeH3Project({ ir });
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);

    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      undefined,
      validation.promptGuides,
      undefined,
      undefined,
      undefined,
      undefined,
      validation.h3_compilations
    );
    expect(plan.h3_compilations).toHaveLength(1);
    expect(plan.h3_compilations![0]!.canonical_prompt).toBe(
      validation.h3_compilations![0]!.canonical_prompt
    );
    expect(plan.h3_compilations![0]!.lineage.workflow_id).toBe(H3_WORKFLOW_ID);

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
    expect(dryRun.executed).toBe(false);
    expect(dryRun.plan.h3_compilations).toHaveLength(1);
  });

  it("keeps validate prompt_guide_hash when review/review-preview createPlan receives h3_compilations", async () => {
    const ir = await loadFixture("t2v.json");
    const configPath = await writeH3Project({
      ir,
      requestOverrides: {
        prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
      }
    });
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: ["knowledge/video-models"]
    });
    expect(validation.ok).toBe(true);
    const expectedHash = validation.h3_compilations![0]!.lineage.prompt_guide_hash;
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

    // Mirrors cli.ts plan / review / review-preview createPlan argument lists.
    const reviewPlanArgs = [
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters ?? validation.analysisAdapter,
      validation.promptGuides,
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection,
      validation.backend
    ] as const;

    const recompiled = createPlan(...reviewPlanArgs);
    expect(recompiled.h3_compilations![0]!.lineage.prompt_guide_hash).toBeUndefined();

    const reviewPlan = createPlan(...reviewPlanArgs, validation.h3_compilations);
    expect(reviewPlan.h3_compilations![0]!.lineage.prompt_guide_hash).toBe(expectedHash);

    // review-preview rewrites review-data with the same createPlan contract.
    const previewPlan = createPlan(...reviewPlanArgs, validation.h3_compilations);
    expect(previewPlan.h3_compilations![0]!.lineage.prompt_guide_hash).toBe(expectedHash);
    expect(previewPlan.h3_compilations![0]!.lineage.prompt_guide_hash)
      .toBe(reviewPlan.h3_compilations![0]!.lineage.prompt_guide_hash);
  });

  it("keeps prompt-only projects backward compatible in plan", async () => {
    const validation = await validateProject("fixtures/projects/local-valid.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.h3_compilations ?? []).toEqual([]);
    const plan = createPlan(validation.project!, validation.manifest!);
    expect(plan).not.toHaveProperty("h3_compilations");
  });

  it("hashes prompt-guide content without local root/path and reacts to content changes", async () => {
    const {
      hashPromptGuideContent,
      enrichH3CompilationsForProject,
      compileProjectH3
    } = await import("../src/h3/index.js");
    const guideA = await loadPromptGuide("knowledge/video-models/pixverse");
    expect(guideA).toBeDefined();
    const hashA = hashPromptGuideContent(guideA!);
    const hashB = hashPromptGuideContent({
      ...guideA!,
      root: "/tmp/other-root",
      path: "/tmp/other-root/prompt-guide.yaml"
    });
    expect(hashA).toBe(hashB);

    const mutated = {
      ...guideA!,
      revision: `${guideA!.revision}-mutated`
    };
    expect(hashPromptGuideContent(mutated)).not.toBe(hashA);

    const ir = await loadFixture("t2v.json");
    const project = projectSchema.parse({
      slug: "h3-guide-hash",
      name: "H3 guide hash",
      run_id: "h3-guide-hash-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [
          h3Request("shot", ir, {
            prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
          })
        ]
      }
    });
    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.compilations[0]!.lineage.prompt_guide_identity).toBe("pixverse/minimax-h3");
    expect(compiled.compilations[0]!.lineage.prompt_guide_hash).toBeUndefined();

    const enriched = enrichH3CompilationsForProject(compiled.compilations, compiled.project, [guideA!]);
    expect(enriched[0]!.lineage.prompt_guide_hash).toBe(hashA);

    // validateProject enriches after loading guides when prompt_guide is present.
    const configPath = await writeH3Project({
      ir,
      requestOverrides: {
        prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
      }
    });
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: ["knowledge/video-models"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.h3_compilations![0]!.lineage.prompt_guide_identity).toBe("pixverse/minimax-h3");
    expect(validation.h3_compilations![0]!.lineage.prompt_guide_hash).toBe(hashA);
  });

  it("uses stablePrettyJson with sorted keys, preserved arrays, omitted undefined, and trailing newline", () => {
    const text = stablePrettyJson({
      zebra: 1,
      alpha: [{ b: 2, a: 1 }, { c: undefined, d: 3 }],
      nested: { y: true, x: false },
      skip: undefined
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify({
      alpha: [{ a: 1, b: 2 }, { d: 3 }],
      nested: { x: false, y: true },
      zebra: 1
    }, null, 2)}\n`);
    // Array order is preserved even when object keys are sorted.
    expect(JSON.parse(text).alpha[0]).toEqual({ a: 1, b: 2 });
  });
});

describe("prompt guidance modes for H3", () => {
  it("matches minimax-h3 for transition and reference without unknown-model fallback", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/pixverse");
    expect(guide?.models.map((model) => model.id)).toContain("minimax-h3");
    expect(guide?.modes).toHaveProperty("transition");
    expect(guide?.modes).toHaveProperty("reference");

    const h3 = guide!.models.find((model) => model.id === "minimax-h3");
    expect(h3?.limits.duration_seconds).toEqual({ min: 5, max: 15 });
    expect(h3?.limits.resolutions).toEqual(["768p", "1440p"]);
    expect(h3?.limits.text_to_video_aspect_ratios).toEqual([
      "auto",
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16"
    ]);
    expect(h3?.limits.prompt_max_characters).toBeUndefined();
    expect(h3?.limits.notes.some((note) => note.includes("narrower"))).toBe(true);

    const transition = resolvePromptGuidance(
      {
        id: "g1",
        prompt: "bridge",
        model: "minimax-h3",
        input_mode: "transition",
        duration: 5,
        aspect: "16:9",
        params: {}
      } satisfies GenerationRequest,
      guide!
    );
    expect(transition.status).toBe("matched");
    expect(transition.model_profile).toBe("minimax-h3");
    expect(transition.recipe?.prompt_order.length).toBeGreaterThan(0);

    const reference = resolvePromptGuidance(
      {
        id: "g2",
        prompt: "ref",
        model: "minimax-h3",
        input_mode: "reference",
        duration: 10,
        aspect: "16:9",
        params: {}
      } satisfies GenerationRequest,
      guide!
    );
    expect(reference.status).toBe("matched");

    const unknown = resolvePromptGuidance(
      {
        id: "g3",
        prompt: "nope",
        model: "totally-unknown-model",
        input_mode: "text-to-video",
        duration: 5,
        aspect: "16:9",
        params: {}
      } satisfies GenerationRequest,
      guide!
    );
    expect(unknown.status).toBe("model-unmatched");
    expect(unknown.recipe).toBeUndefined();

    // Existing models remain matched on classic modes.
    const v6 = resolvePromptGuidance(
      {
        id: "g4",
        prompt: "classic",
        model: "v6",
        input_mode: "text-to-video",
        duration: 5,
        aspect: "16:9",
        params: {}
      } satisfies GenerationRequest,
      guide!
    );
    expect(v6.status).toBe("matched");
    expect(v6.model_profile).toBe("v6");
  });
});

describe("examples/h3-prompt-director contract", () => {
  it("loads the example project under the current schema and compiles H3 successfully", async () => {
    const project = await loadProject("examples/h3-prompt-director/project.yaml");
    expect(project.slug).toBe("h3-prompt-director");
    expect(project.generation?.adapter).toBe("pixverse");
    expect(project.generation?.connection).toBe("pixverse");

    const request = project.generation?.requests[0];
    expect(request).toBeDefined();
    expect(request!.prompt).toBe("");
    expect(request!.model).toBe("minimax-h3");
    expect(request!.prompt_guide).toEqual({ catalog: "pixverse", model: "minimax-h3" });
    expect(request!.h3?.version).toBe(1);
    expect(request!.h3?.target.mode).toBe("text-to-video");
    expect(request!.h3?.assets).toEqual([]);
    expect(request!.h3?.shots).toHaveLength(2);
    expect(request!.h3?.shots[1]?.dialogue?.lock_text).toBe(true);
    expect(request!.h3?.shots[1]?.dialogue?.voiceover).toBe(true);
    expect(request!.h3?.sound.music.enabled).toBe(false);

    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.issues).toEqual([]);
    expect(compiled.compilations).toHaveLength(1);

    const compilation = compiled.compilations[0]!;
    expect(compilation.validation.ok).toBe(true);
    expect(compilation.validation.errors).toEqual([]);
    expect(compilation.lineage.workflow_id).toBe(H3_WORKFLOW_ID);
    expect(compilation.lineage.workflow_version).toBe(H3_WORKFLOW_VERSION);
    expect(compilation.canonical_prompt).toContain("[Shot 1]");
    expect(compilation.canonical_prompt).toContain("[Shot 2] At 00:05.000");
    expect(compilation.canonical_prompt).toContain(
      "<d>[Japanese]AIと自然が、やっと同じ場所で動き始めた。</d>"
    );
    expect(compilation.canonical_prompt).toContain("says in an off-screen voiceover:");
    expect(compilation.canonical_prompt).toContain("while his lips remain completely closed.");
    expect(compilation.canonical_prompt).toContain("non_diegetic_music:\nN/A");
    expect(compilation.execution_request).toMatchObject({
      operation: "video",
      input_mode: "text-to-video",
      model: "minimax-h3",
      duration: 10,
      aspect: "16:9",
      params: expect.objectContaining({ quality: "768p", audio: true })
    });
    expect(compilation.execution_request).not.toHaveProperty("h3");
    expect(compilation.execution_request).not.toHaveProperty("first_frame");
  });

  it("keeps handwritten prompt-only generation requests loadable without H3", async () => {
    const project = await loadProject("fixtures/projects/cli-generation.yaml");
    expect(project.generation?.requests[0]?.h3).toBeUndefined();
    expect(project.generation?.requests[0]?.prompt).toBe("fixture prompt");

    const parsed = projectSchema.safeParse(project);
    expect(parsed.success).toBe(true);

    const compiled = compileProjectH3(project);
    expect(compiled.ok).toBe(true);
    expect(compiled.compilations).toEqual([]);
    expect(compiled.project.generation?.requests[0]?.prompt).toBe("fixture prompt");
  });
});

describe("H3 feasible warnings (H3-W001..W007)", () => {
  it("emits W001 for 3+ shots in 5 seconds or less", () => {
    const ir = parseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "text-to-video",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [],
      shots: [
        { id: "shot_1", start_ms: 0, end_ms: 1600, visual: "Wide open field." },
        { id: "shot_2", start_ms: 1600, end_ms: 3200, visual: "Medium approach." },
        { id: "shot_3", start_ms: 3200, end_ms: 5000, visual: "Close face." }
      ],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    const result = validateH3Warnings(ir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((item) => item.code === "H3-W001")).toBe(true);
  });

  it("emits W002 when a shot packs four or more primary action clauses", async () => {
    const base = await loadFixture("t2v.json");
    const ir = parseH3CreativeIr({
      ...base,
      shots: [
        {
          ...base.shots[0],
          visual: "A man walks in. He turns. He lifts a cup. He smiles at camera."
        },
        base.shots[1]
      ]
    });
    expect(validateH3Warnings(ir).warnings.some((item) => item.code === "H3-W002")).toBe(true);
  });

  it("emits W003 for static/push language conflicts in either direction", async () => {
    const base = await loadFixture("t2v.json");
    const staticPush = parseH3CreativeIr({
      ...base,
      shots: [
        {
          ...base.shots[0],
          camera: { type: "static", sentence: "The camera holds while the subject pushes in." },
          visual: "A static hold that still pushes in toward the face."
        },
        base.shots[1]
      ]
    });
    expect(validateH3Warnings(staticPush).warnings.some((item) => item.code === "H3-W003")).toBe(true);

    const pushStatic = parseH3CreativeIr({
      ...base,
      shots: [
        {
          ...base.shots[0],
          camera: { type: "push_in", sentence: "A static hold frames the lake." },
          visual: "The camera holds a static frame of the lake."
        },
        base.shots[1]
      ]
    });
    expect(validateH3Warnings(pushStatic).warnings.some((item) => item.code === "H3-W003")).toBe(true);
  });

  it("emits W004 when dialogue exceeds the rough spoken-char budget", async () => {
    const base = await loadFixture("t2v.json");
    const longLine = "あ".repeat(base.target.duration * 12 + 1);
    const ir = parseH3CreativeIr({
      ...base,
      shots: [
        base.shots[0],
        {
          ...base.shots[1],
          dialogue: {
            speaker: "hero",
            language: "Japanese",
            text: longLine,
            lock_text: true
          }
        }
      ]
    });
    expect(validateH3Warnings(ir).warnings.some((item) => item.code === "H3-W004")).toBe(true);
  });

  it("emits W005 when subject clothing color cues flip across shots", () => {
    const ir = parseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "text-to-video",
        duration: 10,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [{ id: "hero", description: "traveler in coat" }],
      assets: [],
      shots: [
        {
          id: "shot_1",
          start_ms: 0,
          end_ms: 5000,
          visual: "A traveler in a black coat stands by the lake."
        },
        {
          id: "shot_2",
          start_ms: 5000,
          end_ms: 10000,
          visual: "The same traveler now wears a white coat near the shore."
        }
      ],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    expect(validateH3Warnings(ir).warnings.some((item) => item.code === "H3-W005")).toBe(true);
  });

  it("emits W006 when music is enabled while the soundscape demands silence", async () => {
    const base = await loadFixture("t2v.json");
    const ir = parseH3CreativeIr({
      ...base,
      sound: {
        soundscape: "Complete silence under the night sky.",
        music: { enabled: true, description: "Soft piano." }
      }
    });
    expect(validateH3Warnings(ir).warnings.some((item) => item.code === "H3-W006")).toBe(true);
  });

  it("emits W007 for first-last mode with intermediate cuts", () => {
    const ir = parseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "first-last",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [],
      assets: [
        { id: "start", type: "image", path: "assets/start.png", role: "first_frame" },
        { id: "end", type: "image", path: "assets/end.png", role: "last_frame" }
      ],
      shots: [
        { id: "shot_1", start_ms: 0, end_ms: 2500, visual: "Opening stance." },
        { id: "shot_2", start_ms: 2500, end_ms: 5000, visual: "Final stance." }
      ],
      sound: { soundscape: "Wind.", music: { enabled: false } }
    });
    expect(validateH3Warnings(ir).warnings.some((item) => item.code === "H3-W007")).toBe(true);
  });

  it("keeps validation ok when only feasible warnings fire", async () => {
    const base = await loadFixture("t2v.json");
    // Format-valid IR that still trips a soft warning (music vs complete silence).
    const ir = parseH3CreativeIr({
      ...base,
      sound: {
        soundscape: "Complete silence under the night sky.",
        music: { enabled: true, description: "Sparse piano." }
      }
    });
    const rendered = renderH3Prompt(ir);
    const result = validateH3CreativeIr(ir, { renderedText: rendered.text });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((item) => item.code === "H3-W006")).toBe(true);

    // Warnings alone never flip ok=false.
    const warningsOnly = validateH3Warnings(ir);
    expect(warningsOnly.ok).toBe(true);
    expect(warningsOnly.errors).toEqual([]);
  });
});

describe("H3 renderer branch coverage for shared and reference paths", () => {
  it("renders camera sentence variants, transitions, and speaker fallbacks", async () => {
    const base = await loadFixture("t2v.json");
    const ir = parseH3CreativeIr({
      ...base,
      sound: {
        soundscape: "Wind.",
        // description present for schema validity; renderer falls back to N/A when stripped.
        music: { enabled: true, description: "placeholder" }
      },
      shots: [
        {
          id: "shot_1",
          start_ms: 0,
          end_ms: 2000,
          visual: "Live-action. A wide lake at dawn.",
          camera: { type: "push_out", amplitude: "medium", speed: "slow" }
        },
        {
          id: "shot_2",
          start_ms: 2000,
          end_ms: 4000,
          transition: "none",
          visual: "Soft ripples reach the shoreline.",
          camera: { type: "zoom_in", amplitude: "small", speed: "fast" },
          dialogue: {
            language: "Japanese",
            text: "声だけ残る。",
            lock_text: true,
            speaker_id: "S9"
          }
        },
        {
          id: "shot_3",
          start_ms: 4000,
          end_ms: 6000,
          visual: "The camera cuts across wet stones without a hard edit cue.",
          camera: { type: "pan", direction: "left", speed: "medium" }
        },
        {
          id: "shot_4",
          start_ms: 6000,
          end_ms: 8000,
          visual: "Truck past reeds.",
          camera: { type: "truck", direction: "right", amplitude: "large" }
        },
        {
          id: "shot_5",
          start_ms: 8000,
          end_ms: 10000,
          visual: "An arc around the subject.",
          camera: { type: "arc", amplitude: "small", speed: "slow" }
        },
        {
          id: "shot_6",
          start_ms: 10000,
          end_ms: 12000,
          visual: "Hold the final still frame.",
          camera: { type: "hold" }
        },
        {
          id: "shot_7",
          start_ms: 12000,
          end_ms: 14000,
          visual: "Custom framing remains authoritative.",
          camera: { type: "zoom_out", sentence: "The lens breathes out once" }
        }
      ]
    });

    // Defensive renderer path: enabled music with missing description renders N/A.
    delete (ir.sound.music as { description?: string }).description;

    const rendered = renderH3Prompt(ir);
    const body = rendered.sections.integrated_multimodal_description;
    expect(body).toContain("The camera pushes out with medium amplitude at slow speed.");
    // transition=none avoids the default "camera cuts to" prefix.
    expect(body).toContain("[Shot 2] At 00:02.000, Soft ripples reach the shoreline.");
    expect(body).toContain("The camera zooms in with small amplitude at fast speed.");
    expect(body).toContain("The speaker (S9) says:");
    // Body already starts with "the camera cuts..." so the stamp line reuses that opening.
    expect(body).toContain(
      "[Shot 3] At 00:04.000, The camera cuts across wet stones without a hard edit cue."
    );
    expect(body).toContain("The camera pans left at medium speed.");
    expect(body).toContain("The camera trucks right with large amplitude.");
    expect(body).toContain("The camera arcs around the subject with small amplitude at slow speed.");
    expect(body).toContain("The camera holds a static shot.");
    expect(body).toContain("The lens breathes out once.");
    expect(rendered.sections.non_diegetic_music).toBe("N/A");
  });

  it("omits first-frame alignment for pure text-to-video and keeps track camera direction", async () => {
    const base = await loadFixture("t2v.json");
    const ir = parseH3CreativeIr({
      ...base,
      shots: [
        {
          ...base.shots[0],
          camera: { type: "track", direction: "from the side", speed: "medium" }
        },
        base.shots[1]
      ]
    });
    const rendered = renderH3Prompt(ir);
    expect(rendered.sections.integrated_multimodal_description).not.toContain(
      "is fully referenced."
    );
    expect(rendered.sections.integrated_multimodal_description).toContain(
      "The camera tracks the subject from the side at medium speed."
    );
  });

  it("renders reference fallbacks for unbound subjects, default summary, and default retention", () => {
    const ir = parseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "reference",
        duration: 8,
        quality: "768p",
        aspect: "16:9",
        audio: true
      },
      subjects: [
        {
          id: "narrator",
          description: "unseen narrator"
        }
      ],
      assets: [
        {
          id: "style_still",
          type: "image",
          path: "assets/style.png",
          role: "style_reference"
        }
      ],
      shots: [
        {
          id: "shot_1",
          start_ms: 0,
          end_ms: 8000,
          visual: "A quiet lakeside still."
        }
      ],
      sound: { soundscape: "Soft wind.", music: { enabled: false } }
    });

    const rendered = renderH3ReferencePrompt(ir);
    expect(rendered.format).toBe("reference");
    expect(rendered.sections.subject_definitions).toContain(
      "<Subject 1> is the unseen narrator."
    );
    expect(rendered.sections.summary).toBe(
      "A 8-second reference sequence with 1 shot(s)."
    );
    expect(rendered.sections.retention_analysis).toContain(
      "identity and clothing remain consistent"
    );
  });

  it("falls back to ordered asset labels when subjects are empty and records motion references", () => {
    const orderedOnly = parseH3CreativeIr({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "reference",
        duration: 5,
        quality: "768p",
        aspect: "16:9",
        audio: false
      },
      subjects: [],
      assets: [
        {
          id: "hero_still",
          type: "image",
          path: "assets/hero.png",
          role: "subject_reference"
        },
        {
          id: "style_still",
          type: "image",
          path: "assets/style.png",
          role: "style_reference"
        }
      ],
      shots: [{ id: "shot_1", start_ms: 0, end_ms: 5000, visual: "Quiet reference hold." }],
      sound: { soundscape: "Silence.", music: { enabled: false } }
    });
    const orderedRendered = renderH3ReferencePrompt(orderedOnly);
    expect(orderedRendered.sections.subject_definitions).toContain("<Picture 1> is @image1.");
    expect(orderedRendered.sections.subject_definitions).toContain("<Picture 2> is @image2.");
    expect(orderedRendered.sections.retention_analysis).toContain(
      "Retain referenced subject appearance, clothing, and spatial relationships across the clip."
    );

    const withMotion = parseH3CreativeIr({
      ...orderedOnly,
      assets: [
        orderedOnly.assets[0],
        {
          id: "motion",
          type: "video",
          path: "assets/motion.mp4",
          role: "motion_reference"
        }
      ]
    });
    const motionRendered = renderH3ReferencePrompt(withMotion);
    expect(motionRendered.sections.subject_definitions).toContain(
      "provides the target body movement and camera rhythm"
    );
  });
});

describe("H3 run artifact path safety and persistence branches", () => {
  async function compileOk(ir: H3CreativeIr, requestId = "shot-1"): Promise<H3Compilation> {
    const compiled = compileH3Request(h3Request(requestId, ir));
    expect(compiled.ok).toBe(true);
    return compiled.compilation!;
  }

  it("returns empty artifacts for empty compilations and rejects unsafe adapter ids", async () => {
    const emptyWrite = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-empty-")),
      compilations: [],
      pinnedRequests: [],
      adapterId: "mock-cli"
    });
    expect(emptyWrite).toEqual({ ok: true, issues: [], artifacts: [] });

    const emptyInspect = await inspectH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-empty-inspect-")),
      compilations: [],
      adapterId: "mock-cli"
    });
    expect(emptyInspect).toEqual({ ok: true, issues: [], artifacts: [] });

    const missingAdapter = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-adapter-missing-")),
      compilations: [await compileOk(await loadFixture("t2v.json"))],
      pinnedRequests: [h3Request("shot-1", await loadFixture("t2v.json"))],
      adapterId: ""
    });
    expect(missingAdapter.ok).toBe(false);
    expect(missingAdapter.issues[0]?.code).toBe("H3-C000");
    expect(missingAdapter.issues[0]?.message).toMatch(/adapter id is required/);

    const unsafeAdapter = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-adapter-unsafe-")),
      compilations: [await compileOk(await loadFixture("t2v.json"))],
      pinnedRequests: [h3Request("shot-1", await loadFixture("t2v.json"))],
      adapterId: "../escape"
    });
    expect(unsafeAdapter.ok).toBe(false);
    expect(unsafeAdapter.issues[0]?.message).toMatch(/not a safe path segment/);
  });

  it("fails closed on unsafe request ids and missing pinned requests", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = await compileOk(ir, "shot-1");
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-h3-unsafe-req-"));

    const unsafeId = await writeH3RunArtifacts({
      runDir,
      compilations: [{ ...compiled, request_id: "../escape" }],
      pinnedRequests: [h3Request("shot-1", ir)],
      adapterId: "mock-cli"
    });
    expect(unsafeId.ok).toBe(false);
    expect(unsafeId.issues[0]?.code).toBe("H3-C000");
    expect(unsafeId.issues[0]?.message).toMatch(/not a safe path segment/);

    const missingPinned = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled],
      pinnedRequests: [h3Request("other-id", ir)],
      adapterId: "mock-cli"
    });
    expect(missingPinned.ok).toBe(false);
    expect(missingPinned.issues[0]?.message).toMatch(/pinned request missing/);
  });

  it("hashes first-frame assets under the run dir and refuses missing or unsafe pins", async () => {
    const ir = await loadFixture("first-frame.json");
    const compiled = await compileOk(ir, "ff-1");
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-h3-ff-hash-"));
    await mkdir(join(runDir, "assets"), { recursive: true });
    await writeFile(join(runDir, "assets/start.png"), "start-frame-bytes");

    const written = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled],
      pinnedRequests: [
        h3Request("ff-1", ir, {
          prompt: compiled.adapter_prompt,
          first_frame: "assets/start.png"
        })
      ],
      adapterId: "mock-cli"
    });
    expect(written.ok).toBe(true);
    const lineage = JSON.parse(await readFile(written.artifacts[0]!.absolute_paths.lineage, "utf8"));
    const expected = createHash("sha256").update("start-frame-bytes").digest("hex");
    expect(lineage.asset_hashes).toEqual({ start_image: expected });

    const missingPath = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-ff-missing-")),
      compilations: [compiled],
      pinnedRequests: [h3Request("ff-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(missingPath.ok).toBe(false);
    expect(missingPath.issues[0]?.message).toMatch(/no pinned path at first_frame/);

    const escapeRoot = await mkdtemp(join(tmpdir(), "tsugite-h3-ff-escape-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-h3-ff-outside-"));
    await writeFile(join(outside, "start.png"), "outside");
    const escaped = await writeH3RunArtifacts({
      runDir: escapeRoot,
      compilations: [compiled],
      pinnedRequests: [
        h3Request("ff-1", ir, {
          prompt: compiled.adapter_prompt,
          first_frame: join(outside, "start.png")
        })
      ],
      adapterId: "mock-cli"
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.issues[0]?.message).toMatch(/escapes the run directory/);
  });

  it("hashes first-last and reference pins and refuses incomplete media lists", async () => {
    const firstLast = await loadFixture("first-last.json");
    const flCompiled = await compileOk(firstLast, "fl-1");
    const flRun = await mkdtemp(join(tmpdir(), "tsugite-h3-fl-"));
    await mkdir(join(flRun, "assets"), { recursive: true });
    await writeFile(join(flRun, "assets/start.png"), "start");
    await writeFile(join(flRun, "assets/end.png"), "end");

    const flWritten = await writeH3RunArtifacts({
      runDir: flRun,
      compilations: [flCompiled],
      pinnedRequests: [
        h3Request("fl-1", firstLast, {
          prompt: flCompiled.adapter_prompt,
          input_images: ["assets/start.png", "assets/end.png"]
        })
      ],
      adapterId: "mock-cli"
    });
    expect(flWritten.ok).toBe(true);
    const flLineage = JSON.parse(
      await readFile(flWritten.artifacts[0]!.absolute_paths.lineage, "utf8")
    );
    expect(Object.keys(flLineage.asset_hashes).sort()).toEqual(["end_image", "start_image"]);

    const flMissing = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-fl-missing-")),
      compilations: [flCompiled],
      pinnedRequests: [
        h3Request("fl-1", firstLast, {
          prompt: flCompiled.adapter_prompt,
          input_images: ["assets/start.png"]
        })
      ],
      adapterId: "mock-cli"
    });
    expect(flMissing.ok).toBe(false);
    expect(flMissing.issues[0]?.message).toMatch(/input_images\[1\]/);

    const reference = await loadFixture("reference.json");
    const refCompiled = await compileOk(reference, "ref-1");
    const refRun = await mkdtemp(join(tmpdir(), "tsugite-h3-ref-"));
    await mkdir(join(refRun, "assets"), { recursive: true });
    await writeFile(join(refRun, "assets/hero.png"), "hero");
    await writeFile(join(refRun, "assets/motion.mp4"), "motion");
    await writeFile(join(refRun, "assets/voice.wav"), "voice");

    const refWritten = await writeH3RunArtifacts({
      runDir: refRun,
      compilations: [refCompiled],
      pinnedRequests: [
        h3Request("ref-1", reference, {
          prompt: refCompiled.adapter_prompt,
          input_images: ["assets/hero.png"],
          input_videos: ["assets/motion.mp4"],
          input_audios: ["assets/voice.wav"]
        })
      ],
      adapterId: "mock-cli"
    });
    expect(refWritten.ok).toBe(true);
    const refLineage = JSON.parse(
      await readFile(refWritten.artifacts[0]!.absolute_paths.lineage, "utf8")
    );
    expect(Object.keys(refLineage.asset_hashes).sort()).toEqual([
      "character_image",
      "motion_video",
      "voice_audio"
    ]);

    const refMissingAudio = await writeH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-ref-missing-")),
      compilations: [refCompiled],
      pinnedRequests: [
        h3Request("ref-1", reference, {
          prompt: refCompiled.adapter_prompt,
          input_images: ["assets/hero.png"],
          input_videos: ["assets/motion.mp4"],
          input_audios: []
        })
      ],
      adapterId: "mock-cli"
    });
    expect(refMissingAudio.ok).toBe(false);
    expect(refMissingAudio.issues[0]?.message).toMatch(/input_audios\[0\]/);
  });

  it("refuses symlinked h3 roots, request dirs, artifact leaves, and asset pins", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = await compileOk(ir, "shot-1");
    const outside = await mkdtemp(join(tmpdir(), "tsugite-h3-art-outside-"));

    const symlinkRoot = await mkdtemp(join(tmpdir(), "tsugite-h3-art-symlink-root-"));
    await symlink(outside, join(symlinkRoot, "h3"), "dir");
    const rootBlocked = await writeH3RunArtifacts({
      runDir: symlinkRoot,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(rootBlocked.ok).toBe(false);
    expect(rootBlocked.issues[0]?.message).toMatch(/symlink/);

    const leafRun = await mkdtemp(join(tmpdir(), "tsugite-h3-art-leaf-"));
    const leafWritten = await writeH3RunArtifacts({
      runDir: leafRun,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(leafWritten.ok).toBe(true);
    const promptPath = leafWritten.artifacts[0]!.absolute_paths.prompt_canonical;
    await writeFile(join(outside, "prompt.canonical.txt"), "external\n");
    // Replace the regular artifact leaf with a symlink after a successful write path exists.
    await unlink(promptPath);
    await symlink(join(outside, "prompt.canonical.txt"), promptPath);
    const leafRewrite = await writeH3RunArtifacts({
      runDir: leafRun,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(leafRewrite.ok).toBe(false);
    expect(leafRewrite.issues[0]?.message).toMatch(/symlink/);

    const assetRun = await mkdtemp(join(tmpdir(), "tsugite-h3-asset-symlink-"));
    await mkdir(join(assetRun, "assets"), { recursive: true });
    await writeFile(join(outside, "start.png"), "linked-bytes");
    await symlink(join(outside, "start.png"), join(assetRun, "assets/start.png"));
    const ff = await loadFixture("first-frame.json");
    const ffCompiled = await compileOk(ff, "ff-symlink");
    const assetBlocked = await writeH3RunArtifacts({
      runDir: assetRun,
      compilations: [ffCompiled],
      pinnedRequests: [
        h3Request("ff-symlink", ff, {
          prompt: ffCompiled.adapter_prompt,
          first_frame: "assets/start.png"
        })
      ],
      adapterId: "mock-cli"
    });
    expect(assetBlocked.ok).toBe(false);
    expect(assetBlocked.issues[0]?.message).toMatch(/symlink/);
  });

  it("inspects durable artifacts and fails closed on missing, wrong-shape, and tampered content", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = await compileOk(ir, "shot-1");
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-h3-inspect-"));
    const written = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(written.ok).toBe(true);

    const okInspect = await inspectH3RunArtifacts({
      runDir,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(okInspect.ok).toBe(true);
    expect(okInspect.artifacts[0]!.relative_dir).toBe("h3/shot-1");

    const missingRun = await inspectH3RunArtifacts({
      runDir: join(runDir, "does-not-exist"),
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(missingRun.ok).toBe(false);
    expect(missingRun.issues[0]?.message).toMatch(/existing run directory/);

    const missingArtifacts = await inspectH3RunArtifacts({
      runDir: await mkdtemp(join(tmpdir(), "tsugite-h3-inspect-empty-")),
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(missingArtifacts.ok).toBe(false);
    expect(missingArtifacts.issues[0]?.message).toMatch(/artifacts missing/);

    // Directory replaced by a regular file.
    const fileAsDirRun = await mkdtemp(join(tmpdir(), "tsugite-h3-inspect-file-dir-"));
    await mkdir(join(fileAsDirRun, "h3"), { recursive: true });
    await writeFile(join(fileAsDirRun, "h3", "shot-1"), "not-a-directory");
    const notDir = await inspectH3RunArtifacts({
      runDir: fileAsDirRun,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(notDir.ok).toBe(false);
    expect(notDir.issues[0]?.message).toMatch(/not a directory/);

    // Symlinked request directory.
    const symlinkDirRun = await mkdtemp(join(tmpdir(), "tsugite-h3-inspect-symlink-dir-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-h3-inspect-outside-"));
    await mkdir(join(symlinkDirRun, "h3"), { recursive: true });
    await symlink(outside, join(symlinkDirRun, "h3", "shot-1"), "dir");
    const symlinkDir = await inspectH3RunArtifacts({
      runDir: symlinkDirRun,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(symlinkDir.ok).toBe(false);
    expect(symlinkDir.issues[0]?.message).toMatch(/symlink/);

    // Tampered canonical prompt text.
    await writeFile(written.artifacts[0]!.absolute_paths.prompt_canonical, "tampered\n");
    const tamperedPrompt = await inspectH3RunArtifacts({
      runDir,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(tamperedPrompt.ok).toBe(false);
    expect(tamperedPrompt.issues[0]?.message).toMatch(/prompt\.canonical\.txt/);

    // Restore prompt, break trailing newline contract.
    await writeFile(
      written.artifacts[0]!.absolute_paths.prompt_canonical,
      compiled.canonical_prompt
    );
    const badNewline = await inspectH3RunArtifacts({
      runDir,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(badNewline.ok).toBe(false);
    expect(badNewline.issues[0]?.message).toMatch(/trailing newline/);

    // Restore valid prompt, break creative-ir JSON.
    await writeFile(
      written.artifacts[0]!.absolute_paths.prompt_canonical,
      `${compiled.canonical_prompt}\n`
    );
    await writeFile(written.artifacts[0]!.absolute_paths.creative_ir, "{not-json");
    const badJson = await inspectH3RunArtifacts({
      runDir,
      compilations: [compiled],
      adapterId: "mock-cli"
    });
    expect(badJson.ok).toBe(false);
    expect(badJson.issues[0]?.message).toMatch(/creative-ir\.json is not valid JSON/);

    // Restore creative IR, inject invalid asset_hashes shape into lineage.
    await writeFile(
      written.artifacts[0]!.absolute_paths.creative_ir,
      stablePrettyJson(compiled.creative_ir)
    );
    const lineage = {
      ...compiled.lineage,
      asset_hashes: { bad: "not-a-sha256" }
    };
    await writeFile(written.artifacts[0]!.absolute_paths.lineage, stablePrettyJson(lineage));
    const badAssetHash = await inspectH3RunArtifacts({
      runDir,
      compilations: [{ ...compiled, lineage }],
      adapterId: "mock-cli"
    });
    expect(badAssetHash.ok).toBe(false);
    expect(badAssetHash.issues[0]?.message).toMatch(/asset_hashes\['bad'\]/);

    // Valid 64-hex asset hashes pass shape checks without inventing file contents.
    const goodHash = "a".repeat(64);
    const goodLineage = {
      ...compiled.lineage,
      asset_hashes: { start_image: goodHash }
    };
    await writeFile(written.artifacts[0]!.absolute_paths.lineage, stablePrettyJson(goodLineage));
    await writeFile(
      written.artifacts[0]!.absolute_paths.validation,
      stablePrettyJson(compiled.validation)
    );
    const goodAssetHash = await inspectH3RunArtifacts({
      runDir,
      compilations: [{ ...compiled, lineage: goodLineage }],
      adapterId: "mock-cli"
    });
    expect(goodAssetHash.ok).toBe(true);

    // Missing adapter-named prompt file.
    await unlink(written.artifacts[0]!.absolute_paths.prompt_adapter);
    const missingAdapterPrompt = await inspectH3RunArtifacts({
      runDir,
      compilations: [{ ...compiled, lineage: goodLineage }],
      adapterId: "mock-cli"
    });
    expect(missingAdapterPrompt.ok).toBe(false);
    expect(missingAdapterPrompt.issues[0]?.message).toMatch(/prompt\.mock-cli\.txt' is missing/);
  });

  it("refuses non-file artifact targets and non-directory path components on write", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = await compileOk(ir, "shot-1");

    // h3 exists as a regular file instead of a directory.
    const fileRoot = await mkdtemp(join(tmpdir(), "tsugite-h3-write-file-root-"));
    await writeFile(join(fileRoot, "h3"), "not-dir");
    const blockedRoot = await writeH3RunArtifacts({
      runDir: fileRoot,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(blockedRoot.ok).toBe(false);
    expect(blockedRoot.issues[0]?.message).toMatch(/not a directory/);

    // Request path exists as a regular file.
    const fileRequest = await mkdtemp(join(tmpdir(), "tsugite-h3-write-file-req-"));
    await mkdir(join(fileRequest, "h3"), { recursive: true });
    await writeFile(join(fileRequest, "h3", "shot-1"), "not-dir");
    const blockedRequest = await writeH3RunArtifacts({
      runDir: fileRequest,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(blockedRequest.ok).toBe(false);
    expect(blockedRequest.issues[0]?.message).toMatch(/not a directory/);

    // Existing request dir with an artifact path occupied by a directory.
    const dirLeaf = await mkdtemp(join(tmpdir(), "tsugite-h3-write-dir-leaf-"));
    await mkdir(join(dirLeaf, "h3", "shot-1", "creative-ir.json"), { recursive: true });
    const blockedLeaf = await writeH3RunArtifacts({
      runDir: dirLeaf,
      compilations: [compiled],
      pinnedRequests: [h3Request("shot-1", ir, { prompt: compiled.adapter_prompt })],
      adapterId: "mock-cli"
    });
    expect(blockedLeaf.ok).toBe(false);
    expect(blockedLeaf.issues[0]?.message).toMatch(/not a regular file/);
  });

  it("persists prompt-guide enrichment into lineage when the pin declares a catalog", async () => {
    const ir = await loadFixture("t2v.json");
    const compiled = await compileOk(ir, "shot-guide");
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-h3-guide-art-"));
    const written = await writeH3RunArtifacts({
      runDir,
      compilations: [compiled],
      pinnedRequests: [
        h3Request("shot-guide", ir, {
          prompt: compiled.adapter_prompt,
          prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
        })
      ],
      adapterId: "mock-cli",
      promptGuides: [
        {
          catalog_id: "pixverse",
          model: "minimax-h3",
          modes: { "text-to-video": { notes: ["keep dialogue locked"] } }
        }
      ]
    });
    expect(written.ok).toBe(true);
    const lineage = JSON.parse(await readFile(written.artifacts[0]!.absolute_paths.lineage, "utf8"));
    expect(lineage.prompt_guide_identity).toBe("pixverse");
    expect(typeof lineage.prompt_guide_hash).toBe("string");
    expect(lineage.prompt_guide_hash).toHaveLength(64);

    const inspected = await inspectH3RunArtifacts({
      runDir,
      compilations: [written.artifacts[0]!.compilation],
      adapterId: "mock-cli"
    });
    expect(inspected.ok).toBe(true);
  });
});
