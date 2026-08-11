/**
 * H3 Prompt Director — public API compatibility shim.
 *
 * Implementation lives in src/videoPromptDirector (provider-neutral core +
 * h3Compat). This module preserves the historical public export surface:
 * Creative IR schema, deterministic label mapping, base/reference renderers,
 * static validation, request compiler, lineage enrichment, and run artifacts.
 * No adapter execution, Gate mutations, or shell concatenation live here.
 *
 * H3-specific grammar (Picture labels, FL2VA/L2VA, last-frame-only) is declared
 * only on the minimax-h3 model prompt profile (renderer: h3-grammar).
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
  type H3Scene,
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
  validateScenes,
  LOCK_HASH_MISMATCH_CODE,
  SCENE_LOCATION_MAP_MISMATCH_CODE,
  SCENE_UNDECLARED_SUBJECT_CODE,
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
} from "./validate/index.js";

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
} from "./runArtifacts.js";

export {
  canonicalJson,
  stablePrettyJson,
  sha256Canonical,
  sha256Text
} from "./hash.js";

export {
  videoPromptIrV2Schema,
  videoPromptModeV2Schema,
  parseVideoPromptIrV2,
  safeParseVideoPromptIrV2,
  type VideoPromptIrV2,
  type VideoPromptIrV2Standalone,
  type VideoPromptIrV2Mv
} from "../videoPromptDirector/schemaV2.js";

export {
  upgradeH3V1ToVideoPromptV2,
  compileLegacyH3V1,
  compileH3V1ThroughV2,
  compileVideoPromptIrV2,
  type V1UpgradeOptions,
  type V1UpgradeResult,
  type CompileVideoPromptV2Options,
  type CompileVideoPromptV2Result
} from "../videoPromptDirector/index.js";
