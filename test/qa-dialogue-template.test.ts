import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildManifest, expandQaToDialogue } from "../templates/qa-dialogue/build-manifest.mjs";

const config = {
  slug: "qa-dialogue-fixture",
  aspect: "16:9",
  fps: 30,
  background: {
    id: "background",
    src: "media/background.mp4",
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
      poses: { neutral: "shiba-mouth-closed", curious: "shiba-mouth-closed" },
      mouth_frames: ["shiba-mouth-closed", "shiba-mouth-half", "shiba-mouth-open"]
    },
    {
      id: "itopan",
      display_name: "イトパン",
      side: "right",
      accent: "#3972b8",
      poses: { neutral: "itopan-mouth-closed", explain: "itopan-mouth-half", smile: "itopan-mouth-half" },
      mouth_frames: ["itopan-mouth-closed", "itopan-mouth-half", "itopan-mouth-open"]
    }
  ],
  presentation: {
    preset: "article-dialogue-16x9",
    label: "Q&A DIALOGUE",
    title: "Fixture FAQ",
    draft: true
  },
  audio: { bgm: [], narration: [], sfx: [] }
};

const qa = {
  title: "Fixture FAQ",
  duration_per_qa: 10,
  question_ratio: 0.4,
  intro: {
    text: "FAQを始めるよ",
    speaker: "itopan",
    seconds: 2
  },
  qa_list: [
    {
      id: "q01",
      q: "何から始める？",
      a: "質問リストをJSONに書く",
      detail: "データ駆動で量産できる",
      highlights: ["JSON"]
    },
    {
      id: "q02",
      q: "長い回答は？",
      a_lines: ["複数行に分ける", "1行48文字まで"],
      detail: "字幕を読みやすく保つ"
    }
  ],
  outro: {
    text: "以上だよ",
    speaker: "itopan",
    seconds: 2
  }
};

describe("qa dialogue template builder", () => {
  it("expands qa_list into question/answer captions with continuous timing", () => {
    const expanded = expandQaToDialogue(config, qa);

    expect(expanded.durationSeconds).toBe(24);
    expect(expanded.captions[0]).toMatchObject({
      speaker: "itopan",
      text: "FAQを始めるよ",
      start: 0,
      end: 2
    });
    expect(expanded.captions.some((caption) => caption.visual?.kicker === "QUESTION")).toBe(true);
    expect(expanded.captions.some((caption) => caption.visual?.kicker === "ANSWER")).toBe(true);
    expect(expanded.chapters.map((chapter) => chapter.title)).toEqual(["Intro", "Q1", "Q2", "Outro"]);

    const ends = expanded.captions.map((caption) => caption.end);
    const starts = expanded.captions.map((caption) => caption.start);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]).toBeCloseTo(ends[index - 1], 3);
    }
  });

  it("builds a deterministic remotion manifest from qa input", () => {
    const manifest = buildManifest(config, qa);

    expect(manifest.meta).toMatchObject({
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 24,
      slug: "qa-dialogue-fixture"
    });
    expect(manifest.clips[0]).toMatchObject({ duration: 24, out: 24, audio: false });
    expect(manifest.presentation).toMatchObject({
      preset: "article-dialogue-16x9",
      label: "Q&A DIALOGUE",
      title: "Fixture FAQ",
      draft: true
    });
    expect(manifest.captions.every((caption: { visual?: { headline?: string } }) => caption.visual?.headline)).toBe(
      true
    );
  });

  it("pads the final caption when video.json sets a longer duration_seconds", () => {
    const manifest = buildManifest({ ...config, duration_seconds: 30 }, qa);
    expect(manifest.meta.target_duration_seconds).toBe(30);
    expect(manifest.clips[0].duration).toBe(30);
    expect(manifest.captions.at(-1)?.end).toBe(30);
    expect(manifest.chapters.at(-1)?.end).toBe(30);
  });

  it("rejects long captions, empty lists, and invalid speakers", () => {
    expect(() => buildManifest(config, { ...qa, qa_list: [] })).toThrow(/qa_list/);
    expect(() =>
      buildManifest(config, {
        ...qa,
        qa_list: [{ q: "長".repeat(49), a: "短い回答" }]
      })
    ).toThrow(/48 characters/);
    expect(() =>
      buildManifest(config, {
        ...qa,
        roles: { questioner: "unknown", answerer: "itopan" }
      })
    ).toThrow(/unknown questioner/);
    expect(() => buildManifest({ ...config, aspect: "9:16" }, qa)).toThrow(/16:9/);
  });

  it("keeps the shipped OpenClaw sample and generated manifest in sync", async () => {
    const root = "templates/qa-dialogue";
    const [shippedConfig, shippedQa, shippedManifest] = await Promise.all([
      readJson(`${root}/video.json`),
      readJson(`${root}/qa.json`),
      readJson(`${root}/manifest.json`)
    ]);

    expect(buildManifest(shippedConfig, shippedQa)).toEqual(shippedManifest);
    expect(shippedQa.qa_list).toHaveLength(3);
    expect(shippedManifest.presentation).toMatchObject({
      preset: "article-dialogue-16x9",
      label: "Q&A DIALOGUE",
      draft: true
    });
    expect(shippedManifest.captions.some((caption: { visual?: { kicker?: string } }) => caption.visual?.kicker === "QUESTION")).toBe(
      true
    );
    expect(shippedManifest.captions.some((caption: { visual?: { kicker?: string } }) => caption.visual?.kicker === "ANSWER")).toBe(
      true
    );
    expect(shippedManifest.meta.target_duration_seconds).toBe(60);
    expect(shippedConfig.speakers.every((speaker: { mouth_frames?: string[] }) => speaker.mouth_frames?.length === 3)).toBe(
      true
    );
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
