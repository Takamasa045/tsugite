import { describe, expect, it } from "vitest";
import {
  ORBITAL_SCENES,
  ORBITAL_SHOWREEL_PRESET,
  resolveOrbitalShowreel
} from "../backends/remotion/orbitalPresentation.mjs";

const clip = (id) => ({ id, src: `media/${id}.mp4`, in: 0, out: 5, duration: 5 });

describe("orbital showreel presentation", () => {
  it("keeps a continuous 30-second gallery-to-feature-to-end-card timeline", () => {
    expect(ORBITAL_SHOWREEL_PRESET).toBe("orbital-showreel-16x9");
    expect(ORBITAL_SCENES[0]).toMatchObject({ id: "hook", start: 0 });
    expect(ORBITAL_SCENES.at(-1)).toMatchObject({ id: "outro", start: 26, duration: 4 });
    expect(Math.max(...ORBITAL_SCENES.map((scene) => scene.start + scene.duration))).toBe(30);
  });

  it("resolves exactly three featured clips from the manifest", () => {
    const manifest = {
      clips: [clip("a"), clip("b"), clip("c"), clip("d")],
      presentation: {
        featured: [
          { clip_id: "a", label: "物語も。", counter: "01 / 03" },
          { clip_id: "b", label: "キャラクターも。", counter: "02 / 03" },
          { clip_id: "c", label: "伝える動画も。", counter: "03 / 03" }
        ]
      }
    };

    expect(resolveOrbitalShowreel(manifest).featured.map((entry) => entry.clip.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects a feature that is missing from the clip inventory", () => {
    const manifest = {
      clips: [clip("a"), clip("b"), clip("c")],
      presentation: {
        featured: [
          { clip_id: "a" },
          { clip_id: "b" },
          { clip_id: "missing" }
        ]
      }
    };

    expect(() => resolveOrbitalShowreel(manifest)).toThrow("missing clip 'missing'");
  });
});
