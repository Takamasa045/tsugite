import { describe, expect, it } from "vitest";
import {
  loadStoryGuide,
  recommendStoryFrameworks
} from "../src/adapters/storyKnowledge.js";

describe("story and video grammar knowledge", () => {
  it("loads a source-backed catalog of classic structures and video principles", async () => {
    const guide = await loadStoryGuide();

    expect(guide).toMatchObject({
      schema_version: 1,
      kind: "story-framework-guide",
      catalog_id: "classic-video-storytelling"
    });
    expect(guide.frameworks.map((framework) => framework.id)).toEqual(
      expect.arrayContaining([
        "kishotenketsu",
        "three-act",
        "generalized-beat-sheet",
        "aida",
        "prep"
      ])
    );
    expect(guide.frameworks.length).toBeGreaterThanOrEqual(30);
    expect(guide.principles.map((principle) => principle.id)).toEqual(
      expect.arrayContaining([
        "one-shot-one-role",
        "screen-direction",
        "motivated-cut",
        "audio-leads-picture",
        "rule-of-thirds",
        "thirty-degree-change",
        "match-on-action",
        "room-tone",
        "continuity-anchor"
      ])
    );
    expect(guide.principles.length).toBeGreaterThanOrEqual(30);
    expect(guide.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("recommends a short-form persuasion structure with reasons and timing", async () => {
    const guide = await loadStoryGuide();
    const recommendation = recommendStoryFrameworks(
      "30秒の縦型SNS広告。新しい講座の価値と実績を見せて申込みにつなげたい",
      guide,
      { durationSeconds: 30 }
    );

    expect(recommendation).toMatchObject({
      duration_seconds: 30,
      primary: {
        id: "hook-value-proof-cta",
        selection_reasons: expect.arrayContaining([expect.stringContaining("短尺")])
      },
      duration_preset: {
        recommended_cuts: { min: 5, max: 7 }
      }
    });
    expect(recommendation.secondary.map((framework) => framework.id)).toEqual(
      expect.arrayContaining(["aida"])
    );
    expect(recommendation.rejected.length).toBeGreaterThan(0);
    expect(recommendation.applied_principles.length).toBeGreaterThanOrEqual(4);
  });

  it("uses an abstracted beat sheet for a longer character-change story", async () => {
    const guide = await loadStoryGuide();
    const recommendation = recommendStoryFrameworks(
      "90秒の物語プロモ。主人公の迷い、選択、成長と変化を映画的に描きたい",
      guide,
      { durationSeconds: 90 }
    );

    expect(recommendation.primary.id).toBe("generalized-beat-sheet");
    expect(recommendation.primary.derived_from).toContain("Save the Cat");
    expect(recommendation.secondary.map((framework) => framework.id)).toEqual(
      expect.arrayContaining(["three-act", "kishotenketsu"])
    );
    expect(recommendation.safety_notes).toEqual(
      expect.arrayContaining([expect.stringContaining("固有")])
    );
  });

  it.each([
    {
      request: "60秒のサスペンス。観客だけが危険とタイムリミットを知り、緊張を高めて最後に真相を明かす",
      duration: 60,
      primary: "tension-escalation-reveal",
      principles: ["hold-before-after", "silence-as-emphasis"]
    },
    {
      request: "3分の人物ドキュメンタリー。ひとりの目標を追う取材とインタビュー、現実の障害を描く",
      duration: 180,
      primary: "documentary-character-quest",
      principles: ["cutaway-bridge", "room-tone"]
    },
    {
      request: "2分のMV。楽曲のサビに合わせ、アーティストのパフォーマンスと反復モチーフを強くする",
      duration: 120,
      primary: "music-performance-motif",
      principles: ["color-motif", "sonic-motif"]
    },
    {
      request: "45秒のコメディ。三段オチでパターンを作り、最後に予想を裏切って笑いを取る",
      duration: 45,
      primary: "comedy-rule-of-three",
      principles: ["pace-contrast", "hold-before-after"]
    }
  ])("selects $primary for genre-specific requests", async ({ request, duration, primary, principles }) => {
    const guide = await loadStoryGuide();
    const recommendation = recommendStoryFrameworks(request, guide, { durationSeconds: duration });

    expect(recommendation.primary.id).toBe(primary);
    expect(recommendation.primary.selection_reasons[0]).toContain("依頼");
    expect(recommendation.applied_principles.map((principle) => principle.id)).toEqual(
      expect.arrayContaining(principles)
    );
    expect(recommendation.applied_principles.length).toBeLessThan(guide.principles.length);
  });

  it("rejects a blank creative request", async () => {
    const guide = await loadStoryGuide();

    expect(() => recommendStoryFrameworks("   ", guide)).toThrowError(
      "creative request must not be blank"
    );
  });
});
