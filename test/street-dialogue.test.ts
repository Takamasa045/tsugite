import { describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import { validateManifest } from "../src/manifest/validate.js";
// @ts-expect-error backend modules are plain ESM without type declarations
import {
  STREET_DIALOGUE_PRESET,
  STREET_THEME,
  activeBounce,
  centerAt,
  chapterAt,
  idleBob,
  popIn,
  stickyVisualAt,
  swapPhase
} from "../backends/remotion/streetPresentation.mjs";

function streetManifest() {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 10, slug: "street-test" },
    clips: [
      {
        id: "bg",
        src: "media/bg.mp4",
        in: 0,
        out: 10,
        duration: 10,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: false
      }
    ],
    images: [
      { id: "l-closed", src: "media/l0.png" },
      { id: "l-half", src: "media/l1.png" },
      { id: "l-open", src: "media/l2.png" },
      { id: "r-closed", src: "media/r0.png" },
      { id: "r-half", src: "media/r1.png" },
      { id: "r-open", src: "media/r2.png" }
    ],
    speakers: [
      {
        id: "chill",
        display_name: "チル",
        side: "left",
        accent: "#ff8a3d",
        poses: { neutral: "l-closed" },
        mouth_frames: ["l-closed", "l-half", "l-open"]
      },
      {
        id: "neru",
        display_name: "ネル",
        side: "right",
        accent: "#3ec6b8",
        poses: { neutral: "r-closed" },
        mouth_frames: ["r-closed", "r-half", "r-open"]
      }
    ],
    presentation: { preset: "street-dialogue-16x9", title: "テスト", draft: true },
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [
      { id: "c1", speaker: "chill", text: "やあ", start: 0, end: 5 },
      { id: "c2", speaker: "neru", text: "こんにちは", start: 5, end: 10 }
    ],
    chapters: [],
    provenance: []
  };
}

describe("street dialogue preset validation", () => {
  it("accepts a silent street dialogue draft", () => {
    const result = validateManifest(streetManifest());

    expect(result.ok).toBe(true);
    expect(result.manifest?.presentation?.preset).toBe(STREET_DIALOGUE_PRESET);
  });

  it("requires silent street dialogue presentations to remain marked as drafts", () => {
    const manifest = streetManifest();
    manifest.presentation.draft = false;
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.presentation.draft");
  });

  it("requires exactly one left and one right speaker", () => {
    const manifest = streetManifest();
    manifest.speakers = [manifest.speakers[0]!];
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.presentation.cast");
  });

  it("rejects overlapping or out-of-range presentation captions", () => {
    const manifest = streetManifest();
    manifest.captions[1]!.start = 4;
    manifest.captions[1]!.end = 12;
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["manifest.caption.overlap", "manifest.caption.range"])
    );
  });

  it("rejects presentation captions without a declared speaker", () => {
    const manifest = streetManifest();
    delete (manifest.captions[0] as { speaker?: string }).speaker;
    const result = validateManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.caption.speaker");
  });
});

describe("remotion backend registration", () => {
  it("declares the street dialogue preset in capabilities", async () => {
    const backend = await loadBackendCapabilities("remotion");

    expect(backend?.capabilities.presets).toContain("street-dialogue-16x9");
  });

  it("exposes the street dialogue component", async () => {
    const module = (await import("../backends/remotion/streetDialogue.js")) as {
      StreetDialogue: unknown;
    };

    expect(typeof module.StreetDialogue).toBe("function");
  });
});

describe("street presentation helpers", () => {
  it("keeps a theme with paper, ink, and both speaker accents", () => {
    expect(STREET_THEME.paper).toMatch(/^#/);
    expect(STREET_THEME.ink).toMatch(/^#/);
    expect(STREET_THEME.accentLeft).toMatch(/^#/);
    expect(STREET_THEME.accentRight).toMatch(/^#/);
  });

  it("returns the latest topic card at or before the current second", () => {
    const captions = [
      { text: "a", start: 0, end: 4, visual: { headline: "first" } },
      { text: "b", start: 4, end: 8 },
      { text: "c", start: 8, end: 12, visual: { headline: "second" } }
    ];

    expect(stickyVisualAt(captions, 0)?.headline).toBe("first");
    expect(stickyVisualAt(captions, 6)?.headline).toBe("first");
    expect(stickyVisualAt(captions, 9)?.headline).toBe("second");
    expect(stickyVisualAt([], 3)).toBeUndefined();
  });

  it("finds the active chapter with an inclusive start and exclusive end", () => {
    const chapters = [
      { title: "one", start: 0, end: 5 },
      { title: "two", start: 5, end: 10 }
    ];

    expect(chapterAt(chapters, 0)?.title).toBe("one");
    expect(chapterAt(chapters, 5)?.title).toBe("two");
    expect(chapterAt(chapters, 10)).toBeUndefined();
  });

  it("keeps the idle bob inside its amplitude and phase-shifted per speaker", () => {
    for (let frame = 0; frame < 120; frame += 7) {
      expect(Math.abs(idleBob(frame, 30, 0))).toBeLessThanOrEqual(6);
    }
    expect(idleBob(10, 30, 0)).not.toBe(idleBob(10, 30, Math.PI));
  });

  it("starts the active bounce at full lift and settles within 0.6 seconds", () => {
    expect(activeBounce(0, 30)).toBeGreaterThan(10);
    expect(Math.abs(activeBounce(18, 30))).toBeLessThan(2);
  });

  it("returns the active caption's center-stage directive", () => {
    const captions = [
      { text: "a", start: 0, end: 4, center: { type: "telop", text: "キーワード" } },
      { text: "b", start: 4, end: 8 }
    ];

    expect(centerAt(captions, 1)?.text).toBe("キーワード");
    expect(centerAt(captions, 5)).toBeUndefined();
    expect(centerAt(captions, 9)).toBeUndefined();
  });

  it("flips the desk card label halfway through the swap window", () => {
    expect(swapPhase(0.2, "クモ", "アリ")).toEqual({ label: "クモ", scaleX: 1 });
    expect(swapPhase(0.5, "クモ", "アリ").scaleX).toBeLessThan(0.2);
    expect(swapPhase(0.8, "クモ", "アリ")).toEqual({ label: "アリ", scaleX: 1 });
  });

  it("pops in from zero, may overshoot, and settles at one", () => {
    expect(popIn(0, 30)).toBe(0);
    expect(popIn(60, 30)).toBe(1);
    for (let frame = 0; frame <= 60; frame += 1) {
      expect(popIn(frame, 30)).toBeLessThanOrEqual(1.2);
      expect(popIn(frame, 30)).toBeGreaterThanOrEqual(0);
    }
  });
});
