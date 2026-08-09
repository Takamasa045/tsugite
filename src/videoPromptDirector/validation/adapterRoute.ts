import type { H3CreativeIr, H3Mode } from "../schema.js";
import { finalizeValidation, issue, type H3Issue, type H3ValidationResult } from "./types.js";

/**
 * Fail closed when IR target.model does not exactly match the adapter route profile model.
 * Distinct from quality (PV-E002) and from missing-profile (H3-C005).
 */
export const H3_ROUTE_MODEL_MISMATCH_CODE = "H3-C006";
/** Selected adapter route does not declare support for this H3 mode. */
export const H3_ROUTE_UNSUPPORTED_MODE_CODE = "H3-C007";
/** Neutral asset fields do not satisfy the adapter mode asset binding. */
export const H3_ASSET_BINDING_MISMATCH_CODE = "H3-C008";
/** Adapter requires an explicit ir_model → provider_model mapping that is missing. */
export const H3_PROVIDER_MODEL_MAPPING_MISSING_CODE = "H3-C009";

/**
 * Provider-neutral mode binding declared by an adapter route profile.
 * Core compile produces neutral intents; adapters bind operation / input_mode / assets.
 */
export type H3RouteModeBinding = {
  operation: "video" | "transition" | "reference";
  /** Adapter-facing input_mode after binding (may differ from neutral core intent). */
  input_mode: string;
  /**
   * How neutral GenerationRequest asset fields map onto adapter media fields.
   * - none: no media
   * - first_frame: first_frame only
   * - last_frame: last_frame only
   * - first_and_last_frame: keep first_frame + last_frame
   * - first_last_as_input_images: pack [first, last] into input_images (adapter transition routes)
   * - reference_lists: input_images / input_videos / input_audios
   */
  asset_binding:
    | "none"
    | "first_frame"
    | "last_frame"
    | "first_and_last_frame"
    | "first_last_as_input_images"
    | "reference_lists";
};

/**
 * Provider-neutral execution-route profile for H3-compiled generation requests.
 * Concrete limits live in each adapter's constraints.yaml (`h3_execution_route`).
 * Core never hardcodes vendor duration/aspect/quality/reference caps.
 */
export type H3ExecutionRouteProfile = {
  /** Required non-empty IR model id; IR target.model must match exactly (no fallback). */
  model: string;
  /** Explicit provider model id for the selected adapter route. */
  provider_model?: string;
  /** Optional minimum CLI version required by this adapter route. */
  min_cli_version?: string;
  durations: readonly number[];
  aspects: readonly string[];
  qualities: readonly string[];
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  audioRequiresImageOrVideo: boolean;
  forbidFirstLastReferenceMix: boolean;
  /**
   * Mode → adapter binding. Modes absent from this map are unsupported (H3-C007).
   * When omitted, legacy profiles accept the four pre-Phase-A modes with identity binding.
   */
  modes?: Partial<Record<H3Mode, H3RouteModeBinding>>;
};

/**
 * Adapter execution-route validation (H3-C006 model match + PV-E001..E008 limits).
 * Requires an injected route profile — never invents vendor defaults.
 * Codes stay stable for existing fixtures.
 */
export function validateH3AdapterRoute(
  ir: H3CreativeIr,
  route: H3ExecutionRouteProfile
): H3ValidationResult {
  const issues: H3Issue[] = [];

  if (ir.target.model !== route.model) {
    issues.push(issue(
      H3_ROUTE_MODEL_MISMATCH_CODE,
      `H3 target model '${ir.target.model}' does not match adapter route model '${route.model}'`,
      "error",
      ["target", "model"]
    ));
  }

  if (route.modes && !route.modes[ir.target.mode]) {
    issues.push(issue(
      H3_ROUTE_UNSUPPORTED_MODE_CODE,
      `adapter route does not support H3 mode '${ir.target.mode}'`,
      "error",
      ["target", "mode"]
    ));
  }

  if (!(route.durations as readonly number[]).includes(ir.target.duration)) {
    issues.push(issue(
      "PV-E001",
      `duration must be one of ${route.durations.join(", ")} seconds for the adapter route`,
      "error",
      ["target", "duration"]
    ));
  }

  if (!(route.qualities as readonly string[]).includes(ir.target.quality)) {
    issues.push(issue(
      "PV-E002",
      `quality must be one of ${route.qualities.join(", ")} for the adapter route`,
      "error",
      ["target", "quality"]
    ));
  }

  if (!(route.aspects as readonly string[]).includes(ir.target.aspect)) {
    issues.push(issue(
      "PV-E008",
      `aspect must be one of ${route.aspects.join(", ")} for the adapter route`,
      "error",
      ["target", "aspect"]
    ));
  }

  const images = ir.assets.filter((asset) => asset.type === "image");
  const videos = ir.assets.filter((asset) => asset.type === "video");
  const audios = ir.assets.filter((asset) => asset.type === "audio");

  if (images.length > route.maxImages) {
    issues.push(issue(
      "PV-E003",
      `reference images exceed the route limit of ${route.maxImages}`,
      "error",
      ["assets"]
    ));
  }
  if (videos.length > route.maxVideos) {
    issues.push(issue(
      "PV-E004",
      `reference videos exceed the route limit of ${route.maxVideos}`,
      "error",
      ["assets"]
    ));
  }
  if (audios.length > route.maxAudios) {
    issues.push(issue(
      "PV-E005",
      `reference audios exceed the route limit of ${route.maxAudios}`,
      "error",
      ["assets"]
    ));
  }

  if (
    route.audioRequiresImageOrVideo
    && ir.target.mode === "reference"
    && audios.length > 0
    && images.length + videos.length === 0
  ) {
    issues.push(issue(
      "PV-E006",
      "audio-only reference generation is not allowed; include at least one image or video",
      "error",
      ["assets"]
    ));
  }

  if (route.forbidFirstLastReferenceMix && hasFirstLastReferenceMix(ir)) {
    issues.push(issue(
      "PV-E007",
      "first-last frame assets and reference assets must not be mixed on the adapter route",
      "error",
      ["target", "mode"]
    ));
  }

  return finalizeValidation(issues);
}

function hasFirstLastReferenceMix(ir: H3CreativeIr): boolean {
  const hasFirstLastRole = ir.assets.some(
    (asset) => asset.role === "first_frame" || asset.role === "last_frame"
  );
  const hasReferenceRole = ir.assets.some((asset) =>
    asset.role === "subject_reference"
    || asset.role === "motion_reference"
    || asset.role === "voice_reference"
    || asset.role === "environment_reference"
    || asset.role === "style_reference"
  );
  const hasVideoOrAudio = ir.assets.some((asset) => asset.type === "video" || asset.type === "audio");

  if (ir.target.mode === "reference" && hasFirstLastRole) return true;
  if (
    (ir.target.mode === "first-frame" || ir.target.mode === "first-last" || ir.target.mode === "last-frame")
    && (hasReferenceRole || hasVideoOrAudio)
  ) {
    return true;
  }
  if (hasFirstLastRole && (hasReferenceRole || hasVideoOrAudio)) return true;
  return false;
}
