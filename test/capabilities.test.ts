import { describe, expect, it } from "vitest";
import { validateProject } from "../src/project/validateProject.js";

describe("backend capabilities", () => {
  it("rejects captions, vertical, and fps demands unsupported by a backend", async () => {
    const result = await validateProject("fixtures/projects/captions-limited.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "backend.capability.captions",
        "backend.capability.vertical",
        "backend.capability.fps"
      ])
    );
  });

  it("rejects audio mix and transition demands unsupported by a backend", async () => {
    const result = await validateProject("fixtures/projects/audio-transition-limited.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "backend.capability.audio_mix",
        "backend.capability.transitions"
      ])
    );
  });
});
