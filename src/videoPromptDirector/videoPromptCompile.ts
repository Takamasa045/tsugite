/**
 * video_prompt authoring compile / planning (P3–P4).
 * No provider network calls. Fail-closed on unknown/stale/unsupported/exact-route mismatch.
 */

import { generationRequestOutputKind, type GenerationRequest, type Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { resolveAdapterImplementation } from "./adapterImplementation.js";
import {
  buildAssetFields
} from "./assetBinding.js";
import {
  loadConnectionCapabilityProfile,
  type ConnectionCapabilityProfile
} from "./connectionCapability.js";
import {
  hasVideoPromptField,
  rejectDualAuthoring,
  rejectUncompiledVideoPrompt,
  VIDEO_PROMPT_DUAL_AUTHORING_CODE,
  VIDEO_PROMPT_UNCOMPILED_CODE
} from "./dualAuthoring.js";
import {
  evaluatePlanningReadiness,
  type PlanningReadinessResult
} from "./executionReadiness.js";
import { buildLineage, VIDEO_PROMPT_WORKFLOW_ID, VIDEO_PROMPT_WORKFLOW_VERSION } from "./lineage.js";
import {
  loadModelPromptProfile,
  requiredSemanticsForMode,
  type ModelPromptProfile
} from "./modelProfile.js";
import { renderVideoPrompt } from "./render/index.js";
import type { H3CreativeIr, VideoCreativeIr } from "./schema.js";
import { mapMode, type H3Compilation, type CompileH3RequestResult } from "./compile.js";
import { compileLegacyH3V1, compileVideoPromptIrV2, type VideoPromptV2Compilation } from "./compileV2.js";
import { assertHomogeneousRouteIdentity, routeFromProfiles } from "./effectiveContract.js";
import { safeParseVideoPromptIrV2, type VideoPromptIrV2 } from "./schemaV2.js";
import { upgradeH3V1ToVideoPromptV2, upgradeVideoPromptV1ToV2 } from "./upgradeV1.js";
import { finalizeValidation, issue, type H3Issue } from "./validation/types.js";
import { validateH3CreativeIr } from "./validation/index.js";
import { h3IssueToProjectIssue } from "./compile.js";
import type { GenerationUnitProgramSourceV1 } from "../productionControl/programBinding.js";
import { loadAdapterDialectCapability } from "./adapterDialect.js";
import {
  consumeGenerationUnitLyricsToken,
  type TrustedGenerationUnitLyricsToken
} from "./generationUnitSourceResolver.js";
import { loadPinnedH3GrammarProfile, type H3GrammarProfileV3 } from "./render/h3GrammarV3.js";
import { compilationRevisionId, readCompilationBundleAtomic, writeCompilationBundleAtomic, writeShadowComparisonAtomic } from "./compilationBundle.js";
import { resolve } from "node:path";
import { sha256Text } from "../integrity/canonical.js";

export {
  VIDEO_PROMPT_DUAL_AUTHORING_CODE,
  VIDEO_PROMPT_UNCOMPILED_CODE,
  rejectDualAuthoring,
  rejectUncompiledVideoPrompt
} from "./dualAuthoring.js";

export type GenerationUnitSourceResolver = (input: {
  project: Project;
  request: GenerationRequest;
  ir: VideoPromptIrV2;
  requestIndex: number;
}) => GenerationUnitProgramSourceV1 | undefined | Promise<GenerationUnitProgramSourceV1 | undefined>;

export type CompileVideoPromptOptions = {
  connectionId: string;
  /**
   * Explicit implemented adapter ids. Preferred.
   * Caller boolean alone is never trusted (see resolveAdapterImplementation).
   */
  implementedAdapterIds?: readonly string[];
  /**
   * @deprecated Advisory only. Ignored unless adapter_id is also in implementedAdapterIds
   * or present in the adapter registry.
   */
  adapterImplemented?: boolean;
  /** Catalog presence is advisory only. */
  catalogPresent?: boolean;
  modelProfileRoots?: string[];
  connectionProfileRoots?: string[];
  adapterDirs?: string[];
  intent?: "planning" | "dry-run" | "execute";
  generationUnitSource?: GenerationUnitProgramSourceV1;
  generationUnitSourceByRequestId?: Readonly<Record<string, GenerationUnitProgramSourceV1>>;
  generationUnitSourceResolver?: GenerationUnitSourceResolver;
  requestIndex?: number;
  require_exact_sync?: boolean;
  /** Repo-local pinned grammar loaded by the project entrypoint. */
  grammar_profile?: H3GrammarProfileV3;
  require_pinned_grammar?: boolean;
  grammarProfileRoot?: string;
  /** Compiler-internal opaque token; callers cannot manufacture lyrics authority. */
  generationUnitLyricsToken?: TrustedGenerationUnitLyricsToken;
  compilationArtifactRoot?: string;
  /** Safe durable run/plan revision under compilationArtifactRoot. */
  revision_id?: string;
  shadowArtifactRoot?: string;
};

export type VideoPromptPlan = {
  model_profile: ModelPromptProfile;
  model_profile_digest: string;
  connection_profile: ConnectionCapabilityProfile;
  connection_capability_digest: string;
  readiness: Extract<PlanningReadinessResult, { ok: true }>;
  compilation: H3Compilation;
  /** Present when the request crossed the V2 single-compiler boundary. */
  v2_compilation?: VideoPromptV2Compilation;
  compiler_workflow?: "video-prompt-v3" | "video-prompt-director";
};

export type CompileVideoPromptResult =
  | { ok: true; plan: VideoPromptPlan; issues: [] }
  | { ok: false; plan?: VideoPromptPlan; issues: H3Issue[] };

/**
 * Compile a video_prompt IR for planning / dry-run only.
 * Requires model profile + exact connection capability + verified adapter implementation.
 */
export async function compileVideoPromptRequest(
  request: GenerationRequest,
  ir: VideoCreativeIr | H3CreativeIr,
  options: CompileVideoPromptOptions
): Promise<CompileVideoPromptResult> {
  const issues: H3Issue[] = [];
  issues.push(...rejectDualAuthoring(request));
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const v2 = safeParseVideoPromptIrV2(ir);
  if (v2.success) {
    return compileVideoPromptV2Request(request, v2.data, options);
  }

  // Legacy request.h3 is read-only authoring. Upgrade it in memory and send
  // the result through the same V2 compiler boundary; the source request is
  // restored by the project projection below and is never rewritten.
  if (request.h3 && request.h3 === ir) {
    try {
      const upgraded = upgradeH3V1ToVideoPromptV2(request.h3);
      return compileVideoPromptV2Request(request, upgraded.ir, options, {
        authoring_schema: "H3-V1",
        upgrader_version: "h3-v1-to-v2@1",
        source_digest: upgraded.source_sha256
      });
    } catch (error) {
      return { ok: false, issues: [issue("VPD-U001", error instanceof Error ? error.message : "legacy H3 upgrade failed", "error", ["h3"])] };
    }
  }

  const modelLoad = await loadModelPromptProfile(ir.target.model, options.modelProfileRoots);
  if (!modelLoad.ok) {
    issues.push(issue(modelLoad.code, modelLoad.message, "error", ["target", "model"]));
    return { ok: false, issues };
  }

  const connectionLoad = await loadConnectionCapabilityProfile(
    options.connectionId,
    options.connectionProfileRoots
  );
  if (!connectionLoad.ok) {
    issues.push(issue(connectionLoad.code, connectionLoad.message, "error", ["connection"]));
    return { ok: false, issues };
  }

  const adapterCheck = await resolveAdapterImplementation({
    adapterId: connectionLoad.profile.adapter_id,
    implementedAdapterIds: options.implementedAdapterIds,
    adapterDirs: options.adapterDirs,
    callerClaimsImplemented: options.adapterImplemented
  });
  if (!adapterCheck.ok) {
    issues.push(issue(adapterCheck.code, adapterCheck.message, "error", ["connection", "adapter_id"]));
  }

  // Provider-neutral: only profile-declared modes.*.required_semantics.
  // Do not hardcode H3 l2va/fl2va from mode (exclusiveSemanticsForMode is H3-only helper).
  const semantics = requiredSemanticsForMode(modelLoad.profile, ir.target.mode);
  const readiness = evaluatePlanningReadiness({
    modelProfile: modelLoad.profile,
    connectionProfile: connectionLoad.profile,
    mode: ir.target.mode,
    semantics,
    adapterImplemented: adapterCheck.ok,
    catalogPresent: options.catalogPresent,
    intent: options.intent ?? "planning"
  });

  if (!readiness.ok) {
    issues.push(issue(readiness.code, readiness.message, "error", ["target", "mode"]));
  }

  // A profile-declared grammar renderer selects the legacy V1 compatibility
  // upgrader. The core must not identify that route by a vendor/model id;
  // model profiles are the only authority for renderer selection.
  if (modelLoad.profile.renderer === "h3-grammar") {
    try {
      const upgraded = upgradeVideoPromptV1ToV2(ir as VideoCreativeIr);
      return compileVideoPromptV2Request(request, upgraded.ir, options, {
        authoring_schema: "V1",
        upgrader_version: "video-prompt-v1-to-v2@1",
        source_digest: upgraded.source_sha256
      });
    } catch (error) {
      issues.push(issue("VPD-U001", error instanceof Error ? error.message : "legacy video_prompt upgrade failed", "error", ["video_prompt"]));
      return { ok: false, issues };
    }
  }

  // Profile is mandatory for renderVideoPrompt (no default-H3 fallback).
  const rendered = renderVideoPrompt(ir as H3CreativeIr, modelLoad.profile);
  const validation = validateH3CreativeIr(ir as H3CreativeIr, {
    renderedText: undefined,
    includeWarnings: false
  });
  // Plain-prompt skips H3 section grammar checks (H3-E001..) which require H3 sections.
  // Renderer-independent issues (LOCK-* / scene.* / identity.*) still apply.
  issues.push(
    ...validation.issues.filter(
      (item) =>
        item.code.startsWith("LOCK-")
        || item.code.startsWith("scene.")
        || item.code.startsWith("identity.")
        || item.code.startsWith("iteration.")
    )
  );

  const mapping = mapMode(ir.target.mode);
  const assetFields = buildAssetFields(ir as H3CreativeIr);
  const executionRequest = buildExecutionRequest(
    request,
    ir as H3CreativeIr,
    mapping,
    assetFields,
    rendered.text
  );

  // Authoring IR must never appear on execution_request (H3).
  assertNoAuthoringIr(executionRequest, issues);

  const finalValidation = finalizeValidation(issues);
  const lineage = buildLineage(
    ir as H3CreativeIr,
    rendered.text,
    rendered.text,
    request,
    {
      workflow_id: VIDEO_PROMPT_WORKFLOW_ID,
      workflow_version: VIDEO_PROMPT_WORKFLOW_VERSION,
      model_profile_digest: modelLoad.digest,
      connection_capability_digest: connectionLoad.digest
    }
  );

  const compilation: H3Compilation = {
    request_id: request.id,
    creative_ir: ir as H3CreativeIr,
    canonical_prompt: rendered.text,
    adapter_prompt: rendered.text,
    validation: finalValidation,
    lineage,
    execution_request: executionRequest
  };

  if (!finalValidation.ok || !readiness.ok || !adapterCheck.ok) {
    return {
      ok: false,
      plan: readiness.ok && adapterCheck.ok
        ? {
            model_profile: modelLoad.profile,
            model_profile_digest: modelLoad.digest,
            connection_profile: connectionLoad.profile,
            connection_capability_digest: connectionLoad.digest,
            readiness,
            compilation
          }
        : undefined,
      issues: finalValidation.errors.length > 0 ? finalValidation.errors : issues
    };
  }

  return {
    ok: true,
    plan: {
      model_profile: modelLoad.profile,
      model_profile_digest: modelLoad.digest,
      connection_profile: connectionLoad.profile,
      connection_capability_digest: connectionLoad.digest,
      readiness,
      compilation
    },
    issues: []
  };
}

async function compileVideoPromptV2Request(
  request: GenerationRequest,
  ir: VideoPromptIrV2,
  options: CompileVideoPromptOptions,
  source?: {
    authoring_schema: "VideoPromptIrV2" | "V1" | "H3-V1";
    upgrader_version: string;
    source_digest?: string;
  }
): Promise<CompileVideoPromptResult> {
  const issues: H3Issue[] = [];
  const modelLoad = await loadModelPromptProfile(ir.target.model_profile_id, options.modelProfileRoots);
  if (!modelLoad.ok) return { ok: false, issues: [issue(modelLoad.code, modelLoad.message, "error", ["target", "model_profile_id"])] };
  const connectionLoad = await loadConnectionCapabilityProfile(options.connectionId, options.connectionProfileRoots);
  if (!connectionLoad.ok) return { ok: false, issues: [issue(connectionLoad.code, connectionLoad.message, "error", ["connection"])] };
  const adapterDialectLoad = await loadAdapterDialectCapability(
    connectionLoad.profile.adapter_id ?? "",
    options.adapterDirs,
    {
      model_profile_id: modelLoad.profile.id,
      provider_model: (connectionLoad.profile.exact_model_routes.find((candidate) => candidate.model === modelLoad.profile.id)?.provider_model) ?? "",
      mode: ir.target.mode
    }
  );
  if (!adapterDialectLoad.ok) return { ok: false, issues: [issue(adapterDialectLoad.code, adapterDialectLoad.message, "error", ["connection", "adapter_id"])] };
  const adapterCheck = await resolveAdapterImplementation({
    adapterId: connectionLoad.profile.adapter_id,
    implementedAdapterIds: options.implementedAdapterIds,
    adapterDirs: options.adapterDirs,
    callerClaimsImplemented: options.adapterImplemented
  });
  if (!adapterCheck.ok) issues.push(issue(adapterCheck.code, adapterCheck.message, "error", ["connection", "adapter_id"]));
  const readiness = evaluatePlanningReadiness({
    modelProfile: modelLoad.profile,
    connectionProfile: connectionLoad.profile,
    mode: ir.target.mode,
    semantics: requiredSemanticsForMode(modelLoad.profile, ir.target.mode),
    adapterImplemented: adapterCheck.ok,
    catalogPresent: options.catalogPresent,
    intent: options.intent ?? "planning"
  });
  if (!readiness.ok) issues.push(issue(readiness.code, readiness.message, "error", ["target", "mode"]));
  const selectedRoute = routeFromProfiles({
    model: ir.target.model_profile_id,
    mode: ir.target.mode,
    model_profile: modelLoad.profile,
    connection_profile: connectionLoad.profile,
    model_profile_digest: modelLoad.digest,
    connection_profile_digest: connectionLoad.digest
  });
  if (!selectedRoute.ok) issues.push(...selectedRoute.issues);
  if (!selectedRoute.ok || !adapterCheck.ok) return { ok: false, issues };
  const requireExactSync = options.require_exact_sync ?? ir.shots.some((shot) => shot.vocal_events.some((event) => event.kind === "singing" && event.content.source === "lyrics-cue"));
  const compiled = compileVideoPromptIrV2(ir, {
    request_id: request.id,
    route: selectedRoute.route,
    model_profile: modelLoad.profile,
    connection_profile: connectionLoad.profile,
    model_profile_digest: modelLoad.digest,
    connection_capability_digest: connectionLoad.digest,
    intent: options.intent === "execute" ? "execute" : "planning",
    require_exact_sync: requireExactSync,
    request_index: options.requestIndex,
    ...(options.generationUnitSource ? { generation_unit_source: options.generationUnitSource } : {}),
    ...(options.generationUnitLyricsToken ? { generation_unit_lyrics_token: options.generationUnitLyricsToken } : {}),
    ...(options.grammar_profile ? { grammar_profile: options.grammar_profile } : {}),
    require_pinned_grammar: options.require_pinned_grammar,
    adapter_dialect_capability: adapterDialectLoad.capability,
    ...(source ? { source } : {})
  });
  issues.push(...compiled.issues);
  const v2Compilation = compiled.compilation;
  if (!v2Compilation) return { ok: false, issues };
  if (!v2Compilation.bundle) return { ok: false, issues };
  const pinnedAssetPaths = Object.fromEntries(
    v2Compilation.bundle.asset_lineage
      .filter((asset) => asset.pin)
      .map((asset) => [asset.asset_id, asset.pin!.relative_path])
  );
  const pinnedAssetRecords = Object.fromEntries(
    v2Compilation.bundle.asset_lineage
      .filter((asset) => asset.pin)
      .map((asset) => [asset.asset_id, asset.pin!])
  );
  const executionRequest = buildV2ExecutionRequest(
    request,
    ir,
    v2Compilation.adapter_prompt,
    options.intent === "execute" ? pinnedAssetPaths : undefined,
    options.intent === "execute" ? pinnedAssetRecords : undefined
  );
  const lineage = {
    workflow_id: "video-prompt-v3",
    workflow_version: "3",
    creative_ir_hash: v2Compilation.normalized_ir_digest,
    canonical_prompt_hash: v2Compilation.lineage.canonical_prompt_digest,
    adapter_prompt_hash: v2Compilation.lineage.adapter_prompt_digest,
    model_profile_digest: modelLoad.digest,
    connection_capability_digest: connectionLoad.digest,
    block_digests: v2Compilation.lineage.block_digests
  } as H3Compilation["lineage"];
  const compilation = {
    request_id: request.id,
    creative_ir: ir as never,
    canonical_prompt: v2Compilation.canonical_prompt,
    adapter_prompt: v2Compilation.adapter_prompt,
    validation: v2Compilation.validation,
    lineage,
    execution_request: executionRequest
  } as H3Compilation;
  const plan = {
    model_profile: modelLoad.profile,
    model_profile_digest: modelLoad.digest,
    connection_profile: connectionLoad.profile,
    connection_capability_digest: connectionLoad.digest,
    readiness: readiness.ok ? readiness : { ok: true, planning_only: true, external_submission_allowed: false } as never,
    compilation,
    v2_compilation: v2Compilation as VideoPromptV2Compilation,
    compiler_workflow: "video-prompt-v3" as const
  };
  if (issues.some((item) => item.severity === "error") || !compiled.ok || !readiness.ok) return { ok: false, plan, issues };
  return { ok: true, plan, issues: [] };
}

function buildV2ExecutionRequest(
  request: GenerationRequest,
  ir: VideoPromptIrV2,
  adapterPrompt: string,
  pinnedAssetPaths?: Readonly<Record<string, string>>,
  pinnedAssetRecords?: Readonly<Record<string, { relative_path: string; sha256: string; byte_size: number }>>
): GenerationRequest {
  const {
    h3: _h3,
    video_prompt: _videoPrompt,
    prompt_guide: _promptGuide,
    mode: _mode,
    first_frame: _firstFrame,
    last_frame: _lastFrame,
    reference_images: _referenceImages,
    input_images: _inputImages,
    input_video: _inputVideo,
    input_videos: _inputVideos,
    input_audios: _inputAudios,
    ...rest
  } = request as GenerationRequest & { video_prompt?: unknown };
  const pathFor = (asset: VideoPromptIrV2["assets"][number]): string | undefined => pinnedAssetPaths?.[asset.id] ?? (pinnedAssetPaths ? undefined : asset.path);
  const assets = (role: string, type: "image" | "video" | "audio") => ir.assets.filter((asset) => asset.type === type && asset.role === role).map(pathFor).filter((value): value is string => Boolean(value));
  const inputImages = ir.assets.filter((asset) => asset.type === "image" && ["subject_reference", "motion_reference", "environment_reference", "style_reference", "other"].includes(asset.role)).map(pathFor).filter((value): value is string => Boolean(value));
  const inputVideos = ir.assets.filter((asset) => asset.type === "video").map(pathFor).filter((value): value is string => Boolean(value));
  const inputAudios = ir.assets.filter((asset) => asset.type === "audio").map(pathFor).filter((value): value is string => Boolean(value));
  const pinnedAssetRequestRecords = pinnedAssetRecords
    ? Object.entries(pinnedAssetRecords).map(([asset_id, pin]) => ({ asset_id, ...pin }))
    : [];
  return {
    ...rest,
    id: request.id,
    prompt: adapterPrompt,
    model: ir.target.model_profile_id,
    duration: ir.target.duration_ms / 1_000,
    aspect: ir.target.aspect,
    operation: mapMode(ir.target.mode).operation,
    input_mode: mapMode(ir.target.mode).input_mode,
    params: {
      ...(request.params ?? {}),
      quality: ir.target.quality,
      audio: ir.target.audio,
      ...(pinnedAssetRequestRecords.length > 0 ? { asset_pins: pinnedAssetRequestRecords } : {})
    },
    ...(assets("first_frame", "image").length ? { first_frame: assets("first_frame", "image")[0] } : {}),
    ...(assets("last_frame", "image").length ? { last_frame: assets("last_frame", "image")[0] } : {}),
    ...(inputImages.length ? { input_images: inputImages } : {}),
    ...(inputVideos.length ? { input_videos: inputVideos } : {}),
    ...(inputAudios.length ? { input_audios: inputAudios } : {})
  } as GenerationRequest;
}

/** Alias for planning-oriented callers. */
export async function planVideoPrompt(
  request: GenerationRequest,
  ir: VideoCreativeIr | H3CreativeIr,
  options: CompileVideoPromptOptions
): Promise<CompileVideoPromptResult> {
  return compileVideoPromptRequest(request, ir, { ...options, intent: "planning" });
}

export type CompileProjectVideoPromptResult = Result<{
  project: Project;
  plans: VideoPromptPlan[];
  shadow_comparisons?: VideoPromptShadowComparison[];
}>;

export type VideoPromptShadowComparison = {
  request_id: string;
  authoritative: "legacy";
  status: "compiled" | "failed" | "not-attempted";
  compilation_digest?: string;
  legacy_canonical_prompt_digest?: string;
  legacy_adapter_prompt_digest?: string;
  v2_canonical_prompt_digest?: string;
  v2_adapter_prompt_digest?: string;
  diff?: { fields: string[] };
  issues: Array<{ code: string; message: string }>;
};

/**
 * Compile every video_prompt-bearing request on a project for planning / dry-run.
 * Fail-closed when connection is missing or compilation fails.
 * Never silent-pass empty prompts.
 */
export async function compileProjectVideoPrompts(
  project: Project,
  options: Omit<CompileVideoPromptOptions, "connectionId"> & {
    connectionId?: string;
  } = {}
): Promise<CompileProjectVideoPromptResult> {
  if (!project.generation?.requests.length) {
    return { ok: true, issues: [], project, plans: [] };
  }

  const connectionId = options.connectionId ?? project.generation.connection;
  const plans: VideoPromptPlan[] = [];
  const shadowComparisons: VideoPromptShadowComparison[] = [];
  const v2Routes = [] as Array<NonNullable<VideoPromptPlan["v2_compilation"]>["route"]>;
  const issues: Issue[] = [];
  const nextRequests: GenerationRequest[] = [];
  const rolloutMode = project.orchestration?.mode;
  let pinnedGrammar: H3GrammarProfileV3 | undefined;
  let grammarLoadError: string | undefined;
  const hasVideoBoundaryRequest = project.generation.requests.some((request) =>
    generationRequestOutputKind(request) === "video" || hasVideoPromptField(request) || request.h3 !== undefined
  );
  if ((rolloutMode === "active" || rolloutMode === "shadow") && hasVideoBoundaryRequest) {
    try {
      pinnedGrammar = await loadPinnedH3GrammarProfile(options.grammarProfileRoot ?? "profiles/grammar");
    } catch (error) {
      grammarLoadError = error instanceof Error ? error.message : String(error);
      if (rolloutMode === "active") {
        issues.push({ code: "VPD-C003", message: grammarLoadError, path: "profiles/grammar/h3-v3.yaml" });
      }
    }
  }

  for (const [index, request] of project.generation.requests.entries()) {
    const operationOutputIssue = assertOperationOutputKind(request);
    if (operationOutputIssue) {
      issues.push({ code: "VPD-E022", message: operationOutputIssue, path: `generation.requests.${index}.output_kind` });
      nextRequests.push(request);
      continue;
    }
    const dual = rejectDualAuthoring(request);
    if (dual.length > 0) {
      issues.push(...dual.map((item) => h3IssueToProjectIssue(item, index, "video_prompt")));
      nextRequests.push(request);
      continue;
    }

    const hasNativeVideoPrompt = hasVideoPromptField(request);
    const isActiveVideoRequest = rolloutMode === "active" && generationRequestOutputKind(request) === "video";
    // The project entrypoint is intentionally rollout-gated. Legacy H3 is
    // authoritative until active; native V2 authoring is never silently
    // downgraded to the legacy compiler.
    if (rolloutMode === "shadow") {
      if (hasNativeVideoPrompt) {
        issues.push(h3IssueToProjectIssue(issue("VPD-E022", "native VideoPromptIrV2 requires orchestration.mode=active", "error", ["video_prompt"]), index, "video_prompt"));
        nextRequests.push(request);
        continue;
      }
      const hasLegacyH3 = Boolean(request.h3);
      if (!hasLegacyH3) {
        nextRequests.push(request);
        continue;
      }
      if (!project.generation.connection || !connectionId) {
        shadowComparisons.push({ request_id: request.id, authoritative: "legacy", status: "not-attempted", issues: [{ code: "VPD-E022", message: "shadow V2 comparison requires an explicit generation.connection" }] });
        nextRequests.push(request);
        continue;
      }
      if (grammarLoadError || !pinnedGrammar) {
        shadowComparisons.push({ request_id: request.id, authoritative: "legacy", status: "failed", issues: [{ code: "VPD-C003", message: grammarLoadError ?? "pinned grammar profile is unavailable" }] });
        nextRequests.push(request);
        continue;
      }
      const shadowIr = request.h3;
      if (!shadowIr) {
        nextRequests.push(request);
        continue;
      }
      try {
        const legacy = compileLegacyH3V1(shadowIr);
        const shadowResult = await compileVideoPromptRequest(request, shadowIr, {
          ...options,
          connectionId,
          requestIndex: index,
          grammar_profile: pinnedGrammar,
          require_pinned_grammar: true,
          ...(options.shadowArtifactRoot ? { shadowArtifactRoot: options.shadowArtifactRoot } : {})
        });
        const comparison: VideoPromptShadowComparison = shadowResult.ok && shadowResult.plan?.v2_compilation
          ? {
              request_id: request.id,
              authoritative: "legacy",
              status: "compiled",
              compilation_digest: shadowResult.plan.v2_compilation.bundle.compilation_digest,
              legacy_canonical_prompt_digest: sha256Text(legacy.canonical_prompt),
              legacy_adapter_prompt_digest: sha256Text(legacy.adapter_prompt),
              v2_canonical_prompt_digest: shadowResult.plan.v2_compilation.bundle.canonical_prompt_digest,
              v2_adapter_prompt_digest: shadowResult.plan.v2_compilation.bundle.adapter_prompt_digest,
              diff: {
                fields: [
                  ...(legacy.canonical_prompt === shadowResult.plan.v2_compilation.canonical_prompt ? [] : ["canonical_prompt"]),
                  ...(legacy.adapter_prompt === shadowResult.plan.v2_compilation.adapter_prompt ? [] : ["adapter_prompt"])
                ]
              },
              issues: []
            }
          : { request_id: request.id, authoritative: "legacy", status: "failed", issues: shadowResult.issues.map((item) => ({ code: item.code, message: item.message })) };
        shadowComparisons.push(comparison);
      } catch (error) {
        shadowComparisons.push({ request_id: request.id, authoritative: "legacy", status: "failed", issues: [{ code: "VPD-C004", message: error instanceof Error ? error.message : String(error) }] });
      }
      nextRequests.push(request);
      continue;
    }
    if (rolloutMode !== "active") {
      if (hasNativeVideoPrompt) {
        issues.push(h3IssueToProjectIssue(issue("VPD-E022", "native VideoPromptIrV2 requires orchestration.mode=active", "error", ["video_prompt"]), index, "video_prompt"));
      }
      nextRequests.push(request);
      continue;
    }

    const hasLegacyH3 = Boolean(request.h3);
    // Non-video requests keep their own authority path; the active V2 video
    // boundary must not impose a generation connection on voice/music/image.
    if (generationRequestOutputKind(request) !== "video" && !hasNativeVideoPrompt && !hasLegacyH3) {
      nextRequests.push(request);
      continue;
    }
    // Active is an explicit V2 authority boundary. An adapter name is not a
    // route and must never be promoted into a connection by this compiler.
    if (!project.generation.connection || !connectionId) {
      issues.push({ code: "VPD-E022", message: "active video prompt compilation requires an explicit generation.connection; adapter-only projects are planning-invalid", path: `generation.requests.${index}.video_prompt` });
      nextRequests.push(request);
      continue;
    }
    if (!hasNativeVideoPrompt && !hasLegacyH3 && isActiveVideoRequest) {
      issues.push({ code: "VPD-E022", message: "active video generation requires canonical VideoPromptIrV2 authoring or a legacy H3/V1 input that can be upgraded in memory; raw prompt-only requests are forbidden", path: `generation.requests.${index}.video_prompt` });
      nextRequests.push(request);
      continue;
    }
    if (!hasNativeVideoPrompt && !hasLegacyH3) {
      nextRequests.push(request);
      continue;
    }

    if (!connectionId) {
      issues.push({
        code: VIDEO_PROMPT_UNCOMPILED_CODE,
        message:
          "request.video_prompt requires generation.connection (or adapter) for planning compile; "
          + "empty prompt pass-through is forbidden",
        path: `generation.requests.${index}.video_prompt`
      });
      nextRequests.push(request);
      continue;
    }

    const ir = (request as GenerationRequest & { video_prompt?: VideoCreativeIr }).video_prompt ?? request.h3;
    if (!ir) {
      nextRequests.push(request);
      continue;
    }
    const parsedV2 = safeParseVideoPromptIrV2(ir);
    let generationUnitSource: GenerationUnitProgramSourceV1 | undefined = options.generationUnitSource;
    if (parsedV2.success && parsedV2.data.program_kind === "mv") {
      generationUnitSource = options.generationUnitSourceByRequestId?.[request.id]
        ?? (options.generationUnitSourceResolver
          ? await options.generationUnitSourceResolver({
              project,
              request,
              ir: parsedV2.data,
              requestIndex: index
            })
          : generationUnitSource);
    }
    const generationUnitLyricsToken = generationUnitSource
      ? consumeGenerationUnitLyricsToken(generationUnitSource)
      : undefined;
    const result = await compileVideoPromptRequest(request, ir, {
      ...options,
      connectionId,
      requestIndex: index,
      grammar_profile: pinnedGrammar,
      require_pinned_grammar: true,
      ...(generationUnitSource ? { generationUnitSource } : {}),
      ...(generationUnitLyricsToken ? { generationUnitLyricsToken } : {})
    });
    if (result.plan) {
      plans.push(result.plan);
      if (result.plan.v2_compilation) v2Routes.push(result.plan.v2_compilation.route);
    }
    if (!result.ok) {
      issues.push(...result.issues.map((item) => h3IssueToProjectIssue(item, index, "video_prompt")));
      nextRequests.push(request);
      continue;
    }

    if (options.compilationArtifactRoot && result.plan.v2_compilation) {
      await writeCompilationBundleAtomic(
        resolve(options.compilationArtifactRoot),
        result.plan.v2_compilation.bundle,
        {
          project_root: resolve(options.compilationArtifactRoot),
          revision_id: options.revision_id ?? compilationRevisionId(result.plan.v2_compilation.bundle),
          request_id: result.plan.v2_compilation.request_id,
          allow_existing_same_digest: true
        }
      );
      const persisted = readCompilationBundleAtomic(resolve(options.compilationArtifactRoot), {
        project_root: resolve(options.compilationArtifactRoot),
        revision_id: options.revision_id ?? compilationRevisionId(result.plan.v2_compilation.bundle),
        request_id: result.plan.v2_compilation.request_id
      });
      result.plan.v2_compilation = {
        ...result.plan.v2_compilation,
        bundle: persisted.bundle,
        canonical_prompt: persisted.bundle.canonical_prompt,
        adapter_prompt: persisted.bundle.adapter_prompt,
        effective_contract: persisted.bundle.effective_contract
      };
    }

    // Keep authoring IR for digests; fill execution fields including non-empty prompt.
    nextRequests.push({
      ...result.plan.compilation.execution_request,
      ...(hasLegacyH3 ? { h3: request.h3 } : { video_prompt: ir }),
      ...(request.prompt_guide ? { prompt_guide: request.prompt_guide } : {})
    } as GenerationRequest);
  }

  issues.push(...assertHomogeneousRouteIdentity(v2Routes).map((item) => ({
    code: item.code,
    message: item.message,
    path: "generation.requests"
  })));

  const nextProject: Project = {
    ...project,
    generation: {
      ...project.generation,
      requests: nextRequests
    }
  };

  // Final fail-closed: any remaining empty-prompt video_prompt is an error.
  for (const [index, request] of nextRequests.entries()) {
    for (const item of rejectUncompiledVideoPrompt(request)) {
      issues.push(h3IssueToProjectIssue(item, index, "video_prompt"));
    }
  }

  if (options.shadowArtifactRoot) {
    for (const comparison of shadowComparisons) {
      try {
        await writeShadowComparisonAtomic(options.shadowArtifactRoot, comparison, {
          project_root: options.shadowArtifactRoot,
          revision_id: options.revision_id ?? `shadow-${sha256Text(JSON.stringify(comparison)).slice(0, 32)}`
        });
      } catch (error) {
        // Shadow persistence is non-authoritative: report the failed artifact
        // without changing the legacy result or Gate/run digest.
        comparison.issues.push({ code: "VPD-C004", message: error instanceof Error ? error.message : String(error) });
        comparison.status = "failed";
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, project: nextProject, plans, ...(shadowComparisons.length > 0 ? { shadow_comparisons: shadowComparisons } : {}) };
  }
  return { ok: true, issues: [], project: nextProject, plans, ...(shadowComparisons.length > 0 ? { shadow_comparisons: shadowComparisons } : {}) };
}

function assertOperationOutputKind(request: GenerationRequest): string | undefined {
  const operation = request.operation;
  const expected = operation === "image"
    ? "image"
    : operation === "voice" || operation === "music"
      ? "audio"
      : ["video", "transition", "extend", "modify", "upscale", "reference", "motion-control"].includes(operation ?? "")
        ? "video"
        : undefined;
  if (expected && request.output_kind && request.output_kind !== expected) {
    return `operation '${operation}' cannot declare output_kind '${request.output_kind}'`;
  }
  return undefined;
}

function buildExecutionRequest(
  request: GenerationRequest,
  ir: H3CreativeIr,
  mapping: ReturnType<typeof mapMode>,
  assetFields: ReturnType<typeof buildAssetFields>,
  adapterPrompt: string
): GenerationRequest {
  const {
    h3: _h3,
    video_prompt: _videoPrompt,
    prompt_guide: _promptGuide,
    mode: _mode,
    first_frame: _firstFrame,
    last_frame: _lastFrame,
    reference_images: _referenceImages,
    input_images: _inputImages,
    input_video: _inputVideo,
    input_videos: _inputVideos,
    input_audios: _inputAudios,
    ...rest
  } = request as GenerationRequest & { video_prompt?: unknown };

  const {
    image: _paramsImage,
    video: _paramsVideo,
    ...safeParams
  } = (request.params ?? {}) as Record<string, unknown>;

  return {
    ...rest,
    id: request.id,
    prompt: adapterPrompt,
    model: ir.target.model,
    duration: ir.target.duration,
    aspect: ir.target.aspect,
    operation: mapping.operation,
    input_mode: mapping.input_mode,
    params: {
      ...safeParams,
      quality: ir.target.quality,
      audio: ir.target.audio
    },
    ...(assetFields.first_frame ? { first_frame: assetFields.first_frame } : {}),
    ...(assetFields.last_frame ? { last_frame: assetFields.last_frame } : {}),
    ...(assetFields.input_images ? { input_images: assetFields.input_images } : {}),
    ...(assetFields.input_videos ? { input_videos: assetFields.input_videos } : {}),
    ...(assetFields.input_audios ? { input_audios: assetFields.input_audios } : {})
  };
}

function assertNoAuthoringIr(execution: GenerationRequest, issues: H3Issue[]): void {
  const asAny = execution as GenerationRequest & {
    video_prompt?: unknown;
    h3?: unknown;
    prompt_guide?: unknown;
  };
  if (asAny.video_prompt !== undefined) {
    issues.push(issue(
      "VPD-E032",
      "execution_request must not include video_prompt authoring IR",
      "error",
      ["video_prompt"]
    ));
  }
  if (asAny.h3 !== undefined) {
    issues.push(issue(
      "VPD-E032",
      "execution_request must not include h3 authoring IR",
      "error",
      ["h3"]
    ));
  }
  if (asAny.prompt_guide !== undefined) {
    issues.push(issue(
      "VPD-E032",
      "execution_request must not include prompt_guide authoring metadata",
      "error",
      ["prompt_guide"]
    ));
  }
}

// silence unused import in case CompileH3RequestResult is used by re-exports later
export type { CompileH3RequestResult };
