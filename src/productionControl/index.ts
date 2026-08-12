export * from "./artifactStore.js";
export * from "./canonical.js";
export * from "./contractCompiler.js";
export * from "./contractRegistry.js";
export * from "./dependencyIndex.js";
export * from "./errors.js";
export * from "./eventStore.js";
export * from "./events.js";
export * from "./invalidation.js";
export * from "./programBinding.js";
export * from "./reducer.js";
export * from "./roleEnvelope.js";
export * from "./schema.js";
export * from "./statePersistence.js";
export * from "./taskTreeCompiler.js";
export * from "./taskTreeTemplates.js";
export * from "./contracts/asset.js";
export * from "./contracts/identity.js";
export * from "./contracts/lyrics.js";
export * from "./contracts/music.js";
export * from "./contracts/generationUnit.js";
export * from "./templates/mv.js";
export * from "./mv/timeline.js";
export * from "./mv/composition.js";
export * from "./gateBundle.js";
export * from "./gateSubjects.js";
export * from "./authorityGuard.js";
export * from "./leases.js";
export * from "./dispatcher.js";
export * from "./generationBridge.js";
export * from "./resume.js";
export * from "./activePipeline.js";
export * from "./pricingEvidence.js";
export * from "./durableGateEvidence.js";
export * from "./activeRunGeneration.js";
export * from "./recoveryContracts.js";
export * from "./revisionIntent.js";
export * from "./grantLedger.js";
export * from "./grantStore.js";
// LocalRecoveryPermit mint is intentionally not a public package export.
// Only the local recovery executor (activeRecovery) and authority path mint/consume.
export {
  type SealedPaidAuthorization,
  type SealedLocalRecoveryPermit,
  isSealedPaidAuthorization,
  isSealedLocalRecoveryPermit,
  type RecoveryStopReason,
  type RecoveryDecision,
  createPolicySpec,
  issueRegenerationGrant,
  issueAndPersistRegenerationGrant,
  type AuthorizePaidRegenerationInput,
  authorizePaidRegeneration,
  burnSealedPaidAuthorization,
  rehydrateSealedPaidAuthorization,
  selectRecoveryAction,
  safeStopAwaitingHuman,
  computeRegenerationAttemptKey,
  assertPaidAuthorizationMatchesBinding,
  assertRouteUnchanged,
  assertPolicyExemptSealedAuthorization,
  gateDriftKindsForSealedRevisionIntent
} from "./recovery.js";
// runActivePaidRegeneration is internal — public paid entry is executeCoordinatorPaidRecovery
// (requires confirm_paid=true). Silent programmatic spend via the package surface is forbidden.
export {
  type ActivePaidRegenerationInput,
  type ActivePaidRegenerationResult,
  type ActiveLocalRecoveryInput,
  type ActiveLocalRecoveryResult,
  type CoordinatorRecoveryPlan,
  resumePaidRegenerationContext,
  runActiveLocalRecovery,
  planCoordinatorRecovery,
  executeCoordinatorPaidRecovery
} from "./activeRecovery.js";
export {
  assertContainedUnderProjectRoot,
  isWithinPath,
  type ContainedPathResult
} from "./recoveryPathSafety.js";
