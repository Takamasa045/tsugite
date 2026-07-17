import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { resolveOutputDimensions } from "../backends/outputDimensions.mjs";
import { resolveRemotionPreset } from "../backends/remotion/presetRegistry.mjs";

describe("MIRAICHI last-call preset", () => {
  it("is available through the Remotion preset registry", () => {
    const preset = resolveRemotionPreset("miraichi-lastcall-9x16");

    expect(preset?.id).toBe("miraichi-lastcall-9x16");
    expect(typeof preset?.handler).toBe("function");
  });

  it("resolves a 9:16 manifest to canonical vertical dimensions", () => {
    const manifest = {
      meta: { aspect: "9:16" },
      clips: []
    };

    expect(resolveOutputDimensions(manifest)).toEqual({ width: 1080, height: 1920 });
  });

  it("keeps the revised cut at 15 seconds with a 20:30 start", async () => {
    const manifest = JSON.parse(
      await readFile("projects/miraichi0717-lastcall/manifest.json", "utf8")
    );
    const totalClipDuration = manifest.clips.reduce(
      (sum: number, clip: { duration: number }) => sum + clip.duration,
      0
    );
    const timeCaption = manifest.captions.find((caption: { id: string }) => caption.id === "time");

    expect(manifest.meta.target_duration_seconds).toBe(15);
    expect(totalClipDuration).toBe(15);
    expect(timeCaption?.text).toBe("本日20:30スタート");
    expect(timeCaption?.visual?.badges).toContain("20:30");
  });
});
