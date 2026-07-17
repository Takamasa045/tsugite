import { createHash } from "node:crypto";
import type { Result } from "../types.js";

type RawResult = {
  request_id: string;
  output: string;
  data: Record<string, unknown>;
  source: {
    clip_id: string;
  };
};

export type RawAnalysisForProposal = {
  schema_version: 1;
  run_id: string;
  slug: string;
  input_digest: string;
  results: RawResult[];
};

export type EditorialProposal = {
  schema_version: 1;
  run_id: string;
  slug: string;
  status: "proposed";
  analysis_input_digest: string;
  raw_analysis_digest: string;
  proposal_digest: string;
  outputs: {
    transcripts: Array<Record<string, unknown>>;
    cut_points: Array<Record<string, unknown>>;
    chapters: Array<Record<string, unknown>>;
    summaries: Array<Record<string, unknown>>;
    subtitle_tracks: Array<Record<string, unknown>>;
  };
};

export function createEditorialProposal(raw: RawAnalysisForProposal): EditorialProposal {
  const proposalWithoutDigest = {
    schema_version: 1 as const,
    run_id: raw.run_id,
    slug: raw.slug,
    status: "proposed" as const,
    analysis_input_digest: raw.input_digest,
    raw_analysis_digest: digest(raw),
    outputs: {
      transcripts: collectData(raw.results, "transcript"),
      cut_points: collectMany(raw.results, "cut_points", "cut_points"),
      chapters: collectMany(raw.results, "chapters", "chapters"),
      summaries: collectData(raw.results, "summary"),
      subtitle_tracks: collectData(raw.results, "subtitle_track")
    }
  };
  return {
    ...proposalWithoutDigest,
    proposal_digest: digest(proposalWithoutDigest)
  };
}

export function verifyEditorialProposal(
  raw: RawAnalysisForProposal,
  proposal: EditorialProposal
): Result<Record<never, never>> {
  if (proposal.raw_analysis_digest !== digest(raw) || proposal.analysis_input_digest !== raw.input_digest) {
    return failure("analysis.proposal_raw_mismatch", "editorial proposal does not match raw analysis");
  }
  const { proposal_digest: claimedDigest, ...withoutDigest } = proposal;
  if (claimedDigest !== digest(withoutDigest)) {
    return failure("analysis.proposal_digest_mismatch", "editorial proposal content digest does not match");
  }
  return { ok: true, issues: [] };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function collectData(
  results: RawResult[],
  output: string
): Array<Record<string, unknown>> {
  return results.flatMap((result) => {
    if (result.output !== output) return [];
    return [{
      ...result.data,
      request_id: result.request_id,
      source_clip_id: result.source.clip_id
    }];
  });
}

function collectMany(
  results: RawResult[],
  output: string,
  key: string
): Array<Record<string, unknown>> {
  return results.flatMap((result) => {
    if (result.output !== output) return [];
    const value = result.data[key];
    return Array.isArray(value)
      ? value.filter(isRecord).map((item) => ({
          ...item,
          request_id: result.request_id,
          source_clip_id: result.source.clip_id
        }))
      : [];
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(code: string, message: string): Result<Record<never, never>> {
  return { ok: false, issues: [{ code, message }] };
}
