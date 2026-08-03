/**
 * Mutating finalize apply facade after candidates are known non-empty:
 * preflight → quarantine → promote → completion-record → permanent delete → rollback on failure.
 *
 * Implementation lives in responsibility modules:
 * - finalizeApplyMutatingShared.ts — types, journal helpers
 * - finalizeApplyMutatingPreflight.ts — boundary revalidation + WAL bootstrap
 * - finalizeApplyMutatingQuarantinePhase.ts — quarantine renames
 * - finalizeApplyMutatingPromoteRecord.ts — promotion + completion-record
 * - finalizeApplyMutatingCommit.ts — permanent delete / measured commit
 * - finalizeApplyMutatingFailure.ts — rollback / partial-delete / unexpected failure
 */
import { mkdir } from "node:fs/promises";
import type { PromotionTransaction } from "../project/projectsHome.js";
import type { QuarantinedCandidate } from "./finalizeQuarantine.js";
import { permanentlyDeleteQuarantinedAndComplete } from "./finalizeApplyMutatingCommit.js";
import { handleUnexpectedMutatingFailure } from "./finalizeApplyMutatingFailure.js";
import { prepareMutatingApplyPreflight } from "./finalizeApplyMutatingPreflight.js";
import { promoteAndWriteCompletionRecord } from "./finalizeApplyMutatingPromoteRecord.js";
import { quarantineDeletionCandidates } from "./finalizeApplyMutatingQuarantinePhase.js";
import {
  type MutatingApplyContext,
  type MutatingApplyResult,
  type SessionCounters
} from "./finalizeApplyMutatingShared.js";

export type {
  MutatingApplyContext,
  MutatingApplyResult,
  MutatingApplyTestHooks
} from "./finalizeApplyMutatingShared.js";

/**
 * Full mutating cleanup path: journal → quarantine → promote → record → permanent delete.
 */
export async function applyMutatingFinalizeCleanup(
  ctx: MutatingApplyContext
): Promise<MutatingApplyResult> {
  const preflight = await prepareMutatingApplyPreflight(ctx);
  if (preflight.kind === "failed") return preflight.result;

  const { quarantineRoot } = preflight;
  let journal = preflight.journal;

  await mkdir(quarantineRoot, { recursive: true });
  const quarantined: QuarantinedCandidate[] = [];
  /** Open until completion-record is confirmed; rolled back on pre-record failure. */
  let openPromotionTransaction: PromotionTransaction | undefined;
  const session: SessionCounters = {
    deletedFiles: 0,
    deletedBytes: 0,
    paths: []
  };

  try {
    const quarantinedPhase = await quarantineDeletionCandidates({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      setJournal: (next) => {
        journal = next;
      }
    });
    if (quarantinedPhase.kind === "failed") return quarantinedPhase.result;
    journal = quarantinedPhase.journal;

    const promoteRecord = await promoteAndWriteCompletionRecord({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      setJournal: (next) => {
        journal = next;
      },
      setOpenPromotionTransaction: (tx) => {
        openPromotionTransaction = tx;
      }
    });
    if (promoteRecord.kind === "failed") return promoteRecord.result;
    journal = promoteRecord.journal;
    const { launcherHome, recordPaths, promotionCommitIssues } = promoteRecord;

    return await permanentlyDeleteQuarantinedAndComplete({
      ctx,
      journal,
      quarantineRoot,
      quarantined,
      launcherHome,
      recordPaths,
      promotionCommitIssues,
      session,
      setJournal: (next) => {
        journal = next;
      }
    });
  } catch (error) {
    return handleUnexpectedMutatingFailure({
      ctx,
      error,
      journal,
      quarantineRoot,
      quarantined,
      openPromotionTransaction,
      session,
      setJournal: (next) => {
        journal = next;
      }
    });
  }
}
