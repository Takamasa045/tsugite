import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import {
  compileEditorial,
  type EditorialCompilePolicy,
  type EditorialProposalInput
} from "../src/orchestrator/editorialCompile.js";

describe("editorial EDL compiler", () => {
  it("compiles only explicitly selected cuts, clamps and merges ranges, and retimes source annotations", () => {
    const input = manifest();
    const proposal = editorialProposal();
    const policy: EditorialCompilePolicy = {
      remove_kinds: ["filler", "silence"],
      remove_ids: ["cut-b-tail"],
      exclude_ids: ["cut-excluded"],
      captions: { request_id: "subtitles-en" },
      chapters: { request_id: "chapters-ja" }
    };

    const first = compileEditorial(input, proposal, policy);
    const second = compileEditorial(input, proposal, policy);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("compile failed");
    expect(input).toEqual(manifest());
    expect(first.edl.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.edl.duration_seconds).toBe(11.5);
    expect(first.edl.removed_ranges).toEqual([
      expect.objectContaining({ source_clip_id: "clip-a", source_start: 10, source_end: 10.5 }),
      expect.objectContaining({ source_clip_id: "clip-a", source_start: 11, source_end: 13 }),
      expect.objectContaining({ source_clip_id: "clip-b", source_start: 34, source_end: 36 })
    ]);
    expect(first.edl.segments).toEqual([
      expect.objectContaining({
        source_clip_id: "clip-a",
        source_start: 10.5,
        source_end: 11,
        original_output_start: 0.5,
        original_output_end: 1,
        output_start: 0,
        output_end: 0.5
      }),
      expect.objectContaining({
        source_clip_id: "clip-a",
        source_start: 13,
        source_end: 20,
        original_output_start: 3,
        original_output_end: 10,
        output_start: 0.5,
        output_end: 7.5
      }),
      expect.objectContaining({
        source_clip_id: "clip-b",
        source_start: 30,
        source_end: 34,
        original_output_start: 10,
        original_output_end: 14,
        output_start: 7.5,
        output_end: 11.5
      })
    ]);
    expect(first.manifest.meta.target_duration_seconds).toBe(11.5);
    expect(first.manifest.clips.map((clip) => [clip.source_clip_id, clip.in, clip.out, clip.duration])).toEqual([
      ["clip-a", 10.5, 11, 0.5],
      ["clip-a", 13, 20, 7],
      ["clip-b", 30, 34, 4]
    ]);
    expect(first.manifest.captions).toEqual([
      expect.objectContaining({ id: "caption-cross", text: "Across cuts", start: 0, end: 1 }),
      expect.objectContaining({ id: "caption-b", text: "Tail", start: 11, end: 11.5 })
    ]);
    expect(first.manifest.chapters).toEqual([
      expect.objectContaining({ title: "Opening", start: 0, end: 1.5 }),
      expect.objectContaining({ title: "Second", start: 9.5, end: 11.5 })
    ]);
  });

  it("builds transcript captions from words and removes selected filler matched_text", () => {
    const input = oneClipManifest();
    const proposal = proposalWithTranscript();

    const result = compileEditorial(input, proposal, {
      remove_kinds: ["filler"],
      remove_ids: [],
      exclude_ids: [],
      captions: { request_id: "transcript-ja" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    expect(result.manifest.captions).toEqual([
      expect.objectContaining({ text: "今日は", start: 1, end: 2 }),
      expect.objectContaining({ text: "テストです", start: 2, end: 3.5 })
    ]);
    expect(result.manifest.captions.map((caption) => caption.text).join(" ")).not.toContain("えー");
  });

  it("preserves every range when no cut candidate is selected", () => {
    const result = compileEditorial(oneClipManifest(), proposalWithTranscript(), {
      remove_kinds: [],
      remove_ids: [],
      exclude_ids: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    expect(result.edl.removed_ranges).toEqual([]);
    expect(result.edl.segments).toEqual([
      expect.objectContaining({ source_clip_id: "clip-a", source_start: 0, source_end: 10, output_start: 0, output_end: 10 })
    ]);
    expect(result.manifest.captions).toEqual(oneClipManifest().captions);
  });

  it("retimes existing manifest captions and chapters when no analysis annotation is selected", () => {
    const input = oneClipManifest();
    input.captions = [{ id: "existing", text: "Existing", start: 1, end: 4, emphasis: [] }];
    input.chapters = [
      { title: "Across", start: 1, end: 4 },
      { title: "Removed", start: 2, end: 2.5 }
    ];

    const result = compileEditorial(input, proposalWithTranscript(), {
      remove_kinds: ["filler"],
      remove_ids: [],
      exclude_ids: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    expect(result.manifest.captions).toEqual([
      expect.objectContaining({ id: "existing--part-001", start: 1, end: 2 }),
      expect.objectContaining({ id: "existing--part-002", start: 2, end: 3.5 })
    ]);
    expect(result.manifest.chapters).toEqual([
      expect.objectContaining({ title: "Across", start: 1, end: 3.5 })
    ]);
  });

  it("fails closed when the manifest has external audio tracks", () => {
    const input = oneClipManifest();
    input.audio.bgm.push({ id: "music", src: "music.wav" });

    const result = compileEditorial(input, proposalWithTranscript(), emptyPolicy());

    expect(result).toMatchObject({ ok: false, issues: [{ code: "editorial.external_audio_unsupported" }] });
  });

  it.each([
    ["remove_ids", { remove_ids: ["missing-cut"] }, "editorial.cut_id_unknown"],
    ["exclude_ids", { exclude_ids: ["missing-cut"] }, "editorial.cut_id_unknown"],
    ["caption request", { captions: { request_id: "missing-captions" } }, "editorial.caption_request_unknown"],
    ["chapter request", { chapters: { request_id: "missing-chapters" } }, "editorial.chapter_request_unknown"]
  ])("rejects an unknown explicit %s", (_label, override, code) => {
    const result = compileEditorial(oneClipManifest(), proposalWithTranscript(), {
      ...emptyPolicy(),
      ...override
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects an edit that removes the complete program", () => {
    const proposal = proposalWithTranscript();
    proposal.outputs.cut_points = [{
      id: "cut-all",
      kind: "manual",
      request_id: "manual-cuts",
      source_clip_id: "clip-a",
      source_start: 0,
      source_end: 10
    }];

    const result = compileEditorial(oneClipManifest(), proposal, {
      remove_kinds: [],
      remove_ids: ["cut-all"],
      exclude_ids: []
    });

    expect(result).toMatchObject({ ok: false, issues: [{ code: "editorial.program_empty" }] });
  });

  it.each([
    ["duplicate clips", () => {
      const input = manifest();
      input.clips[1]!.id = "clip-a";
      return compileEditorial(input, editorialProposal(), emptyPolicy());
    }, "editorial.clip_id_duplicate"],
    ["duplicate cuts", () => {
      const proposal = proposalWithTranscript();
      proposal.outputs.cut_points!.push({ ...proposal.outputs.cut_points![0]! });
      return compileEditorial(oneClipManifest(), proposal, emptyPolicy());
    }, "editorial.cut_id_duplicate"],
    ["malformed cuts", () => {
      const proposal = proposalWithTranscript();
      proposal.outputs.cut_points = [{ id: "bad" }];
      return compileEditorial(oneClipManifest(), proposal, emptyPolicy());
    }, "editorial.proposal_invalid"],
    ["unknown cut source", () => {
      const proposal = proposalWithTranscript();
      proposal.outputs.cut_points![0]!.source_clip_id = "missing";
      return compileEditorial(oneClipManifest(), proposal, { ...emptyPolicy(), remove_ids: ["filler-1"] });
    }, "editorial.source_clip_unknown"]
  ])("fails closed for %s", (_label, run, code) => {
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects a caption request id shared by transcript and subtitle outputs", () => {
    const proposal = proposalWithTranscript();
    proposal.outputs.subtitle_tracks = [{
      request_id: "transcript-ja",
      source_clip_id: "clip-a",
      captions: []
    }];

    const result = compileEditorial(oneClipManifest(), proposal, {
      ...emptyPolicy(),
      captions: { request_id: "transcript-ja" }
    });

    expect(result).toMatchObject({ ok: false, issues: [{ code: "editorial.caption_request_ambiguous" }] });
  });
});

function emptyPolicy(): EditorialCompilePolicy {
  return { remove_kinds: [], remove_ids: [], exclude_ids: [] };
}

function manifest(): Manifest {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 16, slug: "seminar" },
    clips: [
      { id: "clip-a", src: "a.mp4", in: 10, out: 20, duration: 10, fps: 30, resolution: { width: 1920, height: 1080 }, audio: true },
      { id: "clip-b", src: "b.mp4", in: 30, out: 36, duration: 6, fps: 30, resolution: { width: 1920, height: 1080 }, audio: true }
    ],
    images: [], speakers: [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [{ id: "old", text: "old", start: 0, end: 1, emphasis: [] }],
    chapters: [], provenance: []
  };
}

function oneClipManifest(): Manifest {
  const value = manifest();
  value.meta.target_duration_seconds = 10;
  value.clips = [{ ...value.clips[0]!, in: 0, out: 10, duration: 10 }];
  return value;
}

function editorialProposal(): EditorialProposalInput {
  return {
    schema_version: 1,
    run_id: "seminar-run",
    slug: "seminar",
    proposal_digest: "a".repeat(64),
    outputs: {
      cut_points: [
        cut("cut-clamp", "silence", "clip-a", 9, 10.5),
        cut("cut-filler", "filler", "clip-a", 11, 12, { matched_text: "um" }),
        cut("cut-overlap", "silence", "clip-a", 11.8, 13),
        cut("cut-unselected", "scene", "clip-a", 13.5, 14),
        cut("cut-excluded", "silence", "clip-a", 15, 16),
        cut("cut-b-tail", "manual", "clip-b", 34, 40)
      ],
      transcripts: [], summaries: [],
      subtitle_tracks: [{
        request_id: "subtitles-en",
        source_clip_id: "clip-a",
        source_language: "ja",
        target_language: "en",
        captions: [{ id: "caption-cross", source_start: 10.25, source_end: 13.5, text: "Across cuts" }]
      }, {
        request_id: "subtitles-en",
        source_clip_id: "clip-b",
        source_language: "ja",
        target_language: "en",
        captions: [{ id: "caption-b", source_start: 33.5, source_end: 35, text: "Tail" }]
      }],
      chapters: [
        { id: "chapter-a", request_id: "chapters-ja", source_clip_id: "clip-a", source_start: 10, source_end: 14, title: "Opening" },
        { id: "chapter-b", request_id: "chapters-ja", source_clip_id: "clip-b", source_start: 32, source_end: 35, title: "Second" }
      ]
    }
  };
}

function proposalWithTranscript(): EditorialProposalInput {
  return {
    schema_version: 1,
    run_id: "seminar-run",
    slug: "seminar",
    proposal_digest: "b".repeat(64),
    outputs: {
      cut_points: [cut("filler-1", "filler", "clip-a", 2, 2.5, { matched_text: "えー" })],
      transcripts: [{
        request_id: "transcript-ja",
        source_clip_id: "clip-a",
        language: "ja",
        segments: [{
          id: "segment-1",
          source_start: 1,
          source_end: 4,
          text: "今日は えー テストです",
          words: [
            { text: "今日は", source_start: 1, source_end: 2 },
            { text: "えー", source_start: 2, source_end: 2.5 },
            { text: "テストです", source_start: 2.5, source_end: 4 }
          ]
        }]
      }],
      chapters: [], summaries: [], subtitle_tracks: []
    }
  };
}

function cut(
  id: string,
  kind: string,
  sourceClipId: string,
  sourceStart: number,
  sourceEnd: number,
  evidence?: { matched_text: string }
) {
  return {
    id, kind, request_id: "cut-request", source_clip_id: sourceClipId,
    source_start: sourceStart, source_end: sourceEnd,
    ...(evidence ? { evidence } : {})
  };
}
