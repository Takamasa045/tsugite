/**
 * Finalize apply routing: empty vs mutating paths after a validated plan.
 * Phase bodies live in finalizeApplyEmpty / finalizeApplyMutating (+ phase modules).
 */
import { ensureFinalizedProjectInLauncherHome, planLauncherHome } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import {
  applyEmptyCandidatesPromotionAndRecord,
  applyIdempotentEmptyAlreadyHome
} from "./finalizeApplyEmpty.js";
import { applyMutatingFinalizeCleanup } from "./finalizeApplyMutating.js";
import { readOptionalRegularFileText } from "./finalizeCompletionRecord.js";
import type { FinalizeFileIdentity } from "./finalizeJournal.js";
import type { FinalizePinnedDirs } from "./finalizePathSafety.js";
import {
  collectReferencedMedia,
  failure
} from "./finalizePlanHelpers.js";
import type { PriorCleanupProgress } from "./finalizeRecovery.js";
import {
  inspectFinalizeDeletionCandidate,
  recheckPlanIdentityBeforeMutation,
  revalidateLiveFinalizeConditions
} from "./finalizeRevalidation.js";
import {
  comparePath,
  errorMessage,
  toProjectRelative
} from "./finalizeShared.js";
import type {
  FinalizeCompletedProjectOptions,
  FinalizeCompletedProjectResult
} from "./finalizeTypes.js";
import { readState } from "./state.js";

export type FinalizeApplyContext = {
  options: FinalizeCompletedProjectOptions;
  projectRoot: string;
  stateDir: string;
  runId: string;
  runDir: string;
  recordPath: string;
  canonicalOutputPath: string;
  canonicalConfigPath: string;
  canonicalManifestPath: string;
  manifestDir: string;
  cleanupRoots: readonly string[];
  candidates: readonly string[];
  mediaFiles: readonly string[];
  retainedMedia: readonly string[];
  identities: readonly FinalizeFileIdentity[];
  plannedBytes: number;
  referencedSourceMedia: readonly string[];
  planDigest: string;
  priorCleanup: PriorCleanupProgress;
  state: Awaited<ReturnType<typeof readState>>;
  finalOutputDigest: string;
  launcherPlan: Awaited<ReturnType<typeof planLauncherHome>>;
  pinnedDirs: FinalizePinnedDirs;
  revalidatePinnedDirs: () => Promise<Issue | undefined>;
  base: FinalizeCompletedProjectResult;
};

function completionRecordProject(options: FinalizeCompletedProjectOptions) {
  return {
    projectSlug: options.project.slug,
    now: options.now
  };
}

/**
 * Apply-path orchestration: preflight → empty or mutating phase handlers.
 * Phase bodies live in finalizeApplyEmpty / finalizeApplyMutating (+ phase modules);
 * safety primitives live in finalizeQuarantine / finalizeCompletionRecord / finalizeRecovery.
 */
export async function executeFinalizeApply(
  ctx: FinalizeApplyContext
): Promise<FinalizeCompletedProjectResult> {
  const {
    options,
    projectRoot,
    stateDir,
    runId,
    runDir,
    recordPath,
    canonicalOutputPath,
    canonicalManifestPath,
    manifestDir,
    cleanupRoots,
    candidates,
    mediaFiles,
    retainedMedia,
    identities,
    plannedBytes,
    referencedSourceMedia,
    planDigest,
    priorCleanup,
    state,
    finalOutputDigest,
    launcherPlan,
    revalidatePinnedDirs,
    base
  } = ctx;

  const project = completionRecordProject(options);
  const emptyShared = {
    projectRoot,
    stateDir,
    runId,
    runDir,
    recordPath,
    canonicalOutputPath,
    referencedSourceMedia,
    planDigest,
    priorCleanup,
    stateUpdatedAt: state.updated_at,
    launcherPlan,
    project,
    base,
    configPath: options.configPath,
    projectSlug: options.project.slug,
    now: options.now,
    promotionHooks: options._testHooks?.promotion,
    revalidatePinnedDirs
  };

  // Empty candidates + already-home + existing record: idempotent success / merge prior progress.
  if (candidates.length === 0) {
    const idempotent = await applyIdempotentEmptyAlreadyHome(emptyShared);
    if (idempotent) return idempotent as FinalizeCompletedProjectResult;
  }

  // Read prior completion-record only as a regular file (lstat + O_NOFOLLOW).
  // Refuse leaf symlinks before journal creation so external content is never snapshotted.
  const existingRecord = await readOptionalRegularFileText(recordPath, {
    outsideCode: "finalize.record_path_outside_project",
    symlinkCode: "finalize.record_path_symlink",
    unsafeCode: "finalize.record_path_unsafe",
    projectRoot
  });
  if (existingRecord.status === "unsafe") return failure(base, existingRecord.issue);
  const existingRecordText = existingRecord.status === "ok" ? existingRecord.text : undefined;
  // Full manifest reference set (including missing files) for mid-apply retention drift checks.
  const plannedManifestReferencedRelative = collectReferencedMedia(options.manifest, manifestDir)
    .map((path) => toProjectRelative(projectRoot, path))
    .sort(comparePath);

  try {
    // Immediately before the first mutation, rebuild the plan identity and re-check candidates.
    // This closes TOCTOU gaps on projects home / slug / config / candidate drift after preview.
    const preMutationBoundary = await revalidatePinnedDirs();
    if (preMutationBoundary) return failure(base, preMutationBoundary);
    const preMutationStale = await recheckPlanIdentityBeforeMutation({
      expectedPlanDigest: options.expectedPlanDigest!,
      configPath: options.configPath,
      projectSlug: options.project.slug,
      projectRoot,
      manifestPath: canonicalManifestPath,
      stateDir,
      runId,
      finalOutputDigest,
      gate3ApprovedInputDigest: state.gates.gate_3.approved_input_digest!,
      retainedMedia,
      candidates,
      identities,
      cleanupRoots
    });
    if (preMutationStale) return failure(base, preMutationStale);

    // Promotion preflight before any destructive work. Full promote runs after quarantine
    // so the durable home receives a tree without superseded media paths.
    if (!launcherPlan.alreadyHome) {
      const preflight = await ensureFinalizedProjectInLauncherHome({
        configPath: options.configPath,
        projectSlug: options.project.slug,
        apply: false,
        now: options.now
      });
      if (!preflight.ok) {
        return {
          ...base,
          ok: false,
          deletedFiles: priorCleanup.deletedFiles,
          deletedBytes: priorCleanup.deletedBytes,
          issues: preflight.issues,
          promotedToLauncherHome: false,
          launcherProjectRoot: preflight.destinationRoot,
          launcherConfigPath: preflight.destinationConfigPath
        };
      }
    }

    if (candidates.length === 0) {
      return await applyEmptyCandidatesPromotionAndRecord(emptyShared) as FinalizeCompletedProjectResult;
    }

    return await applyMutatingFinalizeCleanup({
      projectRoot,
      stateDir,
      runId,
      runDir,
      recordPath,
      canonicalOutputPath,
      candidates,
      mediaFiles,
      identities,
      plannedBytes,
      referencedSourceMedia,
      planDigest,
      priorCleanup,
      stateUpdatedAt: state.updated_at,
      launcherPlan,
      project,
      configPath: options.configPath,
      projectSlug: options.project.slug,
      now: options.now,
      existingRecordText,
      base,
      testHooks: options._testHooks,
      revalidatePinnedDirs,
      revalidateLiveFinalizeConditions: ({ quarantinedOriginalPaths }) => revalidateLiveFinalizeConditions({
        runDir,
        runId,
        canonicalOutputPath,
        expectedFinalDigest: finalOutputDigest,
        expectedGate3Digest: state.gates.gate_3.approved_input_digest!,
        projectRoot,
        project: options.project,
        plannedManifestReferencedRelative,
        plannedRetainedMedia: retainedMedia,
        quarantinedOriginalPaths
      }),
      inspectDeletionCandidate: (absolutePath, expected) => inspectFinalizeDeletionCandidate(
        absolutePath,
        expected,
        projectRoot,
        cleanupRoots
      )
    }) as FinalizeCompletedProjectResult;
  } catch (error) {
    return {
      ...base,
      ok: false,
      // Preserve any measured progress already returned by nested handlers; outer catch
      // only sees unexpected throws before measured counters exist.
      deletedFiles: priorCleanup.deletedFiles,
      deletedBytes: priorCleanup.deletedBytes,
      issues: [{
        code: "finalize.cleanup_failed",
        message: errorMessage(error)
      }]
    };
  }
}
