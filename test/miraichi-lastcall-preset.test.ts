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

  it("resolves the project to canonical vertical dimensions", async () => {
    const manifest = JSON.parse(
      await readFile("projects/miraichi0717-lastcall/manifest.json", "utf8")
    );

    expect(resolveOutputDimensions(manifest)).toEqual({ width: 1080, height: 1920 });
  });
});
