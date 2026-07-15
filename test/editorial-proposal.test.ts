import { describe, expect, it } from "vitest";
import {
  createEditorialProposal,
  verifyEditorialProposal
} from "../src/orchestrator/editorialProposal.js";

function rawAnalysis() {
  const source = {
    clip_id: "seminar-source",
    analysis_start_seconds: 0,
    analysis_end_seconds: 20,
    duration_seconds: 20,
    sha256: "a".repeat(64)
  };
  return {
    schema_version: 1 as const,
    run_id: "seminar-run",
    slug: "seminar",
    adapters: ["local-whisper-analysis"],
    input_digest: "b".repeat(64),
    actual_credits: 0 as const,
    api_used: false as const,
    network_used: false as const,
    results: [
      {
        schema_version: 1,
        request_id: "transcript-ja",
        output: "transcript",
        source,
        data: {
          language: "ja",
          segments: [{ id: "seg-1", source_start: 0, source_end: 5, text: "えっと始めます", words: [] }]
        },
        metadata: { engine: "local-whisper", api_used: false, network_used: false },
        attempts: 1,
        adapter: "local-whisper-analysis"
      },
      {
        schema_version: 1,
        request_id: "fillers-ja",
        output: "cut_points",
        source,
        data: {
          cut_points: [{
            id: "filler-1",
            kind: "filler",
            source_start: 0,
            source_end: 0.4,
            action: "review"
          }]
        },
        metadata: { engine: "local-whisper", api_used: false, network_used: false },
        attempts: 1,
        adapter: "local-whisper-analysis"
      },
      {
        schema_version: 1,
        request_id: "subtitles-en",
        output: "subtitle_track",
        source,
        data: {
          source_language: "ja",
          target_language: "en",
          captions: [{ id: "en-1", source_segment_id: "seg-1", source_start: 0, source_end: 5, text: "Let's begin." }]
        },
        metadata: { engine: "local-whisper", api_used: false, network_used: false },
        attempts: 1,
        adapter: "local-whisper-analysis"
      }
    ]
  };
}

describe("editorial proposal", () => {
  it("creates stable review-only outputs and a digest chain from raw analysis", () => {
    const raw = rawAnalysis();

    const first = createEditorialProposal(raw);
    const second = createEditorialProposal(raw);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema_version: 1,
      run_id: "seminar-run",
      status: "proposed",
      analysis_input_digest: "b".repeat(64),
      outputs: {
        transcripts: [expect.objectContaining({ language: "ja" })],
        cut_points: [expect.objectContaining({
          action: "review",
          kind: "filler",
          request_id: "fillers-ja",
          source_clip_id: "seminar-source"
        })],
        subtitle_tracks: [expect.objectContaining({
          target_language: "en",
          request_id: "subtitles-en",
          source_clip_id: "seminar-source"
        })]
      }
    });
    expect(first.raw_analysis_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.proposal_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyEditorialProposal(raw, first)).toEqual({ ok: true, issues: [] });
  });

  it("rejects a proposal when either raw analysis or proposal content changed", () => {
    const raw = rawAnalysis();
    const proposal = createEditorialProposal(raw);
    const changedRaw = structuredClone(raw);
    changedRaw.results[0]!.data.segments![0]!.text = "差し替え";
    const changedProposal = structuredClone(proposal);
    changedProposal.outputs.cut_points[0]!.source_end = 1;

    expect(verifyEditorialProposal(changedRaw, proposal).ok).toBe(false);
    expect(verifyEditorialProposal(raw, changedProposal).ok).toBe(false);
  });
});
