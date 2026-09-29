import { copyFile, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ElevenV4Error, generateElevenV4, selectElevenV4SpeechTool, validateElevenV4Request } from "../adapters/elevenlabs-v4/client.mjs";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { resolveGenerationConnection } from "../src/connections/registry.js";
import { createPlan } from "../src/orchestrator/plan.js";
import { createReviewDocument, renderReviewHtml } from "../src/orchestrator/review.js";
import { manifestSchema } from "../src/manifest/schema.js";

const request = {
  id: "opening-voice",
  operation: "voice",
  output_kind: "audio",
  audio_role: "narration",
  model: "eleven_v4_turbo",
  prompt: "[softly] ものづくりの旅が始まります。",
  params: { voice_id: "mP74e7DoGAGQYxAmpTm8" }
};
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

function speechTool(modelEnum = ["eleven_v4", "eleven_v4_turbo"]) {
  return {
    name: "text_to_speech",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        voice_id: { type: "string" },
        model_id: { type: "string", enum: modelEnum }
      },
      required: ["text", "voice_id"]
    }
  };
}

function mockClient() {
  return {
    listTools: vi.fn(async () => ({ tools: [speechTool()] })),
    callTool: vi.fn(async () => ({
      content: [{ type: "audio", mimeType: "audio/mpeg", data: mp3.toString("base64") }]
    }))
  };
}

describe("ElevenLabs Eleven v4 generation", () => {
  it("registers the v4 and Turbo MCP connection and declares the prompt transfer", async () => {
    const adapter = await loadAdapterDefinition("elevenlabs-v4");
    const connection = await resolveGenerationConnection("elevenlabs", undefined, {
      models: ["eleven_v4_turbo"], capabilities: ["audio.text-to-speech"]
    });
    expect(connection).toMatchObject({
      adapter: "elevenlabs-v4", transport: "mcp", execution_mode: "pipeline-adapter"
    });
    expect(await resolveGenerationConnection("elevenlabs", undefined, {
      models: ["eleven_v4"], capabilities: ["audio.text-to-speech"]
    })).toMatchObject({ adapter: "elevenlabs-v4" });
    expect(await resolveGenerationConnection("elevenlabs", undefined, {
      models: ["eleven_v3"], capabilities: ["audio.text-to-speech"]
    })).toBeUndefined();
    expect(adapter.network).toMatchObject({
      input_scope: "request-metadata", credential_env: ["ELEVENLABS_MCP_ACCESS_TOKEN"]
    });
    const manifest = manifestSchema.parse(JSON.parse(await readFile("examples/quickstart-local/manifest.json", "utf8")));
    const project = {
      slug: "v4-test", run_id: "v4-test-run", edit: { backend: "remotion" },
      generation: { connection: "elevenlabs", adapter: "elevenlabs-v4", requests: [request] }
    };
    const plan = createPlan(project, manifest, adapter, undefined, [], undefined, connection);
    expect(plan.agent_handoffs[0]).toMatchObject({
      execution: "pipeline-mcp",
      transfer: { input_scope: "request-metadata", credential_env: ["ELEVENLABS_MCP_ACCESS_TOKEN"] }
    });
    const review = createReviewDocument(project, manifest, plan);
    expect(review.generation_audio_requests).toEqual([expect.objectContaining({
      id: request.id, prompt: request.prompt, voice_id: request.params.voice_id
    })]);
    const html = renderReviewHtml(review);
    expect(html).toContain('data-testid="generation-audio-review"');
    expect(html).toContain(request.params.voice_id);
    expect(html).toContain(request.prompt);
  });

  it("validates, plans, preflights, and dry-runs an isolated project without MCP calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-project-"));
    await mkdir(join(root, "media"));
    await copyFile("examples/quickstart-local/manifest.json", join(root, "manifest.json"));
    await copyFile("examples/quickstart-local/media/clip-001.mp4", join(root, "media", "clip-001.mp4"));
    await copyFile("examples/quickstart-local/media/clip-002.mp4", join(root, "media", "clip-002.mp4"));
    const config = join(root, "project.yaml");
    await writeFile(config, `slug: eleven-v4-fixture\nname: Eleven v4 fixture\nrun_id: eleven-v4-fixture-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\ngeneration:\n  connection: elevenlabs\n  requests:\n    - id: opening-voice\n      operation: voice\n      output_kind: audio\n      audio_role: narration\n      model: eleven_v4_turbo\n      prompt: ものづくりの旅が始まります。\n      params:\n        voice_id: mP74e7DoGAGQYxAmpTm8\n`);
    const env = { ...process.env, ELEVENLABS_MCP_ACCESS_TOKEN: "fixture-token" };
    for (const args of [
      ["validate"], ["plan"], ["models"], ["review"], ["run", "--dry-run"]
    ]) {
      const result = spawnSync(process.execPath, ["bin/pipeline", ...args, "--config", config, "--json"], {
        encoding: "utf8", env, timeout: 30_000
      });
      expect(result.status, `${args[0]}: ${result.stderr} ${result.stdout}`).toBe(0);
      expect(result.stdout).not.toContain("fixture-token");
      if (args[0] === "models") {
        expect(result.stdout).toContain("provider-validation-required");
      }
      if (args[0] === "run") {
        expect(result.stdout).toContain('"executed": false');
      }
    }
    const reviewHtml = await readFile(join(root, "dist", "eleven-v4-fixture-run", "review", "index.html"), "utf8");
    expect(reviewHtml).toContain('data-testid="generation-audio-review"');
    expect(reviewHtml).toContain("mP74e7DoGAGQYxAmpTm8");
  }, 30_000);

  it("preflights locally without submitting or charging", () => {
    const result = spawnSync(process.execPath, ["adapters/elevenlabs-v4/preflight.mjs"], {
      input: JSON.stringify({ request }), encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      request_id: request.id, status: "provider-validation-required", model: "eleven_v4_turbo"
    });
  });

  it("calls the discovered MCP speech tool once and pins narration inside the run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    const result = await generateElevenV4({ request, run_dir: runDir }, { client });
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool.mock.calls[0][0]).toEqual({
      name: "text_to_speech",
      arguments: { text: request.prompt, voice_id: request.params.voice_id, model_id: "eleven_v4_turbo" }
    });
    expect(result.audio[0]).toMatchObject({ id: request.id, role: "narration", start: 0 });
    expect(result.audio[0].src.startsWith(await realpath(runDir))).toBe(true);
    expect(await readFile(result.audio[0].src)).toEqual(mp3);
    expect(result.metadata.transport).toBe("mcp");
  });

  it("rejects unsupported requests before contacting ElevenLabs", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    for (const changed of [
      { model: "eleven_v3" },
      { model: undefined },
      { operation: "music" },
      { prompt: "x".repeat(2_001) },
      { params: { voice_id: request.params.voice_id, output_format: "wav_44100" } },
      { input_audios: ["private.wav"] }
    ]) {
      await expect(generateElevenV4({ request: { ...request, ...changed }, run_dir: runDir }, {
        client
      })).rejects.toBeInstanceOf(ElevenV4Error);
    }
    expect(client.callTool).not.toHaveBeenCalled();
    expect(() => validateElevenV4Request({ ...request, params: {} })).toThrow("voice_id_required");
  });

  it("fails closed on missing credentials and uncertain MCP submissions without retry", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const connectMcp = vi.fn();
    await expect(generateElevenV4({ request, run_dir: runDir }, {
      connectMcp, environment: { ELEVENLABS_MCP_ACCESS_TOKEN: "" }
    })).rejects.toMatchObject({ code: "credential_missing" });
    expect(connectMcp).not.toHaveBeenCalled();
    const client = mockClient();
    client.callTool.mockRejectedValue(new Error("secret provider response"));
    await expect(generateElevenV4({ request, run_dir: runDir }, {
      client
    })).rejects.toMatchObject({ code: "mcp_outcome_unknown" });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirected output directory before the paid request", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-outside-"));
    await mkdir(join(runDir, "assets"));
    await symlink(outside, join(runDir, "assets", "elevenlabs-v4"));
    const client = mockClient();
    await expect(generateElevenV4({ request, run_dir: runDir }, {
      client
    })).rejects.toMatchObject({ code: "unsafe_output_directory" });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("rejects a hosted MCP tool that lists v4 but excludes Turbo before sending", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    client.listTools.mockResolvedValue({ tools: [speechTool(["eleven_v3"])] });
    await expect(generateElevenV4({ request, run_dir: runDir }, { client }))
      .rejects.toMatchObject({ code: "mcp_v4_speech_tool_unavailable" });
    expect(client.callTool).not.toHaveBeenCalled();
    expect(() => selectElevenV4SpeechTool([{ ...speechTool(), inputSchema: {
      ...speechTool().inputSchema, required: ["text", "voice_id", "language"]
    } }], request.model)).toThrow("mcp_v4_speech_tool_unavailable");
    expect(selectElevenV4SpeechTool([speechTool(["eleven_v4"])], "eleven_v4")).toBe("text_to_speech");
  });

  it("rejects speech tools without an explicit model declaration before sending", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    const unenumerated = speechTool();
    unenumerated.inputSchema.properties.model_id = { type: "string" };
    client.listTools.mockResolvedValue({ tools: [unenumerated] });
    await expect(generateElevenV4({ request, run_dir: runDir }, { client }))
      .rejects.toMatchObject({ code: "mcp_v4_speech_tool_unavailable" });
    expect(client.callTool).not.toHaveBeenCalled();
    expect(selectElevenV4SpeechTool([{ ...unenumerated, inputSchema: {
      ...unenumerated.inputSchema,
      properties: { ...unenumerated.inputSchema.properties, model_id: {
        type: "string", const: request.model
      } }
    } }], request.model)).toBe("text_to_speech");
  });

  it("rejects an untrusted download link in the MCP result", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    client.callTool.mockResolvedValue({ content: [{ type: "text", text: "https://example.org/audio.mp3" }] });
    const fetchImpl = vi.fn();
    await expect(generateElevenV4({ request, run_dir: runDir }, { client, fetchImpl }))
      .rejects.toMatchObject({ code: "mcp_audio_url_untrusted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads a hosted MCP audio link and keeps the OAuth token out of results", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-eleven-v4-"));
    const client = mockClient();
    client.callTool.mockResolvedValue({
      structuredContent: { audio_url: "https://api.us.elevenlabs.io/audio/result.mp3" }
    });
    client.close = vi.fn(async () => {});
    const connectMcp = vi.fn(async () => client);
    const fetchImpl = vi.fn(async () => new Response(mp3, {
      status: 200, headers: { "content-type": "audio/mpeg" }
    }));
    const result = await generateElevenV4({ request, run_dir: runDir }, {
      connectMcp, fetchImpl, environment: { ELEVENLABS_MCP_ACCESS_TOKEN: "fixture-secret" }
    });
    expect(connectMcp).toHaveBeenCalledWith("fixture-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.us.elevenlabs.io/audio/result.mp3");
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(await readFile(result.audio[0].src)).toEqual(mp3);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});
