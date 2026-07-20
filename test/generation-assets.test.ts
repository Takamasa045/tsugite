import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinGenerationAssets, validateGenerationAssets } from "../src/project/generationAssets.js";

function request(referenceImages: string[]) {
  return {
    id: "act-1",
    prompt: "historical action sequence",
    model: "Standard",
    duration: 15,
    aspect: "16:9" as const,
    input_mode: "image-to-video" as const,
    first_frame: "assets/storyboard.png",
    reference_images: referenceImages,
    params: { omni_reference: true }
  };
}

describe("generation reference image assets", () => {
  it("rejects a missing material reference before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-generation-assets-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets/storyboard.png"), "storyboard");

    const result = await validateGenerationAssets(
      { generation: { adapter: "topview", requests: [request(["assets/missing.png"])] } } as any,
      root,
      root
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "generation.reference_images.exists",
      path: "generation.requests.0.reference_images.0"
    }));
  });

  it("pins storyboard and material references into the run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-generation-assets-"));
    const runDir = join(root, "run");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets/storyboard.png"), "storyboard");
    await writeFile(join(root, "assets/yokai.png"), "yokai");
    await writeFile(join(root, "assets/ronin.png"), "ronin");

    const result = await pinGenerationAssets(
      [request(["assets/yokai.png", "assets/ronin.png"])] as any,
      root,
      root,
      runDir
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0].reference_images).toEqual([
      join(runDir, "assets/generation-inputs/act-1/002-reference.png"),
      join(runDir, "assets/generation-inputs/act-1/003-reference.png")
    ]);
    await expect(access(result.requests[0].first_frame!)).resolves.toBeUndefined();
    await expect(access(result.requests[0].reference_images![0])).resolves.toBeUndefined();
    await expect(access(result.requests[0].reference_images![1])).resolves.toBeUndefined();
  });

  it("pins generic image, video, and audio inputs before a provider CLI can read them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-generation-media-inputs-"));
    const runDir = join(root, "run");
    await mkdir(join(root, "assets"), { recursive: true });
    for (const name of ["reference.png", "source.mp4", "voice.wav"]) {
      await writeFile(join(root, "assets", name), name);
    }
    const result = await pinGenerationAssets([{
      id: "media-request",
      operation: "reference",
      prompt: "continue the scene",
      model: "runtime-model",
      input_images: ["assets/reference.png"],
      input_video: "assets/source.mp4",
      input_audios: ["assets/voice.wav"],
      params: {}
    }] as any, root, root, runDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0].input_images?.[0]).toContain("assets/generation-inputs/media-request/input_images-001.png");
    expect(result.requests[0].input_video).toContain("assets/generation-inputs/media-request/input-video.mp4");
    expect(result.requests[0].input_audios?.[0]).toContain("assets/generation-inputs/media-request/input_audios-001.wav");
  });

  it("pins legacy params.image instead of letting a provider CLI read an arbitrary path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-generation-legacy-input-"));
    const runDir = join(root, "run");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "legacy.png"), "legacy image");
    const legacy = request([]);
    legacy.first_frame = undefined as any;
    legacy.params = { image: "assets/legacy.png" };

    const result = await pinGenerationAssets([legacy] as any, root, root, runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0].params.image).toBe(join(runDir, "assets/generation-inputs/act-1/legacy-image.png"));
    await expect(access(result.requests[0].params.image as string)).resolves.toBeUndefined();
  });
});
