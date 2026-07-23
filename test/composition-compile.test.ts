import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import {
  compileComposition as compileCompositionWithAnalysis,
  type CompositionProposalArtifactInput
} from "../src/orchestrator/compositionCompile.js";
import { digest } from "../src/orchestrator/editorialProposal.js";

function compileComposition(
  manifest: Manifest,
  artifact: CompositionProposalArtifactInput,
  proposalId: string
) {
  return compileCompositionWithAnalysis(
    manifest,
    artifact,
    proposalId,
    artifact && typeof artifact.analysis_digest === "string"
      ? artifact.analysis_digest
      : "0".repeat(64)
  );
}

describe("composition EDL compiler", () => {
  it("reorders selected source ranges deterministically without mutating the input manifest", () => {
    const input = manifest();
    const before = structuredClone(input);
    const artifact = proposalArtifact(input);

    const first = compileComposition(input, artifact, "highlight-v1");
    const second = compileComposition(input, artifact, "highlight-v1");

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(input).toEqual(before);
    if (!first.ok) throw new Error("compile failed");

    expect(first.edl).toMatchObject({
      schema_version: 1,
      run_id: "composition-run",
      proposal_id: "highlight-v1",
      source_manifest_digest: artifact.source_manifest_digest,
      analysis_digest: artifact.analysis_digest,
      brief_digest: artifact.brief_digest,
      proposals_digest: artifact.proposals_digest,
      output_manifest_digest: digest(first.manifest),
      duration_seconds: 5
    });
    expect(first.edl.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.edl.segments).toEqual([
      expect.objectContaining({
        id: "hook",
        source_clip_id: "clip-b",
        source_start: 8,
        source_end: 11,
        output_start: 0,
        output_end: 3,
        role: "hook"
      }),
      expect.objectContaining({
        id: "context",
        source_clip_id: "clip-a",
        source_start: 2,
        source_end: 4,
        output_start: 3,
        output_end: 5,
        role: "context"
      })
    ]);
    expect(first.manifest.meta.target_duration_seconds).toBe(5);
    expect(first.manifest.clips.map((clip) => ({
      id: clip.id,
      src: clip.src,
      source_clip_id: clip.source_clip_id,
      in: clip.in,
      out: clip.out,
      output_start: clip.output_start,
      output_end: clip.output_end
    }))).toEqual([
      {
        id: "hook",
        src: "b.mp4",
        source_clip_id: "clip-b",
        in: 8,
        out: 11,
        output_start: 0,
        output_end: 3
      },
      {
        id: "context",
        src: "a.mp4",
        source_clip_id: "clip-a",
        in: 2,
        out: 4,
        output_start: 3,
        output_end: 5
      }
    ]);
    expect(first.manifest.captions).toEqual([
      expect.objectContaining({
        id: "caption-b",
        source_clip_id: "clip-b",
        source_start: 8.5,
        source_end: 9.5,
        start: 0.5,
        end: 1.5
      }),
      expect.objectContaining({
        id: "caption-a",
        source_clip_id: "clip-a",
        source_start: 2.5,
        source_end: 3.5,
        start: 3.5,
        end: 4.5
      })
    ]);
    expect(first.manifest.chapters).toEqual([
      expect.objectContaining({
        title: "Hook",
        source_clip_id: "clip-b",
        start: 0,
        end: 3
      })
    ]);
  });

  it.each([
    ["source manifest", (artifact: CompositionProposalArtifactInput) => {
      artifact.source_manifest_digest = "a".repeat(64);
    }, "composition.source_manifest_changed"],
    ["brief", (artifact: CompositionProposalArtifactInput) => {
      artifact.brief.goal = "changed";
    }, "composition.brief_digest_invalid"],
    ["proposals", (artifact: CompositionProposalArtifactInput) => {
      artifact.proposals[0]!.title = "changed";
    }, "composition.proposals_digest_invalid"],
    ["story guidance", (artifact: CompositionProposalArtifactInput) => {
      artifact.story_guidance.primary = "changed";
    }, "composition.proposals_digest_invalid"],
    ["analysis", (artifact: CompositionProposalArtifactInput) => {
      artifact.analysis_digest = "not-a-digest";
    }, "composition.analysis_digest_invalid"]
  ])("rejects a stale or invalid %s digest", (_label, mutate, code) => {
    const input = manifest();
    const artifact = proposalArtifact(input);
    mutate(artifact);

    const result = compileComposition(input, artifact, "highlight-v1");

    expect(result).toMatchObject({ ok: false, issues: [{ code }] });
  });

  it("rejects an artifact whose valid analysis digest differs from the verified raw analysis", () => {
    const input = manifest();
    const artifact = proposalArtifact(input);

    expect(
      compileCompositionWithAnalysis(
        input,
        artifact,
        "highlight-v1",
        "c".repeat(64)
      )
    ).toMatchObject({
      ok: false,
      issues: [{ code: "composition.analysis_digest_mismatch" }]
    });
  });

  it("rejects duplicate proposal and segment ids", () => {
    const input = manifest();
    const duplicateProposal = proposalArtifact(input);
    duplicateProposal.proposals.push(structuredClone(duplicateProposal.proposals[0]!));
    refreshProposalsDigest(duplicateProposal);

    expect(compileComposition(input, duplicateProposal, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.proposal_id_duplicate" }]
    });

    const duplicateSegment = proposalArtifact(input);
    duplicateSegment.proposals[0]!.segments[1]!.id = "hook";
    refreshProposalsDigest(duplicateSegment);

    expect(compileComposition(input, duplicateSegment, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.segment_id_duplicate" }]
    });
  });

  it("fails closed for malformed runtime artifact entries", () => {
    const input = manifest();
    expect(compileComposition(
      input,
      null as unknown as CompositionProposalArtifactInput,
      "highlight-v1"
    )).toMatchObject({
      ok: false,
      issues: [{ code: "composition.artifact_invalid" }]
    });

    const malformedProposal = proposalArtifact(input);
    malformedProposal.proposals = [null] as unknown as CompositionProposalArtifactInput["proposals"];
    refreshProposalsDigest(malformedProposal);
    expect(compileComposition(input, malformedProposal, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.proposal_invalid" }]
    });

    const malformedSegment = proposalArtifact(input);
    malformedSegment.proposals[0]!.segments = [null] as unknown as CompositionProposalArtifactInput["proposals"][number]["segments"];
    refreshProposalsDigest(malformedSegment);
    expect(compileComposition(input, malformedSegment, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.segment_invalid" }]
    });
  });

  it("rejects an unknown selected proposal and ambiguous source clip ids", () => {
    const input = manifest();
    const artifact = proposalArtifact(input);
    expect(compileComposition(input, artifact, "missing")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.proposal_unknown" }]
    });

    input.clips[1]!.id = "clip-a";
    const ambiguous = proposalArtifact(input);
    expect(compileComposition(input, ambiguous, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.source_clip_id_duplicate" }]
    });
  });

  it.each([
    ["unknown source", { source_clip_id: "missing" }, "composition.source_clip_unknown"],
    ["zero duration", { source_start: 8, source_end: 8 }, "composition.segment_invalid"],
    ["negative timestamp", { source_start: -1 }, "composition.segment_invalid"],
    ["outside source", { source_end: 16 }, "composition.segment_out_of_range"]
  ])("rejects an invalid segment with %s", (_label, override, code) => {
    const input = manifest();
    const artifact = proposalArtifact(input);
    Object.assign(artifact.proposals[0]!.segments[0]!, override);
    refreshProposalsDigest(artifact);

    expect(compileComposition(input, artifact, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code }]
    });
  });

  it("rejects overlapping source ranges even when they are separated in output order", () => {
    const input = manifest();
    const artifact = proposalArtifact(input);
    artifact.proposals[0]!.segments.push({
      id: "overlap",
      source_clip_id: "clip-b",
      source_start: 10,
      source_end: 12,
      role: "ending",
      reason: "overlaps the hook",
      observation_ids: []
    });
    refreshProposalsDigest(artifact);

    expect(compileComposition(input, artifact, "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.segment_overlap" }]
    });
  });

  it("fails closed for external audio and annotations without source timestamps", () => {
    const audioManifest = manifest();
    audioManifest.audio.bgm.push({ id: "music", src: "music.wav" });
    expect(compileComposition(audioManifest, proposalArtifact(audioManifest), "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.external_audio_unsupported" }]
    });

    const captionManifest = manifest();
    captionManifest.captions[0] = {
      id: "caption-b",
      text: "Unknown source",
      start: 0,
      end: 1,
      emphasis: []
    };
    expect(compileComposition(captionManifest, proposalArtifact(captionManifest), "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.annotation_source_unknown" }]
    });

    const chapterManifest = manifest();
    chapterManifest.chapters[0] = { title: "Unknown source", start: 0, end: 1 };
    expect(compileComposition(chapterManifest, proposalArtifact(chapterManifest), "highlight-v1")).toMatchObject({
      ok: false,
      issues: [{ code: "composition.annotation_source_unknown" }]
    });
  });

  it("clips source-aware annotation provenance to the selected source range", () => {
    const input = manifest();
    input.captions = [{
      id: "wide-caption",
      text: "Partially selected",
      start: 12,
      end: 17,
      emphasis: [],
      source_clip_id: "clip-b",
      source_start: 7,
      source_end: 12
    }];

    const result = compileComposition(input, proposalArtifact(input), "highlight-v1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    expect(result.manifest.captions).toEqual([
      expect.objectContaining({
        id: "wide-caption",
        source_clip_id: "clip-b",
        source_start: 8,
        source_end: 11,
        start: 0,
        end: 3
      })
    ]);
  });
});

function manifest(): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 20,
      slug: "composition"
    },
    clips: [
      {
        id: "clip-a",
        src: "a.mp4",
        in: 0,
        out: 10,
        duration: 10,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: true
      },
      {
        id: "clip-b",
        src: "b.mp4",
        in: 5,
        out: 15,
        duration: 10,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
        audio: true
      }
    ],
    images: [],
    speakers: [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [
      {
        id: "caption-a",
        text: "Context",
        start: 2.5,
        end: 3.5,
        emphasis: [],
        source_clip_id: "clip-a",
        source_start: 2.5,
        source_end: 3.5
      },
      {
        id: "caption-b",
        text: "Hook",
        start: 13.5,
        end: 14.5,
        emphasis: [],
        source_clip_id: "clip-b",
        source_start: 8.5,
        source_end: 9.5
      }
    ],
    chapters: [
      {
        title: "Hook",
        start: 10,
        end: 13,
        source_clip_id: "clip-b",
        source_start: 8,
        source_end: 11
      }
    ],
    provenance: []
  };
}

function proposalArtifact(manifestInput: Manifest): CompositionProposalArtifactInput {
  const brief = {
    goal: "Introduce the activity",
    audience: "First-time visitors",
    target_duration_seconds: 5,
    priority: "highlight"
  };
  const proposals = [{
    id: "highlight-v1",
    title: "Highlight first",
    strategy: "highlight",
    rationale: "Open with movement and then add context",
    estimated_duration_seconds: 5,
    segments: [
      {
        id: "hook",
        source_clip_id: "clip-b",
        source_start: 8,
        source_end: 11,
        role: "hook",
        reason: "Clear motion",
        observation_ids: ["obs-b"]
      },
      {
        id: "context",
        source_clip_id: "clip-a",
        source_start: 2,
        source_end: 4,
        role: "context",
        reason: "Explains the setting",
        observation_ids: ["obs-a"]
      }
    ],
    warnings: []
  }];
  const storyGuidance = {
    primary: "digest",
    supporting: ["case-study"],
    rejected: []
  };
  return {
    schema_version: 1,
    run_id: "composition-run",
    source_manifest_digest: digest(manifestInput),
    analysis_digest: "b".repeat(64),
    brief,
    brief_digest: digest(brief),
    story_guidance: storyGuidance,
    proposals,
    proposals_digest: digest({ story_guidance: storyGuidance, proposals })
  };
}

function refreshProposalsDigest(artifact: CompositionProposalArtifactInput): void {
  artifact.proposals_digest = digest({
    story_guidance: artifact.story_guidance,
    proposals: artifact.proposals
  });
}
