import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import { createPlan } from "../src/orchestrator/plan.js";
import {
  createReviewDocument,
  getReviewOpenCommand,
  inspectGate1Review,
  renderReviewHtml,
  writeCreativeReview
} from "../src/orchestrator/review.js";
import type { Project } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

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
  it("shows fail-closed audio requests in the Gate 1 review", () => {
    const project: Project = {
      ...sampleProject(),
      audio: {
        adapter: "hyperframes-media",
        fallback: "fail",
        bgm: {
          id: "bgm-main",
          prompt: "Warm restrained ambient music",
          start: 0,
          end: 10,
          volume: 0.2,
          mode: "generate"
        },
        sfx: [
          {
            id: "sfx-hit",
            prompt: "Soft transition hit",
            start: 4,
            volume: 0.5
          }
        ],
        params: { allow_cloud_bgm: false }
      }
    };
    const review = createReviewDocument(project, sampleManifest(), createPlan(project, sampleManifest()));
    const html = renderReviewHtml(review);

    expect(review.audio).toMatchObject({
      adapter: "hyperframes-media",
      fallback: "fail",
      automatic_fallback: false
    });
    expect(html).toContain('data-testid="audio-review"');
    expect(html).toContain("Warm restrained ambient music");
    expect(html).toContain("Soft transition hit");
    expect(html).toContain("AUTO FALLBACK");
    expect(html).toContain("OFF");
  });

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

  it("carries an explicit motion plan into review data and an HTML/CSS approximation", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.presentation!.motion_design = {
      summary: "木組みが噛み合うように、情報を順番に組み立てる",
      pacing: "前半は素早く、結論は静かに止める",
      principles: ["一度に動かす主役は一つ", "文字の可読性を優先"]
    };
    manifest.captions[0]!.visual!.motion = {
      entrance: {
        preset: "slide-left",
        label: "問いを差し込む",
        description: "見出しを左から短く入れて停止する",
        target: "headline",
        duration_seconds: 0.45,
        easing: "ease-out"
      },
      emphasis: {
        preset: "pulse",
        label: "キーワードを一度だけ強調",
        description: "問いかけの語だけを小さく拡大する",
        target: "keyword",
        duration_seconds: 0.3,
        easing: "ease-in-out"
      },
      implementation_notes: ["背景は固定し、テキストレイヤーだけを動かす"]
    };

    const plan = createPlan(project, manifest);
    plan.motion_review = {
      surface: "React / Remotion",
      method: "Reactコンポーネントをフレーム値、interpolate、springで制御",
      preview: "html-css-approximation"
    };
    const review = createReviewDocument(project, manifest, plan);
    const html = renderReviewHtml(review);

    expect(review.motion_design).toMatchObject({
      status: "declared",
      summary: "木組みが噛み合うように、情報を順番に組み立てる",
      pacing: "前半は素早く、結論は静かに止める",
      implementation: {
        backend: "remotion",
        surface: "React / Remotion",
        preview: "HTML / CSS approximation"
      }
    });
    expect(review.storyboard[0]?.motion?.cues).toEqual([
      expect.objectContaining({ phase: "entrance", preset: "slide-left", target: "headline" }),
      expect.objectContaining({ phase: "emphasis", preset: "pulse", target: "keyword" })
    ]);
    expect(html).toContain('data-testid="motion-design"');
    expect(html).toContain('data-motion-preset="slide-left"');
    expect(html).toContain("React / Remotion");
    expect(html).toContain("問いを差し込む");
    expect(html).toContain("HTML / CSSによる近似プレビュー");
  });

  it("shows an honest empty motion state when animation direction is not declared", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    const plan = createPlan(project, manifest);
    plan.motion_review = {
      surface: "React / Remotion",
      method: "Reactコンポーネントをフレーム値、interpolate、springで制御",
      preview: "html-css-approximation"
    };

    const review = createReviewDocument(project, manifest, plan);
    const html = renderReviewHtml(review);

    expect(review.motion_design).toMatchObject({
      status: "unspecified",
      implementation: { backend: "remotion", surface: "React / Remotion" }
    });
    expect(review.warnings).toContain("動き・アニメーション設計が未指定です。最終確認前に、全体方針またはカット別モーションを確認してください。");
    expect(html).toContain("個別モーションは未指定です");
    expect(html).not.toContain('data-motion-preset="undefined"');
  });

  it("uses a matching clip motion plan when a caption does not override it", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.clips[0]!.id = "s01";
    manifest.clips[0]!.motion = {
      entrance: {
        preset: "zoom-in",
        description: "映像レイヤーをゆっくり寄せる",
        target: "footage",
        duration_seconds: 1.2
      },
      implementation_notes: []
    };

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.storyboard[0]?.motion?.cues).toContainEqual(
      expect.objectContaining({ phase: "entrance", preset: "zoom-in", target: "footage" })
    );
  });

  it("uses the single clip motion plan when caption and clip ids differ", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.clips[0]!.motion = {
      entrance: {
        preset: "zoom-in",
        description: "背景映像をゆっくり寄せる",
        target: "footage",
        duration_seconds: 1.2
      },
      implementation_notes: []
    };

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.storyboard[0]?.motion?.cues).toContainEqual(
      expect.objectContaining({ phase: "entrance", preset: "zoom-in", target: "footage" })
    );
    expect(review.storyboard[1]?.motion?.cues).toContainEqual(
      expect.objectContaining({ phase: "entrance", preset: "zoom-in", target: "footage" })
    );
  });

  it("uses the motion plan from the clip covering the caption time range", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    delete manifest.captions[1]!.id;
    manifest.clips = [
      {
        ...manifest.clips[0]!,
        id: "clip-001",
        out: 4,
        duration: 4
      },
      {
        ...manifest.clips[0]!,
        id: "clip-002",
        src: "media/answer.mp4",
        in: 0,
        out: 6,
        duration: 6,
        motion: {
          entrance: {
            preset: "slide-right",
            description: "答えの映像を右から入れる",
            target: "footage",
            duration_seconds: 0.4
          },
          implementation_notes: []
        }
      }
    ];

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.storyboard[0]?.motion).toBeUndefined();
    expect(review.storyboard[1]?.motion?.cues).toContainEqual(
      expect.objectContaining({ phase: "entrance", preset: "slide-right", target: "footage" })
    );
  });

  it("shows an MCP generation connection as an agent handoff in Gate 1 review data", async () => {
    const validation = await validateProject("fixtures/projects/generation-connection-topview.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      undefined,
      [],
      undefined,
      validation.generationConnection
    );

    const review = createReviewDocument(validation.project!, validation.manifest!, plan);

    expect(review.handoffs[0]).toMatchObject({
      connection: "topview",
      transport: "mcp",
      provider: "topview",
      route_note: expect.stringContaining("TopView公式MCP"),
      setup_status: "needs-verification",
      automatic_fallback: false,
      execution: "pipeline-mcp"
    });
    const html = renderReviewHtml(review);
    expect(html).toContain("topview via MCP");
    expect(html).toContain("SETUP: NEEDS-VERIFICATION");
    expect(html).toContain("AUTO FALLBACK OFF");
    expect(review.warnings).toContain(
      "接続 'topview' の状態は needs-verification です。最終承認前にログイン、利用権限、残クレジットを確認してください。"
    );
  });

  it("invalidates Gate 1 when the reviewed connection route differs from the current registry", async () => {
    const configPath = "fixtures/projects/generation-connection-topview.yaml";
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    if (!validation.project || !validation.manifest) throw new Error("fixture project is invalid");
    validation.project.generation!.requests[0].input_mode = undefined;
    const plan = createPlan(
      validation.project,
      validation.manifest,
      validation.adapter,
      undefined,
      [],
      undefined,
      validation.generationConnection
    );
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-review-connection-snapshot-"));
    const outputDir = join(stateDir, validation.project.run_id!, "review");
    const written = await writeCreativeReview({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      plan,
      outputDir
    });
    const initial = await inspectGate1Review({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      stateDir
    });
    expect(initial.ok).toBe(true);

    const document = JSON.parse(await readFile(written.dataPath, "utf8"));
    document.handoffs[0].auth_kind = "api-key";
    await writeFile(written.dataPath, `${JSON.stringify(document, null, 2)}\n`);
    await writeFile(written.reviewPath, renderReviewHtml(document));

    const changed = await inspectGate1Review({
      configPath,
      project: validation.project,
      manifest: validation.manifest,
      stateDir
    });
    expect(changed.ok).toBe(false);
    expect(changed.issues).toContainEqual(expect.objectContaining({ code: "gate.connection_changed" }));
  });

  it("records audio connection verification status in the Gate 1 review", async () => {
    const validation = await validateProject("fixtures/projects/audio-connection.yaml");
    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      undefined,
      [],
      validation.audioAdapter,
      validation.generationConnection,
      validation.audioConnection
    );

    const review = createReviewDocument(validation.project!, validation.manifest!, plan);
    const html = renderReviewHtml(review);

    expect(review.handoffs).toContainEqual(expect.objectContaining({
      phase: "audio",
      connection: "hyperframes-media",
      setup_status: "needs-verification"
    }));
    expect(review.warnings).toContain(
      "接続 'hyperframes-media' の状態は needs-verification です。最終承認前にログイン、利用権限、残クレジットを確認してください。"
    );
    expect(html).toContain("hyperframes-media via CLI · SETUP: NEEDS-VERIFICATION");
  });

  it("shows the selected dialogue background as a dedicated Gate 1 review surface", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.images.push({
      id: "room-background",
      src: "media/room-background.png",
      alt: "木の壁と障子がある掛け合い用の部屋"
    });
    manifest.presentation!.background_image_id = "room-background";

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.background).toMatchObject({
      id: "room-background",
      src: "media/room-background.png",
      alt: "木の壁と障子がある掛け合い用の部屋"
    });
    review.background!.preview_src = "assets/002-room-background.png";
    const html = renderReviewHtml(review);
    expect(html).toContain('data-testid="background-review"');
    expect(html).toContain('src="assets/002-room-background.png"');
    expect(html).toContain('href="#background-title"');
    expect(html).toContain("背景・舞台");
  });

  it("uses an explicit caption visual image for the storyboard frame", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.images.push({
      id: "shot-preview",
      src: "media/storyboard/shot-01.png",
      alt: "実際のRemotion構図から書き出した縦型プレビュー"
    });
    manifest.captions[0]!.visual!.image_id = "shot-preview";

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.storyboard[0]!.image).toMatchObject({
      id: "shot-preview",
      src: "media/storyboard/shot-01.png"
    });
  });

  it("marks a vertical review with the 9:16 aspect", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.meta.aspect = "9:16";

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));
    const html = renderReviewHtml(review);

    expect(html).toContain('data-aspect="9:16"');
  });

  it("warns when the selected background image id is not present", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.presentation!.background_image_id = "missing-background";

    const review = createReviewDocument(project, manifest, createPlan(project, manifest));

    expect(review.warnings).toContain(
      "背景画像ID missing-background が manifest.images に見つかりません。"
    );
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

  it("renders an editing-desk layout with clear review navigation and decision context", () => {
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.presentation!.title = "OpenClawの始め方";

    const html = renderReviewHtml(
      createReviewDocument(project, manifest, createPlan(project, manifest))
    );

    expect(html).toContain('class="review-nav"');
    expect(html).toContain('aria-label="レビュー内ナビゲーション"');
    expect(html).toContain('href="#storyboard-title"');
    expect(html).toContain('href="#characters-title"');
    expect(html).toContain('href="#decision-title"');
    expect(html).toContain('class="screening-room"');
    expect(html).toContain('class="film-strip"');
    expect(html).toContain('class="shot-index"');
    expect(html).not.toContain('aria-label="Gate 1 承認待ち"');
    expect(html).toContain('data-testid="review-progress"');
    expect(html).toContain('data-testid="gate-1-final-decision"');
    expect(html.match(/Gate 1/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="gate-1-final-decision"')).toBeGreaterThan(
      html.indexOf('id="conditions-title"')
    );
    expect(html).toContain('data-design="joinery-review"');
    expect(html).toContain('data-material="hinoki-yakisugi"');
    expect(html).toContain('data-aspect="16:9"');
    expect(html).toContain('main[data-aspect="9:16"] .frame{aspect-ratio:9/16}');
    expect(html).toContain('class="joinery-mark"');
    expect(html).toContain('class="hero-joinery"');
    expect(html).toContain("継ぎ手絵コンテ / JOINERY SEQUENCE");
    expect(html).toContain("--yakisugi:#171b18");
    expect(html).toContain("--urushi:#a63d2f");
    expect(html).toContain("映像制作の事前確認");
    expect(html).toContain("<h1>OpenClaw<wbr>の始め方</h1>");
  });

  it("writes deterministic review artifacts and stages only referenced manifest images", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-review-"));
    await mkdir(join(root, "media"));
    await writeFile(join(root, "project.yaml"), "placeholder\n");
    await writeFile(join(root, "manifest.json"), "{}\n");
    await writeFile(join(root, "media/musuhi.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "media/room-background.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "media/unreferenced.png"), Buffer.from([1, 2, 3]));
    const project = sampleProject();
    const manifest = sampleManifest();
    manifest.images.push({
      id: "room-background",
      src: "media/room-background.png",
      alt: "掛け合い用の背景"
    });
    manifest.presentation!.background_image_id = "room-background";
    manifest.images.push({ id: "unused", src: "media/unreferenced.png" });
    const outputDir = join(root, "custom-review");

    const result = await writeCreativeReview({
      configPath: join(root, "project.yaml"),
      project,
      manifest,
      plan: createPlan(project, manifest),
      outputDir
    });

    expect(result.assetCount).toBe(2);
    expect(JSON.parse(await readFile(result.dataPath, "utf8")).schema_version).toBe(1);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("assets/001-musuhi.png");
    expect(html).toContain("assets/002-room-background.png");
    expect(html).toContain('data-testid="background-review"');
    expect(html).not.toContain('aria-label="まず、問いを置くの構成ワイヤー"');
    expect(html).not.toContain("&lt;project.yaml&gt;");
    await expect(stat(join(outputDir, "assets/001-musuhi.png"))).resolves.toBeDefined();
    await expect(stat(join(outputDir, "assets/002-unreferenced.png"))).rejects.toThrow();
    await expect(stat(join(root, "dist/creative-review-run/state.json"))).rejects.toThrow();
  });

  it("stages a generation first_frame from the project directory for Gate 1 review", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-review-generation-image-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "project.yaml"), "placeholder\n");
    await writeFile(join(root, "manifest.json"), "{}\n");
    await writeFile(join(root, "assets/opening.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "assets/character-front.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "assets/character-side.png"), Buffer.from([137, 80, 78, 71]));
    const project = sampleProject();
    project.generation!.requests[0] = {
      ...project.generation!.requests[0],
      mode: "image-to-video",
      input_mode: undefined,
      first_frame: "assets/opening.png",
      reference_images: ["assets/character-front.png", "assets/character-side.png"]
    };
    const manifest = sampleManifest();
    manifest.captions = [];
    manifest.images = [];

    const result = await writeCreativeReview({
      configPath: join(root, "project.yaml"),
      project,
      manifest,
      plan: createPlan(project, manifest),
      outputDir: join(root, "review")
    });

    const data = JSON.parse(await readFile(result.dataPath, "utf8"));
    expect(result.assetCount).toBe(3);
    expect(data.storyboard[0].image).toMatchObject({
      src: "assets/opening.png",
      preview_src: "assets/001-opening.png"
    });
    expect(data.storyboard[0].reference_images).toEqual([
      expect.objectContaining({
        src: "assets/character-front.png",
        preview_src: "assets/002-character-front.png"
      }),
      expect.objectContaining({
        src: "assets/character-side.png",
        preview_src: "assets/003-character-side.png"
      })
    ]);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("外部送信する参照画像");
    expect(html).toContain('data-testid="reference-images-s01"');
    await expect(stat(join(root, "review/assets/001-opening.png"))).resolves.toBeDefined();
    await expect(stat(join(root, "review/assets/002-character-front.png"))).resolves.toBeDefined();
    await expect(stat(join(root, "review/assets/003-character-side.png"))).resolves.toBeDefined();
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
    expect(getReviewOpenCommand("C:\\review\\index.html", "win32")).toEqual({
      command: "explorer.exe",
      args: ["C:\\review\\index.html"]
    });
  });
});
