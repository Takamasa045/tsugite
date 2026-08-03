/**
 * Finalize revalidation: pre-mutation plan identity, live post-quarantine conditions,
 * and per-candidate deletion safety checks.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Manifest } from "../manifest/schema.js";
import { planLauncherHome } from "../project/projectsHome.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import { readState } from "./state.js";
import { sha256File } from "./render.js";
import type { FinalizeFileIdentity } from "./finalizeJournal.js";
import {
  hasSymlinkAlongPath,
  isRegularFile,
  isWithinPath
} from "./finalizePathSafety.js";
import {
  buildPlanDigest,
  captureRegularFileIdentity,
  collectIdentityKeys,
  collectReferencedMedia,
  findMediaFiles,
  identityKey,
  inspectManifestMediaReference,
  partitionMediaByRetention
} from "./finalizePlanHelpers.js";
import {
  comparePath,
  errorMessage,
  errorMessageOr,
  sameFinalizeIdentity,
  sameStringList,
  toProjectRelative
} from "./finalizeShared.js";

/** Local alias kept for the many call sites that still use the historical name. */
const isWithin = isWithinPath;

/**
 * Re-check a deletion candidate immediately before unlink.
 * Verifies regular-file identity and no-symlink/realpath containment from a cleanup root.
 */
export async function inspectFinalizeDeletionCandidate(
  absolutePath: string,
  expected: FinalizeFileIdentity,
  projectRoot: string,
  cleanupRoots: readonly string[]
): Promise<Issue | undefined> {
  if (!isWithin(projectRoot, absolutePath)) {
    return {
      code: "finalize.candidate_path_unsafe",
      message: "deletion candidate escaped the project root",
      path: absolutePath
    };
  }
  const cleanupRoot = cleanupRoots.find((root) => isWithin(root, absolutePath));
  if (!cleanupRoot) {
    return {
      code: "finalize.candidate_path_unsafe",
      message: "deletion candidate is outside fixed cleanup roots",
      path: absolutePath
    };
  }

  try {
    if (await hasSymlinkAlongPath(cleanupRoot, absolutePath)) {
      return {
        code: "finalize.candidate_path_unsafe",
        message: "deletion candidate path contains a symbolic link ancestor",
        path: absolutePath
      };
    }
    const [realProjectRoot, realCleanupRoot, realCandidate] = await Promise.all([
      realpath(projectRoot),
      realpath(cleanupRoot),
      realpath(absolutePath)
    ]);
    if (!isWithin(realProjectRoot, realCandidate) || !isWithin(realCleanupRoot, realCandidate)) {
      return {
        code: "finalize.candidate_path_unsafe",
        message: "deletion candidate realpath escaped cleanup containment",
        path: absolutePath
      };
    }
  } catch (error) {
    return {
      code: "finalize.candidate_changed",
      message: errorMessageOr(error, "deletion candidate could not be revalidated"),
      path: absolutePath
    };
  }

  const live = await captureRegularFileIdentity(absolutePath, projectRoot);
  if (!live || !sameFinalizeIdentity(expected, live)) {
    return {
      code: "finalize.candidate_changed",
      message: "deletion candidate identity changed after plan capture",
      path: absolutePath
    };
  }
  return undefined;
}

export async function recheckPlanIdentityBeforeMutation(input: {
  expectedPlanDigest: string;
  configPath: string;
  projectSlug: string;
  projectRoot: string;
  manifestPath: string;
  stateDir: string;
  runId: string;
  finalOutputDigest: string;
  gate3ApprovedInputDigest: string;
  retainedMedia: readonly string[];
  candidates: readonly string[];
  identities: readonly FinalizeFileIdentity[];
  cleanupRoots: readonly string[];
}): Promise<Issue | undefined> {
  const liveLauncherPlan = await planLauncherHome(input.configPath, input.projectSlug);
  const liveIdentities = await Promise.all(
    input.candidates.map((path) => captureRegularFileIdentity(path, input.projectRoot))
  );
  if (liveIdentities.some((identity) => identity === undefined)) {
    return {
      code: "finalize.candidate_identity_failed",
      message: "unable to re-capture a regular-file identity immediately before mutation"
    };
  }
  for (let index = 0; index < input.candidates.length; index += 1) {
    const expected = input.identities[index]!;
    const live = liveIdentities[index] as FinalizeFileIdentity;
    if (!sameFinalizeIdentity(expected, live)) {
      return {
        code: "finalize.candidate_changed",
        message: "deletion candidate identity changed immediately before mutation",
        path: input.candidates[index]
      };
    }
    const issue = await inspectFinalizeDeletionCandidate(
      input.candidates[index]!,
      expected,
      input.projectRoot,
      input.cleanupRoots
    );
    if (issue) return issue;
  }
  const livePlanDigest = buildPlanDigest({
    projectRoot: input.projectRoot,
    configPath: resolve(input.configPath),
    manifestPath: resolve(input.manifestPath),
    stateDir: input.stateDir,
    projectsHome: liveLauncherPlan.projectsHome,
    destinationRoot: liveLauncherPlan.destinationRoot,
    alreadyHome: liveLauncherPlan.alreadyHome,
    runId: input.runId,
    finalOutputDigest: input.finalOutputDigest,
    gate3ApprovedInputDigest: input.gate3ApprovedInputDigest,
    retainedMedia: input.retainedMedia,
    candidates: liveIdentities as FinalizeFileIdentity[]
  });
  if (livePlanDigest !== input.expectedPlanDigest) {
    return {
      code: "finalize.plan_stale",
      message: "finalize plan changed immediately before mutation; re-run preview before applying cleanup"
    };
  }
  return undefined;
}

/**
 * Re-check run completion authority, final output hash, and manifest-derived retention
 * after quarantine (before promotion and before permanent delete).
 */
export async function revalidateLiveFinalizeConditions(input: {
  runDir: string;
  runId: string;
  canonicalOutputPath: string;
  expectedFinalDigest: string;
  expectedGate3Digest: string;
  projectRoot: string;
  project: Project;
  plannedManifestReferencedRelative: readonly string[];
  plannedRetainedMedia: readonly string[];
  quarantinedOriginalPaths: readonly string[];
}): Promise<Issue | undefined> {
  let liveState;
  try {
    liveState = await readState(join(input.runDir, "state.json"));
  } catch (error) {
    return {
      code: "finalize.state_invalid",
      message: errorMessage(error),
      path: join(input.runDir, "state.json")
    };
  }
  if (
    liveState.run_id !== input.runId
    || liveState.status !== "completed"
    || liveState.gates.gate_3.status !== "approved"
  ) {
    return {
      code: "finalize.run_not_completed",
      message: "finalize run/status/Gate 3 approval changed after quarantine; cleanup blocked",
      path: join(input.runDir, "state.json")
    };
  }
  if (
    !liveState.gates.gate_3.approved_input_digest
    || liveState.gates.gate_3.approved_input_digest !== input.expectedGate3Digest
  ) {
    return {
      code: "finalize.gate3_output_changed",
      message: "Gate 3 approved digest changed after quarantine; cleanup blocked",
      path: join(input.runDir, "state.json")
    };
  }

  let liveFinalDigest: string;
  try {
    liveFinalDigest = await sha256File(input.canonicalOutputPath);
  } catch (error) {
    return {
      code: "finalize.output_hash_failed",
      message: errorMessage(error),
      path: input.canonicalOutputPath
    };
  }
  if (
    liveFinalDigest !== input.expectedFinalDigest
    || liveFinalDigest !== liveState.gates.gate_3.approved_input_digest
  ) {
    return {
      code: "finalize.gate3_output_changed",
      message: "final.mp4 no longer matches the Gate 3 approved output after quarantine",
      path: input.canonicalOutputPath
    };
  }

  // Re-load on-disk manifest so mid-apply retention drift is fail-closed.
  const manifestPath = resolve(input.projectRoot, input.project.manifest);
  let liveManifest: Manifest;
  try {
    liveManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch (error) {
    return {
      code: "finalize.plan_stale",
      message: errorMessageOr(error, "manifest could not be re-read after quarantine"),
      path: manifestPath
    };
  }
  const manifestDir = dirname(manifestPath);
  const liveManifestReferencedRelative = collectReferencedMedia(liveManifest, manifestDir)
    .map((path) => toProjectRelative(input.projectRoot, path))
    .sort(comparePath);
  if (!sameStringList(liveManifestReferencedRelative, input.plannedManifestReferencedRelative)) {
    return {
      code: "finalize.plan_stale",
      message: "manifest-derived retention conditions changed after quarantine; cleanup blocked",
      path: manifestPath
    };
  }

  // Still safety-check any on-disk referenced media that currently exists.
  for (const path of collectReferencedMedia(liveManifest, manifestDir)) {
    const refIssue = await inspectManifestMediaReference(path, input.projectRoot);
    if (refIssue) return refIssue;
  }

  for (const relativePath of input.plannedRetainedMedia) {
    const absolute = resolve(input.projectRoot, relativePath);
    if (!(await isRegularFile(absolute))) {
      return {
        code: "finalize.plan_stale",
        message: "retained media disappeared after quarantine; cleanup blocked",
        path: absolute
      };
    }
  }

  const liveReferencedExisting: string[] = [];
  for (const path of collectReferencedMedia(liveManifest, manifestDir)) {
    if (await isRegularFile(path)) liveReferencedExisting.push(path);
  }
  const livePartition = await partitionMediaByRetention(
    [
      ...(await findMediaFiles([input.runDir], input.projectRoot)),
      ...liveReferencedExisting
    ],
    input.runDir,
    liveReferencedExisting,
    input.projectRoot
  );
  const liveRetained = new Set(livePartition.retained);
  const liveRetainedRelative = new Set(
    livePartition.retained.map((path) => toProjectRelative(input.projectRoot, path))
  );
  const liveIdentityKeys = await collectIdentityKeys(livePartition.retained);

  for (const originalPath of input.quarantinedOriginalPaths) {
    const relative = toProjectRelative(input.projectRoot, originalPath);
    if (liveRetained.has(originalPath) || liveRetainedRelative.has(relative)) {
      return {
        code: "finalize.plan_stale",
        message: "a quarantined candidate became retained after quarantine; cleanup blocked",
        path: originalPath
      };
    }
    // Identity check only if the original path reappeared (should not for quarantined).
    try {
      if (await isRegularFile(originalPath)) {
        const stats = await lstat(originalPath);
        const key = identityKey(stats.dev, stats.ino);
        const real = await realpath(originalPath);
        if (liveIdentityKeys.inodeKeys.has(key) || liveIdentityKeys.realPaths.has(real)) {
          return {
            code: "finalize.plan_stale",
            message: "a quarantined candidate identity became retained after quarantine; cleanup blocked",
            path: originalPath
          };
        }
      }
    } catch {
      // missing original path is expected while quarantined
    }
  }
  return undefined;
}
