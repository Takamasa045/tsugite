/**
 * Finalize public facade: boundary preflight, plan/preview, and apply entry.
 * Implementation is split by responsibility:
 * - finalizeTypes: public option/result contracts
 * - finalizePlanHelpers: media scan, retention, plan digest, result shells
 * - finalizeRevalidation: plan identity / live condition rechecks
 * - finalizeApplyRoute: empty vs mutating apply routing
 * - finalizeApplyEmpty / finalizeApplyMutating (+ phase modules): apply bodies
 */
import { dirname, join, resolve } from "node:path";
import { planLauncherHome } from "../project/projectsHome.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import { readState } from "./state.js";
import { sha256File } from "./render.js";
import { executeFinalizeApply } from "./finalizeApplyRoute.js";
import {
  finalizeJournalPath,
  readFinalizeJournal,
  type FinalizeFileIdentity,
  type FinalizeJournal,
  type FinalizeJournalCandidate,
  type FinalizeJournalPhase
} from "./finalizeJournal.js";
import {
  captureFinalizePinnedDirs,
  inspectApprovedStateDir,
  inspectPinnedFinalizeDirs,
  inspectProjectContainedPath,
  isRegularFile,
  isWithinPath,
  type FinalizePinnedDirs,
  type FinalizeRunDirIdentity,
  type FinalizeStateDirIdentity
} from "./finalizePathSafety.js";
import {
  CLEANUP_ROOT_NAMES,
  buildPlanDigest,
  captureRegularFileIdentity,
  collectReferencedMedia,
  failure,
  findMediaFiles,
  inspectManifestMediaReference,
  partitionMediaByRetention,
  resultBase
} from "./finalizePlanHelpers.js";
import { resolveAuthoritativeProductionId } from "../productionControl/authoritativeCoordination.js";
import {
  assertProductionCompletionDigestMatch,
  buildProductionCompletionDigest,
  coordinationEvidenceOnly,
  excludeControlPlaneFromDeletionCandidates,
  hasCoordinationControlPlane,
  listRetainedControlPlanePaths,
  type ControlPlaneEvidenceRefV1
} from "../productionControl/finalizeRetention.js";
import {
  inspectIncompleteFinalizeTransaction,
  recoverIncompleteFinalizeTransaction,
  type PriorCleanupProgress
} from "./finalizeRecovery.js";
import {
  comparePath,
  errorMessage,
  errorMessageOr,
  sameFinalizeIdentity,
  sameFinalizeStorageIdentity,
  toProjectRelative
} from "./finalizeShared.js";
import type {
  FinalizeCompletedProjectOptions,
  FinalizeCompletedProjectResult,
  FinalizeTestHooks
} from "./finalizeTypes.js";
import { revalidatePersonConsistencyOnFinalize } from "../qa/personConsistency/index.js";

/** Local alias kept for the many call sites that still use the historical name. */
const isWithin = isWithinPath;

export type {
  FinalizeFileIdentity,
  FinalizeJournal,
  FinalizeJournalCandidate,
  FinalizeJournalPhase,
  FinalizeRunDirIdentity,
  FinalizeStateDirIdentity,
  FinalizeTestHooks,
  FinalizeCompletedProjectOptions,
  FinalizeCompletedProjectResult
};

export { finalizeJournalPath, readFinalizeJournal };
export { sameFinalizeIdentity, sameFinalizeStorageIdentity };
export { buildPlanDigest } from "./finalizePlanHelpers.js";
export { inspectFinalizeDeletionCandidate } from "./finalizeRevalidation.js";

/**
 * Safety-boundary preflight for finalize apply.
 * Validates that stateDir equals project.dist_dir and stays inside the project
 * without symlink escape. Captures canonical path + device/inode for lock-time
 * revalidation. Does not create locks or mutate files.
 */
export async function preflightFinalizeApplyBoundary(input: {
  configPath: string;
  project: Project;
  stateDir?: string;
}): Promise<
  | {
    ok: true;
    stateDir: string;
    runId: string;
    runDir: string;
    stateDirIdentity: FinalizeStateDirIdentity;
    runDirIdentity?: FinalizeRunDirIdentity;
  }
  | { ok: false; issues: Issue[] }
> {
  const projectRoot = dirname(resolve(input.configPath));
  const allowedStateDir = resolve(projectRoot, input.project.dist_dir);
  const requestedStateDir = input.stateDir
    ? resolve(input.stateDir)
    : allowedStateDir;
  const stateDirIssue = await inspectApprovedStateDir(
    projectRoot,
    allowedStateDir,
    requestedStateDir
  );
  if (stateDirIssue) return { ok: false, issues: [stateDirIssue] };

  const runId = input.project.run_id ?? input.project.slug;
  const runDir = join(allowedStateDir, runId);
  const runDirIssue = await inspectProjectContainedPath(projectRoot, runDir, {
    outsideCode: "finalize.run_dir_outside_project",
    symlinkCode: "finalize.run_dir_symlink",
    unsafeCode: "finalize.run_dir_unsafe",
    requireDirectory: true,
    allowMissing: true
  });
  if (runDirIssue) return { ok: false, issues: [runDirIssue] };

  try {
    const pinned = await captureFinalizePinnedDirs({
      projectRoot,
      stateDir: allowedStateDir,
      runDir
    });
    return {
      ok: true,
      stateDir: allowedStateDir,
      runId,
      runDir,
      stateDirIdentity: pinned.stateDirIdentity,
      runDirIdentity: pinned.runDirIdentity
    };
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: "finalize.state_dir_unsafe",
        message: error instanceof Error
          ? error.message
          : "finalize stateDir identity could not be captured",
        path: allowedStateDir
      }]
    };
  }
}

export async function finalizeCompletedProject(
  options: FinalizeCompletedProjectOptions
): Promise<FinalizeCompletedProjectResult> {
  const projectRoot = dirname(resolve(options.configPath));
  const allowedStateDir = resolve(projectRoot, options.project.dist_dir);
  const requestedStateDir = options.stateDir
    ? resolve(options.stateDir)
    : allowedStateDir;
  const empty = resultBase(options.apply);

  const stateDirIssue = await inspectApprovedStateDir(
    projectRoot,
    allowedStateDir,
    requestedStateDir
  );
  if (stateDirIssue) return failure(empty, stateDirIssue);

  const stateDir = allowedStateDir;
  const runId = options.project.run_id ?? options.project.slug;
  const runDir = join(stateDir, runId);
  const canonicalOutputPath = join(runDir, "final.mp4");
  const recordPath = join(runDir, "completion-record.json");

  const runDirIssue = await inspectProjectContainedPath(projectRoot, runDir, {
    outsideCode: "finalize.run_dir_outside_project",
    symlinkCode: "finalize.run_dir_symlink",
    unsafeCode: "finalize.run_dir_unsafe",
    requireDirectory: true,
    allowMissing: true
  });
  if (runDirIssue) return failure(empty, runDirIssue);

  if (!isWithin(projectRoot, runDir)) {
    return failure(empty, {
      code: "finalize.state_dir_outside_project",
      message: "finalize requires the run directory to stay inside the project directory",
      path: runDir
    });
  }

  // Pin inspected directory identities for the rest of apply. When CLI preflight
  // already captured them, require the same real entities (closes lock→apply TOCTOU).
  let pinnedDirs: FinalizePinnedDirs;
  try {
    pinnedDirs = await captureFinalizePinnedDirs({ projectRoot, stateDir, runDir });
  } catch (error) {
    return failure(empty, {
      code: "finalize.state_dir_unsafe",
      message: errorMessageOr(error, "finalize stateDir identity could not be captured"),
      path: stateDir
    });
  }
  if (options.expectedStateDirIdentity) {
    const expected = options.expectedStateDirIdentity;
    if (
      pinnedDirs.stateDirIdentity.device !== expected.device
      || pinnedDirs.stateDirIdentity.inode !== expected.inode
      || pinnedDirs.stateDirIdentity.realPath !== expected.realPath
      || resolve(pinnedDirs.stateDirIdentity.path) !== resolve(expected.path)
    ) {
      return failure(empty, {
        code: "finalize.state_dir_changed",
        message: "finalize stateDir identity changed after preflight",
        path: stateDir
      });
    }
    pinnedDirs.stateDirIdentity = expected;
  }
  if (options.expectedRunDirIdentity) {
    if (!pinnedDirs.runDirIdentity) {
      return failure(empty, {
        code: "finalize.run_dir_changed",
        message: "finalize runDir is missing after preflight captured its identity",
        path: runDir
      });
    }
    const expected = options.expectedRunDirIdentity;
    if (
      pinnedDirs.runDirIdentity.device !== expected.device
      || pinnedDirs.runDirIdentity.inode !== expected.inode
      || pinnedDirs.runDirIdentity.realPath !== expected.realPath
      || resolve(pinnedDirs.runDirIdentity.path) !== resolve(expected.path)
    ) {
      return failure(empty, {
        code: "finalize.run_dir_changed",
        message: "finalize runDir identity changed after preflight",
        path: runDir
      });
    }
    pinnedDirs.runDirIdentity = expected;
  }

  const revalidatePinnedDirs = async (): Promise<Issue | undefined> => {
    if (options._testHooks?.beforeBoundaryRevalidate) {
      await options._testHooks.beforeBoundaryRevalidate();
    }
    return inspectPinnedFinalizeDirs(pinnedDirs);
  };

  let priorCleanup: PriorCleanupProgress = {
    deletedFiles: 0,
    deletedBytes: 0,
    deletedPaths: []
  };

  // Apply path recovers incomplete journals / orphan quarantine before planning.
  // Re-verify pinned dirs immediately before recovery mutates under stateDir/runDir.
  if (options.apply) {
    const preRecoveryIssue = await revalidatePinnedDirs();
    if (preRecoveryIssue) return failure(empty, preRecoveryIssue);
    const recovered = await recoverIncompleteFinalizeTransaction({
      stateDir,
      runId,
      projectRoot
    });
    if (!recovered.ok) {
      return {
        ...empty,
        ok: false,
        issues: recovered.issues,
        unrestoredPaths: recovered.unrestoredPaths,
        deletedFiles: recovered.prior.deletedFiles,
        deletedBytes: recovered.prior.deletedBytes
      };
    }
    priorCleanup = recovered.prior;
  } else {
    const incomplete = await inspectIncompleteFinalizeTransaction(stateDir, runId);
    if (incomplete) return failure(empty, incomplete);
  }

  let state;
  try {
    state = await readState(join(runDir, "state.json"));
  } catch (error) {
    return failure(empty, {
      code: "finalize.state_invalid",
      message: errorMessage(error),
      path: join(runDir, "state.json")
    });
  }
  if (state.run_id !== runId || state.status !== "completed" || state.gates.gate_3.status !== "approved") {
    return failure(empty, {
      code: "finalize.run_not_completed",
      message: "finalize requires the selected run to be completed with Gate 3 approved",
      path: join(runDir, "state.json")
    });
  }

  const requiredProof = [
    [canonicalOutputPath, "finalize.output_missing", "canonical final.mp4 is required"],
    [join(runDir, "render-report.json"), "finalize.render_report_missing", "render-report.json is required"],
    [join(runDir, "gate3-qc.json"), "finalize.gate3_qc_missing", "gate3-qc.json is required"]
  ] as const;
  const proofIssues: Issue[] = [];
  for (const [path, code, message] of requiredProof) {
    if (!(await isRegularFile(path))) proofIssues.push({ code, message, path });
  }
  if (proofIssues.length > 0) return { ...empty, issues: proofIssues };
  let finalOutputDigest: string;
  try {
    finalOutputDigest = await sha256File(canonicalOutputPath);
  } catch (error) {
    return {
      ...empty,
      issues: [{
        code: "finalize.output_hash_failed",
        message: errorMessage(error),
        path: canonicalOutputPath
      }]
    };
  }
  if (
    !state.gates.gate_3.approved_input_digest
    || state.gates.gate_3.approved_input_digest !== finalOutputDigest
  ) return failure(empty, {
    code: "finalize.gate3_output_changed",
    message: "final.mp4 no longer matches the Gate 3 approved output",
    path: canonicalOutputPath
  });

  // Person-consistency QA (optional): revalidate binding + report after final.mp4 identity check.
  // Gate 3 approved_input_digest remains final.mp4 sha256; expected person-QA digest is separate.
  const personQaFinalize = await revalidatePersonConsistencyOnFinalize({
    project: options.project,
    runDir,
    finalOutputSha256: finalOutputDigest,
    expectedPersonQaApprovalDigest: state.gates.gate_3.person_qa_approval_digest
  });
  if (!personQaFinalize.ok) {
    return {
      ...empty,
      ok: false,
      deletedFiles: 0,
      deletedBytes: 0,
      issues: personQaFinalize.issues
    };
  }

  const cleanupRoots = [
    stateDir,
    ...CLEANUP_ROOT_NAMES.map((name) => join(projectRoot, name))
  ];
  const allMedia = await findMediaFiles(cleanupRoots, projectRoot);
  const manifestDir = dirname(resolve(projectRoot, options.project.manifest));
  const referencedSourceMedia: string[] = [];
  for (const path of collectReferencedMedia(options.manifest, manifestDir)) {
    const refIssue = await inspectManifestMediaReference(path, projectRoot);
    if (refIssue) return failure(empty, refIssue);
    if (await isRegularFile(path)) referencedSourceMedia.push(path);
  }

  const partitioned = await partitionMediaByRetention(
    allMedia,
    runDir,
    referencedSourceMedia,
    projectRoot
  );
  // Safety net only: control-plane paths are not media and are not under cleanup
  // roots, but never allow them into deletion candidates if they appear.
  const relativePartitionedCandidates = partitioned.candidates.map((path) =>
    toProjectRelative(projectRoot, path)
  );
  const controlPlaneFilter = excludeControlPlaneFromDeletionCandidates(relativePartitionedCandidates);
  const candidates = partitioned.candidates.filter((path) => {
    const relative = toProjectRelative(projectRoot, path);
    return !controlPlaneFilter.retained_extra.includes(relative);
  });
  const mediaFiles = candidates.map((path) => toProjectRelative(projectRoot, path));
  // plan_digest retained set stays the legacy media-retention partition only.
  const retainedMedia = partitioned.retained
    .map((path) => toProjectRelative(projectRoot, path))
    .sort(comparePath);
  const candidateIdentities = await Promise.all(
    candidates.map((path) => captureRegularFileIdentity(path, projectRoot))
  );
  if (candidateIdentities.some((identity) => identity === undefined)) {
    return failure(empty, {
      code: "finalize.candidate_identity_failed",
      message: "unable to capture a regular-file identity for every deletion candidate"
    });
  }
  const identities = candidateIdentities as FinalizeFileIdentity[];
  const plannedBytes = identities.reduce((total, identity) => total + identity.size, 0);
  const launcherPlan = await planLauncherHome(options.configPath, options.project.slug);
  const canonicalConfigPath = resolve(options.configPath);
  const canonicalManifestPath = resolve(projectRoot, options.project.manifest);
  // Legacy plan_digest algorithm and payload are intentionally unchanged.
  const planDigest = buildPlanDigest({
    projectRoot,
    configPath: canonicalConfigPath,
    manifestPath: canonicalManifestPath,
    stateDir,
    projectsHome: launcherPlan.projectsHome,
    destinationRoot: launcherPlan.destinationRoot,
    alreadyHome: launcherPlan.alreadyHome,
    runId,
    finalOutputDigest,
    gate3ApprovedInputDigest: state.gates.gate_3.approved_input_digest,
    retainedMedia,
    candidates: identities
  });

  // Additive control-plane evidence + production_completion_digest (independent of plan_digest).
  // Trigger is coordination/* only: feedback.jsonl / LESSONS.md alone must not require
  // expected production_completion_digest (legacy apply remains unchanged).
  const controlPlaneRelative = await listRetainedControlPlanePaths(projectRoot);
  const controlPlaneEvidence: ControlPlaneEvidenceRefV1[] = controlPlaneRelative.map((relative_path) => ({
    kind: relative_path.startsWith("coordination/") && relative_path.includes("learning/")
      ? "learning"
      : relative_path.startsWith("coordination/") && relative_path.includes("metrics")
        ? "metrics"
        : relative_path.startsWith("coordination/") && relative_path.includes("events")
          ? "events"
          : relative_path === "feedback.jsonl"
            ? "feedback"
            : relative_path.startsWith("coordination/")
              ? "production-contract"
              : "state",
    relative_path,
    retained: true as const
  }));
  const coordinationEvidence = coordinationEvidenceOnly(controlPlaneEvidence);
  const hasControlPlane = hasCoordinationControlPlane(coordinationEvidence);
  // Prefer coordination snapshot production_id; legacy slug only when coordination is absent.
  // Preview and apply share this resolver so completion digests bind to the same identity.
  const productionId = await resolveAuthoritativeProductionId(projectRoot, options.project);
  const productionCompletionDigest = hasControlPlane
    ? buildProductionCompletionDigest({
      production_id: productionId,
      plan_digest: planDigest,
      evidence_refs: coordinationEvidence
    })
    : undefined;

  // Path is always reported; existence is checked separately so callers do not
  // treat a planned record path as proof that finalize already completed.
  const completionRecordExists = await isRegularFile(recordPath);
  const alreadyFinalized = completionRecordExists
    && candidates.length === 0
    && launcherPlan.alreadyHome;

  const base = {
    ok: true,
    issues: [],
    applied: options.apply,
    canonicalOutput: toProjectRelative(projectRoot, canonicalOutputPath),
    recordPath: toProjectRelative(projectRoot, recordPath),
    alreadyFinalized,
    mediaFiles,
    retainedMedia,
    plannedBytes,
    deletedFiles: 0,
    deletedBytes: 0,
    planDigest,
    ...(productionCompletionDigest
      ? {
        productionCompletionDigest,
        // Public evidence for the additive digest is coordination-only.
        controlPlaneEvidence: coordinationEvidence
      }
      : {}),
    candidateIdentities: identities,
    launcherProjectsHome: launcherPlan.projectsHome,
    launcherProjectRoot: launcherPlan.destinationRoot,
    launcherAlreadyHome: launcherPlan.alreadyHome,
    promotedToLauncherHome: false,
    launcherConfigPath: launcherPlan.alreadyHome
      ? canonicalConfigPath
      : join(launcherPlan.destinationRoot, "project.yaml")
  } satisfies FinalizeCompletedProjectResult;

  if (options.apply) {
    if (!options.expectedPlanDigest) {
      return failure(base, {
        code: "finalize.expected_plan_digest_required",
        message: "finalize apply requires expectedPlanDigest from a matching preview"
      });
    }
    if (options.expectedPlanDigest !== planDigest) {
      return failure(base, {
        code: "finalize.plan_stale",
        message: "finalize plan changed after preview; re-run preview before applying cleanup"
      });
    }
    try {
      assertProductionCompletionDigestMatch({
        has_control_plane: hasControlPlane,
        actual: productionCompletionDigest,
        expected: options.expectedProductionCompletionDigest
      });
    } catch (error) {
      return failure(base, {
        code: "finalize.production_completion_digest_mismatch",
        message: error instanceof Error
          ? error.message
          : "production_completion_digest mismatch"
      });
    }
  }

  if (!options.apply) return base;
  const appliedResult = await executeFinalizeApply({
    options,
    projectRoot,
    stateDir,
    runId,
    runDir,
    recordPath,
    canonicalOutputPath,
    canonicalConfigPath,
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
    pinnedDirs,
    revalidatePinnedDirs,
    base
  });
  if (appliedResult.ok && appliedResult.applied) {
    // Align with preview: record exists + durable home ready + no remaining candidates.
    // After a successful mutating apply, candidates were deleted so length>0 pre-list is OK
    // only when deletedFiles covers them; never mark true while unrestored paths remain.
    const recordExistsAfter = await isRegularFile(recordPath);
    const homeReady = appliedResult.launcherAlreadyHome === true
      || appliedResult.promotedToLauncherHome === true
      || launcherPlan.alreadyHome;
    const noRemainingCandidates = (appliedResult.unrestoredPaths?.length ?? 0) === 0
      && (
        candidates.length === 0
        || (appliedResult.deletedFiles ?? 0) >= candidates.length
      );
    return {
      ...appliedResult,
      alreadyFinalized: recordExistsAfter && homeReady && noRemainingCandidates
    };
  }
  return {
    ...appliedResult,
    alreadyFinalized: false
  };
}
