import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analysisAdapterOutputSchema, runCliAnalysisAdapter } from "../src/adapters/cliAnalysis.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { readJsonFile } from "../src/io.js";
import type { Manifest } from "../src/manifest/schema.js";
import type { AnalysisRequest } from "../src/project/schema.js";
import { projectSchema } from "../src/project/schema.js";

describe("CLI analysis adapter", () => {
  it("returns source-timestamp cut candidates without API or network usage", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-run-"));

    process.env.TSUGITE_TEST_SECRET = "must-not-reach-adapter";
    const result = runCliAnalysisAdapter(adapter, [request()], manifest, {
      runId: "analysis-fixture",
      runDir,
      manifestDir: dirname(manifestPath)
    });
    delete process.env.TSUGITE_TEST_SECRET;

    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({
      request_id: "silence-scan",
      output: "cut_points",
      data: {
        cut_points: [
          {
            kind: "silence",
            source_start: 0.25,
            source_end: 0.75,
            action: "review"
          }
        ]
      },
      metadata: { api_used: false, network_used: false }
    });
    expect(result.results?.[0]?.metadata.received_test_secret).toBeNull();
  });

  it("accepts an existing manifest clip id without imposing request-id syntax on it", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const original = (await readJsonFile(manifestPath)) as Manifest;
    const manifest = {
      ...original,
      clips: [{ ...original.clips[0]!, id: "講演 メイン" }]
    };
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-source-id-"));

    const result = runCliAnalysisAdapter(
      adapter,
      [{ ...request(), source_clip_id: "講演 メイン" }],
      manifest,
      { runId: "analysis-source-id", runDir, manifestDir: dirname(manifestPath) }
    );

    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.source.clip_id).toBe("講演 メイン");
  });

  it("accepts the additive analysis request outputs, adapter, and dependency contract", () => {
    const parsed = projectSchema.safeParse({
      slug: "analysis-contract",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      analysis: {
        adapter: "mock-cli-analysis",
        requests: [
          { id: "transcript-ja", adapter: "mock-cli-analysis", output: "transcript" },
          { id: "summary-ja", output: "summary", depends_on: ["transcript-ja"] },
          { id: "subtitles-en", output: "subtitle_track", depends_on: ["transcript-ja"] }
        ]
      }
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.analysis?.requests[0]).toMatchObject({ adapter: "mock-cli-analysis", depends_on: [] });
    }
  });

  it("accepts scene observations and similarity groups with auditable evidence", () => {
    const sceneResult = analysisAdapterOutputSchema.safeParse(contractOutput("scene_observations", {
      scene_observations: [{
        id: "scene-001",
        source_start: 0,
        source_end: 1,
        description: "Opening scene",
        technical_notes: ["Static camera"],
        selection_reasons: ["Clear establishing view"],
        confidence: 0.8,
        evidence: {
          representative_frame: "analysis/representative-frames/scene-001.jpg",
          timestamp_seconds: 0.5
        }
      }]
    }));
    const similarityResult = analysisAdapterOutputSchema.safeParse(contractOutput("similarity_groups", {
      similarity_groups: [{
        id: "similar-001",
        member_observation_ids: ["scene-001", "scene-002"],
        reason: "Same location and framing"
      }]
    }));

    expect(sceneResult.success).toBe(true);
    expect(similarityResult.success).toBe(true);
  });

  it.each([
    [
      "duplicate scene observation ids",
      "scene_observations",
      {
        scene_observations: [
          sceneObservation({ id: "duplicate", source_start: 0, source_end: 0.4 }),
          sceneObservation({ id: "duplicate", source_start: 0.5, source_end: 1 })
        ]
      }
    ],
    [
      "invalid scene confidence",
      "scene_observations",
      { scene_observations: [sceneObservation({ confidence: 1.1 })] }
    ],
    [
      "evidence timestamp outside the scene",
      "scene_observations",
      { scene_observations: [sceneObservation({ evidence: { timestamp_seconds: 1.1 } })] }
    ],
    [
      "unsafe representative frame traversal",
      "scene_observations",
      { scene_observations: [sceneObservation({ evidence: { representative_frame: "../frame.jpg" } })] }
    ],
    [
      "unsafe absolute representative frame",
      "scene_observations",
      { scene_observations: [sceneObservation({ evidence: { representative_frame: "/tmp/frame.jpg" } })] }
    ],
    [
      "unsafe Windows drive-relative representative frame",
      "scene_observations",
      { scene_observations: [sceneObservation({ evidence: { representative_frame: "C:frame.jpg" } })] }
    ],
    [
      "similarity group with fewer than two members",
      "similarity_groups",
      {
        similarity_groups: [{
          id: "similar-001",
          member_observation_ids: ["scene-001"],
          reason: "Insufficient group"
        }]
      }
    ],
    [
      "duplicate similarity group members",
      "similarity_groups",
      {
        similarity_groups: [{
          id: "similar-001",
          member_observation_ids: ["scene-001", "scene-001"],
          reason: "Duplicate member"
        }]
      }
    ],
    [
      "duplicate similarity group ids",
      "similarity_groups",
      {
        similarity_groups: [
          {
            id: "similar-001",
            member_observation_ids: ["scene-001", "scene-002"],
            reason: "First"
          },
          {
            id: "similar-001",
            member_observation_ids: ["scene-003", "scene-004"],
            reason: "Second"
          }
        ]
      }
    ]
  ])("rejects %s", (_label, output, data) => {
    expect(analysisAdapterOutputSchema.safeParse(contractOutput(output, data)).success).toBe(false);
  });

  it("rejects scene observations outside the selected source range", async () => {
    const loaded = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const adapter = { ...loaded, outputs: [...(loaded.outputs ?? []), "scene_observations"] };
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-scene-range-"));
    const result = runCliAnalysisAdapter(
      adapter,
      [{
        id: "scene-scan",
        output: "scene_observations",
        source_clip_id: "render-001",
        depends_on: [],
        params: {
          output_override: {
            output: "scene_observations",
            data: {
              scene_observations: [sceneObservation({
                id: "outside",
                source_start: 0,
                source_end: manifest.clips[0]!.out + 1
              })]
            }
          }
        }
      }] as unknown as AnalysisRequest[],
      manifest,
      { runId: "analysis-scene-range", runDir, manifestDir: dirname(manifestPath) }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.adapter_output_timestamp_out_of_range");
  });

  it("passes validated dependency results to later adapter requests", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-dependencies-"));
    const requests = [
      { id: "transcript-ja", output: "transcript", source_clip_id: "render-001", params: {}, depends_on: [] },
      {
        id: "summary-ja",
        output: "summary",
        source_clip_id: "render-001",
        params: {},
        depends_on: ["transcript-ja"]
      },
      {
        id: "subtitles-en",
        output: "subtitle_track",
        source_clip_id: "render-001",
        params: {},
        depends_on: ["transcript-ja"]
      }
    ] as unknown as AnalysisRequest[];

    const result = runCliAnalysisAdapter(adapter, requests, manifest, {
      runId: "analysis-dependencies",
      runDir,
      manifestDir: dirname(manifestPath)
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[1]).toMatchObject({ output: "summary", data: { language: "ja" } });
    expect(result.results?.[2]?.metadata.input_request_ids).toEqual(["transcript-ja"]);
  });

  it.each([
    [
      "unknown dependency",
      [{ id: "summary", output: "summary", source_clip_id: "render-001", params: {}, depends_on: ["missing"] }],
      "analysis.dependency_not_found"
    ],
    [
      "dependency cycle",
      [
        { id: "first", output: "summary", source_clip_id: "render-001", params: {}, depends_on: ["second"] },
        { id: "second", output: "summary", source_clip_id: "render-001", params: {}, depends_on: ["first"] }
      ],
      "analysis.dependency_cycle"
    ]
  ])("rejects a runtime %s before invoking the adapter", async (_label, requests, code) => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-runtime-graph-"));

    const result = runCliAnalysisAdapter(adapter, requests as unknown as AnalysisRequest[], manifest, {
      runId: "analysis-runtime-graph",
      runDir,
      manifestDir: dirname(manifestPath)
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects dependencies that resolve to a different source clip", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const original = (await readJsonFile(manifestPath)) as Manifest;
    const manifest = {
      ...original,
      clips: [original.clips[0]!, { ...original.clips[0]!, id: "render-002" }]
    };
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-source-dependency-"));
    const requests = [
      { id: "transcript-ja", output: "transcript", source_clip_id: "render-001", params: {}, depends_on: [] },
      { id: "summary-ja", output: "summary", source_clip_id: "render-002", params: {}, depends_on: ["transcript-ja"] }
    ] as unknown as AnalysisRequest[];

    const result = runCliAnalysisAdapter(adapter, requests, manifest, {
      runId: "analysis-source-dependency",
      runDir,
      manifestDir: dirname(manifestPath)
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.dependency_source_mismatch");
  });

  it.each([
    [
      "word outside its transcript segment",
      {
        output: "transcript",
        data: {
          language: "ja",
          segments: [{
            id: "segment-001",
            source_start: 0.1,
            source_end: 0.5,
            text: "bad",
            words: [{ text: "bad", source_start: 0.2, source_end: 0.8 }]
          }]
        }
      },
      "analysis.adapter_output_schema"
    ],
    [
      "out-of-order transcript segments",
      {
        output: "transcript",
        data: {
          language: "ja",
          segments: [
            { id: "segment-002", source_start: 0.5, source_end: 0.9, text: "later" },
            { id: "segment-001", source_start: 0.1, source_end: 0.4, text: "earlier" }
          ]
        }
      },
      "analysis.adapter_output_schema"
    ],
    [
      "duplicate transcript segment ids",
      {
        output: "transcript",
        data: {
          language: "ja",
          segments: [
            { id: "segment-001", source_start: 0.1, source_end: 0.4, text: "first" },
            { id: "segment-001", source_start: 0.5, source_end: 0.9, text: "second" }
          ]
        }
      },
      "analysis.adapter_output_schema"
    ],
    [
      "pre-approved raw cut",
      {
        data: {
          cut_points: [{ id: "bad", kind: "filler", source_start: 0.2, source_end: 0.4, action: "remove" }]
        }
      },
      "analysis.adapter_output_schema"
    ]
  ])("rejects %s", async (_label, override, code) => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-rich-invalid-"));
    const output = "output" in override && typeof override.output === "string" ? override.output : "cut_points";
    const result = runCliAnalysisAdapter(
      adapter,
      [{ id: "rich-invalid", output, source_clip_id: "render-001", params: { output_override: override } }] as unknown as AnalysisRequest[],
      manifest,
      { runId: "analysis-rich-invalid", runDir, manifestDir: dirname(manifestPath) }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects a subtitle that references an unknown transcript segment", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-translation-reference-"));
    const requests = [
      { id: "transcript-ja", output: "transcript", source_clip_id: "render-001", params: {}, depends_on: [] },
      {
        id: "subtitles-en",
        output: "subtitle_track",
        source_clip_id: "render-001",
        depends_on: ["transcript-ja"],
        params: {
          output_override: {
            output: "subtitle_track",
            data: {
              source_language: "ja",
              target_language: "en",
              captions: [{
                id: "subtitle-001",
                source_segment_id: "missing-segment",
                source_start: 0.1,
                source_end: 0.9,
                text: "Hello"
              }]
            }
          }
        }
      }
    ] as unknown as AnalysisRequest[];

    const result = runCliAnalysisAdapter(adapter, requests, manifest, {
      runId: "analysis-translation-reference",
      runDir,
      manifestDir: dirname(manifestPath)
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.adapter_output_translation_reference_missing");
  });

  it.each([
    ["request mismatch", { request_id: "other" }, "analysis.adapter_output_request_id_mismatch"],
    [
      "output mismatch",
      { output: "chapters", data: { chapters: [] } },
      "analysis.adapter_output_type_mismatch"
    ],
    [
      "reversed source range",
      { data: { cut_points: [{ id: "bad", kind: "silence", source_start: 0.8, source_end: 0.2, action: "review" }] } },
      "analysis.adapter_output_schema"
    ],
    [
      "out-of-range timestamp",
      { data: { cut_points: [{ id: "bad", kind: "silence", source_start: 0.8, source_end: 2, action: "review" }] } },
      "analysis.adapter_output_timestamp_out_of_range"
    ],
    ["network usage", { metadata: { engine: "bad", api_used: false, network_used: true } }, "analysis.adapter_network_used"]
  ])("rejects %s", async (_label, override, code) => {
    const adapter = await loadAdapterDefinition("mock-cli-analysis", ["fixtures/adapters", "adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-analysis-invalid-"));
    const base = fixtureOutput(manifest);

    const result = runCliAnalysisAdapter(
      adapter,
      [request({ output_override: deepMerge(base, override) })],
      manifest,
      { runId: "analysis-invalid", runDir, manifestDir: dirname(manifestPath) }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });
});

function request(params: Record<string, unknown> = {}): AnalysisRequest {
  return {
    id: "silence-scan",
    output: "cut_points",
    source_clip_id: "render-001",
    params
  };
}

function fixtureOutput(manifest: Manifest): Record<string, unknown> {
  return {
    schema_version: 1,
    request_id: "silence-scan",
    output: "cut_points",
    source: {
      clip_id: "render-001",
      duration_seconds: manifest.clips[0]!.duration,
      sha256: "ignored-by-fixture-merge"
    },
    data: {
      cut_points: [
        {
          id: "silence-001",
          kind: "silence",
          source_start: 0.25,
          source_end: 0.75,
          action: "review",
          confidence: 1
        }
      ]
    },
    metadata: { engine: "fixture-local-analysis", api_used: false, network_used: false }
  };
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base, ...override };
  for (const key of ["source", "data", "metadata"]) {
    if (isRecord(base[key]) && isRecord(override[key])) merged[key] = { ...base[key], ...override[key] };
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contractOutput(output: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    request_id: "contract-test",
    output,
    source: {
      clip_id: "source-001",
      analysis_start_seconds: 0,
      analysis_end_seconds: 1,
      duration_seconds: 1,
      sha256: "a".repeat(64)
    },
    data,
    metadata: {
      engine: "contract-fixture",
      api_used: false,
      network_used: false
    }
  };
}

function sceneObservation(
  override: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = {
    id: "scene-001",
    source_start: 0,
    source_end: 1,
    description: "Scene",
    technical_notes: [],
    selection_reasons: [],
    confidence: 0.5,
    evidence: {}
  };
  return {
    ...base,
    ...override,
    evidence: {
      ...base.evidence,
      ...(isRecord(override.evidence) ? override.evidence : {})
    }
  };
}
