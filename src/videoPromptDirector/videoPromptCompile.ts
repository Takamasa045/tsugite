/**
 * video_prompt authoring compile / planning (P3–P4).
 * No provider network calls. Fail-closed on unknown/stale/unsupported/exact-route mismatch.
 */

import type { GenerationRequest, Project } from "../project/schema.js";
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
import { finalizeValidation, issue, type H3Issue } from "./validation/types.js";
import { validateH3CreativeIr } from "./validation/index.js";
import { h3IssueToProjectIssue } from "./compile.js";

export {
  VIDEO_PROMPT_DUAL_AUTHORING_CODE,
  VIDEO_PROMPT_UNCOMPILED_CODE,
  rejectDualAuthoring,
  rejectUncompiledVideoPrompt
} from "./dualAuthoring.js";

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
};

export type VideoPromptPlan = {
  model_profile: ModelPromptProfile;
  model_profile_digest: string;
  connection_profile: ConnectionCapabilityProfile;
  connection_capability_digest: string;
  readiness: Extract<PlanningReadinessResult, { ok: true }>;
  compilation: H3Compilation;
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

  // Profile is mandatory for renderVideoPrompt (no default-H3 fallback).
  const rendered = renderVideoPrompt(ir as H3CreativeIr, modelLoad.profile);
  const validation = validateH3CreativeIr(ir as H3CreativeIr, {
    renderedText: modelLoad.profile.renderer === "h3-grammar" ? rendered.text : undefined,
    includeWarnings: modelLoad.profile.renderer === "h3-grammar"
  });
  // Plain-prompt skips H3 section grammar checks (H3-E001..) which require H3 sections.
  // Renderer-independent issues (LOCK-* / scene.*) still apply.
  if (modelLoad.profile.renderer === "h3-grammar") {
    issues.push(...validation.issues);
  } else {
    issues.push(
      ...validation.issues.filter(
        (item) => item.code.startsWith("LOCK-") || item.code.startsWith("scene.")
      )
    );
  }

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
      workflow_id: ir.target.model === "minimax-h3" && modelLoad.profile.renderer === "h3-grammar"
        ? undefined
        : VIDEO_PROMPT_WORKFLOW_ID,
      workflow_version: ir.target.model === "minimax-h3" && modelLoad.profile.renderer === "h3-grammar"
        ? undefined
        : VIDEO_PROMPT_WORKFLOW_VERSION,
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
}>;

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

  const connectionId = options.connectionId
    ?? project.generation.connection
    ?? project.generation.adapter;
  const plans: VideoPromptPlan[] = [];
  const issues: Issue[] = [];
  const nextRequests: GenerationRequest[] = [];

  for (const [index, request] of project.generation.requests.entries()) {
    const dual = rejectDualAuthoring(request);
    if (dual.length > 0) {
      issues.push(...dual.map((item) => h3IssueToProjectIssue(item, index)));
      nextRequests.push(request);
      continue;
    }

    if (!hasVideoPromptField(request)) {
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

    const ir = (request as GenerationRequest & { video_prompt: VideoCreativeIr }).video_prompt;
    const result = await compileVideoPromptRequest(request, ir, {
      ...options,
      connectionId
    });
    if (result.plan) {
      plans.push(result.plan);
    }
    if (!result.ok) {
      issues.push(...result.issues.map((item) => h3IssueToProjectIssue(item, index)));
      nextRequests.push(request);
      continue;
    }

    // Keep authoring IR for digests; fill execution fields including non-empty prompt.
    nextRequests.push({
      ...result.plan.compilation.execution_request,
      video_prompt: ir,
      ...(request.prompt_guide ? { prompt_guide: request.prompt_guide } : {})
    } as GenerationRequest);
  }

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
      issues.push(h3IssueToProjectIssue(item, index));
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, project: nextProject, plans };
  }
  return { ok: true, issues: [], project: nextProject, plans };
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
