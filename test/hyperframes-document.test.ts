import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import { renderIndexHtml } from "../backends/hyperframes/document.mjs";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";

type Manifest = Record<string, unknown>;

function baseManifest(presentation?: Record<string, unknown>): Manifest {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 10, slug: "hf-test" },
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
    images: [],
    speakers: [],
    audio: { bgm: [], narration: [], sfx: [] },
    ...(presentation ? { presentation } : {}),
    captions: [
      {
        id: "s01",
        text: "8割、消したんだって",
        emphasis: ["8割"],
        start: 0,
        end: 4,
        visual: { kicker: "ANTHROPIC 公式", headline: "80%以上、削除", detail: "評価に低下はなかった", badges: ["出典あり"] }
      },
      {
        id: "s02",
        text: "3つの転換がある",
        start: 4,
        end: 10,
        visual: {
          kicker: "TURN",
          headline: "Then → Now",
          steps: ["ルールで縛る → 判断に委ねる", "例を与える → 設計する"],
          badges: []
        }
      }
    ]
  };
}

describe("hyperframes document", () => {
  it("keeps the plain document for manifests that declare no theme", () => {
    const html = renderIndexHtml(baseManifest());

    expect(html).toContain("background: #050505");
    expect(html).toContain('class="clip caption"');
    // The themed layers must not appear for existing untouched projects.
    expect(html).not.toContain('data-role="headline"');
    expect(html).not.toContain("#F0EEE6");
  });

  it("renders the themed visual layers when a theme is declared", () => {
    const html = renderIndexHtml(baseManifest({ preset: "article-explainer", theme: "claude" }));

    expect(html).toContain("#F0EEE6");
    expect(html).toContain('data-role="headline"');
    expect(html).toContain("80%以上、削除");
    expect(html).toContain("ANTHROPIC 公式");
    expect(html).toContain("評価に低下はなかった");
    expect(html).toContain("出典あり");
    expect(html).toContain("ルールで縛る → 判断に委ねる");
  });

  it("gives every timed visual layer the attributes the HyperFrames runtime needs", () => {
    const html = renderIndexHtml(baseManifest({ theme: "claude" }));
    const cards = [...html.matchAll(/<div[^>]*class="clip visual"[^>]*>/g)].map((match) => match[0]);

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toMatch(/data-start="[\d.]+"/);
      expect(card).toMatch(/data-duration="[\d.]+"/);
      expect(card).toMatch(/data-track-index="\d+"/);
    }
    expect(cards[0]).toContain('data-start="0"');
    expect(cards[0]).toContain('data-duration="4"');
    expect(cards[1]).toContain('data-start="4"');
    expect(cards[1]).toContain('data-duration="6"');
  });

  it("declares every themed font family so the renderer does not silently fall back", () => {
    const html = renderIndexHtml(baseManifest({ theme: "claude" }));

    // HyperFrames lint fails the render unless each named family is declared.
    for (const family of ["Hiragino Sans", "Yu Gothic", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP"]) {
      expect(html).toContain(`@font-face { font-family: "${family}"; src: local("${family}"); }`);
    }
    // Generic keywords are not families and must not be declared.
    expect(html).not.toContain('local("sans-serif")');
    expect(html).not.toContain('local("serif")');
  });

  it("never references an external asset, in either mode", () => {
    for (const manifest of [baseManifest(), baseManifest({ theme: "claude" })]) {
      const html = renderIndexHtml(manifest);
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toContain("//cdn.");
    }
  });

  it("escapes caption and visual text so authored copy cannot inject markup", () => {
    const manifest = baseManifest({ theme: "claude" }) as {
      captions: Array<{ text: string; visual: { headline: string } }>;
    };
    manifest.captions[0].text = '<img src=x onerror="alert(1)">';
    manifest.captions[0].visual.headline = "<script>alert(2)</script>";

    const html = renderIndexHtml(manifest);

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x");
  });

  it("marks emphasis inside the caption bar instead of dropping it", () => {
    const html = renderIndexHtml(baseManifest({ theme: "claude" }));
    expect(html).toContain('<em class="emphasis">8割</em>');
  });

  it("keeps the caption on one inline run so emphasis cannot break onto its own column", () => {
    const html = renderIndexHtml(baseManifest({ theme: "claude" }));
    // The caption box is a flex container; bare text nodes beside <em> would each
    // become their own flex item and sit side by side instead of reading as a sentence.
    const caption = html.match(/<div id="s01" class="clip caption"[^>]*>(.*?)<\/div>/s);
    expect(caption?.[1]).toMatch(/^<span class="line">.*<\/span>$/s);
  });
});

describe("hyperframes preset registration", () => {
  it("declares the themed explainer presets so a themed manifest validates", async () => {
    const backend = await loadBackendCapabilities("hyperframes");
    expect(backend?.capabilities.presets).toContain("article-explainer-16x9");
    expect(backend?.capabilities.presets).toContain("article-explainer-9x16");
  });
});
