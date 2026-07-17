import { describe, expect, it } from "vitest";
import { toPortablePath } from "../src/platform/path.js";

describe("portable serialized paths", () => {
  it("uses forward slashes for Windows path fragments stored in manifests and review data", () => {
    expect(toPortablePath(String.raw`assets\generation-inputs\shot-001\001-first-frame.png`)).toBe(
      "assets/generation-inputs/shot-001/001-first-frame.png"
    );
  });

  it("keeps already portable paths unchanged", () => {
    expect(toPortablePath("knowledge/video-models/pixverse/prompt-guide.yaml")).toBe(
      "knowledge/video-models/pixverse/prompt-guide.yaml"
    );
  });
});
