import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Result } from "../types.js";
import {
  digest,
  verifyEditorialProposal,
  type EditorialProposal,
  type RawAnalysisForProposal
} from "./editorialProposal.js";
import {
  compileEditorial,
  type EditorialDecisionList
} from "./editorialCompile.js";
import type { ExecutionPlan } from "./plan.js";

export type EditorialCompilation = {
  manifest: Manifest;
  edl: EditorialDecisionList;
};

type EditorialReview = {
  proposal: EditorialProposal;
  approvalDigest: string;
  compilation?: EditorialCompilation;
};

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
  schema_version: 1 | 2;
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
  approval_digest?: string;
  analysis?: {
    status: "ready" | "missing";
    analysis_input_digest?: string;
    raw_analysis_digest?: string;
    proposal_digest?: string;
    outputs: EditorialProposal["outputs"];
    editorial?: {
      edl_digest: string;
      source_duration_seconds: number;
      output_duration_seconds: number;
      removed_duration_seconds: number;
      applied_cut_ids: string[];
      caption_count: number;
      chapter_count: number;
    };
  };
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
  manifest: Manifest;
  stateDir?: string;
}): Promise<Result<{
  reviewPath: string;
  dataPath: string;
  approvalDigest?: string;
  proposal?: EditorialProposal;
  compilation?: EditorialCompilation;
}>> {
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
    if (
      !html.includes('data-testid="storyboard-sheet"') ||
      html !== renderReviewHtml(data as ReviewDocument)
    ) {
      return {
        ok: false,
        issues: [
          {
            code: "gate.review_invalid",
            message: "Gate 1 review HTML does not match the reviewed data.",
            path: reviewPath
          }
        ],
        reviewPath,
        dataPath
      };
    }
    let approvalDigest: string | undefined;
    let currentEditorial: EditorialReview | undefined;
    if (options.project.analysis) {
      const editorial = await loadEditorialReview(options.configPath, options.project, options.manifest, options.stateDir);
      if (!editorial.ok) {
        return { ok: false, issues: editorial.issues, reviewPath, dataPath };
      }
      const document = data as ReviewDocument;
      currentEditorial = editorial;
      approvalDigest = editorial.approvalDigest;
      if (
        document.approval_digest !== approvalDigest ||
        document.analysis?.proposal_digest !== editorial.proposal.proposal_digest ||
        document.analysis?.editorial?.edl_digest !== editorial.compilation?.edl.digest
      ) {
        return {
          ok: false,
          issues: [{ code: "gate.analysis_changed", message: "analysis artifacts changed after the Gate 1 review", path: dataPath }],
          reviewPath,
          dataPath
        };
      }
    }
    return {
      ok: true,
      issues: [],
      reviewPath,
      dataPath,
      approvalDigest,
      ...(currentEditorial ? { proposal: currentEditorial.proposal } : {}),
      ...(currentEditorial?.compilation ? { compilation: currentEditorial.compilation } : {})
    };
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
  plan: ExecutionPlan,
  editorial?: EditorialReview
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
  if (project.analysis && !editorial) {
    warnings.push("解析成果物が未生成または不整合です。Gate 1は承認できません。");
  }

  return {
    schema_version: project.analysis ? 2 : 1,
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
    ...(project.analysis
      ? {
          ...(editorial ? { approval_digest: editorial.approvalDigest } : {}),
          analysis: editorial
            ? {
                status: "ready" as const,
                analysis_input_digest: editorial.proposal.analysis_input_digest,
                raw_analysis_digest: editorial.proposal.raw_analysis_digest,
                proposal_digest: editorial.proposal.proposal_digest,
                outputs: editorial.proposal.outputs,
                ...(editorial.compilation
                  ? {
                      editorial: {
                        edl_digest: editorial.compilation.edl.digest,
                        source_duration_seconds: editorial.compilation.edl.source_duration_seconds,
                        output_duration_seconds: editorial.compilation.edl.duration_seconds,
                        removed_duration_seconds: editorial.compilation.edl.removed_duration_seconds,
                        applied_cut_ids: editorial.compilation.edl.removed_ranges.flatMap((range) => range.cut_ids),
                        caption_count: editorial.compilation.manifest.captions.length,
                        chapter_count: editorial.compilation.manifest.chapters.length
                      }
                    }
                  : {})
              }
            : {
                status: "missing" as const,
                outputs: emptyEditorialOutputs()
              }
        }
      : {}),
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

  const loadedEditorial = options.project.analysis
    ? await loadEditorialReview(configPath, options.project, options.manifest, options.stateDir)
    : undefined;
  const document = createReviewDocument(
    options.project,
    options.manifest,
    options.plan,
    loadedEditorial?.ok
      ? {
          proposal: loadedEditorial.proposal,
          approvalDigest: loadedEditorial.approvalDigest,
          ...(loadedEditorial.compilation ? { compilation: loadedEditorial.compilation } : {})
        }
      : undefined
  );
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

async function loadEditorialReview(
  configPath: string,
  project: Project,
  manifest: Manifest,
  stateDir?: string
): Promise<Result<EditorialReview>> {
  const distDir = stateDir
    ? resolve(stateDir)
    : resolve(dirname(resolve(configPath)), project.dist_dir);
  const analysisDir = join(distDir, project.run_id ?? project.slug, "analysis");
  try {
    const [rawText, proposalText] = await Promise.all([
      readFile(join(analysisDir, "raw-analysis.json"), "utf8"),
      readFile(join(analysisDir, "editorial-proposal.json"), "utf8")
    ]);
    const raw = JSON.parse(rawText) as RawAnalysisForProposal;
    const proposal = JSON.parse(proposalText) as EditorialProposal;
    const verified = verifyEditorialProposal(raw, proposal);
    if (!verified.ok) {
      return {
        ok: false,
        issues: [{ code: "gate.analysis_stale", message: "analysis proposal digest is stale or invalid", path: analysisDir }]
      };
    }
    let compilation: EditorialCompilation | undefined;
    if (project.edit.editorial) {
      const compiled = compileEditorial(manifest, proposal, project.edit.editorial);
      if (!compiled.ok) {
        return {
          ok: false,
          issues: compiled.issues.map((issue) => ({
            ...issue,
            path: issue.path ?? join(analysisDir, "editorial-proposal.json")
          }))
        };
      }
      compilation = { manifest: compiled.manifest, edl: compiled.edl };
    }
    return {
      ok: true,
      issues: [],
      proposal,
      approvalDigest: digest({
        project,
        manifest,
        raw_analysis_digest: proposal.raw_analysis_digest,
        proposal_digest: proposal.proposal_digest,
        editorial_edl_digest: compilation?.edl.digest
      }),
      ...(compilation ? { compilation } : {})
    };
  } catch {
    return {
      ok: false,
      issues: [{ code: "gate.analysis_stale", message: "analysis artifacts are missing or invalid", path: analysisDir }]
    };
  }
}

function emptyEditorialOutputs(): EditorialProposal["outputs"] {
  return {
    transcripts: [],
    cut_points: [],
    chapters: [],
    summaries: [],
    subtitle_tracks: []
  };
}

function collectReferencedAssets(document: ReviewDocument): ReviewAsset[] {
  return [
    ...document.characters.flatMap((character) => character.poses.flatMap((pose) => pose.asset ?? [])),
    ...document.storyboard.flatMap((shot) => shot.image ?? [])
  ];
}

function renderAnalysisReview(analysis: ReviewDocument["analysis"]): string {
  if (!analysis) return "";
  if (analysis.status !== "ready") {
    return `<section class="warnings" aria-labelledby="analysis-title"><h2 id="analysis-title">解析レビュー</h2><p>解析成果物が揃っていません。</p></section>`;
  }
  const appliedCutIds = new Set(analysis.editorial?.applied_cut_ids ?? []);
  const cutPoints = analysis.outputs.cut_points.map((candidate) => {
    const start = numericField(candidate, "source_start");
    const end = numericField(candidate, "source_end");
    const kind = stringField(candidate, "kind") ?? "candidate";
    const id = stringField(candidate, "id");
    const status = id && appliedCutIds.has(id) ? "適用予定" : "保持";
    return `<li><time>${formatTime(start)}–${formatTime(end)}</time> ${escapeHtml(kind)} · ${status}</li>`;
  }).join("");
  const transcriptCount = analysis.outputs.transcripts.reduce((count, transcript) => {
    const segments = transcript.segments;
    return count + (Array.isArray(segments) ? segments.length : 0);
  }, 0);
  const subtitleCount = analysis.outputs.subtitle_tracks.reduce((count, track) => {
    const captions = track.captions;
    return count + (Array.isArray(captions) ? captions.length : 0);
  }, 0);
  const editorialSummary = analysis.editorial
    ? `<p><b>Gate 1承認後の適用予定:</b> ${analysis.editorial.applied_cut_ids.length}候補を削除、${formatSeconds(analysis.editorial.removed_duration_seconds)}短縮、出力${formatSeconds(analysis.editorial.output_duration_seconds)}、字幕${analysis.editorial.caption_count}件、章${analysis.editorial.chapter_count}件。</p>`
    : "";
  return `<section class="conditions" aria-labelledby="analysis-title" data-testid="analysis-review">
    <div class="section-heading"><div><p class="eyebrow">SOURCE TIMESTAMP / PROPOSED</p><h2 id="analysis-title">解析レビュー</h2></div><p>${analysis.editorial ? "明示された編集方針だけをGate 1承認後に適用します。" : "元動画の時刻を保った確認候補です。自動削除は行いません。"}</p></div>
    <dl class="metrics"><div><dt>文字起こしsegment</dt><dd>${transcriptCount}</dd></div><div><dt>フィラー・カット確認候補</dt><dd>${analysis.outputs.cut_points.length}</dd></div><div><dt>章</dt><dd>${analysis.outputs.chapters.length}</dd></div><div><dt>要約</dt><dd>${analysis.outputs.summaries.length}</dd></div><div><dt>翻訳字幕</dt><dd>${subtitleCount}</dd></div></dl>
    ${editorialSummary}
    ${cutPoints ? `<ul>${cutPoints}</ul>` : "<p>フィラー・カット確認候補はありません。</p>"}
  </section>`;
}

function numericField(value: Record<string, unknown>, key: string): number {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
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
    document.schema_version === (project.analysis ? 2 : 1) &&
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
      <a class="shot-index" href="#detail-${escapeAttribute(shot.id)}" aria-label="SHOT ${String(shot.order).padStart(2, "0")} の詳細へ"><b>${String(shot.order).padStart(2, "0")}</b><small>SHOT</small></a>
      <div class="shot-meta"><span>${escapeHtml(shot.speaker ?? shot.chapter ?? "VISUAL")}</span><time>${formatTime(shot.start)}–${formatTime(shot.end)}</time></div>
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
  const analysis = renderAnalysisReview(document.analysis);

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
  <main id="main" data-design="joinery-review">
    <header class="hero">
      <nav class="review-nav" aria-label="レビュー内ナビゲーション">
        <a class="wordmark" href="#main"><span class="joinery-mark" aria-hidden="true"><i></i><i></i></span><span class="wordmark-copy">TSUGITE<small>CREATIVE REVIEW</small></span></a>
        <div><a href="#storyboard-title">絵コンテ</a><a href="#characters-title">キャラクター</a><a href="#details-title">カット詳細</a><a href="#decision-title">承認判断</a></div>
      </nav>
      <div class="hero-content">
        <div class="hero-copy"><p class="eyebrow">映像制作の事前確認 / CREATIVE REVIEW</p><h1>${escapeHtml(document.summary.title)}</h1><p class="lede">生成に進む前に、映像の流れ、登場人物の一貫性、制作条件を一つの画面で確認します。</p></div>
        <div class="gate-status" aria-label="Gate 1 承認待ち"><span class="status-light"></span><div><small>STATUS / AWAITING REVIEW</small><strong>Gate 1</strong><p>人間の承認が必要です</p></div></div>
      </div>
      <dl class="metrics">
        <div><dt>目標尺</dt><dd>${formatSeconds(document.summary.target_duration_seconds)}</dd></div>
        <div><dt>絵コンテ尺</dt><dd>${formatSeconds(document.summary.storyboard_duration_seconds)}</dd></div>
        <div><dt>画面比率</dt><dd>${escapeHtml(document.summary.aspect)}</dd></div>
        <div><dt>推定credits</dt><dd>${formatNumber(document.summary.estimated_credits)}</dd></div>
        <div><dt>編集backend</dt><dd>${escapeHtml(document.summary.backend)}</dd></div>
      </dl>
    </header>
    ${warnings}
    ${analysis}
    <section class="storyboard-section" aria-labelledby="storyboard-title">
      <div class="section-heading"><div><p class="eyebrow">SEQUENCE / TIMING</p><h2 id="storyboard-title">映像の流れ</h2></div><p>左から時間順です。青い尺ゲージとタイムコードでテンポを確認できます。</p></div>
      <div class="screening-room">
        <div class="screening-toolbar"><span>STORYBOARD MONITOR</span><span>${document.storyboard.length} SHOTS / ${formatSeconds(document.summary.storyboard_duration_seconds)}</span></div>
        <div class="film-strip" data-testid="storyboard-sheet">${storyboard}</div>
        <div class="playback-rail" aria-hidden="true"><span>IN&nbsp; ${formatTime(0)}</span><i></i><span>OUT&nbsp; ${formatTime(document.summary.storyboard_duration_seconds)}</span></div>
      </div>
    </section>
    <section aria-labelledby="characters-title">
      <div class="section-heading"><div><p class="eyebrow">CONTINUITY</p><h2 id="characters-title">キャラクターシート</h2></div><p>表情と役割を生成前に固定します。</p></div>
      <div class="characters">${characters}</div>
    </section>
    <div class="review-layout">
      <section aria-labelledby="details-title"><div class="section-heading"><div><p class="eyebrow">SHOT NOTES</p><h2 id="details-title">カット詳細</h2></div></div>${details}</section>
      <aside class="decision" aria-labelledby="decision-title"><div class="decision-status"><span></span>HUMAN CHECKPOINT</div><p class="eyebrow">GATE 1 / DECISION</p><h2 id="decision-title">次へ進めるか判断</h2><p>このHTMLは読み取り専用です。内容を確認したCoordinatorが、次のいずれかを実行します。</p><label><i class="approve-dot"></i>承認して進む</label><code>${escapeHtml(document.approval_commands.approve)}</code><label><i class="revise-dot"></i>修正へ戻す</label><code>${escapeHtml(document.approval_commands.revise)}</code><label><i class="abort-dot"></i>中止する</label><code>${escapeHtml(document.approval_commands.abort)}</code></aside>
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
:root{color-scheme:light;--washi:#f1f3f0;--paper:#fbfcfa;--sumi:#1b272d;--sumi-soft:#2b3a40;--ai:#315f73;--ai-pale:#dce7e7;--nezumi:#687579;--rule:#ccd3d0;--kane:#b28a4c;--approve:#397b61;--danger:#a24f4d;font-family:"Hiragino Sans","Yu Gothic UI","Yu Gothic",system-ui,sans-serif;line-height:1.68;color:var(--sumi);background:var(--washi)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--washi)}main{width:min(1380px,calc(100% - 48px));margin:0 auto;padding:28px 0 36px}.skip-link{position:fixed;left:12px;top:-60px;background:var(--ai);color:#fff;padding:10px 14px;z-index:20}.skip-link:focus{top:12px}a{color:inherit}a:focus-visible,summary:focus-visible{outline:3px solid var(--ai);outline-offset:3px}.hero{overflow:hidden;background:var(--paper);border:1px solid var(--rule);border-top:3px solid var(--sumi)}.review-nav{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:28px;padding:0 32px;border-bottom:1px solid var(--rule);font:700 .66rem/1 SFMono-Regular,Consolas,monospace;letter-spacing:.07em}.review-nav a{text-decoration:none}.review-nav>div{display:flex;align-items:center;gap:25px;color:var(--nezumi)}.review-nav>div a{padding:24px 0 21px;border-bottom:2px solid transparent}.review-nav>div a:hover{color:var(--ai);border-bottom-color:var(--ai)}.wordmark{display:flex;align-items:center;gap:13px}.wordmark-copy{display:flex;flex-direction:column;gap:4px;letter-spacing:.16em}.wordmark-copy small{font-size:.48rem;letter-spacing:.1em;color:var(--nezumi)}.joinery-mark{position:relative;display:block;width:34px;height:28px}.joinery-mark i{position:absolute;display:block;width:23px;height:8px}.joinery-mark i:first-child{left:0;top:4px;background:var(--ai)}.joinery-mark i:last-child{right:0;bottom:4px;background:var(--sumi)}.joinery-mark::before,.joinery-mark::after{content:"";position:absolute;width:8px;height:16px}.joinery-mark::before{left:8px;top:4px;background:var(--ai)}.joinery-mark::after{right:8px;bottom:4px;background:var(--sumi)}.hero-content{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:72px;align-items:end;padding:64px 54px 58px}.hero-content::before,.hero-content::after{content:"";position:absolute;pointer-events:none}.hero-content::before{right:38px;top:30px;width:96px;height:74px;border-top:1px solid var(--ai);border-right:1px solid var(--ai);opacity:.36}.hero-content::after{right:68px;top:58px;width:66px;height:46px;border-top:1px solid var(--kane);border-right:1px solid var(--kane);opacity:.42}.hero-copy,.gate-status{position:relative;z-index:1}.eyebrow{font:700 .65rem/1.2 SFMono-Regular,Consolas,monospace;letter-spacing:.13em;color:var(--ai);margin:0 0 12px}.hero h1{max-width:900px;font-family:"Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",sans-serif;font-size:clamp(2.6rem,5.2vw,4.9rem);font-weight:700;line-height:1.08;letter-spacing:-.04em;margin:.08em 0 .25em}.lede{max-width:59ch;margin:0;color:var(--nezumi);font-size:.9rem}.gate-status{display:grid;grid-template-columns:10px 1fr;gap:14px;align-items:start;border-left:2px solid var(--ai);padding:5px 0 5px 18px}.status-light{width:8px;height:8px;margin-top:4px;background:var(--kane);border-radius:50%;box-shadow:0 0 0 4px rgba(178,138,76,.12)}.gate-status small{display:block;font:700 .58rem SFMono-Regular,Consolas,monospace;letter-spacing:.09em;color:var(--nezumi)}.gate-status strong{display:block;font-size:1.85rem;line-height:1.1;margin:7px 0 3px}.gate-status p{margin:0;color:var(--nezumi);font-size:.74rem}.metrics{display:grid;grid-template-columns:repeat(5,1fr);margin:0;background:#e8ece9;border-top:1px solid var(--rule)}.metrics div{padding:15px 20px 17px;border-right:1px solid #c5cdca}.metrics div:last-child{border:0}.metrics dt{font-size:.64rem;color:var(--nezumi)}.metrics dd{font:700 .92rem/1.25 SFMono-Regular,Consolas,monospace;margin:5px 0 0;overflow-wrap:anywhere}.warnings{border:1px solid #d8c5a2;border-left:3px solid var(--kane);background:#faf8f1;padding:15px 20px;margin:22px 0 60px}.warnings h2{font-size:.86rem;margin:0}.warnings ul{margin:5px 0 0;padding-left:19px;font-size:.82rem}.section-heading{position:relative;display:flex;align-items:end;justify-content:space-between;gap:28px;margin:0 0 20px;padding-top:17px}.section-heading::before{content:"";position:absolute;left:0;top:0;width:44px;height:1px;background:var(--ai)}.section-heading::after{content:"";position:absolute;left:44px;top:0;width:13px;height:1px;background:var(--kane)}.section-heading h2{font-family:"Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",sans-serif;font-size:clamp(1.7rem,3vw,2.65rem);font-weight:700;line-height:1.15;letter-spacing:-.03em;margin:0}.section-heading>p{color:var(--nezumi);max-width:44ch;margin:0;font-size:.82rem}section{margin:0 0 76px}.storyboard-section{margin-top:56px}.screening-room{background:#e5e9e6;padding:0 20px 18px;border:1px solid #c5cdca;border-left:4px solid var(--ai)}.screening-toolbar{height:48px;display:flex;align-items:center;justify-content:space-between;color:var(--nezumi);font:700 .59rem/1 SFMono-Regular,Consolas,monospace;letter-spacing:.09em;border-bottom:1px solid #c5cdca}.film-strip{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;padding:28px 0 16px}.film-strip::before{content:"";position:absolute;left:0;right:0;top:12px;height:1px;background:linear-gradient(90deg,var(--ai),#99a9a8 82%,#c1c9c6)}.shot{position:relative;min-width:0;margin:0;background:var(--paper);border:1px solid #bdc6c3;box-shadow:0 5px 15px rgba(36,53,58,.07)}.shot::before{content:"";position:absolute;width:1px;height:16px;left:25px;top:-16px;background:var(--ai)}.shot-index{position:absolute;left:10px;top:-20px;z-index:2;display:flex;align-items:baseline;gap:4px;height:27px;padding:4px 8px;background:var(--paper);color:var(--ai);border:1px solid var(--ai);text-decoration:none;font-family:SFMono-Regular,Consolas,monospace}.shot-index b{font-size:.78rem;line-height:1}.shot-index small{font-size:.45rem;letter-spacing:.08em}.shot-meta{display:flex;justify-content:space-between;gap:10px;padding:9px 11px;color:var(--nezumi);font:700 .57rem/1 SFMono-Regular,Consolas,monospace;border-bottom:1px solid #d6dcda;text-transform:uppercase}.frame{aspect-ratio:16/9;background:#dfe4e1;overflow:hidden}.frame img{display:block;width:100%;height:100%;object-fit:contain;background:#e8ebe9}.wireframe{height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:11%;background:linear-gradient(135deg,#dce2df,#f2f4f1);border:7px solid #e8ece9}.wireframe span{font:700 .56rem SFMono-Regular,Consolas,monospace;color:var(--nezumi)}.wireframe strong{max-width:19ch;font-size:clamp(.88rem,1.2vw,1.08rem);line-height:1.25}.shot figcaption{padding:14px 14px 15px;min-height:134px}.shot figcaption small{display:block;color:var(--ai);font:700 .54rem SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.shot figcaption strong{display:block;font-size:.9rem;line-height:1.38;margin:6px 0}.shot figcaption p{font-size:.72rem;line-height:1.6;color:var(--nezumi);margin:8px 0 0}.duration-track{position:relative;height:23px;border-top:1px solid #d6dcda;background:#e8ece9;overflow:hidden}.duration-track span{display:block;height:100%;background:var(--ai);opacity:.88}.duration-track b{position:absolute;right:8px;top:3px;font:700 .57rem SFMono-Regular,Consolas,monospace;color:var(--sumi)}.playback-rail{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;color:var(--nezumi);font:700 .54rem SFMono-Regular,Consolas,monospace;letter-spacing:.05em}.playback-rail i{height:1px;background:#bbc5c2}.characters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.character-card{display:grid;grid-template-columns:170px 1fr;background:var(--paper);border:1px solid var(--rule);border-left:3px solid var(--character-accent);padding:15px;gap:22px}.character-image{aspect-ratio:1;display:grid;place-items:center;background:#e8ece9;overflow:hidden}.character-image img{max-width:100%;max-height:100%;object-fit:contain}.character-placeholder{font:700 .59rem SFMono-Regular,Consolas,monospace;color:var(--nezumi)}.character-card h3{font-size:1.5rem;line-height:1.2;margin:0}.pose-list{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin-top:18px}.pose-list li{font:700 .61rem SFMono-Regular,Consolas,monospace;background:#edf0ed;border:1px solid #d9dfdc;padding:4px 7px}.empty{background:var(--paper);padding:23px;border:1px dashed var(--rule);color:var(--nezumi)}.review-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(320px,1fr);gap:34px;align-items:start}.review-layout>section{margin:0}.shot-detail{background:var(--paper);border:1px solid var(--rule);border-bottom:0}.shot-detail:last-child{border-bottom:1px solid var(--rule)}.shot-detail summary{display:grid;grid-template-columns:88px 1fr auto;gap:12px;align-items:center;min-height:59px;padding:10px 16px;cursor:pointer;font-weight:700;font-size:.88rem}.shot-detail summary:hover{background:#eef1ee}.shot-detail summary span,.shot-detail summary time{font:700 .61rem SFMono-Regular,Consolas,monospace;color:var(--nezumi)}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:3px 20px 24px;border-top:1px solid #dce1df}.detail-grid h3{font-size:.66rem;letter-spacing:.08em;text-transform:uppercase}.utility{font-family:SFMono-Regular,Consolas,monospace;font-size:.67rem}.muted{color:var(--nezumi)}.decision{position:sticky;top:18px;background:var(--paper);color:var(--sumi);padding:25px 24px 26px;border:1px solid var(--rule);border-top:3px solid var(--ai);box-shadow:0 10px 25px rgba(36,53,58,.07)}.decision-status{display:flex;align-items:center;gap:8px;color:var(--nezumi);font:700 .54rem SFMono-Regular,Consolas,monospace;letter-spacing:.09em;margin-bottom:25px}.decision-status span{width:7px;height:7px;border-radius:50%;background:var(--kane)}.decision h2{font-size:1.65rem;line-height:1.25;margin:0}.decision>p:not(.eyebrow){color:var(--nezumi);font-size:.78rem}.decision label{display:flex;align-items:center;gap:8px;font-size:.68rem;margin:17px 0 6px;color:var(--sumi-soft)}.decision label i{width:7px;height:7px;border-radius:50%}.approve-dot{background:var(--approve)}.revise-dot{background:var(--kane)}.abort-dot{background:var(--danger)}.decision code{display:block;background:var(--sumi);border:1px solid var(--sumi);padding:9px 10px;overflow-wrap:anywhere;font-size:.58rem;line-height:1.55;color:#dfe5e2}.conditions{margin-top:76px;background:var(--paper);border:1px solid var(--rule);padding:25px}.conditions ul{padding-left:20px}.conditions>p{color:var(--nezumi);font-size:.76rem}footer{display:flex;justify-content:space-between;border-top:1px solid var(--rule);padding-top:17px;color:var(--nezumi);font:700 .6rem SFMono-Regular,Consolas,monospace}
@media(max-width:1199px){.film-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.review-layout{grid-template-columns:1fr}.decision{position:static}.hero-content{grid-template-columns:minmax(0,1fr) 260px;gap:42px}.metrics{grid-template-columns:repeat(3,1fr)}.metrics div:nth-child(3){border-right:0}.metrics div:nth-child(n+4){border-top:1px solid #c5cdca}}
@media(max-width:800px){main{width:min(100% - 24px,1380px);padding-top:12px}.review-nav{padding:0 19px}.review-nav>div{display:none}.hero-content{grid-template-columns:1fr;padding:44px 24px 36px}.hero-content::before,.hero-content::after{display:none}.gate-status{max-width:310px;margin-top:4px}.metrics{grid-template-columns:repeat(2,1fr)}.metrics div:nth-child(3){border-right:1px solid #c5cdca}.metrics div:nth-child(even){border-right:0}.metrics div:nth-child(n+3){border-top:1px solid #c5cdca}.film-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.characters{grid-template-columns:1fr}.character-card{grid-template-columns:130px 1fr}.section-heading{display:block}.section-heading>p{margin-top:9px}.detail-grid{grid-template-columns:1fr}.shot-detail summary{grid-template-columns:68px 1fr}.shot-detail summary time{display:none}.screening-room{padding-inline:13px}}
@media(max-width:520px){.hero h1{font-size:2.45rem}.screening-room{overflow:hidden}.film-strip{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-color:var(--ai) transparent;scrollbar-width:thin}.film-strip .shot{flex:0 0 min(82vw,330px);scroll-snap-align:start}.metrics{grid-template-columns:1fr}.metrics div,.metrics div:nth-child(3),.metrics div:nth-child(even){border-right:0}.metrics div:nth-child(n+2){border-top:1px solid #c5cdca}.character-card{grid-template-columns:1fr}.character-image{max-width:180px}.screening-toolbar span:first-child{display:none}.shot figcaption{min-height:auto}.section-heading h2{font-size:1.95rem}.review-layout{gap:20px}.wordmark-copy small{display:none}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{@page{size:landscape;margin:10mm}:root{--washi:#fff;--paper:#fff;--sumi:#000;--rule:#777}main{width:100%;padding:0}.review-nav{display:none}.hero{border:0}.hero-content{padding:0}.hero-content::before,.hero-content::after{display:none}.metrics{border:1px solid #777}.metrics div{border-color:#777!important}.screening-room{background:#fff;padding:0;box-shadow:none}.film-strip{grid-template-columns:repeat(4,1fr)}.film-strip::before,.shot::before{background:#000}.shot{box-shadow:none;border-color:#777;break-inside:avoid}.shot-index{color:#000;border-color:#000}.shot-detail[open] .detail-grid,.shot-detail .detail-grid{display:grid}.decision{position:static;box-shadow:none;border:2px solid #000}.decision code{background:#eee;color:#000;border-color:#777}.skip-link{display:none}}
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
