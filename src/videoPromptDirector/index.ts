/**
 * Provider-neutral Video Prompt Director core.
 * H3 public compatibility is re-exported via h3Compat; adapters/providers are not imported here.
 */

export * from "./h3Compat.js";

export {
  videoCreativeIrSchema,
  videoModelIdSchema,
  parseVideoCreativeIr,
  safeParseVideoCreativeIr,
  type VideoCreativeIr
} from "./schema.js";

export {
  modelPromptProfileSchema,
  loadModelPromptProfile,
  modelProfileDigest,
  modelProfileSupportsMode,
  assertModelModeSupported,
  assertSemanticsAllowed,
  MODEL_PROFILE_STALE_CODE,
  MODEL_PROFILE_UNKNOWN_CODE,
  MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
  MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE,
  type ModelPromptProfile,
  type ModelProfileLoadResult
} from "./modelProfile.js";

export {
  connectionCapabilityProfileSchema,
  loadConnectionCapabilityProfile,
  connectionCapabilityDigest,
  resolveExactModelRoute,
  connectionRouteSupportsMode,
  assertConnectionModeSupported,
  CONNECTION_CAPABILITY_UNKNOWN_CODE,
  CONNECTION_CAPABILITY_STALE_CODE,
  CONNECTION_ROUTE_UNSUPPORTED_CODE,
  CONNECTION_ROUTE_EXACT_MISMATCH_CODE,
  CONNECTION_FAMILY_ONLY_CODE,
  type ConnectionCapabilityProfile,
  type ExactModelRoute,
  type ConnectionCapabilityLoadResult
} from "./connectionCapability.js";

export {
  evaluatePlanningReadiness,
  VPD_ADAPTER_MISSING_CODE,
  VPD_CATALOG_NOT_ADAPTER_CODE,
  VPD_RUNTIME_NOT_READY_CODE,
  VPD_PRICE_UNKNOWN_CODE,
  VPD_COST_APPROVAL_MISSING_CODE,
  VPD_AUTH_NOT_VERIFIED_CODE,
  VPD_PROFILE_CONNECTION_MISMATCH_CODE,
  type PlanningReadinessInput,
  type PlanningReadinessResult
} from "./executionReadiness.js";

export {
  resolveAdapterImplementation,
  VPD_ADAPTER_REGISTRY_MISSING_CODE,
  type AdapterImplementationCheckInput,
  type AdapterImplementationCheckResult
} from "./adapterImplementation.js";

export {
  buildAssetFields,
  applyAssetBinding,
  exclusiveSemanticsForMode,
  type NeutralAssetFields
} from "./assetBinding.js";

export {
  VIDEO_PROMPT_WORKFLOW_ID,
  VIDEO_PROMPT_WORKFLOW_VERSION,
  buildLineage
} from "./lineage.js";

export {
  renderVideoPrompt,
  renderPlainPrompt,
  RENDER_PROFILE_REQUIRED_CODE
} from "./render/index.js";

export {
  verifyModelProfileAgainstKnowledge,
  loadKnowledgeModelLimits,
  assertProfileWithinKnowledgeBounds,
  parseModelProfileSourcePin,
  resolveKnowledgePinPath,
  resolveKnowledgePinPathForRead,
  MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE,
  MODEL_PROFILE_KNOWLEDGE_PIN_CODE
} from "./knowledgeBounds.js";

export {
  compileVideoPromptRequest,
  planVideoPrompt,
  compileProjectVideoPrompts,
  rejectDualAuthoring,
  rejectUncompiledVideoPrompt,
  VIDEO_PROMPT_DUAL_AUTHORING_CODE,
  VIDEO_PROMPT_UNCOMPILED_CODE,
  type CompileVideoPromptOptions,
  type CompileVideoPromptResult,
  type CompileProjectVideoPromptResult,
  type VideoPromptPlan
} from "./videoPromptCompile.js";
