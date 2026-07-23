import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import { digest } from "./editorialProposal.js";

const EPSILON = 1e-9;

export type CompositionBrief = {
  goal: string;
  audience: string;
  target_duration_seconds: number;
  priority: "chronological" | "highlight" | "explanatory" | "atmosphere";
  required_clip_ids: string[];
  excluded_clip_ids: string[];
};

export type CompositionStoryGuidance = {
  primary: string;
  supporting: string[];
  rejected: Array<{ id: string; reason: string }>;
  duration_preset: {
    id: string;
    max_seconds: number;
    recommended_cuts: { min: number; max: number };
    phases: Array<{ range: string; role: string }>;
  };
  film_grammar: Array<{ id: string; category: string; instruction: string }>;
};

export type CompositionSegment = {
  id: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  role: string;
  reason: string;
  observation_ids: string[];
};

export type CompositionProposal = {
  id: string;
  title: string;
  strategy: CompositionBrief["priority"];
  rationale: string;
  estimated_duration_seconds: number;
  segments: CompositionSegment[];
  warnings: string[];
};

export type CompositionProposalsArtifact = {
  schema_version: 1;
  run_id: string;
  source_manifest_digest: string;
  analysis_digest: string;
  brief: CompositionBrief;
  brief_digest: string;
  story_guidance: CompositionStoryGuidance;
  proposals: CompositionProposal[];
  proposals_digest: string;
};

export type RawAnalysisForComposition = {
  schema_version: 1;
  run_id: string;
  slug?: string;
  input_digest?: string;
  results: Array<{
    request_id: string;
    adapter?: string;
    output: string;
    source: {
      clip_id: string;
      analysis_start_seconds?: number;
      analysis_end_seconds?: number;
      duration_seconds?: number;
      sha256?: string;
    };
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
};

type Strategy = CompositionBrief["priority"];
type CandidateKind = "scene" | "transcript" | "fallback";

type Candidate = {
  key: string;
  sourceClipId: string;
  sourceStart: number;
  sourceEnd: number;
  sourceOrder: number;
  kind: CandidateKind;
  reason: string;
  observationIds: string[];
  confidence: number;
  descriptiveWeight: number;
  atmosphereWeight: number;
  similarityGroupIds: string[];
};

export function createCompositionProposals(
  raw: RawAnalysisForComposition,
  manifest: Manifest,
  brief: CompositionBrief,
  storyGuidance: CompositionStoryGuidance,
  maxCount = 3
): Result<{ artifact: CompositionProposalsArtifact }> {
  const inputs = validateInputs(raw, manifest, brief, maxCount);
  if (inputs.length > 0) return { ok: false, issues: inputs };

  const candidates = collectCandidates(raw, manifest, brief);
  if (candidates.length === 0) {
    return failure("composition.candidates_empty", "composition has no eligible source segments");
  }

  const strategies = uniqueStrategies(brief.priority);
  const proposals: CompositionProposal[] = [];
  const priorOrders = new Set<string>();
  for (const strategy of strategies) {
    if (proposals.length >= maxCount) break;
    const built = buildProposal(strategy, candidates, manifest, brief, storyGuidance, priorOrders);
    if (!built) continue;
    proposals.push(built);
    priorOrders.add(proposalOrderKey(built.segments));
  }

  if (proposals.length === 0) {
    return failure("composition.proposals_empty", "composition could not produce a valid proposal");
  }

  const proposalIssues = validateProposalSet(proposals, manifest, brief, maxCount, raw);
  if (proposalIssues.length > 0) return { ok: false, issues: proposalIssues };

  const artifactWithoutProposalDigest = {
    schema_version: 1 as const,
    run_id: raw.run_id,
    source_manifest_digest: digest(manifest),
    analysis_digest: digest(raw),
    brief,
    brief_digest: digest(brief),
    story_guidance: storyGuidance,
    proposals
  };
  return {
    ok: true,
    issues: [],
    artifact: {
      ...artifactWithoutProposalDigest,
      proposals_digest: digest({ story_guidance: storyGuidance, proposals })
    }
  };
}

export function validateRawAnalysisForComposition(
  value: unknown
): Result<{ raw: RawAnalysisForComposition }> {
  return isRawAnalysis(value)
    ? { ok: true, issues: [], raw: value }
    : failure(
        "composition.analysis_invalid",
        "raw analysis is not a supported analysis artifact"
      );
}

export function verifyCompositionProposals(
  raw: RawAnalysisForComposition,
  manifest: Manifest,
  brief: CompositionBrief,
  artifact: unknown,
  maxCount = 3
): Result<Record<never, never>> {
  if (!isCompositionArtifact(artifact)) {
    return failure("composition.artifact_invalid", "composition proposal artifact is malformed");
  }
  if (artifact.schema_version !== 1) {
    return failure("composition.schema_version", "composition proposal schema version is unsupported");
  }
  if (artifact.run_id !== raw.run_id) {
    return failure("composition.run_id_mismatch", "composition proposal run id does not match raw analysis");
  }
  if (artifact.source_manifest_digest !== digest(manifest)) {
    return failure("composition.source_manifest_changed", "composition source manifest digest is stale");
  }
  if (artifact.analysis_digest !== digest(raw)) {
    return failure("composition.analysis_changed", "composition analysis digest is stale");
  }
  if (artifact.brief_digest !== digest(brief) || digest(artifact.brief) !== artifact.brief_digest) {
    return failure("composition.brief_changed", "composition brief digest is stale");
  }
  if (
    artifact.proposals_digest !== digest({
      story_guidance: artifact.story_guidance,
      proposals: artifact.proposals
    })
  ) {
    return failure("composition.proposals_changed", "composition proposal content digest is stale");
  }

  const inputIssues = validateInputs(raw, manifest, brief, maxCount);
  if (inputIssues.length > 0) return { ok: false, issues: inputIssues };
  const proposalIssues = validateProposalSet(artifact.proposals, manifest, brief, maxCount, raw);
  return proposalIssues.length > 0
    ? { ok: false, issues: proposalIssues }
    : { ok: true, issues: [] };
}

function validateInputs(
  raw: RawAnalysisForComposition,
  manifest: Manifest,
  brief: CompositionBrief,
  maxCount: number
): Issue[] {
  const issues: Issue[] = [];
  if (!isRawAnalysis(raw)) {
    issues.push({ code: "composition.analysis_invalid", message: "raw analysis is not a supported analysis artifact" });
    return issues;
  }
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 3) {
    issues.push({
      code: "composition.max_count_invalid",
      message: "composition proposal max_count must be between 1 and 3",
      path: "composition.proposals.max_count"
    });
  }
  if (
    !nonEmpty(brief.goal) ||
    !nonEmpty(brief.audience) ||
    !Number.isFinite(brief.target_duration_seconds) ||
    brief.target_duration_seconds <= 0
  ) {
    issues.push({
      code: "composition.brief_invalid",
      message: "composition brief requires a goal, audience, and positive target duration",
      path: "composition.brief"
    });
  }

  const clips = new Set(manifest.clips.map((clip) => clip.id));
  const unknownAnalysisSource = raw.results.find((result) => !clips.has(result.source.clip_id));
  if (unknownAnalysisSource) {
    issues.push({
      code: "composition.analysis_source_unknown",
      message: `raw analysis references unknown clip '${unknownAnalysisSource.source?.clip_id ?? ""}'`,
      path: `analysis.results.${unknownAnalysisSource.request_id}.source.clip_id`
    });
  }
  const required = new Set(brief.required_clip_ids);
  const excluded = new Set(brief.excluded_clip_ids);
  const duplicateRequired = firstDuplicate(brief.required_clip_ids);
  const duplicateExcluded = firstDuplicate(brief.excluded_clip_ids);
  if (duplicateRequired || duplicateExcluded) {
    issues.push({
      code: "composition.brief_clip_duplicate",
      message: `composition brief repeats clip '${duplicateRequired ?? duplicateExcluded}'`,
      path: duplicateRequired
        ? "composition.brief.required_clip_ids"
        : "composition.brief.excluded_clip_ids"
    });
  }
  const unknown = [...required, ...excluded].find((id) => !clips.has(id));
  if (unknown) {
    issues.push({
      code: "composition.brief_clip_unknown",
      message: `composition brief references unknown clip '${unknown}'`,
      path: "composition.brief"
    });
  }
  const conflict = [...required].find((id) => excluded.has(id));
  if (conflict) {
    issues.push({
      code: "composition.brief_clip_conflict",
      message: `composition clip '${conflict}' cannot be both required and excluded`,
      path: "composition.brief"
    });
  }
  return issues;
}

function collectCandidates(
  raw: RawAnalysisForComposition,
  manifest: Manifest,
  brief: CompositionBrief
): Candidate[] {
  const excluded = new Set(brief.excluded_clip_ids);
  const similarityMemberships = collectSimilarityMemberships(raw);
  return manifest.clips.flatMap((clip, sourceOrder) => {
    if (excluded.has(clip.id)) return [];
    const sceneCandidates = resultCandidates(raw, clip.id, sourceOrder, "scene_observations", "scene");
    const transcriptCandidates = resultCandidates(raw, clip.id, sourceOrder, "transcript", "transcript");
    if (sceneCandidates.length > 0) {
      return nonOverlappingCandidates(sceneCandidates).map((scene) => {
        const transcripts = transcriptCandidates.filter((transcript) => rangesOverlap(scene, transcript));
        const transcriptSummary = transcripts.map((transcript) => transcript.reason).join(" ");
        const observationIds = unique([
          ...scene.observationIds,
          ...transcripts.flatMap((transcript) => transcript.observationIds)
        ]);
        return {
          ...scene,
          reason: transcriptSummary ? `${scene.reason} ${transcriptSummary}` : scene.reason,
          observationIds,
          descriptiveWeight: scene.descriptiveWeight +
            transcripts.reduce((sum, transcript) => sum + transcript.descriptiveWeight, 0),
          similarityGroupIds: groupsForObservations(observationIds, similarityMemberships)
        };
      });
    }
    if (transcriptCandidates.length > 0) {
      return nonOverlappingCandidates(transcriptCandidates).map((candidate) => ({
        ...candidate,
        similarityGroupIds: groupsForObservations(candidate.observationIds, similarityMemberships)
      }));
    }
    const fallbackId = `fallback-${serial(sourceOrder)}`;
    return [{
      key: fallbackId,
      sourceClipId: clip.id,
      sourceStart: clip.in,
      sourceEnd: clip.out,
      sourceOrder,
      kind: "fallback" as const,
      reason: "解析区間がないため、素材全体を確認候補として使用",
      observationIds: [fallbackId],
      confidence: 0,
      descriptiveWeight: 0,
      atmosphereWeight: 0,
      similarityGroupIds: []
    }];
  });
}

function resultCandidates(
  raw: RawAnalysisForComposition,
  clipId: string,
  sourceOrder: number,
  output: "scene_observations" | "transcript",
  kind: Exclude<CandidateKind, "fallback">
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const result of raw.results) {
    if (result.output !== output || result.source?.clip_id !== clipId) continue;
    const values = output === "scene_observations"
      ? result.data.scene_observations
      : result.data.segments;
    if (!Array.isArray(values)) continue;
    for (const [index, unknownValue] of values.entries()) {
      const value = record(unknownValue);
      if (
        !value ||
        !nonEmpty(value.id) ||
        !finite(value.source_start) ||
        !finite(value.source_end) ||
        value.source_end <= value.source_start
      ) {
        continue;
      }
      const description = nonEmpty(value.description)
        ? value.description
        : nonEmpty(value.text) ? value.text : `${clipId} の解析区間`;
      const selectionReasons = Array.isArray(value.selection_reasons)
        ? value.selection_reasons.filter(nonEmpty)
        : [];
      const technicalNotes = Array.isArray(value.technical_notes)
        ? value.technical_notes.filter(nonEmpty)
        : [];
      const confidence = finite(value.confidence) ? clamp(value.confidence, 0, 1) : 0.5;
      candidates.push({
        key: `${result.request_id}-${value.id}-${serial(index)}`,
        sourceClipId: clipId,
        sourceStart: value.source_start,
        sourceEnd: value.source_end,
        sourceOrder,
        kind,
        reason: selectionReasons[0] ?? (
          kind === "transcript"
            ? `文字起こしに内容がある: ${truncate(description, 80)}`
            : truncate(description, 120)
        ),
        observationIds: [value.id],
        confidence,
        descriptiveWeight: description.length + (kind === "transcript" ? 100 : 0),
        atmosphereWeight: technicalNotes.length === 0 ? confidence : confidence / (technicalNotes.length + 1),
        similarityGroupIds: []
      });
    }
  }
  return candidates;
}

function nonOverlappingCandidates(candidates: Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd || left.key.localeCompare(right.key)
  );
  const accepted: Candidate[] = [];
  for (const candidate of ordered) {
    if (accepted.every((existing) => !rangesOverlap(existing, candidate))) accepted.push(candidate);
  }
  return accepted;
}

function buildProposal(
  strategy: Strategy,
  candidates: Candidate[],
  manifest: Manifest,
  brief: CompositionBrief,
  storyGuidance: CompositionStoryGuidance,
  priorOrders: Set<string>
): CompositionProposal | undefined {
  const ordered = orderCandidates(strategy, candidates);
  const varied = selectUniqueOrder(ordered, brief, priorOrders);
  if (!varied) return undefined;
  const proposalId = `${strategy}-v1`;
  const segments = varied.map((candidate, index) => ({
    id: `${proposalId}-segment-${serial(index)}`,
    source_clip_id: candidate.sourceClipId,
    source_start: seconds(candidate.sourceStart),
    source_end: seconds(candidate.sourceEnd),
    role: roleFor(strategy, index, varied.length, storyGuidance),
    reason: candidate.reason,
    observation_ids: [...candidate.observationIds]
  }));
  const duration = seconds(segments.reduce((sum, segment) => sum + segment.source_end - segment.source_start, 0));
  const warnings: string[] = [];
  if (duration + EPSILON < brief.target_duration_seconds) {
    warnings.push(
      `希望尺${seconds(brief.target_duration_seconds)}秒に対して素材が${duration}秒しかありません。`
    );
  } else if (duration - EPSILON > brief.target_duration_seconds) {
    warnings.push(
      `必須素材を優先したため希望尺を${seconds(duration - brief.target_duration_seconds)}秒超過します。`
    );
  }
  for (const candidate of varied) {
    if (candidate.kind === "scene" && candidate.confidence < 0.5) {
      warnings.push(`観察 '${candidate.observationIds[0]}' は低信頼のため要確認です。`);
    }
  }
  const clipCount = new Set(segments.map((segment) => segment.source_clip_id)).size;
  return {
    id: proposalId,
    title: strategyTitle(strategy),
    strategy,
    rationale: `${strategyRationale(strategy)} ${clipCount}素材・${segments.length}区間を使用。`,
    estimated_duration_seconds: duration,
    segments,
    warnings
  };
}

function selectForDuration(ordered: Candidate[], brief: CompositionBrief): Candidate[] {
  const required = new Set(brief.required_clip_ids);
  const requiredCandidates = brief.required_clip_ids.flatMap((clipId) => {
    const candidate = ordered.find((item) => item.sourceClipId === clipId);
    return candidate ? [candidate] : [];
  });
  const selected = new Map(requiredCandidates.map((candidate) => [candidate.key, { ...candidate }]));
  const selectedSimilarityGroups = new Set(
    requiredCandidates.flatMap((candidate) => candidate.similarityGroupIds)
  );
  let duration = [...selected.values()].reduce((sum, candidate) => sum + candidateDuration(candidate), 0);

  for (const candidate of ordered) {
    if (selected.has(candidate.key) || required.has(candidate.sourceClipId) && selected.size >= required.size) continue;
    if (candidate.similarityGroupIds.some((groupId) => selectedSimilarityGroups.has(groupId))) continue;
    if (duration >= brief.target_duration_seconds - EPSILON) break;
    const remaining = brief.target_duration_seconds - duration;
    const candidateLength = candidateDuration(candidate);
    if (candidateLength <= remaining + EPSILON) {
      selected.set(candidate.key, { ...candidate });
      candidate.similarityGroupIds.forEach((groupId) => selectedSimilarityGroups.add(groupId));
      duration += candidateLength;
    } else if (remaining > EPSILON) {
      selected.set(candidate.key, {
        ...candidate,
        sourceEnd: seconds(candidate.sourceStart + remaining)
      });
      candidate.similarityGroupIds.forEach((groupId) => selectedSimilarityGroups.add(groupId));
      duration += remaining;
    }
  }

  const order = new Map(ordered.map((candidate, index) => [candidate.key, index]));
  return [...selected.values()].sort(
    (left, right) => (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  );
}

function orderCandidates(strategy: Strategy, candidates: Candidate[]): Candidate[] {
  const ordered = [...candidates];
  switch (strategy) {
    case "chronological":
      return ordered.sort(bySourceTime);
    case "highlight":
      return ordered.sort((left, right) =>
        right.confidence - left.confidence ||
        kindWeight(right.kind) - kindWeight(left.kind) ||
        candidateDuration(right) - candidateDuration(left) ||
        bySourceTime(left, right)
      );
    case "explanatory":
      return ordered.sort((left, right) =>
        right.descriptiveWeight - left.descriptiveWeight ||
        kindWeight(right.kind) - kindWeight(left.kind) ||
        bySourceTime(left, right)
      );
    case "atmosphere":
      return ordered.sort((left, right) =>
        right.atmosphereWeight - left.atmosphereWeight ||
        right.sourceOrder - left.sourceOrder ||
        right.sourceStart - left.sourceStart
      );
  }
}

function selectUniqueOrder(
  ordered: Candidate[],
  brief: CompositionBrief,
  priorOrders: Set<string>
): Candidate[] | undefined {
  const selected = selectForDuration(ordered, brief);
  const key = proposalOrderKey(selected.map(candidateToComparableSegment));
  return priorOrders.has(key) ? undefined : selected;
}

function validateProposalSet(
  proposals: CompositionProposal[],
  manifest: Manifest,
  brief: CompositionBrief,
  maxCount: number,
  raw: RawAnalysisForComposition
): Issue[] {
  const issues: Issue[] = [];
  if (proposals.length === 0 || proposals.length > maxCount || proposals.length > 3) {
    issues.push({
      code: "composition.proposal_count",
      message: "composition must contain between one and max_count proposals",
      path: "proposals"
    });
  }
  const proposalIds = new Set<string>();
  const strategies = new Set<Strategy>();
  const orders = new Set<string>();
  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const candidates = collectCandidates(raw, manifest, brief);
  const excluded = new Set(brief.excluded_clip_ids);
  const similarityMemberships = collectSimilarityMemberships(raw);
  const evidenceByClip = collectEvidenceIds(raw, manifest);
  for (const [proposalIndex, proposal] of proposals.entries()) {
    const proposalPath = `proposals[${proposalIndex}]`;
    if (
      !nonEmpty(proposal.title) ||
      !nonEmpty(proposal.rationale) ||
      !isStrategy(proposal.strategy) ||
      !Number.isFinite(proposal.estimated_duration_seconds) ||
      !Array.isArray(proposal.warnings) ||
      !proposal.warnings.every(nonEmpty)
    ) {
      issues.push({
        code: "composition.proposal_invalid",
        message: "composition proposal requires a title, strategy, rationale, duration, and warnings",
        path: proposalPath
      });
    }
    if (!nonEmpty(proposal.id) || proposalIds.has(proposal.id)) {
      issues.push({
        code: "composition.proposal_id",
        message: "composition proposal ids must be non-empty and unique",
        path: `${proposalPath}.id`
      });
    }
    proposalIds.add(proposal.id);
    if (strategies.has(proposal.strategy)) {
      issues.push({
        code: "composition.proposal_strategy_duplicate",
        message: "composition proposals must use different ordering strategies",
        path: `${proposalPath}.strategy`
      });
    }
    strategies.add(proposal.strategy);
    if (!Array.isArray(proposal.segments) || proposal.segments.length === 0) {
      issues.push({
        code: "composition.segments_empty",
        message: "composition proposal must contain at least one segment",
        path: `${proposalPath}.segments`
      });
      continue;
    }

    const segmentIds = new Set<string>();
    const bySource = new Map<string, CompositionSegment[]>();
    const usedSimilarityGroups = new Set<string>();
    for (const [segmentIndex, segment] of proposal.segments.entries()) {
      const segmentPath = `${proposalPath}.segments[${segmentIndex}]`;
      const clip = clips.get(segment.source_clip_id);
      if (!nonEmpty(segment.id) || segmentIds.has(segment.id)) {
        issues.push({
          code: "composition.segment_id",
          message: "composition segment ids must be non-empty and unique",
          path: `${segmentPath}.id`
        });
      }
      segmentIds.add(segment.id);
      if (!clip) {
        issues.push({
          code: "composition.segment_source_unknown",
          message: `composition segment references unknown clip '${segment.source_clip_id}'`,
          path: `${segmentPath}.source_clip_id`
        });
        continue;
      }
      if (
        !Number.isFinite(segment.source_start) ||
        !Number.isFinite(segment.source_end) ||
        segment.source_end <= segment.source_start ||
        segment.source_start < clip.in - EPSILON ||
        segment.source_end > clip.out + EPSILON
      ) {
        issues.push({
          code: "composition.segment_range",
          message: "composition segment range must stay within its source clip",
          path: segmentPath
        });
      }
      if (Array.isArray(segment.observation_ids)) {
        const allowedEvidence = evidenceByClip.get(segment.source_clip_id) ?? new Set<string>();
        const unknownEvidence = segment.observation_ids.find((id) => !allowedEvidence.has(id));
        if (unknownEvidence) {
          issues.push({
            code: "composition.segment_evidence_unknown",
            message: `composition segment references unknown evidence '${unknownEvidence}'`,
            path: `${segmentPath}.observation_ids`
          });
        }
      }
      for (const groupId of groupsForObservations(segment.observation_ids, similarityMemberships)) {
        if (usedSimilarityGroups.has(groupId)) {
          issues.push({
            code: "composition.similarity_duplicate",
            message: `composition proposal repeats similarity group '${groupId}'`,
            path: `${proposalPath}.segments`
          });
        }
        usedSimilarityGroups.add(groupId);
      }
      if (excluded.has(segment.source_clip_id)) {
        issues.push({
          code: "composition.excluded_clip_used",
          message: `composition proposal uses excluded clip '${segment.source_clip_id}'`,
          path: `${segmentPath}.source_clip_id`
        });
      }
      if (
        !nonEmpty(segment.role) ||
        !nonEmpty(segment.reason) ||
        !Array.isArray(segment.observation_ids) ||
        segment.observation_ids.length === 0 ||
        !segment.observation_ids.every(nonEmpty)
      ) {
        issues.push({
          code: "composition.segment_evidence",
          message: "composition segment requires a role, reason, and observation ids",
          path: segmentPath
        });
      }
      const sourceSegments = bySource.get(segment.source_clip_id) ?? [];
      sourceSegments.push(segment);
      bySource.set(segment.source_clip_id, sourceSegments);
    }
    for (const [clipId, sourceSegments] of bySource) {
      const ordered = [...sourceSegments].sort((left, right) => left.source_start - right.source_start);
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index]!.source_start < ordered[index - 1]!.source_end - EPSILON) {
          issues.push({
            code: "composition.segment_overlap",
            message: `composition proposal contains overlapping ranges from clip '${clipId}'`,
            path: `${proposalPath}.segments`
          });
          break;
        }
      }
    }
    for (const requiredClipId of brief.required_clip_ids) {
      if (!proposal.segments.some((segment) => segment.source_clip_id === requiredClipId)) {
        issues.push({
          code: "composition.required_clip_missing",
          message: `composition proposal does not include required clip '${requiredClipId}'`,
          path: `${proposalPath}.segments`
        });
      }
    }
    const expectedOrder = proposalOrderKey(
      selectForDuration(orderCandidates(proposal.strategy, candidates), brief)
        .map(candidateToComparableSegment)
    );
    if (proposalOrderKey(proposal.segments) !== expectedOrder) {
      issues.push({
        code: "composition.strategy_order",
        message: `composition proposal segments do not follow the '${proposal.strategy}' strategy order`,
        path: `${proposalPath}.segments`
      });
    }
    const duration = seconds(
      proposal.segments.reduce((sum, segment) => sum + segment.source_end - segment.source_start, 0)
    );
    if (Math.abs(duration - proposal.estimated_duration_seconds) > EPSILON) {
      issues.push({
        code: "composition.duration_mismatch",
        message: "composition estimated duration does not match its segments",
        path: `${proposalPath}.estimated_duration_seconds`
      });
    }
    const order = proposalOrderKey(proposal.segments);
    if (orders.has(order)) {
      issues.push({
        code: "composition.proposal_order_duplicate",
        message: "composition proposals must have different segment orders",
        path: `${proposalPath}.segments`
      });
    }
    orders.add(order);
  }
  return issues;
}

function roleFor(
  strategy: Strategy,
  index: number,
  count: number,
  storyGuidance: CompositionStoryGuidance
): string {
  if (index === 0) return "hook";
  if (index === count - 1) return "close";
  const guided = storyGuidance.duration_preset.phases[index]?.role;
  if (guided) return normalizeRole(guided);
  const roles: Record<Strategy, string[]> = {
    chronological: ["context", "development", "transition"],
    highlight: ["overview", "highlight", "transition"],
    explanatory: ["context", "example", "evidence"],
    atmosphere: ["mood", "texture", "transition"]
  };
  return roles[strategy][(index - 1) % roles[strategy].length]!;
}

function normalizeRole(role: string): string {
  const normalized = role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "development";
}

function uniqueStrategies(primary: Strategy): Strategy[] {
  return [
    primary,
    ...(["chronological", "highlight", "explanatory", "atmosphere"] as const).filter(
      (strategy) => strategy !== primary
    )
  ];
}

function strategyTitle(strategy: Strategy): string {
  return {
    chronological: "時系列",
    highlight: "見どころ先行",
    explanatory: "説明重視",
    atmosphere: "雰囲気重視"
  }[strategy];
}

function strategyRationale(strategy: Strategy): string {
  return {
    chronological: "素材内の時間と出来事の流れを保つ構成。",
    highlight: "信頼度と見どころ候補を優先して冒頭の訴求力を高める構成。",
    explanatory: "文字情報と説明量の多い区間を優先する構成。",
    atmosphere: "視覚観察の品質と余韻を優先する構成。"
  }[strategy];
}

function bySourceTime(left: Candidate, right: Candidate): number {
  return left.sourceOrder - right.sourceOrder ||
    left.sourceStart - right.sourceStart ||
    left.sourceEnd - right.sourceEnd ||
    left.key.localeCompare(right.key);
}

function kindWeight(kind: CandidateKind): number {
  return kind === "scene" ? 3 : kind === "transcript" ? 2 : 1;
}

function rangesOverlap(left: Candidate, right: Candidate): boolean {
  return left.sourceClipId === right.sourceClipId &&
    left.sourceStart < right.sourceEnd - EPSILON &&
    right.sourceStart < left.sourceEnd - EPSILON;
}

function candidateDuration(candidate: Candidate): number {
  return candidate.sourceEnd - candidate.sourceStart;
}

function candidateToComparableSegment(candidate: Candidate): CompositionSegment {
  return {
    id: candidate.key,
    source_clip_id: candidate.sourceClipId,
    source_start: seconds(candidate.sourceStart),
    source_end: seconds(candidate.sourceEnd),
    role: "",
    reason: "",
    observation_ids: candidate.observationIds
  };
}

function collectSimilarityMemberships(
  raw: RawAnalysisForComposition
): Map<string, string[]> {
  const memberships = new Map<string, string[]>();
  for (const result of raw.results) {
    if (result.output !== "similarity_groups") continue;
    const groups = result.data.similarity_groups;
    if (!Array.isArray(groups)) continue;
    for (const unknownGroup of groups) {
      const group = record(unknownGroup);
      if (!group || !nonEmpty(group.id) || !Array.isArray(group.member_observation_ids)) continue;
      for (const observationId of group.member_observation_ids.filter(nonEmpty)) {
        memberships.set(observationId, unique([...(memberships.get(observationId) ?? []), group.id]));
      }
    }
  }
  return memberships;
}

function collectEvidenceIds(
  raw: RawAnalysisForComposition,
  manifest: Manifest
): Map<string, Set<string>> {
  const byClip = new Map(manifest.clips.map((clip) => [clip.id, new Set<string>()]));
  const clipsWithEvidence = new Set<string>();
  for (const result of raw.results) {
    const key = result.output === "scene_observations"
      ? "scene_observations"
      : result.output === "transcript" ? "segments" : undefined;
    if (!key) continue;
    const values = result.data[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const item = record(value);
      if (item && nonEmpty(item.id)) {
        byClip.get(result.source.clip_id)?.add(item.id);
        clipsWithEvidence.add(result.source.clip_id);
      }
    }
  }
  for (const [index, clip] of manifest.clips.entries()) {
    if (!clipsWithEvidence.has(clip.id)) byClip.get(clip.id)?.add(`fallback-${serial(index)}`);
  }
  return byClip;
}

function groupsForObservations(
  observationIds: string[],
  memberships: Map<string, string[]>
): string[] {
  return unique(observationIds.flatMap((observationId) => memberships.get(observationId) ?? []));
}

function proposalOrderKey(segments: CompositionSegment[]): string {
  return segments
    .map((segment) => `${segment.source_clip_id}@${segment.source_start}-${segment.source_end}`)
    .join("|");
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function failure(
  code: string,
  message: string,
  path?: string
): { ok: false; issues: Issue[] } {
  return { ok: false, issues: [{ code, message, ...(path ? { path } : {}) }] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStrategy(value: unknown): value is Strategy {
  return ["chronological", "highlight", "explanatory", "atmosphere"].includes(String(value));
}

function isCompositionArtifact(value: unknown): value is CompositionProposalsArtifact {
  const artifact = record(value);
  if (
    !artifact ||
    artifact.schema_version !== 1 ||
    !nonEmpty(artifact.run_id) ||
    !nonEmpty(artifact.source_manifest_digest) ||
    !nonEmpty(artifact.analysis_digest) ||
    !record(artifact.brief) ||
    !nonEmpty(artifact.brief_digest) ||
    !record(artifact.story_guidance) ||
    !Array.isArray(artifact.proposals) ||
    !nonEmpty(artifact.proposals_digest)
  ) {
    return false;
  }
  return artifact.proposals.every((unknownProposal) => {
    const proposal = record(unknownProposal);
    if (
      !proposal ||
      !nonEmpty(proposal.id) ||
      !nonEmpty(proposal.title) ||
      !nonEmpty(proposal.rationale) ||
      !isStrategy(proposal.strategy) ||
      !finite(proposal.estimated_duration_seconds) ||
      !Array.isArray(proposal.warnings) ||
      !proposal.warnings.every(nonEmpty) ||
      !Array.isArray(proposal.segments)
    ) {
      return false;
    }
    return proposal.segments.every((unknownSegment) => {
      const segment = record(unknownSegment);
      return Boolean(segment) &&
        nonEmpty(segment!.id) &&
        nonEmpty(segment!.source_clip_id) &&
        finite(segment!.source_start) &&
        finite(segment!.source_end) &&
        nonEmpty(segment!.role) &&
        nonEmpty(segment!.reason) &&
        Array.isArray(segment!.observation_ids) &&
        segment!.observation_ids.every(nonEmpty);
    });
  });
}

function isRawAnalysis(value: unknown): value is RawAnalysisForComposition {
  const raw = record(value);
  if (
    !raw ||
    raw.schema_version !== 1 ||
    !nonEmpty(raw.run_id) ||
    !Array.isArray(raw.results)
  ) {
    return false;
  }
  return raw.results.every((unknownResult) => {
    const result = record(unknownResult);
    const source = record(result?.source);
    return Boolean(result) &&
      nonEmpty(result!.request_id) &&
      nonEmpty(result!.output) &&
      Boolean(source) &&
      nonEmpty(source!.clip_id) &&
      Boolean(record(result!.data));
  });
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function serial(index: number): string {
  return String(index + 1).padStart(4, "0");
}

function seconds(value: number): number {
  return Number(value.toFixed(9));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
