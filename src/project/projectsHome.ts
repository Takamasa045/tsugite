/**
 * Durable launcher projects home — public facade.
 *
 * Implementation lives in:
 * - projectsHomeShared.ts — public types and common path helpers
 * - projectsHomeResolve.ts — durable home resolution and launcher plan
 * - projectsHomeShelf.ts — pre-production shelf visibility / directory links
 * - projectsHomePromotionSafety.ts — promotion path safety and marker write
 * - projectsHomePromotionTransaction.ts — switch / open tx / commit / rollback
 */

export {
  isWithinDirectory,
  type EnsureLauncherHomeOptions,
  type EnsureLauncherHomeResult,
  type EnsureProjectVisibleOptions,
  type EnsureProjectVisibleResult,
  type LauncherHomePlan,
  type PromotionTransaction,
  type PromotionTransactionTestHooks,
  type ResolveDurableProjectsHomeOptions
} from "./projectsHomeShared.js";

export {
  planLauncherHome,
  resolveDurableProjectsHome
} from "./projectsHomeResolve.js";

export {
  ensureProjectVisibleOnLauncherShelf
} from "./projectsHomeShelf.js";

export {
  ensureFinalizedProjectInLauncherHome
} from "./projectsHomePromotionTransaction.js";

/** Re-export recovery for startup / explicit resume without going through ensure*. */
export { recoverPromotionTransactions } from "./promotionJournal.js";
