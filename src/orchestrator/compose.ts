import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadStoryGuide,
  recommendStoryFrameworks,
  type StoryRecommendation
} from "../adapters/storyKnowledge.js";
import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import {
  createCompositionProposals,
  validateRawAnalysisForComposition,
  verifyCompositionProposals,
  type CompositionBrief,
  type CompositionProposalsArtifact,
  type CompositionStoryGuidance,
  type RawAnalysisForComposition
} from "./compositionProposal.js";

export type CompositionProjectInput = {
  slug: string;
  run_id?: string;
  manifest: string;
  dist_dir: string;
  analysis?: unknown;
  composition?: {
    brief: CompositionBrief;
    proposals: {
      max_count: number;
    };
  };
};

export type ComposeProjectOptions = {
  storyGuidePath?: string;
};

export type ComposeProjectResult = {
  proposalPath: string;
  proposalCount: number;
  sourceManifestDigest: string;
  analysisDigest: string;
  artifact: CompositionProposalsArtifact;
};

export async function composeProject(
  configPath: string,
  project: CompositionProjectInput,
  manifest: Manifest,
  stateDir?: string,
  options: ComposeProjectOptions = {}
): Promise<Result<ComposeProjectResult>> {
  if (!project.composition) {
    return failure(
      "composition.not_configured",
      "project.composition is required before composition proposals can be created"
    );
  }

  const runId = project.run_id ?? project.slug;
  const distDir = stateDir
    ? resolve(stateDir)
    : resolve(dirname(resolve(configPath)), project.dist_dir);
  const analysisDir = join(distDir, runId, "analysis");
  const analysisPath = join(analysisDir, "raw-analysis.json");
  const proposalPath = join(analysisDir, "composition-proposals.json");

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(await readFile(analysisPath, "utf8"));
  } catch (error) {
    return failure(
      "composition.analysis_read_failed",
      `raw analysis could not be read: ${error instanceof Error ? error.message : String(error)}`,
      analysisPath
    );
  }
  const parsedRaw = validateRawAnalysisForComposition(rawInput);
  if (!parsedRaw.ok) {
    return {
      ok: false,
      issues: parsedRaw.issues.map((issue) => ({
        ...issue,
        path: issue.path ?? analysisPath
      }))
    };
  }
  const raw = parsedRaw.raw;
  const currentInputs = await verifyCompositionAnalysisInputs(configPath, project, manifest, raw);
  if (!currentInputs.ok) return currentInputs;

  let storyGuidance: CompositionStoryGuidance;
  try {
    const guide = options.storyGuidePath
      ? await loadStoryGuide(options.storyGuidePath)
      : await loadStoryGuide();
    const recommendation = recommendStoryFrameworks(
      [
        project.composition.brief.goal,
        project.composition.brief.audience,
        project.composition.brief.priority
      ].join(" "),
      guide,
      { durationSeconds: project.composition.brief.target_duration_seconds }
    );
    storyGuidance = toCompositionStoryGuidance(recommendation);
  } catch (error) {
    return failure(
      "composition.story_guidance_failed",
      `story guidance could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const created = createCompositionProposals(
    raw,
    manifest,
    project.composition.brief,
    storyGuidance,
    project.composition.proposals.max_count
  );
  if (!created.ok) return created;

  const verified = verifyCompositionProposals(
    raw,
    manifest,
    project.composition.brief,
    created.artifact,
    project.composition.proposals.max_count
  );
  if (!verified.ok) return verified;

  try {
    await mkdir(analysisDir, { recursive: true });
  } catch {
    return failure(
      "composition.artifact_write_failed",
      "composition proposal directory could not be created",
      analysisDir
    );
  }

  const temporaryPath = `${proposalPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(created.artifact, null, 2)}\n`);
    await rename(temporaryPath, proposalPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return failure(
      "composition.artifact_write_failed",
      "composition proposal artifact could not be written",
      proposalPath
    );
  }

  return {
    ok: true,
    issues: [],
    proposalPath,
    proposalCount: created.artifact.proposals.length,
    sourceManifestDigest: created.artifact.source_manifest_digest,
    analysisDigest: created.artifact.analysis_digest,
    artifact: created.artifact
  };
}

function toCompositionStoryGuidance(
  recommendation: StoryRecommendation
): CompositionStoryGuidance {
  return {
    primary: recommendation.primary.id,
    supporting: recommendation.secondary.map((framework) => framework.id),
    rejected: recommendation.rejected.map((framework) => ({
      id: framework.id,
      reason: framework.reason
    })),
    duration_preset: {
      id: recommendation.duration_preset.id,
      max_seconds: recommendation.duration_preset.max_seconds,
      recommended_cuts: {
        min: recommendation.duration_preset.recommended_cuts.min,
        max: recommendation.duration_preset.recommended_cuts.max
      },
      phases: recommendation.duration_preset.phases.map((phase) => ({ ...phase }))
    },
    film_grammar: recommendation.applied_principles.map((principle) => ({
      id: principle.id,
      category: principle.category,
      instruction: principle.instruction
    }))
  };
}

export async function verifyCompositionAnalysisInputs(
  configPath: string,
  project: CompositionProjectInput,
  manifest: Manifest,
  rawInput: unknown
): Promise<Result<Record<never, never>>> {
  const parsed = validateRawAnalysisForComposition(rawInput);
  if (!parsed.ok) return parsed;
  const raw = parsed.raw;
  if (raw.run_id !== (project.run_id ?? project.slug)) {
    return failure(
      "composition.analysis_run_mismatch",
      "raw analysis belongs to a different run"
    );
  }
  const analysisInput = verifyAnalysisInputDigest(project, raw);
  if (!analysisInput.ok) return analysisInput;
  return verifySourceDigests(configPath, project, manifest, raw);
}

function verifyAnalysisInputDigest(
  project: CompositionProjectInput,
  raw: RawAnalysisForComposition
): Result<Record<never, never>> {
  if (!project.analysis) return { ok: true, issues: [] };
  const expected = createHash("sha256")
    .update(JSON.stringify({
      slug: project.slug,
      run_id: project.run_id ?? project.slug,
      analysis: project.analysis,
      sources: raw.results.map((result) => ({
        adapter: result.adapter,
        source: result.source
      }))
    }))
    .digest("hex");
  if (raw.input_digest !== expected) {
    return failure(
      "composition.analysis_input_changed",
      "raw analysis does not match the current project analysis settings"
    );
  }
  return { ok: true, issues: [] };
}

async function verifySourceDigests(
  configPath: string,
  project: CompositionProjectInput,
  manifest: Manifest,
  raw: RawAnalysisForComposition
): Promise<Result<Record<never, never>>> {
  const manifestDir = dirname(resolve(dirname(resolve(configPath)), project.manifest));
  const clipById = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const expectedByClip = new Map<string, string>();
  for (const result of raw.results) {
    const expected = result.source.sha256;
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
      return failure(
        "composition.analysis_source_digest_missing",
        `raw analysis request '${result.request_id}' has no valid source digest`
      );
    }
    const previous = expectedByClip.get(result.source.clip_id);
    if (previous && previous !== expected) {
      return failure(
        "composition.analysis_source_digest_conflict",
        `raw analysis has conflicting source digests for clip '${result.source.clip_id}'`
      );
    }
    expectedByClip.set(result.source.clip_id, expected);
  }
  const excluded = new Set(project.composition?.brief.excluded_clip_ids ?? []);
  const missingFingerprint = manifest.clips.find((clip) =>
    !excluded.has(clip.id) && !expectedByClip.has(clip.id)
  );
  if (missingFingerprint) {
    return failure(
      "composition.analysis_source_missing",
      `raw analysis has no source fingerprint for eligible clip '${missingFingerprint.id}'`
    );
  }

  for (const [clipId, expected] of expectedByClip) {
    const clip = clipById.get(clipId);
    if (!clip) {
      return failure(
        "composition.analysis_source_unknown",
        `raw analysis references unknown clip '${clipId}'`
      );
    }
    try {
      const actual = await sha256File(resolve(manifestDir, clip.src));
      if (actual !== expected) {
        return failure(
          "composition.analysis_source_changed",
          `source bytes changed after analysis for clip '${clipId}'`
        );
      }
    } catch (error) {
      return failure(
        "composition.analysis_source_unavailable",
        `analysis source could not be verified: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { ok: true, issues: [] };
}

async function sha256File(path: string): Promise<string> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error("analysis source is not a regular file");
  const digest = await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("analysis source changed while its digest was verified");
  }
  return digest;
}

function failure(
  code: string,
  message: string,
  path?: string
): { ok: false; issues: Issue[] } {
  return { ok: false, issues: [{ code, message, ...(path ? { path } : {}) }] };
}
