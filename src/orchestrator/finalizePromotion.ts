import { dirname, resolve } from "node:path";
import {
  ensureFinalizedProjectInLauncherHome,
  planLauncherHome,
  type EnsureLauncherHomeResult,
  type PromotionTransaction,
  type PromotionTransactionTestHooks
} from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import { errorMessage } from "./finalizeShared.js";

export type PromoteIfNeededOptions = {
  configPath: string;
  projectSlug: string;
  now?: string;
  promotionHooks?: PromotionTransactionTestHooks;
};

/**
 * Promote the finalized project into the durable launcher home when needed.
 * alreadyHome short-circuits without copying.
 */
export async function promoteIfNeeded(
  options: PromoteIfNeededOptions,
  alreadyHome: boolean
): Promise<EnsureLauncherHomeResult> {
  if (alreadyHome) {
    return {
      ok: true,
      issues: [],
      projectsHome: (await planLauncherHome(options.configPath, options.projectSlug)).projectsHome,
      projectRoot: dirname(resolve(options.configPath)),
      destinationRoot: dirname(resolve(options.configPath)),
      alreadyHome: true,
      promoted: false,
      destinationConfigPath: resolve(options.configPath)
    };
  }
  return ensureFinalizedProjectInLauncherHome({
    configPath: options.configPath,
    projectSlug: options.projectSlug,
    apply: true,
    now: options.now,
    _testHooks: options.promotionHooks
  });
}

/**
 * Drop the durable promotion backup after the completion-record is confirmed.
 * Commit failures must not be swallowed: keep the promotion journal for restart
 * recovery and surface a stable issue code instead of treating finalize as ok.
 */
export async function commitPromotionTransaction(
  transaction: PromotionTransaction | undefined
): Promise<Issue[]> {
  if (!transaction) return [];
  try {
    await transaction.commit();
    return [];
  } catch (error) {
    return [{
      code: "finalize.promotion_commit_failed",
      message: errorMessage(error),
      path: transaction.destinationRoot
    }];
  }
}

export async function rollbackPromotionTransaction(
  transaction: PromotionTransaction | undefined
): Promise<Issue[]> {
  if (!transaction) return [];
  try {
    await transaction.rollback();
    return [];
  } catch (error) {
    return [{
      code: "finalize.promotion_rollback_failed",
      message: errorMessage(error),
      path: transaction.destinationRoot
    }];
  }
}
