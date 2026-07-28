import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import { NATURE_VIBE_REGGAE_FONT_PATH } from "../backends/remotion/natureVibeAssets.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { stageNatureVibePublicAssets } from "../backends/remotion/publicAssets.mjs";

describe("Remotion public assets", () => {
  it("stages the bundled Reggae One face into the Nature Vibe run public directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-nature-vibe-public-"));
    const copied = await stageNatureVibePublicAssets({
      runDir,
      manifest: { presentation: { preset: "nature-vibe-visualizer-9x16" } }
    });

    expect(copied).toEqual([NATURE_VIBE_REGGAE_FONT_PATH]);
    await expect(stat(join(runDir, NATURE_VIBE_REGGAE_FONT_PATH))).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await readFile(join(runDir, NATURE_VIBE_REGGAE_FONT_PATH))).byteLength).toBeGreaterThan(2_000_000);
  });

  it("uses the same staging hook for the selected-shot review renderer", async () => {
    const source = await readFile("backends/remotion/reviewPreview.mjs", "utf8");

    expect(source).toContain('stageNatureVibePublicAssets({ runDir: realReviewDir, manifest: input.manifest })');
  });
});
