import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import { createPlan } from "../src/orchestrator/plan.js";
import {
  createReviewDocument,
  getReviewOpenCommand,
  renderReviewHtml,
  writeCreativeReview
} from "../src/orchestrator/review.js";
import type { Project } from "../src/project/schema.js";

function sampleProject(): Project {
  return {
    slug: "creative-review",
    run_id: "creative-review-run",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    generation: {
      adapter: "mock-cli",
      requests: [
        {
          id: "s01",
          prompt: "A curious character asks a question",
          model: "video-model",
          duration: 4,
          aspect: "16:9",
          input_mode: "image-to-video",
          params: {}
        }
      ]
    }
  };
}

function sampleManifest(): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 10,
      slug: "creative-review"
    },
    clips: [
      {
        id: "background",
        src: "media/background.mp4",
        in: 0,
        out: 10,
        duration: 10,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: false
      }
    ],
    images: [
      { id: "musuhi-neutral", src: "media/musuhi.png", alt: "むすひのニュートラルポーズ" }
    ],
    speakers: [
      {
        id: "musuhi",
        display_name: "むすひ",
        side: "left",
        accent: "#176b87",
        poses: { neutral: "musuhi-neutral", curious: "musuhi-neutral" }
      }
    ],
    presentation: { preset: "dialogue", title: "クリエイティブ提案", draft: true },
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [
      {
        id: "s01",
        speaker: "musuhi",
        text: "最初の問いかけ",
        start: 0,
        end: 4,
        pose: "curious",
        emphasis: ["問いかけ"],
        visual: { kicker: "HOOK", headline: "まず、問いを置く", badges: ["導入"] }
      },
      {
        id: "s02",
        speaker: "musuhi",
        text: "次に答えを見せる",
        start: 4,
        end: 10,
        pose: "neutral",
        emphasis: [],
        visual: { headline: "答えを見せる", badges: [] }
      }
    ],
    chapters: [{ title: "導入", start: 0, end: 4 }],
    provenance: []
  };
}

describe("creative review", () => {
  it("derives a character sheet and caption-first storyboard without mutating the plan", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    const plan = createPlan(project, manifest);
    const before = JSON.stringify(plan);

    const review = createReviewDocument(project, manifest, plan);

    expect(review.schema_version).toBe(1);
    expect(review.summary).toMatchObject({
      title: "クリエイティブ提案",
      gate: "gate-1",
      target_duration_seconds: 10,
      storyboard_duration_seconds: 10
    });
    expect(review.characters[0]).toMatchObject({ id: "musuhi", display_name: "むすひ" });
    expect(review.characters[0].poses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "curious", image_id: "musuhi-neutral" })
      ])
    );
    expect(review.storyboard).toHaveLength(2);
    expect(review.storyboard[0]).toMatchObject({
      id: "s01",
      order: 1,
      start: 0,
      end: 4,
      prompt: "A curious character asks a question",
      image: expect.objectContaining({ id: "musuhi-neutral" })
    });
    expect(review.storyboard[1].prompt).toBeUndefined();
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("falls back to clips and reports missing character definitions", () => {
    const project = sampleProject();
    delete project.generation;
    const manifest = sampleManifest();
    manifest.captions = [];
    manifest.speakers = [];
    manifest.images = [];

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.storyboard).toEqual([
      expect.objectContaining({ id: "background", start: 0, end: 10, duration: 10 })
    ]);
    expect(review.warnings).toContain("この計画にはキャラクター定義がありません。");
  });

  it("escapes untrusted copy and emits an offline content security policy", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.presentation!.title = "</style><img src=x onerror=alert(1)>";
    manifest.captions[0].text = "<script>alert(1)</script>";

    const html = renderReviewHtml(
      createReviewDocument(project, manifest, createPlan(project, manifest))
    );

    expect(html).toContain("default-src &#39;none&#39;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("data-testid=\"storyboard-sheet\"");
    expect(html).toContain("@media print");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("writes deterministic review artifacts and stages only referenced manifest images", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-review-"));
    await mkdir(join(root, "media"));
    await writeFile(join(root, "project.yaml"), "placeholder\n");
    await writeFile(join(root, "manifest.json"), "{}\n");
    await writeFile(join(root, "media/musuhi.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "media/unreferenced.png"), Buffer.from([1, 2, 3]));
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.images.push({ id: "unused", src: "media/unreferenced.png" });
    const outputDir = join(root, "custom-review");

    const result = await writeCreativeReview({
      configPath: join(root, "project.yaml"),
      project,
      manifest,
      plan: createPlan(project, manifest),
      outputDir
    });

    expect(result.assetCount).toBe(1);
    expect(JSON.parse(await readFile(result.dataPath, "utf8")).schema_version).toBe(1);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("assets/001-musuhi.png");
    expect(html).not.toContain('aria-label="まず、問いを置くの構成ワイヤー"');
    expect(html).not.toContain("&lt;project.yaml&gt;");
    await expect(stat(join(outputDir, "assets/001-musuhi.png"))).resolves.toBeDefined();
    await expect(stat(join(outputDir, "assets/002-unreferenced.png"))).rejects.toThrow();
    await expect(stat(join(root, "dist/creative-review-run/state.json"))).rejects.toThrow();
  });

  it("maps explicit open requests without executing them", () => {
    expect(getReviewOpenCommand("/tmp/review/index.html", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/review/index.html"]
    });
    expect(getReviewOpenCommand("/tmp/review/index.html", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/review/index.html"]
    });
  });
});
