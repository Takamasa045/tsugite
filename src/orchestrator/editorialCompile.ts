import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import { digest } from "./editorialProposal.js";

const EPSILON = 1e-9;

export type EditorialCompilePolicy = {
  remove_kinds: string[];
  remove_ids: string[];
  exclude_ids: string[];
  captions?: { request_id: string };
  chapters?: { request_id: string };
};

export type EditorialProposalInput = {
  schema_version: number;
  run_id: string;
  slug: string;
  proposal_digest: string;
  outputs: {
    transcripts?: Array<Record<string, unknown>>;
    cut_points?: Array<Record<string, unknown>>;
    chapters?: Array<Record<string, unknown>>;
    summaries?: Array<Record<string, unknown>>;
    subtitle_tracks?: Array<Record<string, unknown>>;
  };
};

export type EditorialKeepSegment = {
  id: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  original_output_start: number;
  original_output_end: number;
  output_start: number;
  output_end: number;
};

export type EditorialRemovedRange = {
  id: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  cut_ids: string[];
  kinds: string[];
};

export type EditorialDecisionList = {
  schema_version: 1;
  source_duration_seconds: number;
  duration_seconds: number;
  removed_duration_seconds: number;
  input_manifest_digest: string;
  proposal_digest: string;
  policy_digest: string;
  output_manifest_digest: string;
  segments: EditorialKeepSegment[];
  removed_ranges: EditorialRemovedRange[];
  captions_request_id?: string;
  chapters_request_id?: string;
  digest: string;
};

export function compileEditorial(
  manifest: Manifest,
  proposal: EditorialProposalInput,
  policy: EditorialCompilePolicy
): Result<{ manifest: Manifest; edl: EditorialDecisionList }> {
  if (hasExternalAudio(manifest)) {
    return failure(
      "editorial.external_audio_unsupported",
      "editorial compilation cannot safely retime external audio tracks"
    );
  }

  const clipById = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  if (clipById.size !== manifest.clips.length) {
    return failure("editorial.clip_id_duplicate", "source clip ids must be unique");
  }

  const parsedCuts = parseCuts(proposal.outputs.cut_points ?? []);
  if (!parsedCuts.ok) return parsedCuts;
  const cutById = new Map(parsedCuts.cuts.map((cut) => [cut.id, cut]));
  if (cutById.size !== parsedCuts.cuts.length) {
    return failure("editorial.cut_id_duplicate", "editorial cut ids must be unique");
  }
  const unknownCutId = [...policy.remove_ids, ...policy.exclude_ids].find((id) => !cutById.has(id));
  if (unknownCutId) {
    return failure("editorial.cut_id_unknown", `editorial policy references unknown cut '${unknownCutId}'`);
  }

  const excluded = new Set(policy.exclude_ids);
  const removeIds = new Set(policy.remove_ids);
  const removeKinds = new Set(policy.remove_kinds);
  const selectedCuts = parsedCuts.cuts.filter(
    (cut) => !excluded.has(cut.id) && (removeIds.has(cut.id) || removeKinds.has(cut.kind))
  );
  for (const cut of selectedCuts) {
    if (!clipById.has(cut.source_clip_id)) {
      return failure(
        "editorial.source_clip_unknown",
        `cut '${cut.id}' references unknown source clip '${cut.source_clip_id}'`
      );
    }
  }

  const removedByClip = new Map<string, EditorialRemovedRange[]>();
  for (const clip of manifest.clips) {
    const ranges = selectedCuts
      .filter((cut) => cut.source_clip_id === clip.id)
      .map((cut) => ({
        source_start: Math.max(clip.in, cut.source_start),
        source_end: Math.min(clip.out, cut.source_end),
        cut_ids: [cut.id],
        kinds: [cut.kind]
      }))
      .filter((range) => range.source_end - range.source_start > EPSILON);
    removedByClip.set(clip.id, mergeRanges(clip.id, ranges));
  }

  const timeline = buildTimeline(manifest, removedByClip);
  if (timeline.segments.length === 0 || timeline.duration <= EPSILON) {
    return failure("editorial.program_empty", "editorial policy removes the complete program");
  }

  const edited = structuredClone(manifest);
  edited.clips = buildEditedClips(manifest, timeline.segments);
  edited.meta.target_duration_seconds = timeline.duration;

  if (policy.captions) {
    const compiledCaptions = compileProposalCaptions(
      proposal,
      policy.captions.request_id,
      timeline.segments,
      selectedCuts,
      clipById
    );
    if (!compiledCaptions.ok) return compiledCaptions;
    edited.captions = compiledCaptions.captions;
  } else if (timeline.removed.length > 0 && edited.captions.length > 0) {
    edited.captions = retimeOutputCaptions(edited.captions, timeline.segments);
  }

  if (policy.chapters) {
    const compiledChapters = compileProposalChapters(
      proposal,
      policy.chapters.request_id,
      timeline.segments,
      clipById
    );
    if (!compiledChapters.ok) return compiledChapters;
    edited.chapters = compiledChapters.chapters;
  } else if (timeline.removed.length > 0 && edited.chapters.length > 0) {
    edited.chapters = retimeOutputChapters(edited.chapters, timeline.segments);
  }

  const withoutDigest = {
    schema_version: 1 as const,
    source_duration_seconds: timeline.sourceDuration,
    duration_seconds: timeline.duration,
    removed_duration_seconds: seconds(timeline.sourceDuration - timeline.duration),
    input_manifest_digest: digest(manifest),
    proposal_digest: proposal.proposal_digest,
    policy_digest: digest(policy),
    output_manifest_digest: digest(edited),
    segments: timeline.segments,
    removed_ranges: timeline.removed,
    ...(policy.captions ? { captions_request_id: policy.captions.request_id } : {}),
    ...(policy.chapters ? { chapters_request_id: policy.chapters.request_id } : {})
  };
  return {
    ok: true,
    issues: [],
    manifest: edited,
    edl: { ...withoutDigest, digest: digest(withoutDigest) }
  };
}

type Cut = {
  id: string;
  kind: string;
  request_id: string;
  source_clip_id: string;
  source_start: number;
  source_end: number;
  matched_text?: string;
};

function parseCuts(input: Array<Record<string, unknown>>): Result<{ cuts: Cut[] }> {
  const cuts: Cut[] = [];
  for (const [index, item] of input.entries()) {
    const evidence = record(item.evidence);
    if (
      !nonEmpty(item.id) || !nonEmpty(item.kind) || !nonEmpty(item.request_id) ||
      !nonEmpty(item.source_clip_id) || !finite(item.source_start) || !finite(item.source_end) ||
      item.source_end <= item.source_start
    ) {
      return failure(
        "editorial.proposal_invalid",
        `cut point ${index + 1} does not contain a valid id, source, kind, and range`
      );
    }
    cuts.push({
      id: item.id,
      kind: item.kind,
      request_id: item.request_id,
      source_clip_id: item.source_clip_id,
      source_start: item.source_start,
      source_end: item.source_end,
      ...(nonEmpty(evidence?.matched_text) ? { matched_text: evidence.matched_text } : {})
    });
  }
  return { ok: true, issues: [], cuts };
}

function mergeRanges(
  sourceClipId: string,
  input: Array<Omit<EditorialRemovedRange, "id" | "source_clip_id">>
): EditorialRemovedRange[] {
  const ordered = [...input].sort((left, right) =>
    left.source_start - right.source_start || left.source_end - right.source_end
  );
  const merged: Array<Omit<EditorialRemovedRange, "id" | "source_clip_id">> = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.source_start <= previous.source_end + EPSILON) {
      previous.source_end = Math.max(previous.source_end, range.source_end);
      previous.cut_ids = uniqueSorted([...previous.cut_ids, ...range.cut_ids]);
      previous.kinds = uniqueSorted([...previous.kinds, ...range.kinds]);
    } else {
      merged.push({ ...range, cut_ids: [...range.cut_ids], kinds: [...range.kinds] });
    }
  }
  return merged.map((range, index) => ({
    id: `${sourceClipId}--remove-${serial(index)}`,
    source_clip_id: sourceClipId,
    source_start: seconds(range.source_start),
    source_end: seconds(range.source_end),
    cut_ids: range.cut_ids,
    kinds: range.kinds
  }));
}

function buildTimeline(
  manifest: Manifest,
  removedByClip: Map<string, EditorialRemovedRange[]>
): {
  sourceDuration: number;
  duration: number;
  segments: EditorialKeepSegment[];
  removed: EditorialRemovedRange[];
} {
  let originalCursor = 0;
  let outputCursor = 0;
  const segments: EditorialKeepSegment[] = [];
  const removed: EditorialRemovedRange[] = [];
  for (const clip of manifest.clips) {
    const clipRemoved = removedByClip.get(clip.id) ?? [];
    removed.push(...clipRemoved);
    let sourceCursor = clip.in;
    let segmentIndex = 0;
    for (const cut of [...clipRemoved, { source_start: clip.out, source_end: clip.out }]) {
      if (cut.source_start - sourceCursor > EPSILON) {
        const duration = cut.source_start - sourceCursor;
        segments.push({
          id: `${clip.id}--keep-${serial(segmentIndex)}`,
          source_clip_id: clip.id,
          source_start: seconds(sourceCursor),
          source_end: seconds(cut.source_start),
          original_output_start: seconds(originalCursor + sourceCursor - clip.in),
          original_output_end: seconds(originalCursor + cut.source_start - clip.in),
          output_start: seconds(outputCursor),
          output_end: seconds(outputCursor + duration)
        });
        outputCursor += duration;
        segmentIndex += 1;
      }
      sourceCursor = Math.max(sourceCursor, cut.source_end);
    }
    originalCursor += clip.duration;
  }
  return {
    sourceDuration: seconds(originalCursor),
    duration: seconds(outputCursor),
    segments,
    removed
  };
}

function buildEditedClips(manifest: Manifest, segments: EditorialKeepSegment[]): Manifest["clips"] {
  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const reservedIds = new Set(manifest.clips.map((clip) => clip.id));
  const outputIds = new Set<string>();
  return segments.map((segment) => {
    const source = clips.get(segment.source_clip_id)!;
    const isWholeSource =
      Math.abs(segment.source_start - source.in) <= EPSILON &&
      Math.abs(segment.source_end - source.out) <= EPSILON;
    const preferred = isWholeSource ? source.id : segment.id;
    const id = uniqueId(preferred, outputIds, isWholeSource ? new Set<string>() : reservedIds);
    outputIds.add(id);
    return {
      ...source,
      id,
      in: segment.source_start,
      out: segment.source_end,
      duration: seconds(segment.source_end - segment.source_start),
      source_clip_id: segment.source_clip_id,
      source_start: segment.source_start,
      source_end: segment.source_end,
      original_output_start: segment.original_output_start,
      original_output_end: segment.original_output_end,
      output_start: segment.output_start,
      output_end: segment.output_end
    };
  });
}

function compileProposalCaptions(
  proposal: EditorialProposalInput,
  requestId: string,
  segments: EditorialKeepSegment[],
  selectedCuts: Cut[],
  clipById: Map<string, Manifest["clips"][number]>
): Result<{ captions: Manifest["captions"] }> {
  const subtitleTracks = (proposal.outputs.subtitle_tracks ?? []).filter(
    (track) => track.request_id === requestId
  );
  const transcripts = (proposal.outputs.transcripts ?? []).filter(
    (track) => track.request_id === requestId
  );
  if (subtitleTracks.length === 0 && transcripts.length === 0) {
    return failure("editorial.caption_request_unknown", `caption request '${requestId}' was not found`);
  }
  if (subtitleTracks.length > 0 && transcripts.length > 0) {
    return failure("editorial.caption_request_ambiguous", `caption request '${requestId}' has multiple output types`);
  }

  const output: Manifest["captions"] = [];
  const fillerTextByClip = selectedFillerText(selectedCuts);
  const tracks = subtitleTracks.length > 0 ? subtitleTracks : transcripts;
  for (const track of tracks) {
    if (!nonEmpty(track.source_clip_id) || !clipById.has(track.source_clip_id)) {
      return failure("editorial.source_clip_unknown", `caption request '${requestId}' has an unknown source clip`);
    }
    const sourceItems = subtitleTracks.length > 0 ? track.captions : track.segments;
    if (!Array.isArray(sourceItems)) {
      return failure("editorial.proposal_invalid", `caption request '${requestId}' has no annotation array`);
    }
    for (const [index, unknownItem] of sourceItems.entries()) {
      const item = record(unknownItem);
      if (!item || !finite(item.source_start) || !finite(item.source_end) || item.source_end <= item.source_start || !nonEmpty(item.text)) {
        return failure("editorial.proposal_invalid", `caption item ${index + 1} in '${requestId}' is invalid`);
      }
      const sourceClipId = nonEmpty(item.source_clip_id) ? item.source_clip_id : track.source_clip_id;
      if (!clipById.has(sourceClipId)) {
        return failure("editorial.source_clip_unknown", `caption item references unknown source clip '${sourceClipId}'`);
      }
      const sourceItemOverlaps = sourceOverlaps(segments, sourceClipId, item.source_start, item.source_end);
      const overlaps = sourceItemOverlaps.length > 1 && !hasTimedWords(item)
        ? [{
            source_start: sourceItemOverlaps[0]!.source_start,
            source_end: sourceItemOverlaps.at(-1)!.source_end,
            output_start: sourceItemOverlaps[0]!.output_start,
            output_end: sourceItemOverlaps.at(-1)!.output_end
          }]
        : sourceItemOverlaps;
      const baseId = nonEmpty(item.id) ? item.id : `${requestId}-caption-${serial(index)}`;
      for (const [partIndex, overlap] of overlaps.entries()) {
        const text = transcriptText(
          item,
          overlap.source_start,
          overlap.source_end,
          fillerTextByClip.get(sourceClipId) ?? []
        );
        if (!text) continue;
        output.push({
          id: overlaps.length === 1 ? baseId : `${baseId}--part-${serial(partIndex)}`,
          text,
          start: overlap.output_start,
          end: overlap.output_end,
          emphasis: [],
          ...(nonEmpty(item.speaker) ? { speaker: item.speaker } : {}),
          request_id: requestId,
          source_clip_id: sourceClipId,
          source_start: overlap.source_start,
          source_end: overlap.source_end
        });
      }
    }
  }
  output.sort((left, right) => left.start - right.start || left.end - right.end || (left.id ?? "").localeCompare(right.id ?? ""));
  uniquifyAnnotationIds(output);
  return { ok: true, issues: [], captions: output };
}

function compileProposalChapters(
  proposal: EditorialProposalInput,
  requestId: string,
  segments: EditorialKeepSegment[],
  clipById: Map<string, Manifest["clips"][number]>
): Result<{ chapters: Manifest["chapters"] }> {
  const sourceChapters = (proposal.outputs.chapters ?? []).filter((chapter) => chapter.request_id === requestId);
  if (sourceChapters.length === 0) {
    return failure("editorial.chapter_request_unknown", `chapter request '${requestId}' was not found`);
  }
  const chapters: Manifest["chapters"] = [];
  for (const [index, chapter] of sourceChapters.entries()) {
    if (
      !nonEmpty(chapter.source_clip_id) || !clipById.has(chapter.source_clip_id) ||
      !finite(chapter.source_start) || !finite(chapter.source_end) ||
      chapter.source_end <= chapter.source_start || !nonEmpty(chapter.title)
    ) {
      return failure("editorial.proposal_invalid", `chapter item ${index + 1} in '${requestId}' is invalid`);
    }
    const overlaps = sourceOverlaps(
      segments,
      chapter.source_clip_id,
      chapter.source_start,
      chapter.source_end
    );
    if (overlaps.length === 0) continue;
    chapters.push({
      title: chapter.title,
      start: overlaps[0]!.output_start,
      end: overlaps.at(-1)!.output_end,
      request_id: requestId,
      source_clip_id: chapter.source_clip_id,
      source_start: Math.max(chapter.source_start, overlaps[0]!.source_start),
      source_end: Math.min(chapter.source_end, overlaps.at(-1)!.source_end),
      ...(nonEmpty(chapter.id) ? { id: chapter.id } : {})
    });
  }
  chapters.sort((left, right) => left.start - right.start || left.end - right.end || left.title.localeCompare(right.title));
  return { ok: true, issues: [], chapters };
}

type SourceOverlap = {
  source_start: number;
  source_end: number;
  output_start: number;
  output_end: number;
};

function sourceOverlaps(
  segments: EditorialKeepSegment[],
  sourceClipId: string,
  sourceStart: number,
  sourceEnd: number
): SourceOverlap[] {
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

function transcriptText(
  item: Record<string, unknown>,
  sourceStart: number,
  sourceEnd: number,
  fillerTexts: string[]
): string {
  const words = Array.isArray(item.words) ? item.words.map(record).filter((word): word is Record<string, unknown> => Boolean(word)) : [];
  const validTimedWords = words.filter((word) =>
    nonEmpty(word.text) && finite(word.source_start) && finite(word.source_end)
  );
  const timedWords = validTimedWords.filter((word) =>
    nonEmpty(word.text) && finite(word.source_start) && finite(word.source_end) &&
    word.source_end > sourceStart + EPSILON && word.source_start < sourceEnd - EPSILON
  );
  const raw = validTimedWords.length > 0
    ? timedWords.map((word) => word.text).join(" ")
    : String(item.text);
  return removeMatchedText(raw, fillerTexts);
}

function hasTimedWords(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.words)) return false;
  return item.words.some((unknownWord) => {
    const word = record(unknownWord);
    return Boolean(word && nonEmpty(word.text) && finite(word.source_start) && finite(word.source_end));
  });
}

function selectedFillerText(cuts: Cut[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const cut of cuts) {
    if (cut.kind !== "filler" || !cut.matched_text) continue;
    result.set(cut.source_clip_id, uniqueSorted([...(result.get(cut.source_clip_id) ?? []), cut.matched_text]));
  }
  return result;
}

function removeMatchedText(input: string, values: string[]): string {
  let result = input;
  for (const value of values) result = result.split(value).join("");
  return result.replace(/\s+/g, " ").trim();
}

function retimeOutputCaptions(
  captions: Manifest["captions"],
  segments: EditorialKeepSegment[]
): Manifest["captions"] {
  const output = captions.flatMap((caption, index) => {
    const overlaps = originalOutputOverlaps(segments, caption.start, caption.end);
    const baseId = caption.id ?? `caption-${serial(index)}`;
    return overlaps.map((overlap, partIndex) => ({
      ...caption,
      id: overlaps.length === 1 ? baseId : `${baseId}--part-${serial(partIndex)}`,
      start: overlap.output_start,
      end: overlap.output_end
    }));
  });
  uniquifyAnnotationIds(output);
  return output;
}

function retimeOutputChapters(
  chapters: Manifest["chapters"],
  segments: EditorialKeepSegment[]
): Manifest["chapters"] {
  return chapters.flatMap((chapter) => {
    const overlaps = originalOutputOverlaps(segments, chapter.start, chapter.end);
    return overlaps.length === 0
      ? []
      : [{ ...chapter, start: overlaps[0]!.output_start, end: overlaps.at(-1)!.output_end }];
  });
}

function originalOutputOverlaps(
  segments: EditorialKeepSegment[],
  originalStart: number,
  originalEnd: number
): Array<{ output_start: number; output_end: number }> {
  return segments.flatMap((segment) => {
    const start = Math.max(originalStart, segment.original_output_start);
    const end = Math.min(originalEnd, segment.original_output_end);
    if (end - start <= EPSILON) return [];
    return [{
      output_start: seconds(segment.output_start + start - segment.original_output_start),
      output_end: seconds(segment.output_start + end - segment.original_output_start)
    }];
  });
}

function hasExternalAudio(manifest: Manifest): boolean {
  return manifest.audio.bgm.length > 0 || manifest.audio.narration.length > 0 || manifest.audio.sfx.length > 0;
}

function uniquifyAnnotationIds(items: Array<{ id?: string }>): void {
  const used = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    item.id = uniqueId(item.id, used, new Set<string>());
    used.add(item.id);
  }
}

function uniqueId(preferred: string, used: Set<string>, reserved: Set<string>): string {
  if (!used.has(preferred) && !reserved.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`) || reserved.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function serial(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function seconds(value: number): number {
  return Number(value.toFixed(9));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function failure<T>(code: string, message: string, path?: string): Result<T> {
  const issue: Issue = { code, message, ...(path ? { path } : {}) };
  return { ok: false, issues: [issue] };
}
