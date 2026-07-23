import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest/schema.js";
import { composeProject } from "../src/orchestrator/compose.js";
import { compileComposition } from "../src/orchestrator/compositionCompile.js";
import {
  createCompositionProposals,
  verifyCompositionProposals,
  type CompositionBrief,
  type CompositionProposalsArtifact,
  type CompositionStoryGuidance,
  type RawAnalysisForComposition
} from "../src/orchestrator/compositionProposal.js";
import { digest } from "../src/orchestrator/editorialProposal.js";

describe("composition proposals", () => {
  it("deterministically creates distinct, digest-bound proposals from scene observations", () => {
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 5);
    const raw = rawAnalysis([
      sceneResult("scene-a", "clip-a", [
        observation("obs-a1", 0, 2, "opening highlight", 0.95),
        observation("obs-a2", 2, 5, "context", 0.7)
      ]),
      sceneResult("scene-b", "clip-b", [
        observation("obs-b1", 0, 3, "explanation", 0.8),
        observation("obs-b2", 3, 5, "detail", 0.6)
      ]),
      sceneResult("scene-c", "clip-c", [
        observation("obs-c1", 0, 5, "closing atmosphere", 0.75)
      ])
    ]);
    const brief = compositionBrief({
      target_duration_seconds: 7,
      priority: "highlight",
      required_clip_ids: ["clip-b"],
      excluded_clip_ids: ["clip-c"]
    });

    const first = createCompositionProposals(raw, manifest, brief, storyGuidance(), 3);
    const second = createCompositionProposals(raw, manifest, brief, storyGuidance(), 3);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.artifact).toEqual(second.artifact);
    expect(first.artifact.proposals.length).toBeGreaterThanOrEqual(2);
    expect(first.artifact.proposals.length).toBeLessThanOrEqual(3);
    expect(new Set(first.artifact.proposals.map((proposal) => proposal.strategy)).size)
      .toBe(first.artifact.proposals.length);
    expect(new Set(first.artifact.proposals.map((proposal) =>
      proposal.segments.map((segment) => `${segment.source_clip_id}@${segment.source_start}`).join("|")
    )).size).toBe(first.artifact.proposals.length);
    for (const proposal of first.artifact.proposals) {
      expect(proposal.estimated_duration_seconds).toBe(7);
      expect(proposal.segments.some((segment) => segment.source_clip_id === "clip-b")).toBe(true);
      expect(proposal.segments.some((segment) => segment.source_clip_id === "clip-c")).toBe(false);
      expect(proposal.segments.every((segment) =>
        segment.id &&
        segment.role &&
        segment.reason &&
        segment.observation_ids.length > 0
      )).toBe(true);
    }
    expect(first.artifact).toMatchObject({
      schema_version: 1,
      run_id: "composition-run",
      source_manifest_digest: digest(manifest),
      analysis_digest: digest(raw),
      brief_digest: digest(brief)
    });
    expect(first.artifact.proposals_digest).toBe(digest({
      story_guidance: first.artifact.story_guidance,
      proposals: first.artifact.proposals
    }));
    expect(verifyCompositionProposals(raw, manifest, brief, first.artifact, 3).ok).toBe(true);
  });

  it("uses transcript segments per clip, then full-clip fallback, and reports a duration shortage", () => {
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 2);
    const raw = rawAnalysis([
      transcriptResult("transcript-a", "clip-a", [
        { id: "line-a", source_start: 0, source_end: 1.5, text: "サービスの概要を説明します。" }
      ]),
      sceneResult("scene-b", "clip-b", [
        observation("obs-b", 0, 1, "scene B", 0.8)
      ])
    ]);
    const brief = compositionBrief({ target_duration_seconds: 10, priority: "explanatory" });

    const result = createCompositionProposals(raw, manifest, brief, storyGuidance(), 2);

    expect(result.ok).toBe(true);
    expect(result.artifact.proposals).toHaveLength(2);
    for (const proposal of result.artifact.proposals) {
      expect(proposal.segments).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_clip_id: "clip-a", observation_ids: ["line-a"] }),
        expect.objectContaining({ source_clip_id: "clip-b", observation_ids: ["obs-b"] }),
        expect.objectContaining({ source_clip_id: "clip-c", observation_ids: ["fallback-0003"] })
      ]));
      expect(proposal.warnings.join(" ")).toContain("素材が4.5秒");
    }
  });

  it("rejects unknown or conflicting brief clips and semantic tampering even with a recomputed digest", () => {
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 3);
    const raw = rawAnalysis([]);
    const unknown = createCompositionProposals(
      raw,
      manifest,
      compositionBrief({ required_clip_ids: ["missing"] }),
      storyGuidance(),
      3
    );
    const conflict = createCompositionProposals(
      raw,
      manifest,
      compositionBrief({ required_clip_ids: ["clip-a"], excluded_clip_ids: ["clip-a"] }),
      storyGuidance(),
      3
    );

    expect(unknown.ok).toBe(false);
    expect(unknown.issues[0]?.code).toBe("composition.brief_clip_unknown");
    expect(conflict.ok).toBe(false);
    expect(conflict.issues[0]?.code).toBe("composition.brief_clip_conflict");

    const brief = compositionBrief({ target_duration_seconds: 4 });
    const created = createCompositionProposals(raw, manifest, brief, storyGuidance(), 1);
    expect(created.ok).toBe(true);
    const malformedStrategy = structuredClone(created.artifact) as unknown as {
      proposals: Array<Record<string, unknown>>;
    };
    malformedStrategy.proposals[0]!.strategy = "rotated";
    const invalidStrategy = verifyCompositionProposals(raw, manifest, brief, malformedStrategy, 1);
    expect(invalidStrategy.ok).toBe(false);
    expect(invalidStrategy.issues[0]?.code).toBe("composition.artifact_invalid");

    const malformedEvidence = structuredClone(created.artifact) as unknown as {
      proposals: Array<{ segments: Array<Record<string, unknown>> }>;
    };
    malformedEvidence.proposals[0]!.segments[0]!.observation_ids = "not-an-array";
    const invalidEvidence = verifyCompositionProposals(raw, manifest, brief, malformedEvidence, 1);
    expect(invalidEvidence.ok).toBe(false);
    expect(invalidEvidence.issues[0]?.code).toBe("composition.artifact_invalid");

    const tampered = structuredClone(created.artifact) as CompositionProposalsArtifact;
    tampered.proposals[0]!.segments.push({
      ...tampered.proposals[0]!.segments[0]!,
      id: "overlap",
      source_start: 1,
      source_end: 2
    });
    tampered.proposals[0]!.estimated_duration_seconds += 1;
    tampered.proposals_digest = digest({
      story_guidance: tampered.story_guidance,
      proposals: tampered.proposals
    });

    const verified = verifyCompositionProposals(raw, manifest, brief, tampered, 1);
    expect(verified.ok).toBe(false);
    expect(verified.issues.map((issue) => issue.code)).toContain("composition.segment_overlap");
  });

  it("merges transcript evidence into scenes and suppresses cross-clip similarity duplicates", () => {
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 2);
    const raw = rawAnalysis([
      sceneResult("scene-a", "clip-a", [observation("obs-a", 0, 2, "scene A", 0.9)]),
      transcriptResult("transcript-a", "clip-a", [
        { id: "line-a", source_start: 0.25, source_end: 1.5, text: "活動の価値を説明する" }
      ]),
      sceneResult("scene-b", "clip-b", [observation("obs-b", 0, 2, "similar scene B", 0.8)]),
      sceneResult("scene-c", "clip-c", [observation("obs-c", 0, 2, "different scene C", 0.7)]),
      {
        request_id: "similarity",
        output: "similarity_groups",
        source: { clip_id: "clip-a" },
        data: {
          similarity_groups: [{
            id: "similar-ab",
            member_observation_ids: ["obs-a", "obs-b"],
            reason: "同一場面"
          }]
        }
      }
    ]);

    const result = createCompositionProposals(
      raw,
      manifest,
      compositionBrief({ target_duration_seconds: 4, priority: "explanatory" }),
      storyGuidance(),
      1
    );

    expect(result.ok).toBe(true);
    const proposal = result.artifact.proposals[0]!;
    const sceneA = proposal.segments.find((segment) => segment.observation_ids.includes("obs-a"));
    expect(sceneA?.observation_ids).toContain("line-a");
    expect(sceneA?.reason).toContain("文字起こし");
    expect(proposal.segments.some((segment) => segment.observation_ids.includes("obs-a")) &&
      proposal.segments.some((segment) => segment.observation_ids.includes("obs-b"))).toBe(false);
  });

  it("keeps every proposal in its declared strategy order", () => {
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 2);
    const raw = rawAnalysis([
      sceneResult("scene-a", "clip-a", [observation("obs-a", 0, 2, "scene A", 0.8)]),
      sceneResult("scene-b", "clip-b", [observation("obs-b", 0, 2, "scene B", 0.8)]),
      sceneResult("scene-c", "clip-c", [observation("obs-c", 0, 2, "scene C", 0.8)])
    ]);
    const brief = compositionBrief({ target_duration_seconds: 6, priority: "chronological" });
    const created = createCompositionProposals(raw, manifest, brief, storyGuidance(), 1);

    expect(created.ok).toBe(true);
    expect(created.artifact.proposals[0]!.segments.map((segment) => segment.source_clip_id))
      .toEqual(["clip-a", "clip-b", "clip-c"]);

    const tampered = structuredClone(created.artifact);
    tampered.proposals[0]!.segments = [
      ...tampered.proposals[0]!.segments.slice(1),
      tampered.proposals[0]!.segments[0]!
    ];
    tampered.proposals_digest = digest({
      story_guidance: tampered.story_guidance,
      proposals: tampered.proposals
    });
    const verified = verifyCompositionProposals(raw, manifest, brief, tampered, 1);
    expect(verified.ok).toBe(false);
    expect(verified.issues.map((issue) => issue.code)).toContain("composition.strategy_order");

    for (const priority of ["highlight", "explanatory", "atmosphere"] as const) {
      const strategyBrief = compositionBrief({ target_duration_seconds: 6, priority });
      const strategyProposal = createCompositionProposals(
        raw,
        manifest,
        strategyBrief,
        storyGuidance(),
        1
      );
      expect(strategyProposal.ok).toBe(true);
      const reordered = structuredClone(strategyProposal.artifact);
      reordered.proposals[0]!.segments = [
        ...reordered.proposals[0]!.segments.slice(1),
        reordered.proposals[0]!.segments[0]!
      ];
      reordered.proposals_digest = digest({
        story_guidance: reordered.story_guidance,
        proposals: reordered.proposals
      });
      const strategyVerified = verifyCompositionProposals(
        raw,
        manifest,
        strategyBrief,
        reordered,
        1
      );
      expect(strategyVerified.ok).toBe(false);
      expect(strategyVerified.issues.map((issue) => issue.code))
        .toContain("composition.strategy_order");
    }
  });

  it("fails closed for malformed raw analysis and compiles decimal source bounds with matching precision", () => {
    const manifest = manifestWithClips(["clip-a"], 1);
    const malformed = {
      schema_version: 1,
      run_id: "composition-run",
      results: [null]
    } as unknown as RawAnalysisForComposition;
    const malformedResult = createCompositionProposals(
      malformed,
      manifest,
      compositionBrief({ target_duration_seconds: 1 }),
      storyGuidance(),
      1
    );
    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.issues[0]?.code).toBe("composition.analysis_invalid");

    manifest.clips[0] = {
      ...manifest.clips[0]!,
      in: 0.1234564,
      out: 1.1234564,
      duration: 1
    };
    const raw = rawAnalysis([
      sceneResult("scene-a", "clip-a", [
        observation("obs-a", 0.1234564, 1.1234564, "decimal scene", 0.9)
      ])
    ]);
    const brief = compositionBrief({ target_duration_seconds: 1 });
    const created = createCompositionProposals(raw, manifest, brief, storyGuidance(), 1);
    expect(created.ok).toBe(true);
    expect(verifyCompositionProposals(raw, manifest, brief, created.artifact, 1).ok).toBe(true);
    expect(compileComposition(
      manifest,
      created.artifact,
      created.artifact.proposals[0]!.id,
      created.artifact.analysis_digest
    ).ok).toBe(true);
  });

  it("atomically writes only composition-proposals.json and preserves source, manifest, and Gate state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-compose-project-"));
    const runDir = join(root, "composition-run");
    const analysisDir = join(runDir, "analysis");
    const configPath = join(root, "project.yaml");
    const manifestPath = join(root, "manifest.json");
    const sourcePath = join(root, "media", "clip-a.mp4");
    const statePath = join(runDir, "state.json");
    const manifest = manifestWithClips(["clip-a", "clip-b", "clip-c"], 2);
    const raw = rawAnalysis([
      sceneResult("scene-a", "clip-a", [observation("obs-a", 0, 2, "scene A", 0.9)]),
      cutResult("cuts-b", "clip-b"),
      cutResult("cuts-c", "clip-c")
    ]);
    raw.results[0]!.source.sha256 = createHash("sha256").update("immutable-source").digest("hex");
    raw.results[1]!.source.sha256 = createHash("sha256").update("clip-b").digest("hex");
    raw.results[2]!.source.sha256 = createHash("sha256").update("clip-c").digest("hex");
    await mkdir(analysisDir, { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(configPath, "slug: composition-fixture\n");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await writeFile(sourcePath, "immutable-source");
    await writeFile(join(root, "media", "clip-b.mp4"), "clip-b");
    await writeFile(join(root, "media", "clip-c.mp4"), "clip-c");
    await writeFile(statePath, '{"gates":{"gate_1":{"status":"pending"}}}\n');
    await writeFile(join(analysisDir, "raw-analysis.json"), `${JSON.stringify(raw)}\n`);
    const before = {
      config: await readFile(configPath, "utf8"),
      manifest: await readFile(manifestPath, "utf8"),
      source: await readFile(sourcePath, "utf8"),
      state: await readFile(statePath, "utf8")
    };

    const result = await composeProject(
      configPath,
      {
        slug: "composition-fixture",
        run_id: "composition-run",
        manifest: "manifest.json",
        dist_dir: "dist",
        composition: {
          brief: compositionBrief({ target_duration_seconds: 4 }),
          proposals: { max_count: 3 }
        }
      },
      manifest,
      root
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.proposalPath).toBe(join(analysisDir, "composition-proposals.json"));
    expect(result.proposalCount).toBeGreaterThanOrEqual(2);
    expect(result.proposalCount).toBeLessThanOrEqual(3);
    expect(JSON.parse(await readFile(result.proposalPath!, "utf8"))).toEqual(result.artifact);
    expect({
      config: await readFile(configPath, "utf8"),
      manifest: await readFile(manifestPath, "utf8"),
      source: await readFile(sourcePath, "utf8"),
      state: await readFile(statePath, "utf8")
    }).toEqual(before);

    await writeFile(join(analysisDir, "raw-analysis.json"), "null\n");
    const malformed = await composeProject(
      configPath,
      {
        slug: "composition-fixture",
        run_id: "composition-run",
        manifest: "manifest.json",
        dist_dir: "dist",
        composition: {
          brief: compositionBrief({ target_duration_seconds: 4 }),
          proposals: { max_count: 3 }
        }
      },
      manifest,
      root
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0]?.code).toBe("composition.analysis_invalid");
    await writeFile(join(analysisDir, "raw-analysis.json"), `${JSON.stringify(raw)}\n`);

    await writeFile(sourcePath, "changed-source");
    const stale = await composeProject(
      configPath,
      {
        slug: "composition-fixture",
        run_id: "composition-run",
        manifest: "manifest.json",
        dist_dir: "dist",
        composition: {
          brief: compositionBrief({ target_duration_seconds: 4 }),
          proposals: { max_count: 3 }
        }
      },
      manifest,
      root
    );
    expect(stale.ok).toBe(false);
    expect(stale.issues[0]?.code).toBe("composition.analysis_source_changed");
  });
});

function manifestWithClips(ids: string[], duration: number): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: ids.length * duration,
      slug: "composition-fixture"
    },
    clips: ids.map((id) => ({
      id,
      src: `media/${id}.mp4`,
      in: 0,
      out: duration,
      duration,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      audio: true
    })),
    images: [],
    speakers: [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  };
}

function rawAnalysis(
  results: RawAnalysisForComposition["results"]
): RawAnalysisForComposition {
  return {
    schema_version: 1,
    run_id: "composition-run",
    input_digest: "a".repeat(64),
    results
  };
}

function sceneResult(
  requestId: string,
  clipId: string,
  observations: Array<Record<string, unknown>>
): RawAnalysisForComposition["results"][number] {
  return {
    request_id: requestId,
    output: "scene_observations",
    source: { clip_id: clipId },
    data: { scene_observations: observations }
  };
}

function transcriptResult(
  requestId: string,
  clipId: string,
  segments: Array<Record<string, unknown>>
): RawAnalysisForComposition["results"][number] {
  return {
    request_id: requestId,
    output: "transcript",
    source: { clip_id: clipId },
    data: { language: "ja", segments }
  };
}

function cutResult(
  requestId: string,
  clipId: string
): RawAnalysisForComposition["results"][number] {
  return {
    request_id: requestId,
    output: "cut_points",
    source: { clip_id: clipId },
    data: { cut_points: [] }
  };
}

function observation(
  id: string,
  sourceStart: number,
  sourceEnd: number,
  description: string,
  confidence: number
): Record<string, unknown> {
  return {
    id,
    source_start: sourceStart,
    source_end: sourceEnd,
    description,
    selection_reasons: [`${description}を採用`],
    technical_notes: [],
    confidence,
    evidence: {}
  };
}

function compositionBrief(
  override: Partial<CompositionBrief> = {}
): CompositionBrief {
  return {
    goal: "初めての人へ活動を紹介する",
    audience: "Webサイト訪問者",
    target_duration_seconds: 6,
    priority: "chronological",
    required_clip_ids: [],
    excluded_clip_ids: [],
    ...override
  };
}

function storyGuidance(): CompositionStoryGuidance {
  return {
    primary: "hook-value-proof-cta",
    supporting: ["montage-association"],
    rejected: [{ id: "looped-short", reason: "今回の説明目的への寄与が弱い" }],
    duration_preset: {
      id: "under-30",
      max_seconds: 30,
      recommended_cuts: { min: 3, max: 8 },
      phases: [
        { range: "0-3", role: "hook" },
        { range: "3-20", role: "development" },
        { range: "20-30", role: "close" }
      ]
    },
    film_grammar: [
      { id: "motivated-cut", category: "editing", instruction: "意味の変化でカットする" }
    ]
  };
}
