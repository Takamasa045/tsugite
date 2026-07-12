import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Result } from "../types.js";
import type { ExecutionPlan } from "./plan.js";

type ReviewAsset = {
  id: string;
  src: string;
  alt?: string;
  preview_src?: string;
};

export type ReviewCharacter = {
  id: string;
  display_name: string;
  side: "left" | "right";
  accent: string;
  poses: Array<{
    name: string;
    image_id: string;
    asset?: ReviewAsset;
  }>;
};

export type ReviewShot = {
  id: string;
  order: number;
  start: number;
  end: number;
  duration: number;
  kicker?: string;
  title: string;
  description?: string;
  speaker?: string;
  pose?: string;
  emphasis: string[];
  badges: string[];
  chapter?: string;
  image?: ReviewAsset;
  prompt?: string;
  model?: string;
  input_mode?: string;
};

export type ReviewDocument = {
  schema_version: 1;
  run_id: string;
  slug: string;
  summary: {
    title: string;
    source_title?: string;
    aspect: "16:9" | "9:16";
    target_duration_seconds: number;
    storyboard_duration_seconds: number;
    total_clip_duration_seconds: number;
    backend: string;
    estimated_credits: number;
    draft: boolean;
    gate: "gate-1";
  };
  characters: ReviewCharacter[];
  storyboard: ReviewShot[];
  handoffs: ExecutionPlan["agent_handoffs"];
  prompt_guidance: NonNullable<ExecutionPlan["prompt_guidance"]>;
  steps: ExecutionPlan["steps"];
  warnings: string[];
  approval_commands: {
    approve: string;
    revise: string;
    abort: string;
  };
};

type WriteCreativeReviewOptions = {
  configPath: string;
  project: Project;
  manifest: Manifest;
  plan: ExecutionPlan;
  outputDir?: string;
  stateDir?: string;
};

export type CreativeReviewResult = {
  reviewPath: string;
  dataPath: string;
  outputDir: string;
  assetCount: number;
};

export function getCreativeReviewDir(configPath: string, project: Project, stateDir?: string): string {
  const resolvedStateDir = stateDir
    ? resolve(stateDir)
    : resolve(dirname(resolve(configPath)), project.dist_dir);
  return resolve(resolvedStateDir, project.run_id ?? project.slug, "review");
}

export async function inspectGate1Review(options: {
  configPath: string;
  project: Project;
  stateDir?: string;
}): Promise<Result<{ reviewPath: string; dataPath: string }>> {
  const outputDir = getCreativeReviewDir(options.configPath, options.project, options.stateDir);
  const reviewPath = resolve(outputDir, "index.html");
  const dataPath = resolve(outputDir, "review-data.json");
  const [hasReview, hasData] = await Promise.all([isFile(reviewPath), isFile(dataPath)]);

  if (!hasReview || !hasData) {
    const stateArgument = options.stateDir ? ` --state-dir ${options.stateDir}` : "";
    return {
      ok: false,
      issues: [
        {
          code: "gate.review_required",
          message: `Gate 1 requires a storyboard review. Run 'bin/pipeline review --config ${options.configPath}${stateArgument} --open --json', inspect the HTML, then approve Gate 1.`,
          path: hasReview ? dataPath : reviewPath
        }
      ],
      reviewPath,
      dataPath
    };
  }

  try {
    const [html, dataText] = await Promise.all([readFile(reviewPath, "utf8"), readFile(dataPath, "utf8")]);
    const data = JSON.parse(dataText) as unknown;
    if (!isReviewDocumentForProject(data, options.project)) {
      return {
        ok: false,
        issues: [
          {
            code: "gate.review_invalid",
            message: "Gate 1 review-data.json is not a valid review for this project.",
            path: dataPath
          }
        ],
        reviewPath,
        dataPath
      };
    }
    if (!html.includes('data-testid="storyboard-sheet"')) {
      return {
        ok: false,
        issues: [
          {
            code: "gate.review_invalid",
            message: "Gate 1 review HTML does not contain the storyboard sheet.",
            path: reviewPath
          }
        ],
        reviewPath,
        dataPath
      };
    }
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "gate.review_invalid",
          message: `Gate 1 review artifacts could not be read: ${error instanceof Error ? error.message : String(error)}`,
          path: dataPath
        }
      ],
      reviewPath,
      dataPath
    };
  }

  return { ok: true, issues: [], reviewPath, dataPath };
}

export function createReviewDocument(
  project: Project,
  manifest: Manifest,
  plan: ExecutionPlan
): ReviewDocument {
  const images = new Map(manifest.images.map((image) => [image.id, image]));
  const speakers = new Map(manifest.speakers.map((speaker) => [speaker.id, speaker]));
  const generationRequests = new Map(
    (project.generation?.requests ?? []).map((request) => [request.id, request])
  );
  const characters = manifest.speakers.map((speaker) => ({
    id: speaker.id,
    display_name: speaker.display_name,
    side: speaker.side,
    accent: speaker.accent,
    poses: Object.entries(speaker.poses).map(([name, imageId]) => ({
      name,
      image_id: imageId,
      asset: toReviewAsset(images.get(imageId))
    }))
  }));

  const storyboard = manifest.captions.length > 0
    ? manifest.captions.map((caption, index) => {
        const id = caption.id ?? `caption-${String(index + 1).padStart(2, "0")}`;
        const speaker = caption.speaker ? speakers.get(caption.speaker) : undefined;
        const imageId = speaker && caption.pose ? speaker.poses[caption.pose] : undefined;
        const request = generationRequests.get(id);
        const chapter = manifest.chapters.find(
          (candidate) => caption.start >= candidate.start && caption.start < candidate.end
        );
        return {
          id,
          order: index + 1,
          start: caption.start,
          end: caption.end,
          duration: caption.end - caption.start,
          kicker: caption.visual?.kicker,
          title: caption.visual?.headline ?? caption.text,
          description: caption.text,
          speaker: speaker?.display_name ?? caption.speaker,
          pose: caption.pose,
          emphasis: caption.emphasis,
          badges: caption.visual?.badges ?? [],
          chapter: chapter?.title,
          image: imageId ? toReviewAsset(images.get(imageId)) : undefined,
          prompt: request?.prompt,
          model: request?.model,
          input_mode: request?.input_mode
        } satisfies ReviewShot;
      })
    : createFallbackStoryboard(project, manifest, images);

  const storyboardDuration = storyboard.reduce((maximum, shot) => Math.max(maximum, shot.end), 0);
  const title = manifest.presentation?.title ?? manifest.presentation?.source_title ?? project.slug;
  const configPlaceholder = "<project.yaml>";
  const gateBase = `bin/pipeline gate --config ${configPlaceholder} --actor coordinator --gate gate-1`;
  const warnings: string[] = [];
  if (characters.length === 0) warnings.push("この計画にはキャラクター定義がありません。");
  if (storyboard.every((shot) => !shot.image)) {
    warnings.push("絵コンテに使用できる静止画がないため、構成ワイヤーを表示しています。");
  }
  if (manifest.presentation?.draft) warnings.push("この提案はドラフトとしてマークされています。");
  if (Math.abs(storyboardDuration - manifest.meta.target_duration_seconds) > 0.01) {
    warnings.push(
      `絵コンテ尺 ${formatSeconds(storyboardDuration)} と目標尺 ${formatSeconds(manifest.meta.target_duration_seconds)} が一致していません。`
    );
  }
  const storyboardIds = new Set(storyboard.map((shot) => shot.id));
  const unmatchedRequests = [...generationRequests.keys()].filter((id) => !storyboardIds.has(id));
  if (unmatchedRequests.length > 0 && manifest.captions.length > 0) {
    warnings.push(`絵コンテとIDが一致しない生成リクエスト: ${unmatchedRequests.join(", ")}`);
  }

  return {
    schema_version: 1,
    run_id: project.run_id ?? project.slug,
    slug: project.slug,
    summary: {
      title,
      source_title: manifest.presentation?.source_title,
      aspect: manifest.meta.aspect,
      target_duration_seconds: manifest.meta.target_duration_seconds,
      storyboard_duration_seconds: storyboardDuration,
      total_clip_duration_seconds: plan.total_clip_duration_seconds,
      backend: plan.backend,
      estimated_credits: plan.estimated_credits,
      draft: manifest.presentation?.draft ?? false,
      gate: "gate-1"
    },
    characters,
    storyboard,
    handoffs: plan.agent_handoffs,
    prompt_guidance: plan.prompt_guidance ?? [],
    steps: plan.steps,
    warnings,
    approval_commands: {
      approve: `${gateBase} --decision approve --json`,
      revise: `${gateBase} --decision revise --json`,
      abort: `${gateBase} --decision abort --json`
    }
  };
}

function createFallbackStoryboard(
  project: Project,
  manifest: Manifest,
  images: Map<string, Manifest["images"][number]>
): ReviewShot[] {
  if ((project.generation?.requests.length ?? 0) > 0) {
    let cursor = 0;
    return project.generation!.requests.map((request, index) => {
      const start = cursor;
      cursor += request.duration;
      return {
        id: request.id,
        order: index + 1,
        start,
        end: cursor,
        duration: request.duration,
        title: request.id,
        description: request.prompt,
        emphasis: [],
        badges: [],
        prompt: request.prompt,
        model: request.model,
        input_mode: request.input_mode
      };
    });
  }

  let cursor = 0;
  return manifest.clips.map((clip, index) => {
    const start = cursor;
    cursor += clip.duration;
    const matchingImage = images.get(clip.id);
    return {
      id: clip.id,
      order: index + 1,
      start,
      end: cursor,
      duration: clip.duration,
      title: clip.id,
      description: clip.src,
      emphasis: [],
      badges: [],
      image: toReviewAsset(matchingImage)
    };
  });
}

function toReviewAsset(image: Manifest["images"][number] | undefined): ReviewAsset | undefined {
  if (!image) return undefined;
  return { id: image.id, src: image.src, alt: image.alt };
}

export async function writeCreativeReview(
  options: WriteCreativeReviewOptions
): Promise<CreativeReviewResult> {
  const configPath = resolve(options.configPath);
  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : getCreativeReviewDir(configPath, options.project, options.stateDir);
  const assetsDir = resolve(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  const document = createReviewDocument(options.project, options.manifest, options.plan);
  const configArgument = shellQuote(relative(process.cwd(), configPath) || configPath);
  document.approval_commands = {
    approve: document.approval_commands.approve.replace("<project.yaml>", configArgument),
    revise: document.approval_commands.revise.replace("<project.yaml>", configArgument),
    abort: document.approval_commands.abort.replace("<project.yaml>", configArgument)
  };
  const referencedAssets = collectReferencedAssets(document);
  const manifestPath = resolve(dirname(configPath), options.project.manifest);
  const manifestDir = dirname(manifestPath);
  const assetRoot = options.project.manifest.startsWith("../")
    ? resolve(dirname(configPath), "..")
    : dirname(configPath);
  const realAssetRoot = await realpath(assetRoot);
  const stagedBySource = new Map<string, string>();

  for (const asset of referencedAssets) {
    if (isExternalAsset(asset.src)) continue;
    let previewSrc = stagedBySource.get(asset.src);
    if (!previewSrc) {
      const sourcePath = await realpath(resolve(manifestDir, asset.src));
      if (!isPathWithin(realAssetRoot, sourcePath)) {
        throw new Error(`review asset escapes project root: ${asset.src}`);
      }
      const assetNumber = String(stagedBySource.size + 1).padStart(3, "0");
      const filename = `${assetNumber}-${safeBasename(basename(asset.src))}`;
      await copyFile(sourcePath, resolve(assetsDir, filename));
      previewSrc = `assets/${filename}`;
      stagedBySource.set(asset.src, previewSrc);
    }
    asset.preview_src = previewSrc;
  }

  const reviewPath = resolve(outputDir, "index.html");
  const dataPath = resolve(outputDir, "review-data.json");
  await writeFile(dataPath, `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(reviewPath, renderReviewHtml(document));

  return {
    reviewPath,
    dataPath,
    outputDir,
    assetCount: stagedBySource.size
  };
}

function collectReferencedAssets(document: ReviewDocument): ReviewAsset[] {
  return [
    ...document.characters.flatMap((character) => character.poses.flatMap((pose) => pose.asset ?? [])),
    ...document.storyboard.flatMap((shot) => shot.image ?? [])
  ];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isReviewDocumentForProject(value: unknown, project: Project): boolean {
  if (!value || typeof value !== "object") return false;
  const document = value as {
    schema_version?: unknown;
    run_id?: unknown;
    slug?: unknown;
    storyboard?: unknown;
    summary?: { gate?: unknown };
  };
  return (
    document.schema_version === 1 &&
    document.run_id === (project.run_id ?? project.slug) &&
    document.slug === project.slug &&
    document.summary?.gate === "gate-1" &&
    Array.isArray(document.storyboard) &&
    document.storyboard.length > 0
  );
}

function isExternalAsset(src: string): boolean {
  return /^(?:[a-z]+:|\/)/i.test(src) || src.includes("\\");
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function safeBasename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
  return sanitized || "asset";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function getReviewOpenCommand(
  reviewPath: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [reviewPath] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", reviewPath] };
  return { command: "xdg-open", args: [reviewPath] };
}

export async function openCreativeReview(reviewPath: string): Promise<void> {
  const target = getReviewOpenCommand(reviewPath);
  await promisify(execFile)(target.command, target.args);
}

export function renderReviewHtml(document: ReviewDocument): string {
  const maxShotDuration = Math.max(...document.storyboard.map((shot) => shot.duration), 1);
  const warnings = document.warnings.length > 0
    ? `<section class="warnings" aria-labelledby="warnings-title"><h2 id="warnings-title">確認ポイント</h2><ul>${document.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";
  const storyboard = document.storyboard.map((shot) => {
    const image = shot.image?.preview_src
      ? `<img src="${escapeAttribute(shot.image.preview_src)}" alt="${escapeAttribute(shot.image.alt ?? `${shot.title}の絵コンテ`)}">`
      : `<div class="wireframe" role="img" aria-label="${escapeAttribute(`${shot.title}の構成ワイヤー`)}"><span>${escapeHtml(shot.speaker ?? "VISUAL")}</span><strong>${escapeHtml(shot.title)}</strong></div>`;
    const barWidth = Math.max(12, (shot.duration / maxShotDuration) * 100);
    return `<figure class="shot" id="shot-${escapeAttribute(shot.id)}">
      <div class="shot-meta"><span>SHOT ${String(shot.order).padStart(2, "0")}</span><time>${formatTime(shot.start)}–${formatTime(shot.end)}</time></div>
      <div class="frame">${image}</div>
      <figcaption><small>${escapeHtml(shot.kicker ?? shot.chapter ?? "STORYBOARD")}</small><strong>${escapeHtml(shot.title)}</strong><p>${escapeHtml(shorten(shot.description ?? "構成を確認してください。", 72))}</p></figcaption>
      <div class="duration-track" aria-label="尺 ${formatSeconds(shot.duration)}"><span style="width:${barWidth.toFixed(2)}%"></span><b>${formatSeconds(shot.duration)}</b></div>
    </figure>`;
  }).join("");
  const characters = document.characters.length > 0
    ? document.characters.map((character) => {
        const representative = character.poses.find((pose) => pose.asset?.preview_src) ?? character.poses[0];
        const image = representative?.asset?.preview_src
          ? `<img src="${escapeAttribute(representative.asset.preview_src)}" alt="${escapeAttribute(representative.asset.alt ?? character.display_name)}">`
          : `<div class="character-placeholder" aria-label="参照画像なし">NO IMAGE</div>`;
        return `<article class="character-card" style="--character-accent:${safeColor(character.accent)}"><div class="character-image">${image}</div><div><p class="eyebrow">${character.side === "left" ? "画面左" : "画面右"}</p><h3>${escapeHtml(character.display_name)}</h3><ul class="pose-list">${character.poses.map((pose) => `<li>${escapeHtml(pose.name)}${pose.asset ? "" : " · 画像未設定"}</li>`).join("")}</ul></div></article>`;
      }).join("")
    : `<p class="empty">この計画にはキャラクター定義がありません。</p>`;
  const details = document.storyboard.map((shot) => `<details class="shot-detail" id="detail-${escapeAttribute(shot.id)}"><summary><span>SHOT ${String(shot.order).padStart(2, "0")}</span>${escapeHtml(shot.title)}<time>${formatSeconds(shot.duration)}</time></summary><div class="detail-grid"><div><h3>内容</h3><p>${escapeHtml(shot.description ?? "説明はありません。")}</p>${shot.speaker ? `<p><b>話者</b> ${escapeHtml(shot.speaker)}${shot.pose ? ` / ${escapeHtml(shot.pose)}` : ""}</p>` : ""}</div><div><h3>生成条件</h3>${shot.prompt ? `<p>${escapeHtml(shot.prompt)}</p><p class="utility">${escapeHtml([shot.model, shot.input_mode].filter(Boolean).join(" · "))}</p>` : `<p class="muted">このカットに一致する生成リクエストはありません。</p>`}</div></div></details>`).join("");
  const handoffs = document.handoffs.length > 0
    ? document.handoffs.map((handoff) => `<li><b>${escapeHtml(handoff.phase)}</b> ${escapeHtml(handoff.adapter)} · ${escapeHtml(handoff.execution)}</li>`).join("")
    : "<li>外部エージェントへの引き継ぎはありません。</li>";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src &#39;self&#39; data:; style-src &#39;unsafe-inline&#39;;">
  <title>${escapeHtml(document.summary.title)} · Creative Review</title>
  <style>${reviewStyles()}</style>
</head>
<body>
  <a class="skip-link" href="#main">内容へ移動</a>
  <main id="main">
    <header class="hero">
      <div><p class="eyebrow">TSUGITE / CREATIVE REVIEW</p><h1>${escapeHtml(document.summary.title)}</h1><p>生成前に、全体の流れとキャラクターの一貫性を確認します。</p></div>
      <div class="gate-stamp"><span>AWAITING</span><strong>Gate 1</strong><small>人間の承認が必要</small></div>
    </header>
    <dl class="metrics">
      <div><dt>目標尺</dt><dd>${formatSeconds(document.summary.target_duration_seconds)}</dd></div>
      <div><dt>絵コンテ尺</dt><dd>${formatSeconds(document.summary.storyboard_duration_seconds)}</dd></div>
      <div><dt>画面比率</dt><dd>${escapeHtml(document.summary.aspect)}</dd></div>
      <div><dt>推定credits</dt><dd>${formatNumber(document.summary.estimated_credits)}</dd></div>
      <div><dt>編集backend</dt><dd>${escapeHtml(document.summary.backend)}</dd></div>
    </dl>
    ${warnings}
    <section aria-labelledby="storyboard-title">
      <div class="section-heading"><div><p class="eyebrow">SEQUENCE FIRST</p><h2 id="storyboard-title">一枚絵コンテ</h2></div><p>左上から時間順。下端の帯がカットの相対的な長さを示します。</p></div>
      <div class="storyboard" data-testid="storyboard-sheet">${storyboard}</div>
    </section>
    <section aria-labelledby="characters-title">
      <div class="section-heading"><div><p class="eyebrow">CONTINUITY</p><h2 id="characters-title">キャラクターシート</h2></div><p>表情と役割を生成前に固定します。</p></div>
      <div class="characters">${characters}</div>
    </section>
    <div class="review-layout">
      <section aria-labelledby="details-title"><div class="section-heading"><div><p class="eyebrow">SHOT NOTES</p><h2 id="details-title">カット詳細</h2></div></div>${details}</section>
      <aside class="decision" aria-labelledby="decision-title"><p class="eyebrow">HUMAN DECISION</p><h2 id="decision-title">判断する</h2><p>このHTMLから状態は変更されません。Coordinatorが内容を確認して実行します。</p><label>承認</label><code>${escapeHtml(document.approval_commands.approve)}</code><label>修正へ戻す</label><code>${escapeHtml(document.approval_commands.revise)}</code><label>中止</label><code>${escapeHtml(document.approval_commands.abort)}</code></aside>
    </div>
    <section class="conditions" aria-labelledby="conditions-title"><div class="section-heading"><div><p class="eyebrow">PRODUCTION</p><h2 id="conditions-title">制作条件</h2></div></div><ul>${handoffs}</ul><p>プロンプトガイド: ${document.prompt_guidance.length}件 / 工程: ${document.steps.length}段階</p></section>
    <footer><span>${escapeHtml(document.run_id)}</span><span>ReviewDocument v${document.schema_version}</span></footer>
  </main>
</body>
</html>
`;
}

function reviewStyles(): string {
  return `
:root{color-scheme:light;--canvas:#e8edf1;--panel:#fff;--ink:#17212b;--muted:#5b6874;--rule:#b9c4cc;--accent:#176b87;--approve:#1f6b4f;--warn:#9a5a12;--danger:#a33a3a;font-family:"Hiragino Sans","Yu Gothic",system-ui,sans-serif;line-height:1.6;color:var(--ink);background:var(--canvas)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0}main{width:min(1440px,calc(100% - 40px));margin:0 auto;padding:44px 0 28px}.skip-link{position:fixed;left:12px;top:-60px;background:var(--ink);color:#fff;padding:10px 14px;z-index:10}.skip-link:focus{top:12px}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.hero{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:end;border-bottom:1px solid var(--rule);padding-bottom:28px}.hero h1{font-size:clamp(2rem,5vw,4.8rem);line-height:1.04;letter-spacing:-.045em;margin:.1em 0}.hero>div>p:last-child{color:var(--muted);max-width:56ch}.eyebrow{font:700 .72rem/1.2 SFMono-Regular,Consolas,monospace;letter-spacing:.15em;color:var(--accent);margin:0 0 10px}.gate-stamp{border:2px solid var(--ink);padding:16px 20px;min-width:210px;transform:rotate(-1deg)}.gate-stamp span,.gate-stamp small{display:block;font:700 .67rem/1.4 SFMono-Regular,Consolas,monospace;letter-spacing:.12em}.gate-stamp strong{display:block;font-size:2rem}.metrics{display:grid;grid-template-columns:repeat(5,1fr);background:var(--ink);color:#fff;margin:24px 0 52px}.metrics div{padding:16px 18px;border-right:1px solid #46515b}.metrics div:last-child{border:0}.metrics dt{font-size:.72rem;color:#bcc7cf}.metrics dd{font:700 1.12rem/1.3 SFMono-Regular,Consolas,monospace;margin:5px 0 0;overflow-wrap:anywhere}.warnings{border-left:5px solid var(--warn);background:#fff8ed;padding:18px 22px;margin:-24px 0 46px}.warnings h2{font-size:1rem;margin:0}.warnings ul{margin:8px 0 0;padding-left:20px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin:0 0 18px}.section-heading h2{font-size:clamp(1.45rem,3vw,2.25rem);line-height:1.1;margin:0}.section-heading>p{color:var(--muted);max-width:42ch;margin:0}section{margin:0 0 64px}.storyboard{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.shot{min-width:0;margin:0;background:var(--panel);border:1px solid var(--rule);box-shadow:0 9px 22px rgba(23,33,43,.07)}.shot-meta{display:flex;justify-content:space-between;padding:9px 11px;font:700 .68rem/1 SFMono-Regular,Consolas,monospace;border-bottom:1px solid var(--rule)}.frame{aspect-ratio:16/9;background:#d7e0e6;overflow:hidden}.frame img{display:block;width:100%;height:100%;object-fit:contain;background:#f6f8fa}.wireframe{height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:12%;background:linear-gradient(135deg,#dce4e9,#f5f7f8);border:9px solid #edf1f4}.wireframe span{font:700 .65rem SFMono-Regular,Consolas,monospace;color:var(--muted)}.wireframe strong{font-size:clamp(.85rem,1.3vw,1.1rem);line-height:1.25}.shot figcaption{padding:14px;min-height:132px}.shot figcaption small{display:block;color:var(--accent);font:700 .63rem SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.shot figcaption strong{display:block;line-height:1.25;margin:5px 0}.shot figcaption p{font-size:.82rem;color:var(--muted);margin:8px 0 0}.duration-track{position:relative;height:28px;border-top:1px solid var(--rule);background:#edf2f5}.duration-track span{display:block;height:100%;background:var(--accent);opacity:.78}.duration-track b{position:absolute;right:8px;top:5px;font:700 .68rem SFMono-Regular,Consolas,monospace;color:var(--ink)}.characters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.character-card{display:grid;grid-template-columns:180px 1fr;background:var(--panel);border-top:5px solid var(--character-accent);padding:18px;gap:20px}.character-image{aspect-ratio:1;display:grid;place-items:center;background:#edf2f5;overflow:hidden}.character-image img{max-width:100%;max-height:100%;object-fit:contain}.character-placeholder{font:700 .7rem SFMono-Regular,Consolas,monospace;color:var(--muted)}.character-card h3{font-size:1.55rem;margin:0}.pose-list{display:flex;flex-wrap:wrap;gap:7px;list-style:none;padding:0}.pose-list li{font-size:.75rem;background:#eef3f5;padding:4px 8px;border-radius:2px}.empty{background:var(--panel);padding:24px;border:1px dashed var(--rule);color:var(--muted)}.review-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:24px;align-items:start}.review-layout>section{margin:0}.shot-detail{background:var(--panel);border-bottom:1px solid var(--rule)}.shot-detail summary{display:grid;grid-template-columns:92px 1fr auto;gap:12px;align-items:center;min-height:58px;padding:10px 16px;cursor:pointer;font-weight:700}.shot-detail summary span,.shot-detail summary time{font:700 .72rem SFMono-Regular,Consolas,monospace;color:var(--muted)}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:2px 18px 24px}.detail-grid h3{font-size:.74rem;letter-spacing:.08em;text-transform:uppercase}.utility{font-family:SFMono-Regular,Consolas,monospace;font-size:.75rem}.muted{color:var(--muted)}.decision{position:sticky;top:18px;background:var(--ink);color:#fff;padding:24px}.decision h2{font-size:1.8rem;margin:0}.decision p{color:#c9d2d8}.decision label{display:block;font-size:.7rem;margin:16px 0 5px;color:#bdc8cf}.decision code{display:block;background:#2b3640;padding:10px;overflow-wrap:anywhere;font-size:.68rem}.conditions{margin-top:64px;background:var(--panel);padding:24px}.conditions ul{padding-left:20px}footer{display:flex;justify-content:space-between;border-top:1px solid var(--rule);padding-top:18px;color:var(--muted);font:700 .7rem SFMono-Regular,Consolas,monospace}
@media(max-width:1199px){.storyboard{grid-template-columns:repeat(3,minmax(0,1fr))}.review-layout{grid-template-columns:1fr}.decision{position:static}.metrics{grid-template-columns:repeat(3,1fr)}}
@media(max-width:767px){main{width:min(100% - 24px,1440px);padding-top:24px}.hero{grid-template-columns:1fr}.gate-stamp{width:max-content}.metrics{grid-template-columns:repeat(2,1fr);margin-bottom:38px}.storyboard{grid-template-columns:repeat(2,minmax(0,1fr))}.characters{grid-template-columns:1fr}.character-card{grid-template-columns:110px 1fr}.section-heading{display:block}.section-heading>p{margin-top:8px}.detail-grid{grid-template-columns:1fr}.shot-detail summary{grid-template-columns:72px 1fr}.shot-detail summary time{display:none}}
@media(max-width:430px){.storyboard{grid-template-columns:1fr}.metrics{grid-template-columns:1fr}.character-card{grid-template-columns:1fr}.character-image{max-width:180px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{@page{size:landscape;margin:10mm}:root{--canvas:#fff;--ink:#000;--rule:#777}main{width:100%;padding:0}.storyboard{grid-template-columns:repeat(4,1fr)}.shot{box-shadow:none;break-inside:avoid}.shot-detail[open] .detail-grid,.shot-detail .detail-grid{display:grid}.decision{position:static;background:#fff;color:#000;border:2px solid #000}.decision p{color:#222}.decision code{background:#eee}.skip-link{display:none}}
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function safeColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : "#176b87";
}

function formatSeconds(value: number): string {
  return `${formatNumber(value)}秒`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTime(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
