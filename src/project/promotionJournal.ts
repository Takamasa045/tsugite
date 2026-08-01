/**
 * Durable promotion transaction journal under the launcher projects home.
 *
 * Public facade: types, constants, and re-exports of responsibility modules.
 * Implementation lives in:
 * - promotionJournalShared.ts — types, constants, error, path helpers
 * - promotionJournalIdentity.ts — schema validation + identity binding
 * - promotionJournalPathSafety.ts — contained path / symlink safety
 * - promotionJournalPersistence.ts — atomic journal load/write/clear
 * - promotionJournalRecovery.ts — commit / rollback / crash recovery
 */

export {
  PROMOTION_BACKUP_PREFIX,
  PROMOTION_IDENTITY_SEPARATOR,
  PROMOTION_JOURNAL_DIR_NAME,
  PROMOTION_JOURNAL_PHASES,
  PROMOTION_STAGING_PREFIX,
  PromotionJournalError,
  promotionJournalDir,
  promotionJournalPath,
  type PromotionJournal,
  type PromotionJournalLoadResult,
  type PromotionJournalPhase,
  type RecoverPromotionTransactionsResult
} from "./promotionJournalShared.js";

export {
  inspectPromotionIdentityBinding,
  isPromotionBackupBoundToIdentity,
  isPromotionStagingBoundToIdentity,
  parsePromotionJournalSchema,
  promotionBackupBaseName,
  promotionDestinationSlug,
  promotionStagingBasePrefix
} from "./promotionJournalIdentity.js";

export {
  hasSymlinkAlongPath,
  hasSymlinkAncestor,
  inspectPromotionJournalPaths,
  isWithinDirectory
} from "./promotionJournalPathSafety.js";

export {
  clearPromotionJournal,
  loadPromotionJournal,
  writePromotionJournal
} from "./promotionJournalPersistence.js";

export {
  finishCommitFromJournal,
  finishRollbackFromJournal,
  recoverPromotionTransactions
} from "./promotionJournalRecovery.js";
