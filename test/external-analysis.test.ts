import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/orchestrator/analyze.js";
import { createPlan } from "../src/orchestrator/plan.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { projectSchema } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

const adapterDirs = ["fixtures/adapters", "adapters"];

describe("optional external analysis", () => {
  it("keeps local mode as the backwards-compatible default and rejects online adapters", async () => {
    const parsed = projectSchema.parse({
      slug: "local-default",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      analysis: { adapter: "local", requests: [{ id: "t", output: "transcript" }] }
    });
    expect(parsed.analysis?.mode).toBe("local");

    const validation = await validateProject("fixtures/projects/local-with-online-analysis.yaml", { adapterDirs });
    expect(validation.ok).toBe(false);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: "analysis.online_adapter_forbidden" }));
  });

  it("rejects credentials embedded in external analysis request params", () => {
    const parsed = projectSchema.safeParse({
      slug: "unsafe-external-params",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      analysis: {
        mode: "cloud",
        adapter: "external",
        requests: [{ id: "summary", output: "summary", params: { api_key: "do-not-store-here" } }]
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("environment variables");
  });

  it("rejects runtime injection variables in an online adapter credential allowlist", async () => {
    await expect(loadAdapterDefinition("mock-cli-dangerous-env", adapterDirs)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "adapter.schema" })]
    });
  });

  it("validates hybrid cross-adapter refinement and exposes its transfer scope in the plan", async () => {
    const validation = await validateProject("fixtures/projects/hybrid-analysis.yaml", { adapterDirs });
    expect(validation.ok).toBe(true);

    const plan = createPlan(
      validation.project!,
      validation.manifest!,
      validation.adapter,
      validation.analysisAdapters
    );
    expect(plan.analysis).toMatchObject({
      mode: "hybrid",
      external_permission_required: true,
      max_estimated_credits: 0.25,
      transfers: [{
        request_id: "transcript-refined",
        adapter: "mock-cli-external-refinement",
        input_scope: "low-confidence-segments",
        credential_env: ["TSUGITE_TEST_ANALYSIS_TOKEN"]
      }]
    });
    expect(plan.estimated_credits).toBe(0.25);
  });

  it("requires execution-time permission before any external adapter can run", async () => {
    const validation = await validateProject("fixtures/projects/hybrid-analysis.yaml", { adapterDirs });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-hybrid-denied-"));
    const result = await analyzeProject(
      "fixtures/projects/hybrid-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      stateDir
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.external_permission_required");
  });

  it("sends only low-confidence segments in hybrid mode and forwards only declared credentials", async () => {
    const validation = await validateProject("fixtures/projects/hybrid-analysis.yaml", { adapterDirs });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-hybrid-allowed-"));
    const credential = "do-not-persist-this-value";
    const result = await analyzeProject(
      "fixtures/projects/hybrid-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      stateDir,
      {
        allowExternalAnalysis: true,
        environment: {
          ...process.env,
          TSUGITE_TEST_ANALYSIS_TOKEN: credential,
          TSUGITE_UNDECLARED_SECRET: "must-not-be-forwarded"
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ actualCredits: 0.25, apiUsed: true, networkUsed: true });
    const text = await readFile(result.analysisPath!, "utf8");
    expect(text).not.toContain(credential);
    expect(text).not.toContain("must-not-be-forwarded");
    const artifact = JSON.parse(text);
    expect(artifact.external_transfers).toEqual([{
      request_id: "transcript-refined",
      adapter: "mock-cli-external-refinement",
      input_scope: "low-confidence-segments",
      source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      segment_ids: ["segment-low"],
      dependency_ids: []
    }]);
    const refined = artifact.results.find((entry: { request_id: string }) => entry.request_id === "transcript-refined");
    expect(refined.data.segments.map((segment: { id: string }) => segment.id)).toEqual(["segment-low", "segment-high"]);
    expect(refined.data.segments[0]).toMatchObject({ text: "えっと こんにちは", confidence: 0.98 });
    expect(refined.metadata).toMatchObject({
      received_segment_ids: ["segment-low"],
      source_path_received: false,
      dependency_count: 0,
      credential_present: true,
      undeclared_secret_present: false
    });
  });

  it("allows full selected source media only in cloud mode with explicit permission", async () => {
    const validation = await validateProject("fixtures/projects/cloud-analysis.yaml", { adapterDirs });
    expect(validation.ok).toBe(true);
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-cloud-allowed-"));
    const result = await analyzeProject(
      "fixtures/projects/cloud-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      stateDir,
      {
        allowExternalAnalysis: true,
        environment: { ...process.env, TSUGITE_TEST_ANALYSIS_TOKEN: "cloud-test-token" }
      }
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ actualCredits: 0.5, apiUsed: true, networkUsed: true });
    const artifact = JSON.parse(await readFile(result.analysisPath!, "utf8"));
    expect(artifact.results[0].metadata).toMatchObject({
      input_scope: "source-media",
      source_path_received: true,
      credential_present: true
    });
    expect(artifact.external_transfers[0]).toMatchObject({
      request_id: "summary-cloud",
      input_scope: "source-media",
      segment_ids: []
    });
  });

  it("can explicitly include dependency outputs for cloud translated subtitles", async () => {
    const validation = await validateProject("fixtures/projects/cloud-translation-analysis.yaml", { adapterDirs });
    expect(validation.ok).toBe(true);
    const result = await analyzeProject(
      "fixtures/projects/cloud-translation-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      await mkdtemp(join(tmpdir(), "tsugite-cloud-translation-")),
      {
        allowExternalAnalysis: true,
        environment: { ...process.env, TSUGITE_TEST_ANALYSIS_TOKEN: "translation-test-token" }
      }
    );

    expect(result.ok).toBe(true);
    const artifact = JSON.parse(await readFile(result.analysisPath!, "utf8"));
    const subtitles = artifact.results.find((entry: { request_id: string }) => entry.request_id === "subtitles-cloud");
    expect(subtitles.data).toMatchObject({
      source_language: "ja",
      target_language: "en",
      captions: [expect.objectContaining({ source_segment_id: "segment-low", text: "Hello" })]
    });
    expect(subtitles.metadata).toMatchObject({
      input_scope: "source-media-and-dependencies",
      source_path_received: true,
      dependency_count: 1,
      credential_present: true
    });
    expect(artifact.external_transfers[0]).toMatchObject({
      request_id: "subtitles-cloud",
      input_scope: "source-media-and-dependencies",
      dependency_ids: ["transcript-local"]
    });
  });

  it("fails before spawn when a declared credential is missing", async () => {
    const validation = await validateProject("fixtures/projects/cloud-analysis.yaml", { adapterDirs });
    const result = await analyzeProject(
      "fixtures/projects/cloud-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      undefined,
      {
        allowExternalAnalysis: true,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME }
      }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "analysis.credential_missing",
      path: "TSUGITE_TEST_ANALYSIS_TOKEN"
    });
  });

  it("keeps the local transcript without a network call when no segment is below the threshold", async () => {
    const validation = await validateProject("fixtures/projects/hybrid-analysis.yaml", { adapterDirs });
    validation.project!.analysis!.confidence_threshold = 0.1;
    const result = await analyzeProject(
      "fixtures/projects/hybrid-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      await mkdtemp(join(tmpdir(), "tsugite-hybrid-noop-")),
      {
        allowExternalAnalysis: true,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME }
      }
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ actualCredits: 0, apiUsed: false, networkUsed: false });
    const artifact = JSON.parse(await readFile(result.analysisPath!, "utf8"));
    expect(artifact.external_transfers).toEqual([]);
    expect(artifact.results[1]).toMatchObject({
      request_id: "transcript-refined",
      attempts: 0,
      metadata: { engine: "hybrid-local-passthrough", api_used: false, network_used: false }
    });
    expect(artifact.results[1].data.segments).toHaveLength(2);
  });

  it("rejects an adapter response that echoes a declared credential", async () => {
    const validation = await validateProject("fixtures/projects/hybrid-analysis.yaml", { adapterDirs });
    validation.project!.analysis!.requests[1]!.params.echo_credential = true;
    const result = await analyzeProject(
      "fixtures/projects/hybrid-analysis.yaml",
      validation.project!,
      validation.manifest!,
      validation.analysisAdapters,
      await mkdtemp(join(tmpdir(), "tsugite-hybrid-secret-")),
      {
        allowExternalAnalysis: true,
        environment: { ...process.env, TSUGITE_TEST_ANALYSIS_TOKEN: "echo-detection-token" }
      }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.adapter_output_secret_detected");
    expect(result.issues[0]?.message).not.toContain("echo-detection-token");
  });
});
