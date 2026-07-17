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
});
