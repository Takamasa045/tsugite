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
  requiredSemanticsForMode,
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
  resolveConnectionPinPath,
  verifyConnectionPinFile,
  resolveExactModelRoute,
  resolveExactModelRouteForMode,
  connectionRouteSupportsMode,
  assertConnectionModeSupported,
  CONNECTION_CAPABILITY_UNKNOWN_CODE,
  CONNECTION_CAPABILITY_STALE_CODE,
  CONNECTION_CAPABILITY_PIN_CODE,
  CONNECTION_CAPABILITY_READINESS_CODE,
  CONNECTION_ROUTE_UNSUPPORTED_CODE,
  CONNECTION_ROUTE_EXACT_MISMATCH_CODE,
  CONNECTION_FAMILY_ONLY_CODE,
  type ConnectionCapabilityProfile,
  type ExactModelRoute,
  type ConnectionCapabilityLoadResult,
  type LoadConnectionCapabilityOptions
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
  type GenerationUnitSourceResolver,
  type VideoPromptPlan
} from "./videoPromptCompile.js";

export {
  createProjectGenerationUnitSourceResolver,
  isAuthoritativeGenerationUnitSource,
  generationUnitContractFacts
} from "./generationUnitSourceResolver.js";

export {
  videoPromptIrV2Schema,
  videoPromptModeV2Schema,
  parseVideoPromptIrV2,
  safeParseVideoPromptIrV2,
  programBindingSchema,
  routeIdentitySchema,
  type VideoPromptIrV2,
  type VideoPromptIrV2Standalone,
  type VideoPromptIrV2Mv,
  type ShotV2,
  type VocalEventV2,
  type VisibleTextEventV2,
  type ProgramBindingForV2,
  type RouteIdentityForV2
} from "./schemaV2.js";

export { identityDefinitionSchema, type IdentityDefinitionContractV1 } from "../personConsistency/schema.js";

export {
  upgradeH3V1ToVideoPromptV2,
  upgradeVideoPromptV1ToV2,
  type V1UpgradeOptions,
  type V1UpgradeResult
} from "./upgradeV1.js";

export {
  buildSemanticBlocks,
  semanticBlockDigestMap,
  semanticBlocksDigest,
  validateExactText,
  resolveVocalEventText,
  DEFAULT_RESERVED_EXACT_TEXT_TOKENS,
  type LyricsSource,
  type LyricsCueSource,
  type SemanticPromptBlock,
  type SemanticBlockResult,
  type SemanticBlockOptions
} from "./semanticBlocks.js";

export {
  createEffectiveGenerationContract,
  createRouteIdentity,
  routeFromProfiles,
  routeIdentityDigest,
  assertRouteIdentity,
  assertEffectiveGenerationContract,
  assertHomogeneousRouteIdentity,
  validatePromptBudget,
  validatePromptLength,
  type EffectiveGenerationContractV1,
  type PromptBudget,
  type BudgetLimit,
  type CapabilityClaim,
  type EffectiveContractTruth,
  type RouteIdentityInput,
  effectiveGenerationContractSchema
} from "./effectiveContract.js";

export {
  type PinnedPromptBudgetEvidence,
  type TrustedPinnedPromptBudgetEvidence
} from "./promptBudgetEvidence.js";

export {
  buildAdapterLabelMap,
  compileAdapterDialect,
  validateAdapterDialect,
  loadAdapterDialectCapability,
  adapterDialectProfileDigest,
  resolveRendererDialectCapability,
  ADAPTER_DIALECT_PROFILE_CODE,
  type AdapterDialectCapability,
  type RendererDialectCapability,
  type AdapterLabel,
  type AdapterLabelMap,
  type AdapterDialectResult
} from "./adapterDialect.js";

export {
  compileVideoPromptIrV2,
  compileH3V1ThroughV2,
  compileLegacyH3V1,
  validateMvBinding,
  VIDEO_PROMPT_V2_WORKFLOW_ID,
  VIDEO_PROMPT_V2_WORKFLOW_VERSION,
  type CompileVideoPromptV2Options,
  type CompileVideoPromptV2Result,
  type VideoPromptV2Compilation,
  type GenerationUnitDurationBinding,
  type LegacyH3CompatibilityCompilation
} from "./compileV2.js";

export {
  renderH3GrammarV3,
  validateGrammarShape,
  DEFAULT_H3_GRAMMAR_PROFILE_V3,
  H3_GRAMMAR_V3_VERSION,
  H3_BASE_SECTION_ORDER_V3,
  H3_REFERENCE_SECTION_ORDER_V3,
  h3GrammarProfileDigest,
  isTrustedH3GrammarProfile,
  loadPinnedH3GrammarProfile,
  type H3GrammarProfileV3,
  type H3GrammarV3Result,
  type H3GrammarV3Options
} from "./render/h3GrammarV3.js";

export {
  compilationBundleSchema,
  compilationRevisionId,
  deriveExecutionCompilationBundleFromPlanningArtifact,
  isAdoptedExecutionCompilationBundle,
  createExecutionSubmissionLease,
  consumeExecutionSubmissionLease,
  verifyCompilationBundle,
  assertCompilationBundleAssets,
  isProjectAssetIdentityContained,
  writeCompilationBundleAtomic,
  readCompilationBundleAtomic,
  writeShadowComparisonAtomic,
  type RuntimeAssetPinEvidence,
  type AssetPin,
  type CompilationBundleV1,
  type CompilationBundleInput,
  type ExecutionCompilationBundle,
  type ExecutionBundleAuthorityContext,
  type ExecutionSubmissionLease,
  type CreateOnlyArtifactStoreEnvelope
} from "./compilationBundle.js";
