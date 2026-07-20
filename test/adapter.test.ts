import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliGenerationAdapter } from "../src/adapters/cliGeneration.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { validateGenerationConstraints } from "../src/adapters/constraints.js";
import type { GenerationRequest } from "../src/project/schema.js";
import { loadProject } from "../src/project/loadProject.js";

describe("adapter contract", () => {
  it("loads a declared cli adapter contract", async () => {
    const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("cli");
    expect(adapter.class).toBe("generation");
    expect(adapter.dry_run_estimate).toBe(true);
    expect(adapter.retry.max_attempts).toBe(2);
  });

  it("loads a dedicated audio adapter capability contract", async () => {
    const adapter = await loadAdapterDefinition("mock-cli-audio", ["fixtures/adapters", "adapters"]);

    expect(adapter.class).toBe("audio");
    expect(adapter.audio_capabilities).toEqual({
      bgm_modes: ["generate", "retrieve"],
      sfx: true
    });
  });

  it("declares the real HyperFrames audio network boundary without ElevenLabs credentials", async () => {
    const adapter = await loadAdapterDefinition("hyperframes-media", ["adapters"]);

    expect(adapter.offline).toBe(false);
    expect(adapter.network).toMatchObject({
      input_scope: "request-metadata",
      timeout_ms: 3_600_000,
      credential_env: [],
      optional_credential_env: ["HEYGEN_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
    });
    expect(adapter.network?.optional_credential_env).not.toContain("ELEVENLABS_API_KEY");
  });

  it("loads vendor-neutral setup checks declared by a real adapter", async () => {
    const adapter = await loadAdapterDefinition("pixverse");

    expect(adapter.checks.setup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command",
          name: "provider:pixverse",
          command: ["pixverse", "--version"],
          capture_version: true
        })
      ])
    );
  });

  it("accepts generated clips copied into the run directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-adapter-run-"));
    const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);

    const result = runCliGenerationAdapter(adapter, [generationRequest("generated-001")], {
      runId: "adapter-safe-output",
      runDir
    });

    expect(result.ok).toBe(true);
    expect(result.clips?.[0]?.src).toMatch(new RegExp(`^${escapeRegExp(runDir)}[\\\\/]`));
  });

  it("accepts generated image and audio assets through the same media adapter contract", async () => {
    const harness = await outputHarness();
    const image = await writeRunFile(harness.runDir, "generated.png");
    const audio = await writeRunFile(harness.runDir, "generated.wav");
    const output = {
      request_id: "mixed-media",
      credits: 1,
      clips: [],
      images: [{ id: "generated-image", src: image }],
      audio: [{ id: "generated-voice", src: audio, role: "narration", start: 0 }],
      metadata: {}
    };
    const result = runOutputHarness(harness, [generationRequest("mixed-media", output)]);

    expect(result.ok).toBe(true);
    expect(result.images).toEqual([expect.objectContaining({ id: "generated-image", src: image })]);
    expect(result.audio).toEqual([expect.objectContaining({ id: "generated-voice", role: "narration", src: audio })]);
    expect(result.credits).toBe(1);
  });

  it("does not expose raw provider output when an adapter command fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-adapter-run-"));
    const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);
    const result = runCliGenerationAdapter(
      adapter,
      [
        {
          ...generationRequest("provider-failure"),
          params: { exit_code: 40, error_output: "https://provider.invalid/file?token=secret-token" }
        }
      ],
      { runId: "adapter-provider-failure", runDir }
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "run.adapter_exit.invalid_request",
      message: "adapter command failed"
    });
    expect(result.issues[0]?.message).not.toContain("secret-token");
  });

  it("rejects an adapter request_id that does not match the input request", async () => {
    const harness = await outputHarness();
    const src = await writeRunFile(harness.runDir, "mismatch.mp4");
    const result = runOutputHarness(harness, [
      generationRequest("expected", generatedOutput("different", [{ id: "safe-clip", src }]))
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_output_request_id_mismatch");
  });

  it("rejects unsafe and duplicate clip ids in one adapter response", async () => {
    const harness = await outputHarness();
    const src = await writeRunFile(harness.runDir, "duplicate.mp4");

    for (const clips of [
      [{ id: "../escape", src }],
      [
        { id: "duplicate-clip", src },
        { id: "duplicate-clip", src }
      ]
    ]) {
      const result = runOutputHarness(harness, [
        generationRequest("clip-contract", generatedOutput("clip-contract", clips))
      ]);

      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("run.adapter_output_schema");
    }
  });

  it("rejects duplicate clip ids across adapter responses", async () => {
    const harness = await outputHarness();
    const firstSrc = await writeRunFile(harness.runDir, "first.mp4");
    const secondSrc = await writeRunFile(harness.runDir, "second.mp4");
    const result = runOutputHarness(harness, [
      generationRequest("first", generatedOutput("first", [{ id: "same-clip", src: firstSrc }])),
      generationRequest("second", generatedOutput("second", [{ id: "same-clip", src: secondSrc }]))
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_output_clip_id_duplicate");
  });

  it.each(["missing", "directory"] as const)("rejects %s clip sources", async (kind) => {
    const harness = await outputHarness();
    const src = join(harness.runDir, kind === "missing" ? "missing.mp4" : "directory.mp4");
    if (kind === "directory") await mkdir(src);
    const result = runOutputHarness(harness, [
      generationRequest("invalid-src", generatedOutput("invalid-src", [{ id: "invalid-src-clip", src }]))
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_output_clip_src_invalid");
  });

  it("does not echo an invalid adapter clip source into public errors", async () => {
    const harness = await outputHarness();
    const src = join(harness.runDir, "signed-url-token=secret-token.mp4");
    const result = runOutputHarness(harness, [
      generationRequest("invalid-secret-src", generatedOutput("invalid-secret-src", [{ id: "secret-src", src }]))
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_output_clip_src_invalid");
    expect(result.issues[0]?.message).not.toContain("secret-token");
  });

  it("rejects clip sources outside runDir, including symlink escapes", async () => {
    const harness = await outputHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-adapter-outside-"));
    const outsideSrc = await writeRunFile(outsideDir, "outside.mp4");
    const symlinkSrc = join(harness.runDir, "symlink.mp4");
    await symlink(outsideSrc, symlinkSrc);

    for (const src of [outsideSrc, symlinkSrc]) {
      const result = runOutputHarness(harness, [
        generationRequest("outside-src", generatedOutput("outside-src", [{ id: "outside-src-clip", src }]))
      ]);

      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("run.adapter_output_clip_src_outside_run_dir");
    }
  });

  it("loads real cli generation adapters with command wrappers", async () => {
    const pixverse = await loadAdapterDefinition("pixverse", ["fixtures/adapters", "adapters"]);
    const kling = await loadAdapterDefinition("kling", ["fixtures/adapters", "adapters"]);

    expect(pixverse.command).toMatchObject({
      executable: "node",
      args: ["adapters/pixverse/generate.mjs"],
      input: "stdin-json"
    });
    expect(kling.command).toMatchObject({
      executable: "node",
      args: ["adapters/kling/generate.mjs"],
      input: "stdin-json"
    });
  });

  it("loads the executable Topview CLI generation adapter", async () => {
    const adapter = await loadAdapterDefinition("topview", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("cli");
    expect(adapter.class).toBe("generation");
    expect(adapter.dry_run_estimate).toBe(true);
    expect(adapter.command).toMatchObject({
      executable: "node",
      args: ["adapters/topview/generate.mjs"],
      input: "stdin-json"
    });
  });

  it("loads optional OpenClaw generation without requiring OpenClaw during validation", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/openclaw-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.adapter).toMatchObject({
      name: "openclaw",
      kind: "cli",
      class: "generation",
      dry_run_estimate: true,
      command: {
        executable: "node",
        args: ["adapters/openclaw/generate.mjs"],
        input: "stdin-json"
      }
    });
  });

  it("loads optional Hermes as an analysis handoff adapter", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/hermes-analysis.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.analysisAdapter).toMatchObject({
      name: "hermes",
      kind: "mcp-agent",
      class: "analysis",
      dry_run_estimate: false
    });
  });

  it("does not require optional adapters when a project does not select them", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/local-media-only.yaml", {
      adapterDirs: ["adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.adapter).toBeUndefined();
    expect(result.analysisAdapter).toBeUndefined();
  });

  it("loads a declared analysis adapter contract", async () => {
    const adapter = await loadAdapterDefinition("analysis-metadata", ["fixtures/adapters", "adapters"]);

    expect(adapter.kind).toBe("mcp-agent");
    expect(adapter.class).toBe("analysis");
    expect(adapter.dry_run_estimate).toBe(false);
  });

  it("applies adapter constraints before run", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");
    const result = await validateGenerationConstraints(project, ["fixtures/adapters", "adapters"]);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);

    const generation = project.generation!;
    const badProject = {
      ...project,
      generation: {
        adapter: generation.adapter,
        requests: [{ ...generation.requests[0], duration: 7 }]
      }
    };
    const badResult = await validateGenerationConstraints(badProject, ["fixtures/adapters", "adapters"]);

    expect(badResult.ok).toBe(false);
    expect(badResult.issues[0]?.code).toBe("adapter.constraint.duration-supported");
  });

  it("keeps declared prompt input mode aligned with execution parameters", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");
    const request = project.generation!.requests[0];
    const missingImage = {
      ...project,
      generation: {
        ...project.generation!,
        requests: [{ ...request, input_mode: "image-to-video" as const, params: {} }]
      }
    };
    const unexpectedImage = {
      ...project,
      generation: {
        ...project.generation!,
        requests: [
          {
            ...request,
            input_mode: "text-to-video" as const,
            params: { image: "references/shot.png" }
          }
        ]
      }
    };
    const wrongImageType = {
      ...project,
      generation: {
        ...project.generation!,
        requests: [
          {
            ...request,
            input_mode: "image-to-video" as const,
            params: { image: true }
          }
        ]
      }
    };

    const missingResult = await validateGenerationConstraints(missingImage, ["fixtures/adapters", "adapters"]);
    const unexpectedResult = await validateGenerationConstraints(unexpectedImage, ["fixtures/adapters", "adapters"]);
    const wrongTypeResult = await validateGenerationConstraints(wrongImageType, ["fixtures/adapters", "adapters"]);

    expect(missingResult.issues[0]?.code).toBe("adapter.input_mode.required_param");
    expect(unexpectedResult.issues[0]?.code).toBe("adapter.input_mode.forbidden_param");
    expect(wrongTypeResult.issues[0]?.code).toBe("adapter.input_mode.param_type");
  });

  it("accepts Topview image-to-video and requires first_frame", async () => {
    const project = await loadProject("fixtures/projects/topview-generation.yaml");
    const supported = {
      ...project,
      generation: {
        ...project.generation!,
        requests: project.generation!.requests.map((request) => ({
          ...request,
          mode: "image-to-video" as const,
          first_frame: "../media/character.svg"
        }))
      }
    };
    const missing = {
      ...supported,
      generation: {
        ...supported.generation,
        requests: supported.generation.requests.map(({ first_frame: _firstFrame, ...request }) => request)
      }
    };

    const supportedResult = await validateGenerationConstraints(supported, ["fixtures/adapters", "adapters"]);
    const missingResult = await validateGenerationConstraints(missing, ["fixtures/adapters", "adapters"]);

    expect(supportedResult.ok).toBe(true);
    expect(missingResult.issues[0]?.code).toBe("adapter.input_mode.required_field");
  });

  it("applies multiple adapter constraints and skips optional missing fields", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");
    const generation = project.generation!;
    const validWithoutSeed = {
      ...project,
      generation: {
        adapter: "kling",
        requests: [
          {
            ...generation.requests[0],
            duration: 5,
            aspect: "16:9" as const,
            seed: undefined
          }
        ]
      }
    };
    const invalid = {
      ...project,
      generation: {
        adapter: "kling",
        requests: [
          {
            ...generation.requests[0],
            duration: 4,
            aspect: "1:1",
            seed: -1
          }
        ]
      }
    };

    const validResult = await validateGenerationConstraints(validWithoutSeed, ["fixtures/adapters", "adapters"]);
    const invalidResult = await validateGenerationConstraints(invalid as typeof project, ["fixtures/adapters", "adapters"]);

    expect(validResult.ok).toBe(true);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "adapter.constraint.duration-supported",
        "adapter.constraint.aspect-supported",
        "adapter.constraint.seed-min"
      ])
    );
  });

  it("rejects analysis adapters in generation slots", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/generation-analysis-adapter.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.class_mismatch");
  });

  it("accepts analysis adapters in analysis slots", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/analysis-metadata.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.analysisAdapter?.kind).toBe("mcp-agent");
    expect(result.analysisAdapter?.class).toBe("analysis");
  });

  it("requires mcp-agent adapters to include a skill definition", async () => {
    await expect(loadAdapterDefinition("no-skill-agent", ["fixtures/adapters", "adapters"])).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "adapter.skill_md_missing"
        })
      ])
    });
  });

  it("rejects adapters that cannot provide dry-run estimates", async () => {
    const { validateProject } = await import("../src/project/validateProject.js");
    const result = await validateProject("fixtures/projects/no-dry-adapter.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("adapter.dry_run_unsupported");
  });
});

type OutputHarness = {
  adapter: Awaited<ReturnType<typeof loadAdapterDefinition>>;
  runDir: string;
};

async function outputHarness(): Promise<OutputHarness> {
  const adapter = await loadAdapterDefinition("mock-cli", ["fixtures/adapters", "adapters"]);
  return {
    adapter: {
      ...adapter,
      command: {
        ...adapter.command!,
        args: ["fixtures/adapters/mock-cli/output-from-params.mjs"]
      }
    },
    runDir: await mkdtemp(join(tmpdir(), "tsugite-adapter-contract-"))
  };
}

function runOutputHarness(harness: OutputHarness, requests: GenerationRequest[]) {
  return runCliGenerationAdapter(harness.adapter, requests, {
    runId: "adapter-output-contract",
    runDir: harness.runDir
  });
}

function generationRequest(id: string, output?: unknown): GenerationRequest {
  return {
    id,
    prompt: "fixture prompt",
    model: "fixture-model",
    duration: 1,
    aspect: "16:9",
    params: output === undefined ? {} : { output }
  };
}

function generatedOutput(requestId: string, clips: Array<{ id: string; src: string }>) {
  return {
    request_id: requestId,
    credits: 0,
    clips: clips.map((clip) => ({
      ...clip,
      duration: 1,
      fps: 30,
      resolution: {
        width: 320,
        height: 180
      },
      audio: false
    })),
    metadata: {}
  };
}

async function writeRunFile(directory: string, name: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, "fixture media");
  return path;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
