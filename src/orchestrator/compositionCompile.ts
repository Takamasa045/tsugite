import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import { digest } from "./editorialProposal.js";

const EPSILON = 1e-9;
const SHA256 = /^[a-f0-9]{64}$/;

export type CompositionProposalSegmentInput = {
  id?: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  role: string;
  reason: string;
  observation_ids: string[];
};

export type CompositionProposalInput = {
  id: string;
  title: string;
  rationale: string;
  estimated_duration_seconds: number;
  segments: CompositionProposalSegmentInput[];
  warnings?: string[];
  [key: string]: unknown;
};

export type CompositionProposalArtifactInput = {
  schema_version: 1;
  run_id: string;
  source_manifest_digest: string;
  analysis_digest: string;
  brief: Record<string, unknown>;
  brief_digest: string;
  story_guidance: Record<string, unknown>;
  proposals: CompositionProposalInput[];
  proposals_digest: string;
  [key: string]: unknown;
};

export type CompositionEdlSegment = {
  id: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  output_start: number;
  output_end: number;
  role: string;
  reason: string;
  observation_ids: string[];
  [key: string]: unknown;
};

export type CompositionDecisionList = {
  schema_version: 1;
  run_id: string;
  proposal_id: string;
  source_manifest_digest: string;
  analysis_digest: string;
  brief_digest: string;
  proposals_digest: string;
  output_manifest_digest: string;
  segments: CompositionEdlSegment[];
  duration_seconds: number;
  digest: string;
};

export type CompositionCompilation = {
  manifest: Manifest;
  edl: CompositionDecisionList;
  sourceDigests?: Record<string, string>;
};

export function compileComposition(
  manifest: Manifest,
  artifact: CompositionProposalArtifactInput,
  proposalId: string,
  expectedAnalysisDigest: string
): Result<CompositionCompilation> {
  const artifactCheck = validateArtifact(manifest, artifact);
  if (!artifactCheck.ok) return artifactCheck;
  if (
    !SHA256.test(expectedAnalysisDigest)
    || artifact.analysis_digest !== expectedAnalysisDigest
  ) {
    return failure(
      "composition.analysis_digest_mismatch",
      "composition proposals do not match the verified raw analysis"
    );
  }

  const proposalIds = new Set<string>();
  for (const [index, proposal] of artifact.proposals.entries()) {
    if (!isRecord(proposal) || !nonEmpty(proposal.id)) {
      return failure(
        "composition.proposal_invalid",
        `composition proposal ${index + 1} has no valid id`,
        `proposals[${index}].id`
      );
    }
    if (proposalIds.has(proposal.id)) {
      return failure(
        "composition.proposal_id_duplicate",
        `composition proposal id '${proposal.id}' is duplicated`,
        `proposals[${index}].id`
      );
    }
    proposalIds.add(proposal.id);
  }

  const proposal = artifact.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) {
    return failure(
      "composition.proposal_unknown",
      `composition proposal '${proposalId}' was not found`
    );
  }
  if (!Array.isArray(proposal.segments) || proposal.segments.length === 0) {
    return failure(
      "composition.proposal_invalid",
      `composition proposal '${proposalId}' has no segments`
    );
  }
  if (hasExternalAudio(manifest)) {
    return failure(
      "composition.external_audio_unsupported",
      "composition compilation cannot safely retime external audio tracks"
    );
  }

  const clipById = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  if (clipById.size !== manifest.clips.length) {
    return failure(
      "composition.source_clip_id_duplicate",
      "source clip ids must be unique"
    );
  }

  const annotations = validateAnnotationSources(manifest, clipById);
  if (!annotations.ok) return annotations;

  const parsedSegments = parseSegments(proposal, clipById);
  if (!parsedSegments.ok) return parsedSegments;

  const overlap = findOverlappingSegment(parsedSegments.segments);
  if (overlap) {
    return failure(
      "composition.segment_overlap",
      `composition segments '${overlap.left.id}' and '${overlap.right.id}' overlap in source clip '${overlap.left.source_clip_id}'`
    );
  }

  let outputCursor = 0;
  const edlSegments = parsedSegments.segments.map((segment) => {
    const duration = segment.source_end - segment.source_start;
    const outputStart = outputCursor;
    outputCursor += duration;
    return {
      ...segment,
      source_start: seconds(segment.source_start),
      source_end: seconds(segment.source_end),
      output_start: seconds(outputStart),
      output_end: seconds(outputCursor)
    };
  });
  const durationSeconds = seconds(outputCursor);

  const compiled = structuredClone(manifest);
  compiled.clips = edlSegments.map((segment) => {
    const source = clipById.get(segment.source_clip_id)!;
    return {
      ...source,
      id: segment.id,
      in: segment.source_start,
      out: segment.source_end,
      duration: seconds(segment.source_end - segment.source_start),
      source_clip_id: segment.source_clip_id,
      source_start: segment.source_start,
      source_end: segment.source_end,
      output_start: segment.output_start,
      output_end: segment.output_end
    };
  });
  compiled.meta.target_duration_seconds = durationSeconds;
  compiled.captions = retimeCaptions(manifest.captions, edlSegments);
  compiled.chapters = retimeChapters(manifest.chapters, edlSegments);

  const withoutDigest = {
    schema_version: 1 as const,
    run_id: artifact.run_id,
    proposal_id: proposal.id,
    source_manifest_digest: artifact.source_manifest_digest,
    analysis_digest: artifact.analysis_digest,
    brief_digest: artifact.brief_digest,
    proposals_digest: artifact.proposals_digest,
    output_manifest_digest: digest(compiled),
    segments: edlSegments,
    duration_seconds: durationSeconds
  };

  return {
    ok: true,
    issues: [],
    manifest: compiled,
    edl: {
      ...withoutDigest,
      digest: digest(withoutDigest)
    }
  };
}

function validateArtifact(
  manifest: Manifest,
  artifact: CompositionProposalArtifactInput
): Result<Record<never, never>> {
  if (
    !isRecord(artifact) ||
    artifact.schema_version !== 1 ||
    !nonEmpty(artifact.run_id) ||
    !artifact.brief ||
    typeof artifact.brief !== "object" ||
    Array.isArray(artifact.brief) ||
    !artifact.story_guidance ||
    typeof artifact.story_guidance !== "object" ||
    Array.isArray(artifact.story_guidance) ||
    !Array.isArray(artifact.proposals)
  ) {
    return failure(
      "composition.artifact_invalid",
      "composition proposal artifact is invalid"
    );
  }
  if (
    !SHA256.test(artifact.source_manifest_digest) ||
    artifact.source_manifest_digest !== digest(manifest)
  ) {
    return failure(
      "composition.source_manifest_changed",
      "composition proposals do not match the current source manifest"
    );
  }
  if (!SHA256.test(artifact.analysis_digest)) {
    return failure(
      "composition.analysis_digest_invalid",
      "composition analysis digest is invalid"
    );
  }
  if (
    !SHA256.test(artifact.brief_digest) ||
    artifact.brief_digest !== digest(artifact.brief)
  ) {
    return failure(
      "composition.brief_digest_invalid",
      "composition brief digest is stale or invalid"
    );
  }
  if (
    !SHA256.test(artifact.proposals_digest) ||
    artifact.proposals_digest !== digest({
      story_guidance: artifact.story_guidance,
      proposals: artifact.proposals
    })
  ) {
    return failure(
      "composition.proposals_digest_invalid",
      "composition proposals digest is stale or invalid"
    );
  }
  return { ok: true, issues: [] };
}

function parseSegments(
  proposal: CompositionProposalInput,
  clipById: Map<string, Manifest["clips"][number]>
): Result<{ segments: Array<CompositionEdlSegment> }> {
  const ids = new Set<string>();
  const segments: CompositionEdlSegment[] = [];

  for (const [index, segment] of proposal.segments.entries()) {
    if (!isRecord(segment)) {
      return failure(
        "composition.segment_invalid",
        `composition segment ${index + 1} is invalid`,
        `proposals.${proposal.id}.segments[${index}]`
      );
    }
    const id = segment.id ?? `${proposal.id}--segment-${serial(index)}`;
    if (
      !nonEmpty(id) ||
      !nonEmpty(segment.source_clip_id) ||
      !finite(segment.source_start) ||
      !finite(segment.source_end) ||
      segment.source_start < 0 ||
      segment.source_end - segment.source_start <= EPSILON ||
      !nonEmpty(segment.role) ||
      !nonEmpty(segment.reason) ||
      !Array.isArray(segment.observation_ids) ||
      segment.observation_ids.some((observationId) => !nonEmpty(observationId))
    ) {
      return failure(
        "composition.segment_invalid",
        `composition segment ${index + 1} is invalid`,
        `proposals.${proposal.id}.segments[${index}]`
      );
    }
    if (ids.has(id)) {
      return failure(
        "composition.segment_id_duplicate",
        `composition segment id '${id}' is duplicated`,
        `proposals.${proposal.id}.segments[${index}].id`
      );
    }
    ids.add(id);

    const source = clipById.get(segment.source_clip_id);
    if (!source) {
      return failure(
        "composition.source_clip_unknown",
        `composition segment '${id}' references unknown source clip '${segment.source_clip_id}'`
      );
    }
    if (
      segment.source_start < source.in - EPSILON ||
      segment.source_end > source.out + EPSILON
    ) {
      return failure(
        "composition.segment_out_of_range",
        `composition segment '${id}' falls outside source clip '${source.id}'`
      );
    }
    segments.push({
      id,
      source_clip_id: segment.source_clip_id,
      source_start: segment.source_start,
      source_end: segment.source_end,
      output_start: 0,
      output_end: 0,
      role: segment.role,
      reason: segment.reason,
      observation_ids: [...segment.observation_ids]
    });
  }

  return { ok: true, issues: [], segments };
}

function findOverlappingSegment(
  segments: CompositionEdlSegment[]
): { left: CompositionEdlSegment; right: CompositionEdlSegment } | undefined {
  const bySource = new Map<string, CompositionEdlSegment[]>();
  for (const segment of segments) {
    const sourceSegments = bySource.get(segment.source_clip_id) ?? [];
    sourceSegments.push(segment);
    bySource.set(segment.source_clip_id, sourceSegments);
  }
  for (const sourceSegments of bySource.values()) {
    const ordered = [...sourceSegments].sort((left, right) =>
      left.source_start - right.source_start || left.source_end - right.source_end
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1]!;
      const right = ordered[index]!;
      if (right.source_start < left.source_end - EPSILON) return { left, right };
    }
  }
  return undefined;
}

function validateAnnotationSources(
  manifest: Manifest,
  clipById: Map<string, Manifest["clips"][number]>
): Result<Record<never, never>> {
  const annotations = [
    ...manifest.captions.map((annotation, index) => ({
      annotation: annotation as Record<string, unknown>,
      path: `captions[${index}]`
    })),
    ...manifest.chapters.map((annotation, index) => ({
      annotation: annotation as Record<string, unknown>,
      path: `chapters[${index}]`
    }))
  ];
  for (const { annotation, path } of annotations) {
    const sourceClipId = annotation.source_clip_id;
    const sourceStart = annotation.source_start;
    const sourceEnd = annotation.source_end;
    if (
      !nonEmpty(sourceClipId) ||
      !finite(sourceStart) ||
      !finite(sourceEnd) ||
      !clipById.has(sourceClipId)
    ) {
      return failure(
        "composition.annotation_source_unknown",
        "composition cannot safely retime an annotation without source clip timestamps",
        path
      );
    }
    const source = clipById.get(sourceClipId)!;
    if (
      sourceStart < source.in - EPSILON ||
      sourceEnd - sourceStart <= EPSILON ||
      sourceEnd > source.out + EPSILON
    ) {
      return failure(
        "composition.annotation_source_invalid",
        `annotation source timestamps fall outside source clip '${sourceClipId}'`,
        path
      );
    }
  }
  return { ok: true, issues: [] };
}

function retimeCaptions(
  captions: Manifest["captions"],
  segments: CompositionEdlSegment[]
): Manifest["captions"] {
  const output = captions.flatMap((caption) => {
    const source = caption as Record<string, unknown>;
    const overlaps = annotationOverlaps(
      source.source_clip_id as string,
      source.source_start as number,
      source.source_end as number,
      segments
    );
    return overlaps.map((overlap, index) => ({
      ...caption,
      ...(caption.id && overlaps.length > 1
        ? { id: `${caption.id}--part-${serial(index)}` }
        : {}),
      source_start: overlap.source_start,
      source_end: overlap.source_end,
      start: overlap.output_start,
      end: overlap.output_end
    }));
  });
  output.sort((left, right) => left.start - right.start || left.end - right.end);
  uniquifyCaptionIds(output);
  return output;
}

function retimeChapters(
  chapters: Manifest["chapters"],
  segments: CompositionEdlSegment[]
): Manifest["chapters"] {
  const output = chapters.flatMap((chapter) => {
    const source = chapter as Record<string, unknown>;
    return annotationOverlaps(
      source.source_clip_id as string,
      source.source_start as number,
      source.source_end as number,
      segments
    ).map((overlap) => ({
      ...chapter,
      source_start: overlap.source_start,
      source_end: overlap.source_end,
      start: overlap.output_start,
      end: overlap.output_end
    }));
  });
  output.sort((left, right) => left.start - right.start || left.end - right.end);
  return output;
}

function annotationOverlaps(
  sourceClipId: string,
  sourceStart: number,
  sourceEnd: number,
  segments: CompositionEdlSegment[]
): Array<{
  source_start: number;
  source_end: number;
  output_start: number;
  output_end: number;
}> {
  return segments.flatMap((segment) => {
    if (segment.source_clip_id !== sourceClipId) return [];
    const start = Math.max(sourceStart, segment.source_start);
    const end = Math.min(sourceEnd, segment.source_end);
    if (end - start <= EPSILON) return [];
    return [{
      source_start: seconds(start),
      source_end: seconds(end),
      output_start: seconds(segment.output_start + start - segment.source_start),
      output_end: seconds(segment.output_start + end - segment.source_start)
    }];
  });
}

function uniquifyCaptionIds(captions: Manifest["captions"]): void {
  const used = new Set<string>();
  for (const caption of captions) {
    if (!caption.id) continue;
    const preferred = caption.id;
    let candidate = preferred;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${preferred}-${suffix}`;
      suffix += 1;
    }
    caption.id = candidate;
    used.add(candidate);
  }
}

function hasExternalAudio(manifest: Manifest): boolean {
  return (
    manifest.audio.bgm.length > 0 ||
    manifest.audio.narration.length > 0 ||
    manifest.audio.sfx.length > 0
  );
}

function serial(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function seconds(value: number): number {
  return Number(value.toFixed(9));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure<T>(code: string, message: string, path?: string): Result<T> {
  const issue: Issue = { code, message, ...(path ? { path } : {}) };
  return { ok: false, issues: [issue] };
}
