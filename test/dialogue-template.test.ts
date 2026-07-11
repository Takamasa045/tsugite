import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildManifest } from "../templates/blog-dialogue-60s/build-manifest.mjs";

const config = {
  slug: "article-dialogue",
  aspect: "16:9",
  fps: 30,
  duration_seconds: 60,
  background: {
    id: "background",
    src: "media/background-60s.mp4",
    resolution: { width: 1920, height: 1080 }
  },
  images: [
    { id: "shiba-mouth-closed", src: "media/characters/shiba-mouth-closed.png" },
    { id: "shiba-mouth-half", src: "media/characters/shiba-mouth-half.png" },
    { id: "shiba-mouth-open", src: "media/characters/shiba-mouth-open.png" },
    { id: "itopan-mouth-closed", src: "media/characters/itopan-mouth-closed.png" },
    { id: "itopan-mouth-half", src: "media/characters/itopan-mouth-half.png" },
    { id: "itopan-mouth-open", src: "media/characters/itopan-mouth-open.png" }
  ],
  speakers: [
    {
      id: "shiba",
      display_name: "しば",
      side: "left",
      accent: "#df7b37",
      poses: { neutral: "shiba-mouth-closed" },
      mouth_frames: ["shiba-mouth-closed", "shiba-mouth-half", "shiba-mouth-open"]
    },
    {
      id: "itopan",
      display_name: "イトパン",
      side: "right",
      accent: "#3972b8",
      poses: { neutral: "itopan-mouth-closed" },
      mouth_frames: ["itopan-mouth-closed", "itopan-mouth-half", "itopan-mouth-open"]
    }
  ],
  presentation: {
    preset: "article-dialogue-16x9",
    title: "Article dialogue",
    source_url: "https://example.com/article",
    draft: true
  },
  audio: { bgm: [], narration: [], sfx: [] },
  chapters: [
    { title: "Hook", start: 0, end: 10 },
    { title: "Core", start: 10, end: 45 },
    { title: "CTA", start: 45, end: 60 }
  ]
};

const dialogue = [
  { id: "s01", speaker: "shiba", text: "質問", start: 0, end: 30, pose: "neutral" },
  { id: "s02", speaker: "itopan", text: "続きは記事で", start: 30, end: 60, pose: "neutral" }
];

describe("blog dialogue template builder", () => {
  it("builds a deterministic 60-second manifest from the dialogue source", () => {
    const manifest = buildManifest(config, dialogue);

    expect(manifest.meta).toMatchObject({ aspect: "16:9", fps: 30, target_duration_seconds: 60 });
    expect(manifest.clips[0]).toMatchObject({ duration: 60, out: 60, audio: false });
    expect(manifest.captions).toEqual(dialogue);
    expect(manifest.presentation).toMatchObject({ preset: "article-dialogue-16x9", draft: true });
    expect(manifest.audio).toEqual({ bgm: [], narration: [], sfx: [] });
  });

  it("rejects gaps, overlaps, unknown speakers, and a non-60-second template", () => {
    expect(() => buildManifest({ ...config, duration_seconds: 59 }, dialogue)).toThrow(/60 seconds/);
    expect(() => buildManifest(config, [{ ...dialogue[0], end: 31 }, dialogue[1]])).toThrow(/overlap/);
    expect(() => buildManifest(config, [dialogue[0], { ...dialogue[1], start: 31 }])).toThrow(/gap/);
    expect(() => buildManifest(config, [dialogue[0], { ...dialogue[1], speaker: "unknown" }])).toThrow(
      /unknown speaker/
    );
    expect(() =>
      buildManifest(config, [{ ...dialogue[0], text: "長".repeat(49) }, dialogue[1]])
    ).toThrow(/48 characters/);
    expect(() =>
      buildManifest(
        { ...config, speakers: [{ ...config.speakers[0], mouth_frames: undefined }, config.speakers[1]] },
        dialogue
      )
    ).toThrow(/closed, half-open, and open mouth frames/);
  });

  it("keeps the shipped J-space dialogue and generated manifest in sync", async () => {
    const root = "templates/blog-dialogue-60s";
    const [shippedConfig, shippedDialogue, shippedManifest] = await Promise.all([
      readJson(`${root}/video.json`),
      readJson(`${root}/dialogue_60s.json`),
      readJson(`${root}/manifest.json`)
    ]);

    expect(buildManifest(shippedConfig, shippedDialogue)).toEqual(shippedManifest);
    expect(shippedDialogue).toHaveLength(10);
    expect(shippedDialogue[0]).toMatchObject({ start: 0, speaker: "shiba" });
    expect(shippedDialogue.at(-1)).toMatchObject({ end: 60, speaker: "itopan" });
    expect(shippedDialogue.at(-1).text).toContain("記事");
    expect(shippedDialogue.every((segment: { visual?: { headline?: string } }) => segment.visual?.headline)).toBe(true);
    expect(shippedConfig.images).toHaveLength(6);
    expect(shippedConfig.speakers.every((speaker: { mouth_frames?: string[] }) => speaker.mouth_frames?.length === 3)).toBe(
      true
    );
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
