import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Manifest } from "../manifest/schema.js";
import {
  resolveGenerationConnection,
  type GenerationConnectionResolution
} from "../connections/registry.js";
import { generationRequestCapability, generationRequestMode, generationRequestOutputKind, type GenerationRequest, type Project } from "../project/schema.js";
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
import {
  compileComposition,
  type CompositionCompilation,
  type CompositionProposalArtifactInput
} from "./compositionCompile.js";
import { verifyCompositionAnalysisInputs } from "./compose.js";
import {
  verifyCompositionProposals,
  type CompositionProposalsArtifact,
  type RawAnalysisForComposition
} from "./compositionProposal.js";
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
  source_scope?: "manifest" | "project";
};

const REVIEW_SOURCE_DIGEST_CACHE_MAX_ENTRIES = 512;
const reviewSourceDigestCache = new Map<string, {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}>();

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

export type ReviewMotionCue = {
  phase: "entrance" | "emphasis" | "exit" | "transition_to_next";
  preset: "none" | "fade" | "slide-left" | "slide-right" | "rise" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "parallax" | "pulse" | "wipe";
  label?: string;
  description: string;
  target: string;
  duration_seconds?: number;
  easing?: string;
};

export type ReviewMotionPlan = {
  cues: ReviewMotionCue[];
  implementation_notes: string[];
};

export type ReviewMotionDesign = {
  status: "declared" | "partial" | "unspecified";
  summary: string;
  pacing?: string;
  principles: string[];
  implementation: {
    backend: string;
    surface: string;
    method: string;
    preview: "HTML / CSS approximation" | "specification only";
  };
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
  reference_images?: ReviewAsset[];
  prompt?: string;
  model?: string;
  input_mode?: string;
  motion?: ReviewMotionPlan;
};

export type ReviewCompositionProposal = {
  id: string;
  title: string;
  rationale: string;
  estimated_duration_seconds: number;
  selected: boolean;
  segments: Array<{
    id: string;
    source_clip_id: string;
    source_src?: string;
    source_start: number;
    source_end: number;
    role: string;
    reason: string;
    observation_ids: string[];
  }>;
  warnings: string[];
};

export type ReviewDocument = {
  schema_version: 1 | 2 | 3;
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
  background?: ReviewAsset;
  motion_design: ReviewMotionDesign;
  characters: ReviewCharacter[];
  storyboard: ReviewShot[];
  handoffs: ExecutionPlan["agent_handoffs"];
  audio?: ExecutionPlan["audio"];
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
  composition?: {
    status: "ready" | "selection-required" | "missing";
    proposals_digest?: string;
    selected_proposal_id?: string;
    approval_digest?: string;
    edl_digest?: string;
    proposals: ReviewCompositionProposal[];
  };
  approval_commands: {
    approve: string;
    revise: string;
    abort: string;
  };
};

type CompositionReview = {
  artifact: CompositionProposalArtifactInput;
  approvalDigest: string;
  compilation?: CompositionCompilation;
};

type WriteCreativeReviewOptions = {
  configPath: string;
  project: Project;
  manifest: Manifest;
  plan: ExecutionPlan;
  outputDir?: string;
  stateDir?: string;
};

type ManifestMotionPlan = NonNullable<Manifest["clips"][number]["motion"]>;
type TimedManifestClip = {
  clip: Manifest["clips"][number];
  start: number;
  end: number;
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
  compilation?: EditorialCompilation | CompositionCompilation;
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
    let editorialApprovalDigest: string | undefined;
    let currentEditorial: EditorialReview | undefined;
    if (options.project.analysis) {
      const editorial = await loadEditorialReview(options.configPath, options.project, options.manifest, options.stateDir);
      if (!editorial.ok) {
        return { ok: false, issues: editorial.issues, reviewPath, dataPath };
      }
      const document = data as ReviewDocument;
      currentEditorial = editorial;
      editorialApprovalDigest = editorial.approvalDigest;
      if (
        document.approval_digest !== editorialApprovalDigest ||
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
    let currentComposition: CompositionReview | undefined;
    if (options.project.composition) {
      const composition = await loadCompositionReview(
        options.configPath,
        options.project,
        options.manifest,
        options.stateDir
      );
      if (!composition.ok) {
        return { ok: false, issues: composition.issues, reviewPath, dataPath };
      }
      if (!composition.compilation || !options.project.edit.composition?.proposal_id) {
        return {
          ok: false,
          issues: [{
            code: "gate.composition_selection_required",
            message: "Gate 1 requires one composition proposal to be selected in edit.composition.proposal_id",
            path: "edit.composition.proposal_id"
          }],
          reviewPath,
          dataPath
        };
      }
      currentComposition = composition;
      const reviewed = (data as ReviewDocument).composition;
      if (
        reviewed?.approval_digest !== composition.approvalDigest
        || reviewed.proposals_digest !== composition.artifact.proposals_digest
        || reviewed.selected_proposal_id !== options.project.edit.composition.proposal_id
        || reviewed.edl_digest !== composition.compilation.edl.digest
      ) {
        return {
          ok: false,
          issues: [{
            code: "gate.composition_changed",
            message: "composition artifacts or selection changed after the Gate 1 review",
            path: dataPath
          }],
          reviewPath,
          dataPath
        };
      }
    }
    const document = data as ReviewDocument;
    const currentConnections = await resolveReviewConnectionSnapshots(options.project);
    if (!currentConnections.ok) {
      return { ok: false, issues: currentConnections.issues, reviewPath, dataPath };
    }
    const reviewedConnections = reviewConnectionSnapshots(document);
    if (digest(reviewedConnections) !== digest(currentConnections.snapshots)) {
      return {
        ok: false,
        issues: [{
          code: "gate.connection_changed",
          message: "connection route or setup status changed after the Gate 1 review; regenerate and approve the review again",
          path: dataPath
        }],
        reviewPath,
        dataPath
      };
    }
    const approvalDigest = digest({
      schema_version: 1,
      project: options.project,
      manifest: options.manifest,
      review: document,
      preview_assets: await fingerprintReviewAssets(outputDir, document),
      source_assets: await fingerprintGate1SourceAssets(
        options.configPath,
        options.project,
        options.manifest
      ),
      connections: currentConnections.snapshots,
      editorial_approval_digest: editorialApprovalDigest,
      composition_approval_digest: currentComposition?.approvalDigest
    });
    return {
      ok: true,
      issues: [],
      reviewPath,
      dataPath,
      approvalDigest,
      ...(currentEditorial ? { proposal: currentEditorial.proposal } : {}),
      ...(currentComposition?.compilation
        ? { compilation: currentComposition.compilation }
        : currentEditorial?.compilation
          ? { compilation: currentEditorial.compilation }
          : {})
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

type ReviewConnectionSnapshot = {
  phase: "generation" | "audio";
  connection: string;
  adapter: string;
  transport: GenerationConnectionResolution["transport"];
  provider: string;
  route_note: string;
  auth_kind: GenerationConnectionResolution["auth_kind"];
  contract_digest: string;
  setup_status: GenerationConnectionResolution["setup_status"];
};

async function resolveReviewConnectionSnapshots(project: Project): Promise<
  | { ok: true; snapshots: ReviewConnectionSnapshot[] }
  | { ok: false; issues: Array<{ code: string; message: string; path?: string }> }
> {
  const snapshots: ReviewConnectionSnapshot[] = [];
  if (project.generation?.connection) {
    const resolution = await resolveGenerationConnection(project.generation.connection, undefined, {
      models: project.generation.requests.flatMap((request) => request.model ? [request.model] : []),
      capabilities: [...new Set(project.generation.requests.map(generationRequestCapability))]
    });
    if (!resolution) {
      return {
        ok: false,
        issues: [{
          code: "gate.connection_changed",
          message: `generation connection '${project.generation.connection}' is no longer available for the reviewed request`,
          path: "generation.connection"
        }]
      };
    }
    snapshots.push(toReviewConnectionSnapshot("generation", resolution));
  }
  if (project.audio?.connection) {
    const capabilities = [
      ...(project.audio.bgm ? ["audio.music"] : []),
      ...(project.audio.sfx.length > 0 ? ["audio.sound-effects"] : [])
    ];
    const resolution = await resolveGenerationConnection(project.audio.connection, undefined, { capabilities });
    if (!resolution) {
      return {
        ok: false,
        issues: [{
          code: "gate.connection_changed",
          message: `audio connection '${project.audio.connection}' is no longer available for the reviewed request`,
          path: "audio.connection"
        }]
      };
    }
    snapshots.push(toReviewConnectionSnapshot("audio", resolution));
  }
  return { ok: true, snapshots };
}

function toReviewConnectionSnapshot(
  phase: ReviewConnectionSnapshot["phase"],
  resolution: GenerationConnectionResolution
): ReviewConnectionSnapshot {
  return {
    phase,
    connection: resolution.id,
    adapter: resolution.adapter,
    transport: resolution.transport,
    provider: resolution.provider,
    route_note: resolution.route_note,
    auth_kind: resolution.auth_kind,
    contract_digest: resolution.contract_digest,
    setup_status: resolution.setup_status
  };
}

function reviewConnectionSnapshots(document: ReviewDocument): ReviewConnectionSnapshot[] {
  return document.handoffs.flatMap((handoff) => {
    if (
      (handoff.phase !== "generation" && handoff.phase !== "audio")
      || !handoff.connection
      || !handoff.transport
      || !handoff.provider
      || !handoff.route_note
      || !handoff.auth_kind
      || !handoff.connection_contract_digest
      || !handoff.setup_status
    ) return [];
    return [{
      phase: handoff.phase,
      connection: handoff.connection,
      adapter: handoff.adapter,
      transport: handoff.transport,
      provider: handoff.provider,
      route_note: handoff.route_note,
      auth_kind: handoff.auth_kind,
      contract_digest: handoff.connection_contract_digest,
      setup_status: handoff.setup_status
    }];
  });
}

async function fingerprintGate1SourceAssets(
  configPath: string,
  project: Project,
  manifest: Manifest
): Promise<Array<{ scope: "manifest" | "project"; src: string; sha256: string }>> {
  const projectDir = dirname(resolve(configPath));
  const manifestDir = dirname(resolve(projectDir, project.manifest));
  const candidates: Array<{ scope: "manifest" | "project"; src: string }> = [
    ...manifest.clips.map((clip) => ({ scope: "manifest" as const, src: clip.src })),
    ...manifest.images.map((image) => ({ scope: "manifest" as const, src: image.src })),
    ...(["bgm", "narration", "sfx"] as const).flatMap((track) =>
      manifest.audio[track]
        .filter((entry): entry is typeof entry & { src: string } => Boolean(entry.src))
        .map((entry) => ({ scope: "manifest" as const, src: entry.src }))
    ),
    ...(project.generation?.requests ?? []).flatMap((request) => [
      ...(request.first_frame ? [{ scope: "project" as const, src: request.first_frame }] : []),
      ...(request.reference_images ?? []).map((src) => ({ scope: "project" as const, src }))
    ])
  ];
  const unique = new Map<string, { scope: "manifest" | "project"; src: string }>();
  for (const candidate of candidates) {
    unique.set(`${candidate.scope}:${candidate.src}`, candidate);
  }
  const fingerprints: Array<{ scope: "manifest" | "project"; src: string; sha256: string }> = [];
  for (const candidate of [...unique.values()].sort((left, right) =>
    `${left.scope}:${left.src}`.localeCompare(`${right.scope}:${right.src}`)
  )) {
    const base = candidate.scope === "project" ? projectDir : manifestDir;
    const sourcePath = await realpath(resolve(base, candidate.src));
    fingerprints.push({
      ...candidate,
      sha256: await fingerprintReviewSourceFile(sourcePath)
    });
  }
  return fingerprints;
}

async function fingerprintReviewSourceFile(path: string): Promise<string> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error(`review source is not a regular file: ${path}`);
  const cached = reviewSourceDigestCache.get(path);
  if (cached && sameReviewSourceIdentity(cached, before)) return cached.digest;
  const digest = await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
  const after = await stat(path);
  if (!sameReviewSourceIdentity(before, after)) {
    throw new Error(`review source changed while it was being fingerprinted: ${path}`);
  }
  reviewSourceDigestCache.set(path, {
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    digest
  });
  if (reviewSourceDigestCache.size > REVIEW_SOURCE_DIGEST_CACHE_MAX_ENTRIES) {
    const oldest = reviewSourceDigestCache.keys().next().value as string | undefined;
    if (oldest) reviewSourceDigestCache.delete(oldest);
  }
  return digest;
}

function sameReviewSourceIdentity(
  left: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  right: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function fingerprintReviewAssets(
  outputDir: string,
  document: ReviewDocument
): Promise<Array<{ path: string; sha256: string }>> {
  const realOutputDir = await realpath(outputDir);
  const previewPaths = [...new Set(
    collectReferencedAssets(document)
      .map((asset) => asset.preview_src)
      .filter((path): path is string => Boolean(path))
  )].sort();
  const fingerprints: Array<{ path: string; sha256: string }> = [];
  for (const previewPath of previewPaths) {
    const sourcePath = await realpath(resolve(outputDir, previewPath));
    if (!isPathWithin(realOutputDir, sourcePath)) {
      throw new Error(`review preview escapes review root: ${previewPath}`);
    }
    fingerprints.push({
      path: previewPath,
      sha256: createHash("sha256").update(await readFile(sourcePath)).digest("hex")
    });
  }
  return fingerprints;
}
export function createReviewDocument(
  project: Project,
  manifest: Manifest,
  plan: ExecutionPlan,
  editorial?: EditorialReview,
  composition?: CompositionReview
): ReviewDocument {
  const images = new Map(manifest.images.map((image) => [image.id, image]));
  const speakers = new Map(manifest.speakers.map((speaker) => [speaker.id, speaker]));
  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const clipTimeline = createClipTimeline(manifest.clips);
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
  const backgroundImageId = reviewBackgroundImageId(manifest);
  const background = backgroundImageId ? toReviewAsset(images.get(backgroundImageId)) : undefined;

  const storyboard = manifest.captions.length > 0
    ? manifest.captions.map((caption, index) => {
        const id = caption.id ?? `caption-${String(index + 1).padStart(2, "0")}`;
        const speaker = caption.speaker ? speakers.get(caption.speaker) : undefined;
        const imageId = caption.visual?.image_id
          ?? (speaker && caption.pose ? speaker.poses[caption.pose] : undefined);
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
          image: imageId ? toReviewAsset(images.get(imageId)) : generationReviewAsset(request),
          reference_images: generationReferenceReviewAssets(request),
          prompt: request?.prompt,
          model: request?.model,
          input_mode: request ? generationRequestMode(request) : undefined,
          motion: toReviewMotion(
            caption.visual?.motion
              ?? clips.get(id)?.motion
              ?? clipMotionForTimeRange(clipTimeline, caption.start, caption.end)
          )
        } satisfies ReviewShot;
      })
    : createFallbackStoryboard(project, manifest, images);

  const storyboardDuration = storyboard.reduce((maximum, shot) => Math.max(maximum, shot.end), 0);
  const motionDesign = createReviewMotionDesign(plan, manifest, storyboard);
  const title = manifest.presentation?.title ?? manifest.presentation?.source_title ?? project.slug;
  const configPlaceholder = "<project.yaml>";
  const gateBase = `bin/pipeline gate --config ${configPlaceholder} --actor coordinator --gate gate-1`;
  const warnings: string[] = [];
  if (backgroundImageId && !background) {
    warnings.push(`背景画像ID ${backgroundImageId} が manifest.images に見つかりません。`);
  }
  if (characters.length === 0) warnings.push("この計画にはキャラクター定義がありません。");
  if (storyboard.every((shot) => !shot.image)) {
    warnings.push("絵コンテに使用できる静止画がないため、構成ワイヤーを表示しています。");
  }
  if (manifest.presentation?.draft) warnings.push("この提案はドラフトとしてマークされています。");
  if (motionDesign.status === "unspecified") {
    warnings.push("動き・アニメーション設計が未指定です。最終確認前に、全体方針またはカット別モーションを確認してください。");
  }
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
    warnings.push("解析成果物が未生成または不整合です。最終承認には進めません。");
  }
  for (const handoff of plan.agent_handoffs) {
    if ((handoff.phase === "generation" || handoff.phase === "audio") && handoff.connection) {
      const status = handoff.setup_status ?? "needs-verification";
      warnings.push(
        `接続 '${handoff.connection}' の状態は ${status} です。最終承認前にログイン、利用権限、残クレジットを確認してください。`
      );
    }
  }

  return {
    schema_version: project.composition ? 3 : project.analysis ? 2 : 1,
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
    ...(background ? { background } : {}),
    motion_design: motionDesign,
    characters,
    storyboard,
    handoffs: plan.agent_handoffs,
    ...(plan.audio ? { audio: plan.audio } : {}),
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
    ...(project.composition
      ? {
          composition: composition
            ? createReviewComposition(project, manifest, composition)
            : {
                status: "missing" as const,
                proposals: []
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

function createReviewComposition(
  project: Project,
  manifest: Manifest,
  composition: CompositionReview
): NonNullable<ReviewDocument["composition"]> {
  const selectedProposalId = project.edit.composition?.proposal_id;
  const sourceById = new Map(manifest.clips.map((clip) => [clip.id, clip.src]));
  return {
    status: selectedProposalId ? "ready" : "selection-required",
    proposals_digest: composition.artifact.proposals_digest,
    ...(selectedProposalId ? { selected_proposal_id: selectedProposalId } : {}),
    approval_digest: composition.approvalDigest,
    ...(composition.compilation ? { edl_digest: composition.compilation.edl.digest } : {}),
    proposals: composition.artifact.proposals.map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      rationale: proposal.rationale,
      estimated_duration_seconds: proposal.estimated_duration_seconds,
      selected: proposal.id === selectedProposalId,
      segments: proposal.segments.map((segment, index) => ({
        id: segment.id ?? `${proposal.id}--segment-${String(index + 1).padStart(4, "0")}`,
        source_clip_id: segment.source_clip_id,
        ...(sourceById.get(segment.source_clip_id)
          ? { source_src: sourceById.get(segment.source_clip_id) }
          : {}),
        source_start: segment.source_start,
        source_end: segment.source_end,
        role: segment.role,
        reason: segment.reason,
        observation_ids: segment.observation_ids
      })),
      warnings: proposal.warnings ?? []
    }))
  };
}

function createFallbackStoryboard(
  project: Project,
  manifest: Manifest,
  images: Map<string, Manifest["images"][number]>
): ReviewShot[] {
  if ((project.generation?.requests.length ?? 0) > 0) {
    let cursor = 0;
    return project.generation!.requests.filter((request) => generationRequestOutputKind(request) === "video").map((request, index) => {
      const start = cursor;
      cursor += request.duration ?? 0;
      return {
        id: request.id,
        order: index + 1,
        start,
        end: cursor,
        duration: request.duration ?? 0,
        title: request.id,
        description: request.prompt,
        emphasis: [],
        badges: [],
        prompt: request.prompt,
        model: request.model,
        input_mode: generationRequestMode(request),
        image: generationReviewAsset(request),
        reference_images: generationReferenceReviewAssets(request)
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
      image: toReviewAsset(matchingImage),
      motion: toReviewMotion(clip.motion)
    };
  });
}

function createClipTimeline(clips: Manifest["clips"]): TimedManifestClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const start = cursor;
    cursor += clip.duration;
    return { clip, start, end: cursor };
  });
}

function clipMotionForTimeRange(
  timeline: TimedManifestClip[],
  captionStart: number,
  captionEnd: number
): ManifestMotionPlan | undefined {
  if (timeline.length === 1) return timeline[0]!.clip.motion;

  let bestMatch: { clip: TimedManifestClip; overlap: number } | undefined;
  for (const timedClip of timeline) {
    const overlap = Math.max(
      0,
      Math.min(captionEnd, timedClip.end) - Math.max(captionStart, timedClip.start)
    );
    if (overlap > (bestMatch?.overlap ?? 0)) bestMatch = { clip: timedClip, overlap };
  }
  return bestMatch?.clip.clip.motion;
}

function toReviewMotion(motion: ManifestMotionPlan | undefined): ReviewMotionPlan | undefined {
  if (!motion) return undefined;
  const phases = ["entrance", "emphasis", "exit", "transition_to_next"] as const;
  const cues = phases.flatMap((phase) => {
    const cue = motion[phase];
    return cue ? [{ phase, ...cue } satisfies ReviewMotionCue] : [];
  });
  if (cues.length === 0 && motion.implementation_notes.length === 0) return undefined;
  return { cues, implementation_notes: [...motion.implementation_notes] };
}

function createReviewMotionDesign(
  plan: ExecutionPlan,
  manifest: Manifest,
  storyboard: ReviewShot[]
): ReviewMotionDesign {
  const declared = manifest.presentation?.motion_design;
  const hasShotMotion = storyboard.some((shot) => Boolean(shot.motion));
  const status = declared && hasShotMotion ? "declared" : declared || hasShotMotion ? "partial" : "unspecified";
  return {
    status,
    summary: declared?.summary ?? (hasShotMotion
      ? "カット別の動きは指定されていますが、映像全体のモーション方針は未指定です。"
      : "映像全体の動きとカット別アニメーションは未指定です。"),
    ...(declared?.pacing ? { pacing: declared.pacing } : {}),
    principles: declared?.principles ?? [],
    implementation: motionImplementation(plan.backend, plan.motion_review)
  };
}

function motionImplementation(
  backend: string,
  motionReview: ExecutionPlan["motion_review"]
): ReviewMotionDesign["implementation"] {
  return {
    backend,
    surface: motionReview?.surface ?? "Backend-native composition",
    method: motionReview?.method ?? "編集backendの実装仕様に従う",
    preview: motionReview?.preview === "html-css-approximation"
      ? "HTML / CSS approximation"
      : "specification only"
  };
}

function toReviewAsset(image: Manifest["images"][number] | undefined): ReviewAsset | undefined {
  if (!image) return undefined;
  return { id: image.id, src: image.src, alt: image.alt, source_scope: "manifest" };
}

function reviewBackgroundImageId(manifest: Manifest): string | undefined {
  const presentation = (manifest.presentation ?? {}) as Record<string, unknown>;
  return stringField(presentation, "background_image_id")
    ?? stringField(presentation, "reference_image_id")
    ?? (manifest.images.some((image) => image.id === "background") ? "background" : undefined);
}

function generationReviewAsset(request: GenerationRequest | undefined): ReviewAsset | undefined {
  if (!request?.first_frame) return undefined;
  return {
    id: `${request.id}-first-frame`,
    src: request.first_frame,
    alt: `${request.id}の開始フレーム`,
    source_scope: "project"
  };
}

function generationReferenceReviewAssets(request: GenerationRequest | undefined): ReviewAsset[] {
  return (request?.reference_images ?? []).map((src, index) => ({
    id: `${request!.id}-reference-${String(index + 1).padStart(2, "0")}`,
    src,
    alt: `${request!.id}の参照画像${index + 1}`,
    source_scope: "project"
  }));
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
  const loadedComposition = options.project.composition
    ? await loadCompositionReview(configPath, options.project, options.manifest, options.stateDir)
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
      : undefined,
    loadedComposition?.ok
      ? {
          artifact: loadedComposition.artifact,
          approvalDigest: loadedComposition.approvalDigest,
          ...(loadedComposition.compilation ? { compilation: loadedComposition.compilation } : {})
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
    const sourceKey = `${asset.source_scope ?? "manifest"}:${asset.src}`;
    let previewSrc = stagedBySource.get(sourceKey);
    if (!previewSrc) {
      const sourceBase = asset.source_scope === "project" ? dirname(configPath) : manifestDir;
      const sourcePath = await realpath(resolve(sourceBase, asset.src));
      if (!isPathWithin(realAssetRoot, sourcePath)) {
        throw new Error(`review asset escapes project root: ${asset.src}`);
      }
      const assetNumber = String(stagedBySource.size + 1).padStart(3, "0");
      const filename = `${assetNumber}-${safeBasename(basename(asset.src))}`;
      await copyFile(sourcePath, resolve(assetsDir, filename));
      previewSrc = `assets/${filename}`;
      stagedBySource.set(sourceKey, previewSrc);
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

async function loadCompositionReview(
  configPath: string,
  project: Project,
  manifest: Manifest,
  stateDir?: string
): Promise<Result<CompositionReview>> {
  const distDir = stateDir
    ? resolve(stateDir)
    : resolve(dirname(resolve(configPath)), project.dist_dir);
  const analysisDir = join(distDir, project.run_id ?? project.slug, "analysis");
  try {
    const [rawText, artifactText] = await Promise.all([
      readFile(join(analysisDir, "raw-analysis.json"), "utf8"),
      readFile(join(analysisDir, "composition-proposals.json"), "utf8")
    ]);
    const raw = JSON.parse(rawText) as RawAnalysisForComposition;
    const artifact = JSON.parse(artifactText) as CompositionProposalsArtifact;
    const currentAnalysis = await verifyCompositionAnalysisInputs(
      configPath,
      project,
      manifest,
      raw
    );
    if (!currentAnalysis.ok) {
      return {
        ok: false,
        issues: currentAnalysis.issues.map((issue) => ({
          ...issue,
          code: "gate.composition_stale",
          path: issue.path ?? analysisDir
        }))
      };
    }
    const expectedBrief = project.composition?.brief;
    const verified = expectedBrief
      ? verifyCompositionProposals(
          raw,
          manifest,
          expectedBrief,
          artifact,
          project.composition!.proposals.max_count
        )
      : { ok: false as const, issues: [] };
    if (
      !expectedBrief
      || artifact.run_id !== (project.run_id ?? project.slug)
      || !verified.ok
    ) {
      return {
        ok: false,
        issues: [{
          code: "gate.composition_stale",
          message: "composition proposals do not match the current analysis, brief, or source manifest",
          path: analysisDir
        }]
      };
    }

    const selectedProposalId = project.edit.composition?.proposal_id;
    let compilation: CompositionCompilation | undefined;
    if (selectedProposalId) {
      const compiled = compileComposition(
        manifest,
        artifact as CompositionProposalArtifactInput,
        selectedProposalId,
        digest(raw)
      );
      if (!compiled.ok) {
        return {
          ok: false,
          issues: compiled.issues.map((issue) => ({
            ...issue,
            path: issue.path ?? join(analysisDir, "composition-proposals.json")
          }))
        };
      }
      compilation = {
        manifest: compiled.manifest,
        edl: compiled.edl,
        sourceDigests: Object.fromEntries(
          raw.results.map((result) => [result.source.clip_id, result.source.sha256!])
        )
      };
    }

    return {
      ok: true,
      issues: [],
      artifact,
      approvalDigest: digest({
        project_composition: project.composition,
        selected_proposal_id: selectedProposalId,
        source_manifest_digest: artifact.source_manifest_digest,
        analysis_digest: artifact.analysis_digest,
        brief_digest: artifact.brief_digest,
        proposals_digest: artifact.proposals_digest,
        composition_edl_digest: compilation?.edl.digest
      }),
      ...(compilation ? { compilation } : {})
    };
  } catch {
    return {
      ok: false,
      issues: [{
        code: "gate.composition_stale",
        message: "composition proposal artifacts are missing or invalid",
        path: analysisDir
      }]
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
    ...document.storyboard.flatMap((shot) => shot.image ?? []),
    ...document.storyboard.flatMap((shot) => shot.reference_images ?? []),
    ...(document.background ? [document.background] : [])
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
    ? `<p><b>最終承認後の適用予定:</b> ${analysis.editorial.applied_cut_ids.length}候補を削除、${formatSeconds(analysis.editorial.removed_duration_seconds)}短縮、出力${formatSeconds(analysis.editorial.output_duration_seconds)}、字幕${analysis.editorial.caption_count}件、章${analysis.editorial.chapter_count}件。</p>`
    : "";
  return `<section class="conditions" aria-labelledby="analysis-title" data-testid="analysis-review">
    <div class="section-heading"><div><p class="eyebrow">SOURCE TIMESTAMP / PROPOSED</p><h2 id="analysis-title">解析レビュー</h2></div><p>${analysis.editorial ? "明示された編集方針だけを最終承認後に適用します。" : "元動画の時刻を保った確認候補です。自動削除は行いません。"}</p></div>
    <dl class="metrics"><div><dt>文字起こしsegment</dt><dd>${transcriptCount}</dd></div><div><dt>フィラー・カット確認候補</dt><dd>${analysis.outputs.cut_points.length}</dd></div><div><dt>章</dt><dd>${analysis.outputs.chapters.length}</dd></div><div><dt>要約</dt><dd>${analysis.outputs.summaries.length}</dd></div><div><dt>翻訳字幕</dt><dd>${subtitleCount}</dd></div></dl>
    ${editorialSummary}
    ${cutPoints ? `<ul>${cutPoints}</ul>` : "<p>フィラー・カット確認候補はありません。</p>"}
  </section>`;
}

function renderCompositionReview(composition: ReviewDocument["composition"]): string {
  if (!composition) return "";
  if (composition.status === "missing") {
    return `<section class="warnings" aria-labelledby="composition-title" data-testid="composition-review"><h2 id="composition-title">構成案比較</h2><p>構成案が未生成または不整合です。composeを再実行してください。</p></section>`;
  }
  const proposals = composition.proposals.map((proposal) => {
    const segments = proposal.segments.map((segment, index) =>
      `<li data-source-clip="${escapeAttribute(segment.source_clip_id)}" data-source-start="${segment.source_start}" data-source-end="${segment.source_end}"><b>${index + 1}. ${escapeHtml(segment.role)}</b> <code>${escapeHtml(segment.source_clip_id)} ${formatTime(segment.source_start)}–${formatTime(segment.source_end)}</code><p>${escapeHtml(segment.reason)}</p>${segment.source_src ? `<small>素材: ${escapeHtml(segment.source_src)}</small>` : ""}${segment.observation_ids.length > 0 ? `<small>根拠: ${segment.observation_ids.map(escapeHtml).join(", ")}</small>` : ""}</li>`
    ).join("");
    const warnings = proposal.warnings.length > 0
      ? `<ul class="warnings">${proposal.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "";
    return `<article class="motion-shot" data-proposal-id="${escapeAttribute(proposal.id)}" data-selected="${proposal.selected}">
      <header><span>${proposal.selected ? "SELECTED" : "PROPOSAL"}</span><h3>${escapeHtml(proposal.title)}</h3><time>${formatSeconds(proposal.estimated_duration_seconds)}</time></header>
      <p>${escapeHtml(proposal.rationale)}</p>
      <ol>${segments}</ol>
      ${warnings}
    </article>`;
  }).join("");
  const status = composition.status === "selection-required"
    ? "比較後、project.yaml の edit.composition.proposal_id に採用案を明示し、reviewを再生成してください。"
    : `採用案 ${escapeHtml(composition.selected_proposal_id ?? "")} をGate 1の対象として固定します。`;
  return `<section class="motion-section" aria-labelledby="composition-title" data-testid="composition-review">
    <div class="section-heading"><div><p class="eyebrow">MULTI-SOURCE / PROPOSALS</p><h2 id="composition-title">構成案比較</h2></div><p>${status}</p></div>
    <div class="motion-score">${proposals}</div>
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
  const expectedSchemaVersion = project.composition ? 3 : project.analysis ? 2 : 1;
  return (
    document.schema_version === expectedSchemaVersion &&
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
  if (platform === "win32") return { command: "explorer.exe", args: [reviewPath] };
  return { command: "xdg-open", args: [reviewPath] };
}

export async function openCreativeReview(reviewPath: string): Promise<void> {
  const target = getReviewOpenCommand(reviewPath);
  await promisify(execFile)(target.command, target.args);
}

function renderMotionReview(document: ReviewDocument): string {
  const motionShots = document.storyboard.filter((shot) => shot.motion);
  const implementation = document.motion_design.implementation;
  const previewDescription = implementation.preview === "HTML / CSS approximation"
    ? "HTML / CSSによる近似プレビュー"
    : "仕様表示のみ";
  const principles = document.motion_design.principles.length > 0
    ? `<ul>${document.motion_design.principles.map((principle) => `<li>${escapeHtml(principle)}</li>`).join("")}</ul>`
    : `<p class="muted">全体原則は未指定です。</p>`;
  const shotRows = motionShots.length > 0
    ? motionShots.map((shot) => `<article class="motion-shot">
        <header><span>SHOT ${String(shot.order).padStart(2, "0")}</span><h3>${escapeHtml(shot.title)}</h3><time>${formatTime(shot.start)}–${formatTime(shot.end)}</time></header>
        <div class="motion-cues">${shot.motion!.cues.map(renderMotionCue).join("") || `<p class="muted">実装メモのみが指定されています。</p>`}</div>
        ${shot.motion!.implementation_notes.length > 0 ? `<ul class="motion-notes">${shot.motion!.implementation_notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
      </article>`).join("")
    : `<div class="motion-empty"><strong>個別モーションは未指定です</strong><p>各カットの <code>visual.motion</code> または <code>clip.motion</code> に、入場・強調・退場・次カットへの遷移を記述すると、ここに動きとタイミングが表示されます。</p></div>`;

  return `<section class="motion-section" aria-labelledby="motion-title" data-testid="motion-design">
    <div class="section-heading"><div><p class="eyebrow">MOTION / IMPLEMENTATION</p><h2 id="motion-title">動き・アニメーション設計</h2></div><p>カットの動き、対象レイヤー、尺、イージング、実装方法を最終確認の前に揃えます。</p></div>
    <div class="motion-overview">
      <div><span class="motion-status" data-status="${escapeAttribute(document.motion_design.status)}">${motionStatusLabel(document.motion_design.status)}</span><h3>${escapeHtml(document.motion_design.summary)}</h3>${document.motion_design.pacing ? `<p><b>テンポ:</b> ${escapeHtml(document.motion_design.pacing)}</p>` : ""}${principles}</div>
      <dl><div><dt>編集backend</dt><dd>${escapeHtml(implementation.backend)}</dd></div><div><dt>実装面</dt><dd>${escapeHtml(implementation.surface)}</dd></div><div><dt>実装方法</dt><dd>${escapeHtml(implementation.method)}</dd></div><div><dt>レビュー表示</dt><dd>${previewDescription}</dd></div><div><dt>指定済み</dt><dd>${motionShots.length} / ${document.storyboard.length}カット</dd></div></dl>
    </div>
    <div class="motion-score">${shotRows}</div>
    <p class="motion-disclaimer">この動きはレビュー用の近似表示です。最終映像は選択したbackendのフレーム計算・タイムライン実装で再現し、render後にGate 3で確認します。</p>
  </section>`;
}

function renderMotionCue(cue: ReviewMotionCue): string {
  const timing = [
    cue.duration_seconds !== undefined ? `${formatNumber(cue.duration_seconds)}秒` : undefined,
    cue.easing
  ].filter(Boolean).join(" · ");
  return `<div class="motion-cue" data-motion-preset="${escapeAttribute(cue.preset)}">
    <div class="motion-demo" aria-hidden="true"><span class="motion-demo-layer">${escapeHtml(shorten(cue.target, 16))}</span></div>
    <div><span class="motion-phase">${motionPhaseLabel(cue.phase)}</span><h4>${escapeHtml(cue.label ?? cue.description)}</h4><p>${escapeHtml(cue.description)}</p><small>${escapeHtml(cue.target)}${timing ? ` · ${escapeHtml(timing)}` : ""}</small></div>
  </div>`;
}

function renderShotMotionDetails(shot: ReviewShot): string {
  if (!shot.motion) {
    return `<div class="shot-motion-detail"><h3>動き・アニメーション</h3><p class="muted">このカットのモーションは未指定です。</p></div>`;
  }
  return `<div class="shot-motion-detail"><h3>動き・アニメーション</h3><ol>${shot.motion.cues.map((cue) => `<li><b>${motionPhaseLabel(cue.phase)}:</b> ${escapeHtml(cue.label ?? cue.description)} <span>${escapeHtml(cue.preset)}${cue.duration_seconds !== undefined ? ` / ${formatNumber(cue.duration_seconds)}秒` : ""}${cue.easing ? ` / ${escapeHtml(cue.easing)}` : ""}</span></li>`).join("")}</ol>${shot.motion.implementation_notes.length > 0 ? `<p><b>実装メモ:</b> ${shot.motion.implementation_notes.map(escapeHtml).join(" / ")}</p>` : ""}</div>`;
}

function motionStatusLabel(status: ReviewMotionDesign["status"]): string {
  if (status === "declared") return "全体・カット指定済み";
  if (status === "partial") return "一部指定";
  return "未指定";
}

function motionPhaseLabel(phase: ReviewMotionCue["phase"]): string {
  if (phase === "entrance") return "入場";
  if (phase === "emphasis") return "強調";
  if (phase === "exit") return "退場";
  return "次カットへの遷移";
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
    const motionCount = shot.motion?.cues.length ?? 0;
    return `<figure class="shot" id="shot-${escapeAttribute(shot.id)}">
      <a class="shot-index" href="#detail-${escapeAttribute(shot.id)}" aria-label="SHOT ${String(shot.order).padStart(2, "0")} の詳細へ"><b>${String(shot.order).padStart(2, "0")}</b><small>SHOT</small></a>
      <div class="shot-meta"><span>${escapeHtml(shot.speaker ?? shot.chapter ?? "VISUAL")}</span><time>${formatTime(shot.start)}–${formatTime(shot.end)}</time></div>
      <div class="frame">${image}</div>
      <figcaption><small>${escapeHtml(shot.kicker ?? shot.chapter ?? "STORYBOARD")}</small><strong>${escapeHtml(shot.title)}</strong><p>${escapeHtml(shorten(shot.description ?? "構成を確認してください。", 72))}</p>${motionCount > 0 ? `<span class="motion-count">${motionCount} MOTION CUES</span>` : ""}</figcaption>
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
  const details = document.storyboard.map((shot) => {
    const referenceImages = (shot.reference_images ?? []).length > 0
      ? `<div class="reference-images" data-testid="reference-images-${escapeAttribute(shot.id)}"><h3>外部送信する参照画像</h3><div>${(shot.reference_images ?? []).map((asset) => asset.preview_src
          ? `<figure><img src="${escapeAttribute(asset.preview_src)}" alt="${escapeAttribute(asset.alt ?? asset.id)}"><figcaption>${escapeHtml(asset.src)}</figcaption></figure>`
          : `<p class="muted">${escapeHtml(asset.src)}</p>`).join("")}</div></div>`
      : "";
    return `<details class="shot-detail" id="detail-${escapeAttribute(shot.id)}"><summary><span>SHOT ${String(shot.order).padStart(2, "0")}</span>${escapeHtml(shot.title)}<time>${formatSeconds(shot.duration)}</time></summary><div class="detail-grid"><div><h3>内容</h3><p>${escapeHtml(shot.description ?? "説明はありません。")}</p>${shot.speaker ? `<p><b>話者</b> ${escapeHtml(shot.speaker)}${shot.pose ? ` / ${escapeHtml(shot.pose)}` : ""}</p>` : ""}</div><div><h3>生成条件</h3>${shot.prompt ? `<p>${escapeHtml(shot.prompt)}</p><p class="utility">${escapeHtml([shot.model, shot.input_mode].filter(Boolean).join(" · "))}</p>` : `<p class="muted">このカットに一致する生成リクエストはありません。</p>`}${referenceImages}</div>${renderShotMotionDetails(shot)}</div></details>`;
  }).join("");
  const handoffs = document.handoffs.length > 0
    ? document.handoffs.map((handoff) => {
        const route = handoff.connection
          ? ` · ${escapeHtml(handoff.connection)}${handoff.transport ? ` via ${escapeHtml(handoff.transport.toUpperCase())}` : ""}${handoff.setup_status ? ` · SETUP: ${escapeHtml(handoff.setup_status.toUpperCase())}` : ""}`
          : "";
        return `<li><b>${escapeHtml(handoff.phase)}</b> ${escapeHtml(handoff.adapter)}${route} · ${escapeHtml(handoff.execution)} · AUTO FALLBACK OFF</li>`;
      }).join("")
    : "<li>外部エージェントへの引き継ぎはありません。</li>";
  const analysis = renderAnalysisReview(document.analysis);
  const compositionReview = renderCompositionReview(document.composition);
  const motionReview = renderMotionReview(document);
  const audioReview = document.audio
    ? `<section class="audio-section" aria-labelledby="audio-title" data-testid="audio-review">
      <div class="section-heading"><div><p class="eyebrow">SOUND / TIMING</p><h2 id="audio-title">音響設計</h2></div><p>最終承認前にBGMと効果音の内容・タイミングを確認します。未解決時は停止し、別providerへの自動切り替えは行いません。</p></div>
      <div class="audio-policy"><dl><div><dt>ADAPTER</dt><dd>${escapeHtml(document.audio.adapter ?? "未選択")}</dd></div><div><dt>FALLBACK</dt><dd>${escapeHtml(document.audio.fallback)}</dd></div><div><dt>AUTO FALLBACK</dt><dd>${document.audio.automatic_fallback ? "ON" : "OFF"}</dd></div><div><dt>EXTERNAL ACCESS</dt><dd>${document.audio.external_permission_required ? "REVIEW REQUIRED" : "NONE"}</dd></div></dl>${document.audio.transfer ? `<p class="utility">NETWORK INPUT: ${escapeHtml(document.audio.transfer.input_scope)} / REQUIRED CREDENTIAL ENV: ${escapeHtml(document.audio.transfer.credential_env.join(", ") || "none")} / OPTIONAL CREDENTIAL ENV: ${escapeHtml(document.audio.transfer.optional_credential_env.join(", ") || "none")}</p>` : ""}</div>
      <div class="audio-tracks">${document.audio.bgm ? renderAudioTrack("BGM", document.audio.bgm) : ""}${document.audio.sfx.map((track) => renderAudioTrack("SFX", track)).join("")}</div>
    </section>`
    : "";
  const backgroundReview = document.background
    ? `<section class="background-section" aria-labelledby="background-title" data-testid="background-review">
      <div class="section-heading"><div><p class="eyebrow">SCENE / BACKGROUND</p><h2 id="background-title">背景・舞台</h2></div><p>人物の後ろに置く背景板です。掛け合いの空気感と画面比率を生成前に確認します。</p></div>
      <figure class="background-plate" data-aspect="${escapeAttribute(document.summary.aspect)}">
        <div class="background-frame">${document.background.preview_src
          ? `<img src="${escapeAttribute(document.background.preview_src)}" alt="${escapeAttribute(document.background.alt ?? "選択された背景画像")}">`
          : `<div class="background-placeholder">BACKGROUND IMAGE</div>`}</div>
        <figcaption><p class="eyebrow">SELECTED BACKGROUND</p><h3>${escapeHtml(document.background.alt ?? document.background.id)}</h3><p>この画像が掛け合い全体の舞台として使われます。</p><dl><div><dt>ASSET ID</dt><dd>${escapeHtml(document.background.id)}</dd></div><div><dt>ASPECT</dt><dd>${escapeHtml(document.summary.aspect)}</dd></div></dl></figcaption>
      </figure>
    </section>`
    : "";

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
  <main id="main" data-design="joinery-review" data-material="hinoki-yakisugi" data-aspect="${escapeAttribute(document.summary.aspect)}">
    <header class="hero">
      <nav class="review-nav" aria-label="レビュー内ナビゲーション">
        <a class="wordmark" href="#main"><span class="joinery-mark" aria-hidden="true"><i></i><i></i></span><span class="wordmark-copy">TSUGITE<small>CREATIVE REVIEW</small></span></a>
        <div>${document.composition ? `<a href="#composition-title">構成案</a>` : ""}${document.background ? `<a href="#background-title">背景</a>` : ""}${document.audio ? `<a href="#audio-title">音響</a>` : ""}<a href="#storyboard-title">絵コンテ</a><a href="#motion-title">アニメーション</a><a href="#characters-title">キャラクター</a><a href="#details-title">カット詳細</a><a href="#decision-title">最終確認</a></div>
      </nav>
      <div class="hero-content">
        <div class="hero-joinery" aria-hidden="true"><span></span><i></i></div>
        <div class="hero-copy"><p class="eyebrow">映像制作の事前確認 / CREATIVE REVIEW</p><h1>${formatDisplayTitle(document.summary.title)}</h1><p class="lede">生成に進む前に、映像の流れ、動き、登場人物の一貫性、制作条件を順番に確認します。</p></div>
        <div class="review-progress" data-testid="review-progress"><span class="status-light"></span><div><small>REVIEW ORDER</small><strong>構成 → 動き → 条件</strong><p>承認判断はすべて確認した後に表示します</p></div></div>
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
    ${compositionReview}
    ${backgroundReview}
    ${audioReview}
    <section class="storyboard-section" aria-labelledby="storyboard-title">
      <div class="section-heading"><div><p class="eyebrow">SEQUENCE / TIMING</p><h2 id="storyboard-title">映像の流れ</h2></div><p>一枚ずつの材を組むように、左から時間順で構成とテンポを確認します。</p></div>
      <div class="screening-room">
        <div class="screening-toolbar"><span>継ぎ手絵コンテ / JOINERY SEQUENCE</span><span>${document.storyboard.length} SHOTS / ${formatSeconds(document.summary.storyboard_duration_seconds)}</span></div>
        <div class="film-strip" data-testid="storyboard-sheet">${storyboard}</div>
        <div class="playback-rail" aria-hidden="true"><span>IN&nbsp; ${formatTime(0)}</span><i></i><span>OUT&nbsp; ${formatTime(document.summary.storyboard_duration_seconds)}</span></div>
      </div>
    </section>
    ${motionReview}
    <section aria-labelledby="characters-title">
      <div class="section-heading"><div><p class="eyebrow">CONTINUITY</p><h2 id="characters-title">キャラクターシート</h2></div><p>表情と役割を生成前に固定します。</p></div>
      <div class="characters">${characters}</div>
    </section>
    <section class="details-section" aria-labelledby="details-title"><div class="section-heading"><div><p class="eyebrow">SHOT NOTES</p><h2 id="details-title">カット詳細</h2></div></div>${details}</section>
    <section class="conditions" aria-labelledby="conditions-title"><div class="section-heading"><div><p class="eyebrow">PRODUCTION</p><h2 id="conditions-title">制作条件</h2></div></div><ul>${handoffs}</ul><p>プロンプトガイド: ${document.prompt_guidance.length}件 / 工程: ${document.steps.length}段階</p></section>
    <section class="final-decision" id="decision-title" aria-labelledby="final-decision-heading" data-testid="gate-1-final-decision">
      <div class="final-decision-copy"><p class="eyebrow">REVIEW COMPLETE</p><h2 id="final-decision-heading">すべて確認した後の最終判断</h2><p>構成、動き、キャラクター、生成条件、音響、実装方法を確認してから選びます。このHTMLは読み取り専用です。</p></div>
      <aside class="decision"><div class="decision-status"><span></span>FINAL HUMAN CHECKPOINT</div><p class="eyebrow">Gate 1 / FINAL DECISION</p><h3>最終確認</h3><label><i class="approve-dot"></i>承認して進む</label><code>${escapeHtml(document.approval_commands.approve)}</code><label><i class="revise-dot"></i>修正へ戻す</label><code>${escapeHtml(document.approval_commands.revise)}</code><label><i class="abort-dot"></i>中止する</label><code>${escapeHtml(document.approval_commands.abort)}</code></aside>
    </section>
    <footer><span>${escapeHtml(document.run_id)}</span><span>ReviewDocument v${document.schema_version}</span></footer>
  </main>
</body>
</html>
`;
}

function renderAudioTrack(
  kind: "BGM" | "SFX",
  track: {
    id: string;
    prompt: string;
    start: number;
    end?: number;
    volume?: number;
    mode?: "generate" | "retrieve";
    query?: string;
  }
): string {
  return `<article class="audio-track"><p class="eyebrow">${kind}</p><h3>${escapeHtml(track.id)}</h3><p>${escapeHtml(track.prompt)}</p><dl><div><dt>START</dt><dd>${formatSeconds(track.start)}</dd></div>${track.end === undefined ? "" : `<div><dt>END</dt><dd>${formatSeconds(track.end)}</dd></div>`}<div><dt>VOLUME</dt><dd>${track.volume === undefined ? "default" : formatNumber(track.volume)}</dd></div>${track.mode ? `<div><dt>MODE</dt><dd>${escapeHtml(track.mode)}</dd></div>` : ""}${track.query ? `<div><dt>QUERY</dt><dd>${escapeHtml(track.query)}</dd></div>` : ""}</dl></article>`;
}

function reviewStyles(): string {
  return `
.audio-section{margin-top:66px}.audio-policy{color:var(--ink);background:var(--hinoki);border:1px solid #a58b65;padding:18px 22px}.audio-policy dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:0}.audio-policy dl div{border-left:4px solid var(--urushi);padding-left:12px}.audio-policy dt{font:700 .52rem SFMono-Regular,Consolas,monospace;color:var(--urushi);letter-spacing:.1em}.audio-policy dd{margin:6px 0 0;font:700 .7rem SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.audio-policy>p{margin:14px 0 0}.audio-tracks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.audio-track{color:var(--ink);background:var(--kinari);border:1px solid #a58b65;border-top:4px solid var(--shinchu);padding:18px}.audio-track h3{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.15rem;margin:5px 0}.audio-track p{font-size:.75rem;line-height:1.6}.audio-track dl{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 0}.audio-track dl div{min-width:90px}.audio-track dt{font:700 .5rem SFMono-Regular,Consolas,monospace;color:var(--urushi)}.audio-track dd{margin:4px 0 0;font:700 .62rem SFMono-Regular,Consolas,monospace}
.reference-images{margin-top:20px;padding-top:13px;border-top:1px solid #d1bfa0}.reference-images>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.reference-images figure{min-width:0;margin:0;background:#e2d3b8;border:1px solid #c5ad86}.reference-images img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#d5c4a6}.reference-images figcaption{padding:6px 7px;font:700 .5rem SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
:root{color-scheme:dark;--yakisugi:#171b18;--sumi:#20231e;--sumi-soft:#2d3029;--hinoki:#e7d4ae;--kinari:#f4eddf;--mokume:#c8a878;--urushi:#a63d2f;--shinchu:#b89456;--koke:#5b6655;--ink:#27251f;--ink-soft:#756b5c;--rule:rgba(75,58,36,.25);--light-rule:rgba(244,237,223,.16);--approve:#47725a;--danger:#9e3f35;font-family:"Hiragino Sans","Yu Gothic UI","Yu Gothic",system-ui,sans-serif;line-height:1.68;color:var(--kinari);background:var(--yakisugi)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{min-height:100vh;margin:0;background-color:var(--yakisugi);background-image:linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px),repeating-linear-gradient(96deg,transparent 0 39px,rgba(200,168,120,.025) 40px,transparent 43px)}body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.38;background:radial-gradient(circle at 12% 0,rgba(184,148,86,.12),transparent 32%),radial-gradient(circle at 91% 18%,rgba(166,61,47,.08),transparent 24%)}main{width:min(1460px,calc(100% - 48px));margin:0 auto;padding:28px 0 38px}.skip-link{position:fixed;left:12px;top:-60px;background:var(--urushi);color:#fff;padding:10px 14px;z-index:20}.skip-link:focus{top:12px}a{color:inherit}a:focus-visible,summary:focus-visible{outline:3px solid var(--shinchu);outline-offset:3px}.hero{position:relative;overflow:hidden;background-color:var(--hinoki);background-image:repeating-linear-gradient(2deg,transparent 0 22px,rgba(92,61,30,.035) 23px,transparent 25px),linear-gradient(112deg,rgba(255,255,255,.46),transparent 48%);color:var(--ink);border:1px solid #ad8f62;box-shadow:0 26px 70px rgba(0,0,0,.3)}.review-nav{position:relative;z-index:4;min-height:70px;display:flex;align-items:center;justify-content:space-between;gap:28px;padding:0 34px;color:var(--kinari);background:var(--sumi);border-bottom:1px solid #080a08;font:700 .65rem/1 SFMono-Regular,Consolas,monospace;letter-spacing:.08em}.review-nav::after{content:"";position:absolute;left:0;right:0;bottom:-3px;height:3px;background:linear-gradient(90deg,var(--urushi) 0 22%,var(--shinchu) 22% 31%,transparent 31%)}.review-nav a{text-decoration:none}.review-nav>div{display:flex;align-items:center;gap:27px;color:#cfc4b2}.review-nav>div a{padding:27px 0 24px;border-bottom:2px solid transparent}.review-nav>div a:hover{color:#fff;border-bottom-color:var(--shinchu)}.wordmark{display:flex;align-items:center;gap:14px}.wordmark-copy{display:flex;flex-direction:column;gap:4px;letter-spacing:.18em}.wordmark-copy small{font-size:.47rem;letter-spacing:.13em;color:#9d9385}.joinery-mark{position:relative;display:block;width:42px;height:30px}.joinery-mark i{position:absolute;display:block;width:27px;height:9px;background:var(--hinoki)}.joinery-mark i:first-child{left:0;top:3px;clip-path:polygon(0 0,100% 0,100% 45%,72% 45%,72% 100%,0 100%)}.joinery-mark i:last-child{right:0;bottom:3px;clip-path:polygon(28% 0,100% 0,100% 100%,0 100%,0 55%,28% 55%)}.joinery-mark::before,.joinery-mark::after{content:"";position:absolute;z-index:2;width:11px;height:11px;background:var(--urushi)}.joinery-mark::before{left:14px;top:8px}.joinery-mark::after{right:14px;bottom:8px}.hero-content{position:relative;isolation:isolate;display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:80px;align-items:end;min-height:410px;padding:76px 58px 68px}.hero-content::before{content:"見立てて、組んで、確かめる。";position:absolute;right:23px;top:30px;z-index:2;writing-mode:vertical-rl;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:.7rem;letter-spacing:.22em;color:rgba(39,37,31,.55)}.hero-copy,.gate-status{position:relative;z-index:3}.hero-copy{max-width:760px}.hero-joinery{position:absolute;z-index:1;left:55%;top:0;width:190px;height:100%;transform:translateX(-50%);opacity:.9;filter:drop-shadow(0 8px 9px rgba(75,48,19,.18));animation:set-joinery 800ms cubic-bezier(.2,.8,.2,1) both}.hero-joinery::before,.hero-joinery::after{content:"";position:absolute;left:0;width:100%;height:51%;background:linear-gradient(90deg,#bc9865,#e6c994 46%,#c8a36d);border-inline:1px solid rgba(89,58,28,.18)}.hero-joinery::before{top:-1px;clip-path:polygon(0 0,100% 0,100% 66%,70% 66%,70% 100%,30% 100%,30% 66%,0 66%)}.hero-joinery::after{bottom:-1px;clip-path:polygon(30% 0,70% 0,70% 34%,100% 34%,100% 100%,0 100%,0 34%,30% 34%)}.hero-joinery span{position:absolute;left:57px;top:calc(50% - 20px);z-index:2;width:76px;height:40px;background:var(--urushi);box-shadow:inset 0 0 0 1px rgba(70,16,11,.32)}.hero-joinery i{position:absolute;left:94px;top:0;z-index:3;width:1px;height:100%;background:rgba(76,49,23,.28)}@keyframes set-joinery{from{opacity:0;transform:translate(-50%,-18px)}to{opacity:.9;transform:translate(-50%,0)}}.eyebrow{font:700 .63rem/1.2 SFMono-Regular,Consolas,monospace;letter-spacing:.16em;color:var(--urushi);margin:0 0 14px}.hero h1{max-width:720px;font-family:"Hiragino Mincho ProN","Yu Mincho","YuMincho",serif;font-size:clamp(3rem,5.7vw,5.55rem);font-weight:600;line-height:1.04;letter-spacing:-.055em;margin:.06em 0 .28em;text-wrap:balance}.lede{max-width:55ch;margin:0;color:#685d4f;font-size:.9rem}.gate-status{display:grid;grid-template-columns:9px 1fr;gap:13px;align-items:start;color:var(--kinari);background:rgba(30,32,27,.96);border-top:4px solid var(--urushi);padding:22px 21px 20px;box-shadow:9px 10px 0 rgba(115,80,43,.16)}.status-light{width:8px;height:8px;margin-top:4px;background:var(--shinchu);border-radius:50%;box-shadow:0 0 0 4px rgba(184,148,86,.13)}.gate-status small{display:block;font:700 .56rem SFMono-Regular,Consolas,monospace;letter-spacing:.11em;color:#a89e8f}.gate-status strong{display:block;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:2.05rem;font-weight:600;line-height:1.1;margin:8px 0 3px}.gate-status p{margin:0;color:#bcb09f;font-size:.72rem}.metrics{display:grid;grid-template-columns:repeat(5,1fr);margin:0;background:#d8bd8f;border-top:1px solid #a8885a}.metrics div{position:relative;padding:19px 22px 21px;border-right:1px solid rgba(71,49,25,.23);background:linear-gradient(94deg,rgba(255,255,255,.18),transparent)}.metrics div::before{content:"";position:absolute;left:0;top:0;width:28px;height:3px;background:var(--urushi);transform:scaleX(0);transform-origin:left;transition:transform .22s ease}.metrics div:hover::before{transform:scaleX(1)}.metrics div:last-child{border:0}.metrics dt{font-size:.61rem;color:#6d5d49}.metrics dd{font:700 .92rem/1.25 SFMono-Regular,Consolas,monospace;margin:5px 0 0;color:var(--ink);overflow-wrap:anywhere}.warnings{color:var(--ink);border:1px solid #b69663;border-left:5px solid var(--urushi);background:var(--hinoki);padding:17px 21px;margin:24px 0 62px}.warnings h2{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1rem;margin:0}.warnings ul{margin:5px 0 0;padding-left:19px;font-size:.82rem}.section-heading{position:relative;display:flex;align-items:end;justify-content:space-between;gap:28px;margin:0 0 23px;padding:0 0 0 24px}.section-heading::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:7px;background:var(--urushi)}.section-heading::after{content:"";position:absolute;left:9px;top:3px;bottom:3px;width:2px;background:var(--shinchu)}.section-heading h2{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:clamp(2rem,3.2vw,3rem);font-weight:600;line-height:1.1;letter-spacing:-.04em;margin:0;color:var(--kinari)}.section-heading>p{color:#b3aa9d;max-width:44ch;margin:0;font-size:.8rem}section{margin:0 0 82px}.storyboard-section{margin-top:66px}.screening-room{position:relative;color:var(--ink);background-color:var(--mokume);background-image:repeating-linear-gradient(1deg,transparent 0 27px,rgba(87,56,25,.045) 28px,transparent 30px),linear-gradient(105deg,rgba(255,255,255,.3),transparent 48%);padding:0 22px 22px;border:1px solid #8f7047;box-shadow:0 20px 55px rgba(0,0,0,.26)}.screening-room::before,.screening-room::after{content:"";position:absolute;top:-10px;width:74px;height:10px;background:var(--hinoki)}.screening-room::before{left:22%}.screening-room::after{right:22%}.screening-toolbar{height:53px;display:flex;align-items:center;justify-content:space-between;color:#5e4e3b;font:700 .58rem/1 SFMono-Regular,Consolas,monospace;letter-spacing:.11em;border-bottom:1px solid rgba(73,50,26,.26)}.film-strip{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:34px 0 17px}.film-strip::before{content:"";position:absolute;left:0;right:0;top:15px;height:9px;background:linear-gradient(180deg,#775435,#a9814f);box-shadow:inset 0 2px rgba(255,255,255,.16)}.shot{position:relative;min-width:0;margin:0;background:var(--kinari);border:1px solid #9d7b4d;box-shadow:5px 7px 0 rgba(76,51,25,.18);transition:transform .2s ease,box-shadow .2s ease}.shot:hover{transform:translateY(-3px);box-shadow:7px 11px 0 rgba(76,51,25,.15)}.shot::before,.shot::after{content:"";position:absolute;z-index:2;top:-19px;width:22px;height:13px;background:#775435}.shot::before{left:22px}.shot::after{right:22px}.shot-index{position:absolute;left:12px;top:-25px;z-index:3;display:flex;align-items:baseline;gap:4px;height:29px;padding:5px 9px;background:var(--urushi);color:#fff;border:1px solid #77271f;text-decoration:none;font-family:SFMono-Regular,Consolas,monospace;box-shadow:2px 2px 0 rgba(68,35,21,.25)}.shot-index b{font-size:.78rem;line-height:1}.shot-index small{font-size:.44rem;letter-spacing:.09em}.shot-meta{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;color:#756552;font:700 .55rem/1 SFMono-Regular,Consolas,monospace;border-bottom:1px solid #d3c3a6;text-transform:uppercase}.frame{aspect-ratio:16/9;background:#d5c4a6;overflow:hidden;border-bottom:1px solid #c8b798}.frame img{display:block;width:100%;height:100%;object-fit:contain;background:#e5dac6}.wireframe{height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:11%;background:linear-gradient(135deg,#d1b98f,#eee2ca);border:7px solid rgba(255,255,255,.22)}.wireframe span{font:700 .55rem SFMono-Regular,Consolas,monospace;color:#756552}.wireframe strong{max-width:19ch;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:clamp(.92rem,1.3vw,1.16rem);font-weight:600;line-height:1.25}.shot figcaption{padding:16px 15px 17px;min-height:142px}.shot figcaption small{display:block;color:var(--urushi);font:700 .52rem SFMono-Regular,Consolas,monospace;letter-spacing:.12em}.shot figcaption strong{display:block;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1rem;line-height:1.38;margin:7px 0}.shot figcaption p{font-size:.7rem;line-height:1.65;color:#766b5c;margin:9px 0 0}.duration-track{position:relative;height:25px;border-top:1px solid #d3c3a6;background:#ded0b8;overflow:hidden}.duration-track span{display:block;height:100%;background:var(--urushi);opacity:.94}.duration-track b{position:absolute;right:8px;top:4px;font:700 .55rem SFMono-Regular,Consolas,monospace;color:var(--ink);mix-blend-mode:multiply}.playback-rail{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;color:#66533d;font:700 .53rem SFMono-Regular,Consolas,monospace;letter-spacing:.06em}.playback-rail i{height:3px;background:linear-gradient(90deg,var(--urushi),#725135 48%,#725135 52%,var(--shinchu))}.characters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.character-card{display:grid;grid-template-columns:180px 1fr;color:var(--ink);background:var(--kinari);border:1px solid #a58b65;border-top:4px solid var(--character-accent);padding:17px;gap:24px;box-shadow:6px 7px 0 rgba(0,0,0,.15)}.character-image{aspect-ratio:1;display:grid;place-items:center;background-color:#d8c5a4;background-image:linear-gradient(90deg,transparent 49%,rgba(73,54,31,.13) 50%,transparent 51%),linear-gradient(transparent 49%,rgba(73,54,31,.13) 50%,transparent 51%);background-size:34px 34px;overflow:hidden}.character-image img{max-width:100%;max-height:100%;object-fit:contain}.character-placeholder{font:700 .58rem SFMono-Regular,Consolas,monospace;color:var(--ink-soft)}.character-card h3{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.7rem;font-weight:600;line-height:1.2;margin:0}.pose-list{display:flex;flex-wrap:wrap;gap:7px;list-style:none;padding:0;margin-top:18px}.pose-list li{font:700 .58rem SFMono-Regular,Consolas,monospace;background:#e2d3b8;border:1px solid #c5ad86;padding:4px 8px}.empty{color:var(--ink);background:var(--kinari);padding:23px;border:1px dashed #a58b65}.review-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(330px,1fr);gap:34px;align-items:start}.review-layout>section{margin:0}.shot-detail{color:var(--ink);background:var(--kinari);border:1px solid #a58b65;border-bottom:0}.shot-detail:last-child{border-bottom:1px solid #a58b65}.shot-detail summary{display:grid;grid-template-columns:92px 1fr auto;gap:12px;align-items:center;min-height:63px;padding:11px 17px;cursor:pointer;font-weight:700;font-size:.86rem}.shot-detail summary:hover{background:#e9dcc5}.shot-detail summary span,.shot-detail summary time{font:700 .59rem SFMono-Regular,Consolas,monospace;color:#756552}.shot-detail summary span{color:var(--urushi)}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:5px 21px 26px;border-top:1px solid #d1bfa0}.detail-grid h3{font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--urushi)}.utility{font-family:SFMono-Regular,Consolas,monospace;font-size:.65rem}.muted{color:var(--ink-soft)}.decision{position:sticky;top:18px;color:var(--kinari);background:var(--sumi);padding:28px 26px 29px;border:1px solid #494439;border-top:6px solid var(--urushi);box-shadow:10px 12px 0 rgba(0,0,0,.19)}.decision::after{content:"要";position:absolute;right:22px;top:20px;display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(166,61,47,.65);color:var(--urushi);font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.2rem;transform:rotate(-4deg)}.decision-status{display:flex;align-items:center;gap:8px;color:#aaa091;font:700 .52rem SFMono-Regular,Consolas,monospace;letter-spacing:.11em;margin-bottom:26px}.decision-status span{width:7px;height:7px;border-radius:50%;background:var(--shinchu)}.decision h2{max-width:10ch;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.85rem;font-weight:600;line-height:1.23;margin:0}.decision>p:not(.eyebrow){color:#bdb2a2;font-size:.76rem}.decision label{display:flex;align-items:center;gap:8px;font-size:.67rem;margin:18px 0 6px;color:#d2c8b8}.decision label i{width:7px;height:7px;border-radius:50%}.approve-dot{background:var(--approve)}.revise-dot{background:var(--shinchu)}.abort-dot{background:var(--danger)}.decision code{display:block;color:#2e281f;background:var(--hinoki);border:1px solid #987a50;border-left:4px solid var(--shinchu);padding:10px 11px;overflow-wrap:anywhere;font-size:.56rem;line-height:1.55}.conditions{margin-top:80px;color:var(--ink);background:var(--hinoki);border:1px solid #aa8c60;padding:27px;background-image:linear-gradient(100deg,rgba(255,255,255,.22),transparent)}.conditions .section-heading h2{color:var(--ink)}.conditions .section-heading>p{color:var(--ink-soft)}.conditions ul{padding-left:20px}.conditions>p{color:var(--ink-soft);font-size:.75rem}footer{display:flex;justify-content:space-between;border-top:1px solid var(--light-rule);padding-top:18px;color:#968e82;font:700 .58rem SFMono-Regular,Consolas,monospace}
main[data-aspect="9:16"] .frame{aspect-ratio:9/16}
.background-section{margin-top:66px}.background-plate{position:relative;display:grid;grid-template-columns:minmax(0,1.75fr) minmax(270px,.65fr);margin:0;color:var(--ink);background:var(--hinoki);border:1px solid #9d7b4d;box-shadow:8px 10px 0 rgba(0,0,0,.18)}.background-plate::before,.background-plate::after{content:"";position:absolute;z-index:2;width:68px;height:11px;background:var(--mokume);border:1px solid rgba(87,56,25,.25)}.background-plate::before{left:18%;top:-6px}.background-plate::after{right:18%;bottom:-6px}.background-frame{position:relative;min-height:320px;aspect-ratio:16/9;overflow:hidden;background:var(--sumi);border-right:1px solid #9d7b4d}.background-frame::after{content:"背景板";position:absolute;left:14px;bottom:14px;padding:6px 9px;color:var(--kinari);background:rgba(23,27,24,.83);font:700 .54rem SFMono-Regular,Consolas,monospace;letter-spacing:.12em}.background-frame img{display:block;width:100%;height:100%;object-fit:cover}.background-placeholder{height:100%;display:grid;place-items:center;color:#a69a88;font:700 .62rem SFMono-Regular,Consolas,monospace;letter-spacing:.16em}.background-plate figcaption{align-self:stretch;display:flex;flex-direction:column;justify-content:center;padding:34px 30px;background-image:repeating-linear-gradient(2deg,transparent 0 23px,rgba(92,61,30,.04) 24px,transparent 26px)}.background-plate figcaption h3{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.55rem;font-weight:600;line-height:1.38;margin:0}.background-plate figcaption>p:not(.eyebrow){color:var(--ink-soft);font-size:.76rem}.background-plate figcaption dl{display:grid;gap:10px;margin:24px 0 0}.background-plate figcaption dl div{display:grid;grid-template-columns:70px 1fr;gap:12px;padding-top:8px;border-top:1px solid rgba(75,58,36,.2)}.background-plate figcaption dt{font:700 .53rem SFMono-Regular,Consolas,monospace;color:var(--urushi);letter-spacing:.1em}.background-plate figcaption dd{margin:0;font:700 .65rem SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.background-plate[data-aspect="9:16"]{grid-template-columns:minmax(280px,.8fr) minmax(270px,1fr)}.background-plate[data-aspect="9:16"] .background-frame{justify-self:center;width:min(100%,430px);aspect-ratio:9/16;border-left:1px solid #9d7b4d}
.hero-copy,.review-progress{position:relative;z-index:3}.review-progress{display:grid;grid-template-columns:9px 1fr;gap:13px;align-items:start;color:var(--kinari);background:rgba(30,32,27,.96);border-top:4px solid var(--shinchu);padding:22px 21px 20px;box-shadow:9px 10px 0 rgba(115,80,43,.16)}.review-progress small{display:block;font:700 .56rem SFMono-Regular,Consolas,monospace;letter-spacing:.11em;color:#a89e8f}.review-progress strong{display:block;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.35rem;font-weight:600;line-height:1.35;margin:8px 0 5px}.review-progress p{margin:0;color:#bcb09f;font-size:.7rem}.motion-count{display:inline-flex!important;margin-top:12px;padding:4px 7px;color:var(--kinari)!important;background:var(--koke);font:700 .48rem SFMono-Regular,Consolas,monospace!important;letter-spacing:.08em!important}.motion-section{margin-top:82px}.motion-overview{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr);gap:30px;color:var(--ink);background:var(--hinoki);border:1px solid #9d7b4d;padding:28px 30px;box-shadow:7px 9px 0 rgba(0,0,0,.16)}.motion-overview h3{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.6rem;line-height:1.4;margin:13px 0 8px}.motion-overview p,.motion-overview li{font-size:.76rem}.motion-status{display:inline-block;padding:5px 9px;color:#fff;background:var(--koke);font:700 .55rem SFMono-Regular,Consolas,monospace;letter-spacing:.08em}.motion-status[data-status="unspecified"]{background:var(--urushi)}.motion-status[data-status="partial"]{color:var(--ink);background:var(--shinchu)}.motion-overview dl{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:0;background:rgba(75,58,36,.2);border:1px solid rgba(75,58,36,.2)}.motion-overview dl div{min-width:0;padding:11px 12px;background:var(--kinari)}.motion-overview dt{font:700 .5rem SFMono-Regular,Consolas,monospace;color:var(--urushi);letter-spacing:.08em}.motion-overview dd{margin:5px 0 0;font-size:.68rem;overflow-wrap:anywhere}.motion-score{display:grid;gap:15px;margin-top:16px}.motion-shot{color:var(--ink);background:var(--kinari);border:1px solid #a58b65}.motion-shot>header{display:grid;grid-template-columns:80px 1fr auto;gap:13px;align-items:center;padding:13px 17px;background:#dfceb0;border-bottom:1px solid #c4aa80}.motion-shot>header span,.motion-shot>header time{font:700 .55rem SFMono-Regular,Consolas,monospace;color:var(--urushi)}.motion-shot>header h3{margin:0;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.05rem}.motion-cues{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1px;background:#cdb994}.motion-cue{display:grid;grid-template-columns:92px 1fr;gap:14px;min-width:0;padding:15px;background:var(--kinari)}.motion-cue h4{font-size:.77rem;line-height:1.35;margin:5px 0}.motion-cue p{font-size:.65rem;line-height:1.5;margin:0}.motion-cue small{display:block;margin-top:7px;color:var(--ink-soft);font:700 .52rem SFMono-Regular,Consolas,monospace}.motion-phase{color:var(--urushi);font:700 .5rem SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.motion-demo{position:relative;height:68px;overflow:hidden;background:linear-gradient(135deg,#242922,#474b40);border:1px solid #171b18}.motion-demo::before{content:"";position:absolute;inset:8px;border:1px solid rgba(244,237,223,.14)}.motion-demo-layer{position:absolute;left:13px;right:13px;top:22px;padding:5px 6px;color:#fff;background:var(--urushi);font:700 .48rem SFMono-Regular,Consolas,monospace;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;will-change:transform,opacity,clip-path;animation-duration:3.2s;animation-iteration-count:infinite;animation-timing-function:ease-in-out}.motion-cue[data-motion-preset="fade"] .motion-demo-layer{animation-name:motion-fade}.motion-cue[data-motion-preset="slide-left"] .motion-demo-layer{animation-name:motion-slide-left}.motion-cue[data-motion-preset="slide-right"] .motion-demo-layer{animation-name:motion-slide-right}.motion-cue[data-motion-preset="rise"] .motion-demo-layer{animation-name:motion-rise}.motion-cue[data-motion-preset="zoom-in"] .motion-demo-layer{animation-name:motion-zoom-in}.motion-cue[data-motion-preset="zoom-out"] .motion-demo-layer{animation-name:motion-zoom-out}.motion-cue[data-motion-preset="pan-left"] .motion-demo-layer{animation-name:motion-pan-left}.motion-cue[data-motion-preset="pan-right"] .motion-demo-layer{animation-name:motion-pan-right}.motion-cue[data-motion-preset="parallax"] .motion-demo-layer{animation-name:motion-parallax}.motion-cue[data-motion-preset="pulse"] .motion-demo-layer{animation-name:motion-pulse}.motion-cue[data-motion-preset="wipe"] .motion-demo-layer{animation-name:motion-wipe}.motion-notes{margin:0;padding:10px 22px 13px 38px;border-top:1px solid #d1bfa0;font-size:.68rem}.motion-empty{color:var(--ink);background:var(--hinoki);border:1px dashed #9d7b4d;padding:24px}.motion-empty strong{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.15rem}.motion-empty p{max-width:80ch;font-size:.75rem}.motion-disclaimer{margin:13px 0 0;color:#aaa093;font-size:.7rem}.shot-motion-detail{grid-column:1/-1;padding-top:4px;border-top:1px solid #d1bfa0}.shot-motion-detail ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px;padding-left:20px}.shot-motion-detail li{font-size:.72rem}.shot-motion-detail li span{color:var(--ink-soft);font:700 .58rem SFMono-Regular,Consolas,monospace}.final-decision{display:grid;grid-template-columns:minmax(0,1fr) minmax(380px,.85fr);gap:48px;align-items:center;margin-top:96px;padding:46px;color:var(--kinari);background:linear-gradient(112deg,#252a23,#171b18);border:1px solid #494439;border-top:8px solid var(--urushi);box-shadow:0 26px 70px rgba(0,0,0,.3)}.final-decision-copy h2{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:clamp(2.2rem,4vw,4rem);font-weight:600;line-height:1.12;margin:0}.final-decision-copy>p:not(.eyebrow){max-width:45ch;color:#bdb2a2}.final-decision .decision{position:relative;top:auto;box-shadow:9px 11px 0 rgba(0,0,0,.22)}.decision h3{max-width:10ch;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:1.85rem;font-weight:600;line-height:1.23;margin:0}@keyframes motion-fade{0%,100%{opacity:0}22%,72%{opacity:1}}@keyframes motion-slide-left{0%,100%{opacity:0;transform:translateX(-55px)}25%,72%{opacity:1;transform:translateX(0)}}@keyframes motion-slide-right{0%,100%{opacity:0;transform:translateX(55px)}25%,72%{opacity:1;transform:translateX(0)}}@keyframes motion-rise{0%,100%{opacity:0;transform:translateY(24px)}25%,72%{opacity:1;transform:translateY(0)}}@keyframes motion-zoom-in{0%,100%{opacity:0;transform:scale(.72)}25%,72%{opacity:1;transform:scale(1)}}@keyframes motion-zoom-out{0%,100%{opacity:0;transform:scale(1.35)}25%,72%{opacity:1;transform:scale(1)}}@keyframes motion-pan-left{0%,100%{transform:translateX(26px)}50%{transform:translateX(-26px)}}@keyframes motion-pan-right{0%,100%{transform:translateX(-26px)}50%{transform:translateX(26px)}}@keyframes motion-parallax{0%,100%{transform:translate(-20px,8px) rotate(-2deg)}50%{transform:translate(16px,-5px) rotate(1deg)}}@keyframes motion-pulse{0%,100%{transform:scale(1)}35%{transform:scale(1.14)}52%{transform:scale(1)}}@keyframes motion-wipe{0%,100%{clip-path:inset(0 100% 0 0)}28%,72%{clip-path:inset(0 0 0 0)}}
@media(max-width:1199px){.film-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.review-layout{grid-template-columns:1fr}.decision{position:static}.hero-content{grid-template-columns:minmax(0,1fr) 255px;gap:50px}.hero-joinery{left:57%;width:150px}.metrics{grid-template-columns:repeat(3,1fr)}.metrics div:nth-child(3){border-right:0}.metrics div:nth-child(n+4){border-top:1px solid rgba(71,49,25,.23)}}
@media(max-width:800px){main{width:min(100% - 24px,1460px);padding-top:12px}.review-nav{padding:0 20px}.review-nav>div{display:none}.hero-content{grid-template-columns:1fr;min-height:0;padding:58px 26px 42px}.hero-content::before{display:none}.hero-copy{min-width:0;padding-right:52px}.hero h1{max-width:100%;word-break:keep-all;overflow-wrap:anywhere;text-wrap:wrap}.hero-joinery{left:auto;right:14px;width:90px;transform:none;opacity:.42;animation:none}.hero-joinery span{left:27px;width:36px}.hero-joinery i{left:44px}.gate-status{max-width:330px;margin-top:14px}.metrics{grid-template-columns:repeat(2,1fr)}.metrics div:nth-child(3){border-right:1px solid rgba(71,49,25,.23)}.metrics div:nth-child(even){border-right:0}.metrics div:nth-child(n+3){border-top:1px solid rgba(71,49,25,.23)}.film-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.characters{grid-template-columns:1fr}.character-card{grid-template-columns:140px 1fr}.section-heading{display:block}.section-heading>p{margin-top:10px}.detail-grid{grid-template-columns:1fr}.shot-detail summary{grid-template-columns:70px 1fr}.shot-detail summary time{display:none}.screening-room{padding-inline:14px}.screening-room::before,.screening-room::after{width:45px}}
@media(max-width:800px){.background-plate,.background-plate[data-aspect="9:16"]{grid-template-columns:1fr}.background-frame,.background-plate[data-aspect="9:16"] .background-frame{justify-self:stretch;width:100%;min-height:0;aspect-ratio:16/9;border:0;border-bottom:1px solid #9d7b4d}.background-plate[data-aspect="9:16"] .background-frame{justify-self:center;width:min(100%,360px);aspect-ratio:9/16;border-inline:1px solid #9d7b4d}.background-plate figcaption{padding:26px 24px}.background-plate::before{left:12%}.background-plate::after{right:12%}}
@media(max-width:1199px){.motion-cues{grid-template-columns:repeat(2,minmax(0,1fr))}.final-decision{grid-template-columns:1fr}.motion-overview{grid-template-columns:1fr}.review-progress{max-width:310px}}
@media(max-width:800px){.review-progress{max-width:330px;margin-top:14px}.motion-cues{grid-template-columns:1fr}.motion-cue{grid-template-columns:82px 1fr}.motion-overview{padding:22px}.motion-overview dl{grid-template-columns:1fr}.motion-shot>header{grid-template-columns:70px 1fr}.motion-shot>header time{display:none}.shot-motion-detail ol{grid-template-columns:1fr}.final-decision{padding:28px 22px;gap:26px}}
@media(max-width:520px){.hero h1{font-size:clamp(2.25rem,11vw,2.7rem);line-height:1.12}.hero-copy{padding-right:20px}.hero-joinery{right:-13px;width:72px;opacity:.28}.hero-joinery span{left:21px;width:30px}.hero-joinery i{left:35px}.screening-room{overflow:hidden}.film-strip{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-color:var(--urushi) transparent;scrollbar-width:thin}.film-strip .shot{flex:0 0 min(82vw,330px);scroll-snap-align:start}.metrics{grid-template-columns:1fr}.metrics div,.metrics div:nth-child(3),.metrics div:nth-child(even){border-right:0}.metrics div:nth-child(n+2){border-top:1px solid rgba(71,49,25,.23)}.character-card{grid-template-columns:1fr}.character-image{max-width:180px}.screening-toolbar span:first-child{display:none}.shot figcaption{min-height:auto}.section-heading h2{font-size:2.1rem}.review-layout{gap:20px}.wordmark-copy small{display:none}.decision::after{display:none}.background-plate figcaption h3{font-size:1.35rem}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{@page{size:landscape;margin:10mm}:root{--yakisugi:#fff;--kinari:#fff;--hinoki:#fff;--sumi:#000;--ink:#000;--ink-soft:#444}body{background:#fff;color:#000}body::before{display:none}main{width:100%;padding:0}.review-nav{display:none}.hero{border:0;box-shadow:none;background:#fff}.hero-content{min-height:0;padding:0}.hero-content::before,.hero-joinery{display:none}.hero h1,.section-heading h2{color:#000}.review-progress{background:#fff;color:#000;border:1px solid #000;box-shadow:none}.metrics{border:1px solid #777;background:#fff}.metrics div{border-color:#777!important;background:#fff}.screening-room{background:#fff;padding:0;box-shadow:none}.screening-room::before,.screening-room::after{display:none}.film-strip{grid-template-columns:repeat(4,1fr)}.film-strip::before,.shot::before,.shot::after{background:#000}.shot{box-shadow:none;border-color:#777;break-inside:avoid}.shot-index{background:#fff;color:#000;border-color:#000}.character-card,.motion-overview{box-shadow:none}.motion-demo{border-color:#000}.shot-detail[open] .detail-grid,.shot-detail .detail-grid{display:grid}.final-decision{display:grid;background:#fff;color:#000;border:2px solid #000;box-shadow:none}.decision{position:static;box-shadow:none;border:2px solid #000;background:#fff;color:#000}.decision::after{display:none}.decision>p:not(.eyebrow),.decision label{color:#333}.decision code{background:#eee;color:#000;border-color:#777}.conditions{background:#fff}.skip-link{display:none}}
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

function formatDisplayTitle(value: string): string {
  return escapeHtml(value)
    .replace(/([A-Za-z0-9])(?=[^\x00-\x7F])/g, "$1<wbr>")
    .replace(/([^\x00-\x7F])(?=[A-Za-z0-9])/g, "$1<wbr>");
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
