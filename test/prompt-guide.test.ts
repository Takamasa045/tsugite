import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPromptGuide,
  loadPromptGuideById,
  resolveProjectPromptGuidance,
  resolvePromptGuidance
} from "../src/adapters/promptKnowledge.js";
import { projectSchema, type GenerationRequest } from "../src/project/schema.js";

describe("adapter prompt knowledge", () => {
  it.each([
    ["pixverse", "v6"],
    ["kling", "video-3.0"],
    ["seedance", "seedance-2.0"]
  ])("loads a source-backed %s guide", async (catalog, profile) => {
    const guide = await loadPromptGuide(join("knowledge/video-models", catalog));

    expect(guide).toMatchObject({
      schema_version: 1,
      kind: "video-prompt-guide",
      catalog_id: catalog
    });
    expect(guide?.models.map((model) => model.id)).toContain(profile);
    expect(guide?.modes).toHaveProperty("text-to-video");
    expect(guide?.modes).toHaveProperty("image-to-video");
    expect(guide?.sources.length).toBeGreaterThan(0);
    expect(guide?.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("returns undefined when a catalog has no prompt guide", async () => {
    await expect(loadPromptGuide("knowledge/video-models/missing")).resolves.toBeUndefined();
  });

  it("rejects unsafe catalog ids before joining filesystem paths", async () => {
    await expect(loadPromptGuideById("../outside")).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: "prompt_guide.catalog_id"
        })
      ]
    });
  });

  it("rejects malformed prompt guides with a structured issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-prompt-guide-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "prompt-guide.yaml"), "schema_version: 1\nid: broken\nmodes: {}\n");

    await expect(loadPromptGuide(root)).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: "prompt_guide.schema",
          path: join(root, "prompt-guide.yaml")
        })
      ]
    });
  });

  it("selects I2V guidance from an image request and exposes provenance", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/pixverse");
    const guidance = resolvePromptGuidance(imageRequest("v6"), guide!);

    expect(guidance).toMatchObject({
      request_id: "guide-001",
      catalog_id: "pixverse",
      input_mode: "image-to-video",
      model_profile: "v6",
      status: "matched",
      guide_path: "knowledge/video-models/pixverse/prompt-guide.yaml",
      verified_at: "2026-07-10",
      recipe: {
        template: expect.any(String),
        negative_prompt: {
          strategy: expect.any(String)
        }
      }
    });
    expect(guidance.source_urls.length).toBeGreaterThan(0);
    expect(guidance.recipe?.checklist.length).toBeGreaterThan(2);
    expect(guidance.model_limits).toMatchObject({
      duration_seconds: { min: 1, max: 15 },
      image_to_video_uses_input_aspect: true
    });
    expect(guidance.sources.map((source) => source.id)).not.toContain("c1-api");
  });

  it("marks expired guidance stale and preserves explicit missing-catalog status", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/pixverse");
    const stale = resolvePromptGuidance(imageRequest("v6"), guide!, "2026-10-11");
    const project = projectSchema.parse({
      slug: "missing-guide",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "fixture",
        requests: [
          {
            ...textRequest("fixture-model"),
            prompt_guide: { catalog: "missing-guide" }
          }
        ]
      }
    });

    expect(stale.freshness).toBe("stale");
    expect(resolveProjectPromptGuidance(project, [])).toEqual([
      expect.objectContaining({ status: "catalog-missing", catalog_id: "missing-guide" })
    ]);
  });

  it("rejects invalid calendar dates in otherwise valid catalogs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-prompt-guide-date-"));
    const catalogRoot = join(root, "pixverse");
    await mkdir(catalogRoot, { recursive: true });
    const source = await readFile("knowledge/video-models/pixverse/prompt-guide.yaml", "utf8");
    await writeFile(join(catalogRoot, "prompt-guide.yaml"), source.replace("review_after: 2026-10-10", "review_after: 2026-02-31"));

    await expect(loadPromptGuide(catalogRoot)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "prompt_guide.schema" })]
    });
  });

  it("keeps distinct model variants separate when their limits differ", async () => {
    const kling = await loadPromptGuide("knowledge/video-models/kling");
    const seedance = await loadPromptGuide("knowledge/video-models/seedance");

    const o1 = resolvePromptGuidance(
      { ...textRequest("kling-video-o1"), input_mode: "text-to-video" },
      kling!
    );
    const video3 = resolvePromptGuidance(
      { ...textRequest("kling-v3"), input_mode: "text-to-video" },
      kling!
    );

    expect(o1).toMatchObject({
      model_profile: "video-o1",
      model_limits: {
        duration_seconds: { min: 3, max: 10 }
      }
    });
    expect(o1.model_limits).not.toHaveProperty("max_storyboard_shots");
    expect(o1.recipe?.checklist.map((rule) => rule.id)).not.toContain("video-3-storyboard");
    expect(video3.model_limits?.resolutions).toContain("4k");
    expect(video3.recipe?.checklist.map((rule) => rule.id)).toContain("video-3-storyboard");
    expect(resolvePromptGuidance(textRequest("dreamina-seedance-2-0-fast-260128"), seedance!)).toMatchObject({
      model_profile: "seedance-2.0-fast",
      model_limits: {
        resolutions: ["480p", "720p"]
      }
    });
  });

  it("does not apply a family recipe to an unknown model", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/pixverse");
    const guidance = resolvePromptGuidance(textRequest("unrelated-model"), guide!);

    expect(guidance).toMatchObject({
      status: "model-unmatched",
      model_profile: undefined,
      recipe: undefined,
      available_model_profiles: expect.arrayContaining(["v6"])
    });
    expect(guidance.sources).toEqual([]);
  });

  it("limits unset-mode provenance to the matched model", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/pixverse");
    const guidance = resolvePromptGuidance(textRequest("c1"), guide!);

    expect(guidance.status).toBe("input-mode-unset");
    expect(guidance.sources.map((source) => source.id)).toEqual(expect.arrayContaining(["prompt-guide", "c1-api"]));
    expect(guidance.sources.map((source) => source.id)).not.toContain("v6-api");
    expect(guidance.sources.map((source) => source.id)).not.toContain("i2v-api");
  });

  it("resolves advisory knowledge with a model selector separate from the execution name", async () => {
    const guide = await loadPromptGuide("knowledge/video-models/seedance");
    const request: GenerationRequest = {
      ...imageRequest("Standard"),
      prompt_guide: {
        catalog: "seedance",
        model: "seedance-2.0"
      }
    };

    const guidance = resolvePromptGuidance(request, guide!);

    expect(guidance.status).toBe("matched");
    expect(guidance.model).toBe("Standard");
    expect(guidance.model_profile).toBe("seedance-2.0");
  });
});

function textRequest(model: string): GenerationRequest {
  return {
    id: "guide-001",
    prompt: "A quiet mountain trail at dawn",
    model,
    duration: 5,
    aspect: "16:9",
    params: {}
  };
}

function imageRequest(model: string): GenerationRequest {
  return {
    ...textRequest(model),
    input_mode: "image-to-video",
    prompt_guide: {
      catalog: "pixverse"
    },
    params: {
      image: "references/trail.png"
    }
  };
}
