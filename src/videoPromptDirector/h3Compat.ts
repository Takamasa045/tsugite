/**
 * H3 compatibility surface over the provider-neutral Video Prompt Director core.
 * Public H3 API shapes, workflow id/version, and H3-only grammar remain stable.
 * H3-specific last-frame-only / FL2VA / L2VA / Picture labels live in the
 * minimax-h3 model prompt profile (renderer: h3-grammar), not in other profiles.
 */

export {
  h3CreativeIrSchema,
  h3ModeSchema,
  h3ModeUiLabel,
  H3_MODE_UI_LABELS,
  h3ModelSchema,
  H3_CANONICAL_MODEL,
  h3QualitySchema,
  h3AspectSchema,
  H3_MODEL_ASPECTS,
  h3AssetTypeSchema,
  h3AssetRoleSchema,
  h3CameraTypeSchema,
  parseH3CreativeIr,
  safeParseH3CreativeIr,
  type H3CreativeIr,
  type H3Mode,
  type H3Model,
  type H3Quality,
  type H3Aspect,
  type H3ModelAspect,
  type H3Asset,
  type H3Subject,
  type H3Shot,
  type H3Dialogue,
  type H3Camera
} from "./schema.js";

export {
  mapH3AssetLabels,
  h3LabelForAsset,
  adapterLabelForAsset,
  type H3AssetLabel,
  type H3SubjectLabel,
  type H3LabelMap
} from "./assetLabels.js";

export {
  renderH3Prompt,
  renderH3BasePrompt,
  renderH3ReferencePrompt,
  BASE_SECTION_ORDER,
  REFERENCE_SECTION_ORDER,
  formatCutTimestamp,
  type H3RenderResult,
  type H3BaseSection,
  type H3ReferenceSection
} from "./render/index.js";

export {
  validateH3CreativeIr,
  validateH3Format,
  validateH3AdapterRoute,
  validateH3Warnings,
  validateLockedBlocks,
  LOCK_HASH_MISMATCH_CODE,
  H3_ROUTE_MODEL_MISMATCH_CODE,
  H3_ROUTE_UNSUPPORTED_MODE_CODE,
  H3_ASSET_BINDING_MISMATCH_CODE,
  H3_PROVIDER_MODEL_MAPPING_MISSING_CODE,
  type H3ExecutionRouteProfile,
  type H3RouteModeBinding,
  type H3Issue,
  type H3IssueSeverity,
  type H3ValidationResult,
  type H3ValidateOptions
} from "./validation/index.js";

export {
  hashLockedText,
  collectLockedBlockHashes,
  LOCKED_BLOCK_FIELDS,
  type LockedBlockField,
  type LockedTextBlock,
  type SubjectLockedBlocks
} from "./lockedBlocks.js";

export {
  compileH3Request,
  compileProjectH3,
  applyH3ExecutionRouteProfile,
  mapMode,
  h3IssueToProjectIssue,
  hashPromptGuideContent,
  enrichH3Compilation,
  enrichH3CompilationsForProject,
  H3_WORKFLOW_ID,
  H3_WORKFLOW_VERSION,
  H3_ROUTE_PROFILE_REQUIRED_CODE,
  type H3Compilation,
  type H3Lineage,
  type H3PromptGuideSource,
  type CompileH3RequestResult,
  type CompileProjectH3Result,
  type CompileH3Options
} from "./compile.js";

export {
  writeH3RunArtifacts,
  inspectH3RunArtifacts,
  h3AdapterPromptFileName,
  type H3RequestArtifacts
} from "./artifacts.js";

export {
  canonicalJson,
  stablePrettyJson,
  sha256Canonical,
  sha256Text
} from "../integrity/canonical.js";
