/**
 * H3 Prompt Director — request compiler (phase 2A).
 *
 * Isolated from adapter execution. Maps Creative IR to the existing generation
 * request contract, validates H3 format rules, and records lineage.
 * Adapter route limits (PV-E*) are optional at pure compile time and injected
 * from the selected adapter's constraints after adapter resolution.
 */

import type { GenerationRequest, Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import { collectPromptBlockDigests } from "./blockDigests.js";
import { collectLockedBlockHashes } from "./lockedBlocks.js";
import {
  hasVideoPromptField,
  rejectDualAuthoring,
  VIDEO_PROMPT_DUAL_AUTHORING_CODE
} from "./dualAuthoring.js";
import { renderH3Prompt } from "./render/h3Grammar.js";
import type { H3Asset, H3CreativeIr, H3Mode } from "./schema.js";
import {
  H3_ASSET_BINDING_MISMATCH_CODE,
  H3_PROVIDER_MODEL_MAPPING_MISSING_CODE,
  validateH3AdapterRoute,
  validateH3CreativeIr,
  type H3ExecutionRouteProfile,
  type H3Issue,
  type H3RouteModeBinding,
  type H3ValidationResult
} from "./validation/index.js";
import { finalizeValidation, issue } from "./validation/types.js";

export { VIDEO_PROMPT_DUAL_AUTHORING_CODE };

/** Fail-closed when H3 requests are present but the selected adapter has no route profile. */
export const H3_ROUTE_PROFILE_REQUIRED_CODE = "H3-C005";

/** Stable workflow identity for compiled H3 prompts. */
export const H3_WORKFLOW_ID = "h3-prompt-director";
/**
 * Versioned IR/compiler contract identity (not an implementation phase name).
 * v2: last-frame mode, provider-neutral first-last/last-frame intents, official FL2VA/L2VA alignment.
 */
export const H3_WORKFLOW_VERSION = "2";

export type H3Lineage = {
  workflow_id: string;
  workflow_version: string;
  creative_ir_hash: string;
  canonical_prompt_hash: string;
  adapter_prompt_hash: string;
  prompt_guide_identity?: string;
  /** Canonical hash of loaded guide content with local root/path stripped. */
  prompt_guide_hash?: string;
  /** Pin-time asset id → sha256 of the regular file under the run directory. */
  asset_hashes?: Record<string, string>;
  /** Declared sha256 of subject locked_blocks fields ("subjectId.field" → hex). */
  locked_block_hashes?: Record<string, string>;
  /** IR field digests for iteration multi-block comparison (Phase E). */
  block_digests?: Record<string, string>;
};

/** Loaded prompt guide shape for content hashing (root/path are excluded). */
export type H3PromptGuideSource = {
  catalog_id: string;
  root?: string;
  path?: string;
  [key: string]: unknown;
};

export type H3Compilation = {
  request_id: string;
  creative_ir: H3CreativeIr;
  /** Canonical H3 rendered prompt (label dialect may diverge later). */
  canonical_prompt: string;
  /** Adapter-route prompt. Currently identical to canonical, stored separately. */
  adapter_prompt: string;
  validation: H3ValidationResult;
  lineage: H3Lineage;
  /** Adapter-ready generation request (no raw h3 IR, no advisory prompt_guide). */
  execution_request: GenerationRequest;
};

export type CompileH3RequestResult =
  | {
      ok: true;
      compilation: H3Compilation;
      issues: [];
    }
  | {
      ok: false;
      compilation?: H3Compilation;
      issues: H3Issue[];
    };

export type CompileProjectH3Result = Result<{
  project: Project;
  compilations: H3Compilation[];
}>;

/** Provider-neutral mode mapping produced by the core compiler (adapter binding is separate). */
export type ModeMapping = {
  operation: "video" | "transition" | "reference";
  input_mode:
    | "text-to-video"
    | "image-to-video"
    | "first-last-frame-to-video"
    | "last-frame-to-video"
    | "reference";
};

export type CompileH3Options = {
  /**
   * Optional adapter execution-route profile.
   * Pure format compile omits this; pipeline injects it after adapter resolution.
   */
  routeProfile?: H3ExecutionRouteProfile;
};

/**
 * Compile a single generation request that carries Creative IR.
 * Without `routeProfile`, runs format/render/asset mapping only (connection-ready).
 * With `routeProfile`, also applies PV-E001..E008 against that profile.
 * Prompt-only requests must not call this; use compileProjectH3 instead.
 */
export function compileH3Request(
  request: GenerationRequest,
  options: CompileH3Options = {}
): CompileH3RequestResult {
  const dual = rejectDualAuthoring(request);
  if (dual.length > 0) {
    return { ok: false, issues: dual };
  }

  const ir = request.h3;
  if (!ir) {
    return {
      ok: false,
      issues: [issue("H3-C000", "compileH3Request requires request.h3", "error")]
    };
  }

  const issues: H3Issue[] = [];
  issues.push(...validateAuthorConflicts(request, ir));
  issues.push(...validateModeAssets(ir));

  const rendered = renderH3Prompt(ir);
  const canonicalPrompt = rendered.text;
  // Separate field for a future label-dialect renderer; identical for contract v1.
  const adapterPrompt = rendered.text;

  // Empty author prompt, or exact deterministic compiler output, is allowed so
  // compileProjectH3(compileProjectH3(project).project) stays idempotent.
  issues.push(...validateAuthorPrompt(request, adapterPrompt));

  const validation = validateH3CreativeIr(ir, {
    renderedText: canonicalPrompt,
    ...(options.routeProfile ? { routeProfile: options.routeProfile } : {}),
    includeWarnings: true
  });
  issues.push(...validation.issues);

  const mapping = mapMode(ir.target.mode);
  const assetFields = buildAssetFields(ir);
  const executionRequest = buildExecutionRequest(request, ir, mapping, assetFields, adapterPrompt);

  const finalValidation = finalizeValidation(issues);
  const lineage = buildLineage(ir, canonicalPrompt, adapterPrompt, request);

  const compilation: H3Compilation = {
    request_id: request.id,
    creative_ir: ir,
    canonical_prompt: canonicalPrompt,
    adapter_prompt: adapterPrompt,
    validation: finalValidation,
    lineage,
    execution_request: executionRequest
  };

  if (!finalValidation.ok) {
    return { ok: false, compilation, issues: finalValidation.errors };
  }
  return { ok: true, compilation, issues: [] };
}

/**
 * Compile every H3-bearing generation request on a project.
 * Stage 1 (default): format/render/asset mapping without route limits so
 * connection resolution can see operation/model/mode.
 * Pass `routeProfile` only when the selected adapter profile is already known.
 * Prompt-only requests pass through unchanged.
 * On success, requests keep `h3` for digest/Gate integrity while execution
 * fields are filled from IR so asset validation and adapters see them.
 */
export function compileProjectH3(
  project: Project,
  options: CompileH3Options = {}
): CompileProjectH3Result {
  if (!project.generation?.requests.length) {
    return { ok: true, issues: [], project, compilations: [] };
  }

  const compilations: H3Compilation[] = [];
  const issues: Issue[] = [];
  const nextRequests: GenerationRequest[] = [];

  for (const [index, request] of project.generation.requests.entries()) {
    const dual = rejectDualAuthoring(request);
    if (dual.length > 0) {
      issues.push(...dual.map((item) => h3IssueToProjectIssue(item, index)));
      nextRequests.push(request);
      continue;
    }

    if (!request.h3) {
      // video_prompt-only is handled by compileProjectVideoPrompts; never silent dual-path.
      // Pass through unchanged here so validate/plan can fail-closed or compile separately.
      nextRequests.push(request);
      continue;
    }

    if (hasVideoPromptField(request)) {
      // Defensive: dual should already have been rejected above.
      issues.push(h3IssueToProjectIssue(
        issue(
          VIDEO_PROMPT_DUAL_AUTHORING_CODE,
          "request.h3 and request.video_prompt cannot be specified together",
          "error",
          ["video_prompt"]
        ),
        index
      ));
      nextRequests.push(request);
      continue;
    }

    const result = compileH3Request(request, options);
    if (result.compilation) {
      compilations.push(result.compilation);
    }
    if (!result.ok) {
      issues.push(...result.issues.map((item) => h3IssueToProjectIssue(item, index)));
      // Keep original request so callers can inspect IR; do not partial-apply.
      nextRequests.push(request);
      continue;
    }

    nextRequests.push(applyCompilationToRequest(request, result.compilation));
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      project: {
        ...project,
        generation: {
          ...project.generation,
          requests: nextRequests
        }
      },
      compilations
    };
  }

  return {
    ok: true,
    issues: [],
    project: {
      ...project,
      generation: {
        ...project.generation,
        requests: nextRequests
      }
    },
    compilations
  };
}

/**
 * Stage 2: inject the selected adapter's H3 route profile into compilations.
 * Fail closed with H3-C005 when H3 compilations exist but no profile is declared.
 * Merges H3-C006/C007/C008/C009 and PV-E* issues; binds provider-neutral fields to adapter route.
 */
export function applyH3ExecutionRouteProfile(
  compilations: H3Compilation[],
  routeProfile: H3ExecutionRouteProfile | undefined,
  options: {
    project: Project;
    adapterName?: string;
  }
): Result<{ compilations: H3Compilation[]; project: Project }> {
  if (compilations.length === 0) {
    return { ok: true, issues: [], compilations, project: options.project };
  }

  if (!routeProfile) {
    const adapterLabel = options.adapterName ? ` '${options.adapterName}'` : "";
    return {
      ok: false,
      issues: [{
        code: H3_ROUTE_PROFILE_REQUIRED_CODE,
        message:
          `generation adapter${adapterLabel} does not declare an H3 execution route profile; `
          + "H3 requests cannot execute without adapter route constraints",
        path: "generation.adapter"
      }],
      compilations,
      project: options.project
    };
  }

  const issues: Issue[] = [];
  const next = compilations.map((compilation) => {
    const routeIssues: H3Issue[] = [];
    const routeResult = validateH3AdapterRoute(compilation.creative_ir, routeProfile);
    routeIssues.push(...routeResult.issues);

    const bindingResult = bindExecutionRequestToRoute(compilation, routeProfile);
    routeIssues.push(...bindingResult.issues);

    const merged = finalizeValidation([
      ...compilation.validation.issues,
      ...routeIssues
    ]);
    const requestIndex = options.project.generation?.requests.findIndex(
      (request) => request.id === compilation.request_id
    ) ?? -1;
    const index = requestIndex >= 0 ? requestIndex : 0;
    const errors = routeIssues.filter((item) => item.severity === "error");
    issues.push(...errors.map((item) => h3IssueToProjectIssue(item, index)));

    return {
      ...compilation,
      validation: merged,
      execution_request: bindingResult.execution_request
    };
  });

  const project = applyBoundCompilationsToProject(options.project, next);
  if (issues.length > 0) {
    return { ok: false, issues, compilations: next, project };
  }
  return { ok: true, issues: [], compilations: next, project };
}

/** Rewrite generation requests from bound execution fields while keeping raw h3 IR. */
function applyBoundCompilationsToProject(
  project: Project,
  compilations: H3Compilation[]
): Project {
  if (!project.generation?.requests.length) return project;
  const byId = new Map(compilations.map((item) => [item.request_id, item]));
  return {
    ...project,
    generation: {
      ...project.generation,
      requests: project.generation.requests.map((request) => {
        const compilation = byId.get(request.id);
        if (!compilation) return request;
        return applyCompilationToRequest(request, compilation);
      })
    }
  };
}

/**
 * Provider-neutral mode mapping. Adapter-specific operation/input_mode live in route bindings.
 */
export function mapMode(mode: H3Mode): ModeMapping {
  switch (mode) {
    case "text-to-video":
      return { operation: "video", input_mode: "text-to-video" };
    case "first-frame":
      return { operation: "video", input_mode: "image-to-video" };
    case "first-last":
      return { operation: "video", input_mode: "first-last-frame-to-video" };
    case "last-frame":
      return { operation: "video", input_mode: "last-frame-to-video" };
    case "reference":
      return { operation: "reference", input_mode: "reference" };
  }
}

function bindExecutionRequestToRoute(
  compilation: H3Compilation,
  route: H3ExecutionRouteProfile
): { execution_request: GenerationRequest; issues: H3Issue[] } {
  const issues: H3Issue[] = [];
  const mode = compilation.creative_ir.target.mode;
  const binding = resolveModeBinding(mode, route);

  if (route.modes && !binding) {
    // validateH3AdapterRoute already emits H3-C007; keep execution fields neutral.
    return { execution_request: compilation.execution_request, issues };
  }

  if (route.modes && route.provider_model === undefined) {
    // Profiles that declare modes must also declare provider_model mapping explicitly.
    issues.push(issue(
      H3_PROVIDER_MODEL_MAPPING_MISSING_CODE,
      `adapter route for model '${route.model}' is missing provider_model mapping`,
      "error",
      ["target", "model"]
    ));
  }

  let execution = { ...compilation.execution_request };
  if (binding) {
    const assetBound = applyAssetBinding(execution, binding);
    issues.push(...assetBound.issues);
    execution = {
      ...assetBound.request,
      operation: binding.operation,
      input_mode: binding.input_mode as GenerationRequest["input_mode"]
    };
  }

  if (route.provider_model) {
    execution = {
      ...execution,
      params: {
        ...(execution.params ?? {}),
        provider_model: route.provider_model
      }
    };
  }

  return { execution_request: execution, issues };
}

function resolveModeBinding(
  mode: H3Mode,
  route: H3ExecutionRouteProfile
): H3RouteModeBinding | undefined {
  if (route.modes) return route.modes[mode];
  // Legacy profiles without explicit modes: identity binding for pre-Phase-A four modes.
  switch (mode) {
    case "text-to-video":
      return { operation: "video", input_mode: "text-to-video", asset_binding: "none" };
    case "first-frame":
      return { operation: "video", input_mode: "image-to-video", asset_binding: "first_frame" };
    case "first-last":
      return {
        operation: "transition",
        input_mode: "transition",
        asset_binding: "first_last_as_input_images"
      };
    case "reference":
      return { operation: "reference", input_mode: "reference", asset_binding: "reference_lists" };
    case "last-frame":
      return undefined;
  }
}

function applyAssetBinding(
  request: GenerationRequest,
  binding: H3RouteModeBinding
): { request: GenerationRequest; issues: H3Issue[] } {
  const issues: H3Issue[] = [];
  const base = { ...request };

  switch (binding.asset_binding) {
    case "none":
      return { request: base, issues };
    case "first_frame": {
      if (!base.first_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "last_frame": {
      if (!base.last_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires last_frame",
          "error",
          ["last_frame"]
        ));
      }
      if (base.first_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "last_frame binding must not include first_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "first_and_last_frame": {
      if (!base.first_frame || !base.last_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame and last_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "first_last_as_input_images": {
      const first = base.first_frame;
      const last = base.last_frame;
      if (!first || !last) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame and last_frame to pack input_images",
          "error",
          ["first_frame"]
        ));
        return { request: base, issues };
      }
      const {
        first_frame: _first,
        last_frame: _last,
        ...rest
      } = base;
      return {
        request: {
          ...rest,
          input_images: [first, last]
        },
        issues
      };
    }
    case "reference_lists": {
      const hasMedia = Boolean(
        (base.input_images?.length ?? 0)
        + (base.input_videos?.length ?? 0)
        + (base.input_audios?.length ?? 0)
      );
      if (!hasMedia) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires at least one reference media list",
          "error",
          ["input_images"]
        ));
      }
      return { request: base, issues };
    }
  }
}

function buildLineage(
  ir: H3CreativeIr,
  canonicalPrompt: string,
  adapterPrompt: string,
  request: GenerationRequest
): H3Lineage {
  const lineage: H3Lineage = {
    workflow_id: H3_WORKFLOW_ID,
    workflow_version: H3_WORKFLOW_VERSION,
    creative_ir_hash: sha256Canonical(ir),
    canonical_prompt_hash: sha256Text(canonicalPrompt),
    adapter_prompt_hash: sha256Text(adapterPrompt)
  };

  const guideIdentity = promptGuideIdentity(request);
  if (guideIdentity) {
    lineage.prompt_guide_identity = guideIdentity;
    // Guide file content is not loaded here; never invent a content hash.
  }

  const lockedBlockHashes = collectLockedBlockHashes(ir);
  if (lockedBlockHashes) {
    lineage.locked_block_hashes = lockedBlockHashes;
  }

  lineage.block_digests = collectPromptBlockDigests(ir);

  return lineage;
}

function promptGuideIdentity(request: GenerationRequest): string | undefined {
  const guide = request.prompt_guide;
  if (!guide) return undefined;
  return guide.model ? `${guide.catalog}/${guide.model}` : guide.catalog;
}

function validateAuthorPrompt(request: GenerationRequest, adapterPrompt: string): H3Issue[] {
  if (request.prompt.trim().length === 0) return [];
  // Exact match only: allows recompilation of already-compiled requests.
  if (request.prompt === adapterPrompt) return [];
  return [
    issue(
      "H3-C002",
      "h3 requests must use an empty author prompt or the exact compiler output; compiled prompt is the single source of truth",
      "error",
      ["prompt"]
    )
  ];
}

function validateAuthorConflicts(request: GenerationRequest, ir: H3CreativeIr): H3Issue[] {
  const issues: H3Issue[] = [];
  const mapping = mapMode(ir.target.mode);

  compareOptional(issues, "model", request.model, ir.target.model, ["model"]);
  compareOptional(issues, "duration", request.duration, ir.target.duration, ["duration"]);
  compareOptional(issues, "aspect", request.aspect, ir.target.aspect, ["aspect"]);
  compareOptional(issues, "operation", request.operation, mapping.operation, ["operation"]);

  if (request.input_mode !== undefined) {
    compareOptional(issues, "input_mode", request.input_mode, mapping.input_mode, ["input_mode"]);
  }
  if (request.mode !== undefined) {
    // Legacy mode alias maps to the same values as input_mode for H3 modes.
    compareOptional(issues, "mode", request.mode, mapping.input_mode, ["mode"]);
  }

  const params = request.params ?? {};
  if (params.quality !== undefined) {
    compareOptional(issues, "quality", params.quality, ir.target.quality, ["params", "quality"]);
  }
  if (params.audio !== undefined) {
    compareOptional(issues, "audio", params.audio, ir.target.audio, ["params", "audio"]);
  }

  // Adapter video/transition/reference routes treat these as media inputs.
  // Reject so they cannot bypass H3 asset fields (e.g. T2V smuggling params.image).
  issues.push(...validateForbiddenMediaParams(params));

  issues.push(...validateAuthorAssetConflicts(request, ir));
  return issues;
}

/** Legacy params that adapter H3 operations interpret as media inputs. */
const FORBIDDEN_H3_MEDIA_PARAMS = ["image", "video"] as const;

function validateForbiddenMediaParams(params: Record<string, unknown>): H3Issue[] {
  const issues: H3Issue[] = [];
  for (const key of FORBIDDEN_H3_MEDIA_PARAMS) {
    if (params[key] !== undefined) {
      issues.push(issue(
        "H3-C001",
        `author field 'params.${key}' conflicts with h3-compiled asset fields`,
        "error",
        ["params", key]
      ));
    }
  }
  return issues;
}

function validateAuthorAssetConflicts(request: GenerationRequest, ir: H3CreativeIr): H3Issue[] {
  const issues: H3Issue[] = [];
  const expected = buildAssetFields(ir);

  compareOptional(issues, "first_frame", request.first_frame, expected.first_frame, ["first_frame"]);
  compareOptional(issues, "last_frame", request.last_frame, expected.last_frame, ["last_frame"]);
  compareStringArray(issues, "input_images", request.input_images, expected.input_images, ["input_images"]);
  compareStringArray(issues, "input_videos", request.input_videos, expected.input_videos, ["input_videos"]);
  compareStringArray(issues, "input_audios", request.input_audios, expected.input_audios, ["input_audios"]);

  // T2V and frame modes must not smuggle reference_images / input_video extras.
  if (request.reference_images !== undefined) {
    issues.push(issue(
      "H3-C001",
      "author field 'reference_images' conflicts with h3-compiled asset fields",
      "error",
      ["reference_images"]
    ));
  }
  if (request.input_video !== undefined) {
    issues.push(issue(
      "H3-C001",
      "author field 'input_video' conflicts with h3-compiled asset fields",
      "error",
      ["input_video"]
    ));
  }

  return issues;
}

function compareOptional(
  issues: H3Issue[],
  field: string,
  author: unknown,
  expected: unknown,
  path: Array<string | number>
): void {
  if (author === undefined) return;
  if (expected === undefined || !sameValue(author, expected)) {
    issues.push(issue(
      "H3-C001",
      `author field '${field}' conflicts with h3 target (author=${stringify(author)}, h3=${stringify(expected)})`,
      "error",
      path
    ));
  }
}

function compareStringArray(
  issues: H3Issue[],
  field: string,
  author: string[] | undefined,
  expected: string[] | undefined,
  path: Array<string | number>
): void {
  if (author === undefined) return;
  if (expected === undefined || !sameStringArray(author, expected)) {
    issues.push(issue(
      "H3-C001",
      `author field '${field}' conflicts with h3-compiled asset fields`,
      "error",
      path
    ));
  }
}

function validateModeAssets(ir: H3CreativeIr): H3Issue[] {
  const issues: H3Issue[] = [];
  const images = ir.assets.filter((asset) => asset.type === "image");
  const videos = ir.assets.filter((asset) => asset.type === "video");
  const audios = ir.assets.filter((asset) => asset.type === "audio");
  const firstFrames = ir.assets.filter((asset) => asset.role === "first_frame");
  const lastFrames = ir.assets.filter((asset) => asset.role === "last_frame");

  switch (ir.target.mode) {
    case "text-to-video": {
      if (ir.assets.length > 0) {
        issues.push(issue(
          "H3-C003",
          "text-to-video mode must not declare execution assets",
          "error",
          ["assets"]
        ));
      }
      break;
    }
    case "first-frame": {
      if (firstFrames.length !== 1) {
        issues.push(issue(
          "H3-C003",
          "first-frame mode requires exactly one first_frame asset",
          "error",
          ["assets"]
        ));
      } else if (firstFrames[0]!.type !== "image") {
        issues.push(issue(
          "H3-C004",
          "first_frame asset must be an image",
          "error",
          ["assets", assetIndex(ir, firstFrames[0]!), "type"]
        ));
      }
      if (lastFrames.length > 0) {
        issues.push(issue(
          "H3-C003",
          "first-frame mode must not declare last_frame assets",
          "error",
          ["assets"]
        ));
      }
      const unexpected = ir.assets.filter((asset) => asset.role !== "first_frame");
      if (unexpected.length > 0) {
        issues.push(issue(
          "H3-C003",
          "first-frame mode accepts only a single first_frame image asset",
          "error",
          ["assets"]
        ));
      }
      break;
    }
    case "first-last": {
      if (firstFrames.length !== 1 || lastFrames.length !== 1) {
        issues.push(issue(
          "H3-C003",
          "first-last mode requires exactly one first_frame and one last_frame image",
          "error",
          ["assets"]
        ));
      }
      for (const asset of [...firstFrames, ...lastFrames]) {
        if (asset.type !== "image") {
          issues.push(issue(
            "H3-C004",
            `${asset.role} asset must be an image`,
            "error",
            ["assets", assetIndex(ir, asset), "type"]
          ));
        }
      }
      const unexpected = ir.assets.filter(
        (asset) => asset.role !== "first_frame" && asset.role !== "last_frame"
      );
      if (unexpected.length > 0 || ir.assets.length !== firstFrames.length + lastFrames.length) {
        issues.push(issue(
          "H3-C003",
          "first-last mode accepts only first_frame and last_frame image assets",
          "error",
          ["assets"]
        ));
      }
      if (videos.length > 0 || audios.length > 0) {
        issues.push(issue(
          "H3-C003",
          "first-last mode must not include video or audio assets",
          "error",
          ["assets"]
        ));
      }
      break;
    }
    case "last-frame": {
      if (lastFrames.length !== 1) {
        issues.push(issue(
          "H3-C003",
          "last-frame mode requires exactly one last_frame asset",
          "error",
          ["assets"]
        ));
      } else if (lastFrames[0]!.type !== "image") {
        issues.push(issue(
          "H3-C004",
          "last_frame asset must be an image",
          "error",
          ["assets", assetIndex(ir, lastFrames[0]!), "type"]
        ));
      }
      if (firstFrames.length > 0) {
        issues.push(issue(
          "H3-C003",
          "last-frame mode must not declare first_frame assets",
          "error",
          ["assets"]
        ));
      }
      const unexpected = ir.assets.filter((asset) => asset.role !== "last_frame");
      if (unexpected.length > 0) {
        issues.push(issue(
          "H3-C003",
          "last-frame mode accepts only a single last_frame image asset",
          "error",
          ["assets"]
        ));
      }
      if (videos.length > 0 || audios.length > 0) {
        issues.push(issue(
          "H3-C003",
          "last-frame mode must not include video or audio assets",
          "error",
          ["assets"]
        ));
      }
      break;
    }
    case "reference": {
      // Cardinality limits and audio-only / first-last mixing live in adapter route (PV-E*).
      // Compiler only enforces that reference assets are present for execution fields.
      if (images.length + videos.length + audios.length === 0) {
        issues.push(issue(
          "H3-C003",
          "reference mode requires at least one image, video, or audio asset",
          "error",
          ["assets"]
        ));
      }
      break;
    }
  }

  return issues;
}

function buildAssetFields(ir: H3CreativeIr): {
  first_frame?: string;
  last_frame?: string;
  input_images?: string[];
  input_videos?: string[];
  input_audios?: string[];
} {
  switch (ir.target.mode) {
    case "text-to-video":
      return {};
    case "first-frame": {
      const first = ir.assets.find((asset) => asset.role === "first_frame" && asset.type === "image");
      return first ? { first_frame: first.path } : {};
    }
    case "first-last": {
      const first = ir.assets.find((asset) => asset.role === "first_frame" && asset.type === "image");
      const last = ir.assets.find((asset) => asset.role === "last_frame" && asset.type === "image");
      if (!first || !last) return {};
      // Provider-neutral: keep role fields separate; adapters may pack into input_images.
      return { first_frame: first.path, last_frame: last.path };
    }
    case "last-frame": {
      const last = ir.assets.find((asset) => asset.role === "last_frame" && asset.type === "image");
      return last ? { last_frame: last.path } : {};
    }
    case "reference": {
      // Preserve IR declaration order, partitioned by type.
      const input_images = ir.assets.filter((asset) => asset.type === "image").map((asset) => asset.path);
      const input_videos = ir.assets.filter((asset) => asset.type === "video").map((asset) => asset.path);
      const input_audios = ir.assets.filter((asset) => asset.type === "audio").map((asset) => asset.path);
      return {
        ...(input_images.length > 0 ? { input_images } : {}),
        ...(input_videos.length > 0 ? { input_videos } : {}),
        ...(input_audios.length > 0 ? { input_audios } : {})
      };
    }
  }
}

function buildExecutionRequest(
  request: GenerationRequest,
  ir: H3CreativeIr,
  mapping: ModeMapping,
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

  // Drop legacy media-input params even on partial/failed compilations so they
  // cannot be forwarded if a caller inspects execution_request after rejection.
  const {
    image: _paramsImage,
    video: _paramsVideo,
    ...safeParams
  } = (request.params ?? {}) as Record<string, unknown>;

  const params: Record<string, unknown> = {
    ...safeParams,
    quality: ir.target.quality,
    audio: ir.target.audio
  };

  const execution: GenerationRequest = {
    ...rest,
    id: request.id,
    prompt: adapterPrompt,
    model: ir.target.model,
    duration: ir.target.duration,
    aspect: ir.target.aspect,
    operation: mapping.operation,
    input_mode: mapping.input_mode,
    params,
    ...(assetFields.first_frame ? { first_frame: assetFields.first_frame } : {}),
    ...(assetFields.last_frame ? { last_frame: assetFields.last_frame } : {}),
    ...(assetFields.input_images ? { input_images: assetFields.input_images } : {}),
    ...(assetFields.input_videos ? { input_videos: assetFields.input_videos } : {}),
    ...(assetFields.input_audios ? { input_audios: assetFields.input_audios } : {})
  };

  return execution;
}

/** Keep raw IR on the project request for digests; fill execution fields from compilation. */
function applyCompilationToRequest(
  request: GenerationRequest,
  compilation: H3Compilation
): GenerationRequest {
  return {
    ...compilation.execution_request,
    h3: request.h3,
    ...(request.prompt_guide ? { prompt_guide: request.prompt_guide } : {})
  };
}

export function h3IssueToProjectIssue(h3Issue: H3Issue, requestIndex: number): Issue {
  const nested = h3Issue.path && h3Issue.path.length > 0
    ? `.${h3Issue.path.map(String).join(".")}`
    : "";
  return {
    code: h3Issue.code,
    message: h3Issue.message,
    path: `generation.requests.${requestIndex}.h3${nested}`
  };
}

/**
 * Hash parsed prompt-guide content without local root/path so the digest is
 * portable across worktrees and catalog checkout locations.
 */
export function hashPromptGuideContent(guide: H3PromptGuideSource): string {
  const { root: _root, path: _path, ...content } = guide;
  return sha256Canonical(content);
}

/**
 * Enrich a compilation lineage with loaded prompt-guide content and/or
 * pin-time asset hashes. Never invents hashes when sources are missing.
 */
export function enrichH3Compilation(
  compilation: H3Compilation,
  options: {
    promptGuide?: H3PromptGuideSource;
    assetHashes?: Record<string, string>;
  } = {}
): H3Compilation {
  const lineage: H3Lineage = { ...compilation.lineage };
  if (options.promptGuide) {
    if (!lineage.prompt_guide_identity) {
      lineage.prompt_guide_identity = options.promptGuide.catalog_id;
    }
    lineage.prompt_guide_hash = hashPromptGuideContent(options.promptGuide);
  }
  if (options.assetHashes && Object.keys(options.assetHashes).length > 0) {
    lineage.asset_hashes = Object.fromEntries(
      Object.entries(options.assetHashes).sort(([left], [right]) => left.localeCompare(right))
    );
  }
  return { ...compilation, lineage };
}

/**
 * Attach loaded prompt-guide content hashes to compilations using each request's
 * `prompt_guide.catalog` (or leave lineage unchanged when no guide was loaded).
 */
export function enrichH3CompilationsForProject(
  compilations: H3Compilation[],
  project: Project,
  promptGuides: H3PromptGuideSource[]
): H3Compilation[] {
  if (compilations.length === 0 || promptGuides.length === 0) return compilations;
  const byCatalog = new Map(promptGuides.map((guide) => [guide.catalog_id, guide]));
  return compilations.map((compilation) => {
    const request = project.generation?.requests.find((item) => item.id === compilation.request_id);
    const catalog = request?.prompt_guide?.catalog;
    const guide = catalog ? byCatalog.get(catalog) : undefined;
    return guide ? enrichH3Compilation(compilation, { promptGuide: guide }) : compilation;
  });
}

function assetIndex(ir: H3CreativeIr, asset: H3Asset): number {
  return ir.assets.findIndex((item) => item.id === asset.id);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "number") return left === right;
  return left === right;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
