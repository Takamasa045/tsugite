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
});
