import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildGeminiTtsRequest, runGeminiTts } from "../adapters/google-gemini-tts/geminiTts.mjs";
import { applyDialogueDraft, buildDialogueDraftRequest, generateDialogueDraft, parseDialogueDraft } from "../adapters/google-gemini-tts/dialogueDraft.mjs";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { listConnectionOptions, resolveGenerationConnection } from "../src/connections/registry.js";

const conversation = {
  id: "dialogue",
  operation: "voice",
  output_kind: "audio",
  audio_role: "narration",
  model: "gemini-3.8-flash-tts",
  prompt: "A: おはよう。今日は何を作る？\nB: 短い動画を作ろう。",
  params: {
    speakers: [{ speaker: "A", voice: "Kore" }, { speaker: "B", voice: "Puck" }],
    turn_styles: ["warm and curious", "relaxed and friendly"]
  }
};

function smallWav() {
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(38, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(2, 40);
  return wav;
}

describe("Google Gemini TTS connection", () => {
  it("registers a direct, key-gated TTS route without claiming provider readiness", async () => {
    const adapter = await loadAdapterDefinition("google-gemini-tts");
    expect(adapter.kind).toBe("cli");
    expect(adapter.retry).toMatchObject({ max_attempts: 0, retryable_exit_codes: [] });
    expect(adapter.network.credential_env).toEqual(["GEMINI_API_KEY"]);
    const options = await listConnectionOptions({
      capability: "audio.text-to-speech",
      model: "gemini-3.8-flash-tts",
      environment: {}
    });
    expect(options.find((option) => option.id === "google-gemini-tts")?.setup.status).toBe("needs-setup");
    await expect(resolveGenerationConnection("google-gemini-tts", undefined, {
      models: ["gemini-3.8-flash-tts"], capabilities: ["audio.text-to-speech"]
    })).resolves.toMatchObject({ adapter: "google-gemini-tts", execution_mode: "pipeline-adapter" });
  });

  it("preserves the written dialogue as separate, styled speaker turns", () => {
    const body = buildGeminiTtsRequest(conversation);
    expect(body).toMatchObject({
      model: "gemini-3.8-flash-tts",
      store: false,
      response_format: { type: "audio", mime_type: "audio/wav", delivery: "inline" },
      generation_config: { speech_config: { mode: "conversational", speakers: conversation.params.speakers } }
    });
    expect(body.input[0].content).toEqual([
      { type: "text", text: "おはよう。今日は何を作る？", annotations: [{ type: "speech_metadata", speaker: "A", style: "warm and curious" }] },
      { type: "text", text: "短い動画を作ろう。", annotations: [{ type: "speech_metadata", speaker: "B", style: "relaxed and friendly" }] }
    ]);
    expect(() => buildGeminiTtsRequest({ ...conversation, prompt: "A: one\nUnknown: two" })).toThrow(/declared Speaker/);
    expect(() => buildGeminiTtsRequest({ ...conversation, model: "gemini-unknown-tts" })).toThrow(/unsupported/);
  });

  it("pins one WAV and reuses the exact same request without a second paid call", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-gemini-tts-"));
    const wav = smallWav();
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(_url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
      expect(init.headers["x-goog-api-key"]).toBe("fixture-key");
      expect(init.redirect).toBe("error");
      return new Response(JSON.stringify({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }] }]
      }), { headers: { "content-type": "application/json" } });
    });
    const payload = { request: conversation, run_id: "dialogue-run", run_dir: runDir };
    const first = await runGeminiTts(payload, { apiKey: "fixture-key", fetchImpl });
    expect(first.audio).toHaveLength(1);
    expect(first.metadata).toMatchObject({ billing_unknown: true, reused: false });
    expect(await readFile(first.audio[0].src)).toEqual(wav);
    const second = await runGeminiTts(payload, { apiKey: "fixture-key", fetchImpl });
    expect(second.metadata.reused).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(runGeminiTts({ ...payload, request: { ...conversation, prompt: "A: 違う。\nB: そうだね。" } }, {
      apiKey: "fixture-key", fetchImpl
    })).rejects.toThrow(/different request/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never retries a completed HTTP response without usable audio", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-gemini-tts-fail-"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "completed", steps: [] })));
    await expect(runGeminiTts({ request: conversation, run_id: "dialogue-run", run_dir: runDir }, {
      apiKey: "fixture-key", fetchImpl
    })).rejects.toThrow(/WAV audio block/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(runGeminiTts({ request: conversation, run_id: "dialogue-run", run_dir: runDir }, {
      apiKey: "fixture-key", fetchImpl
    })).rejects.toThrow(/outcome is unknown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates and applies a reviewed two-person script draft without a second paid call", async () => {
    const brief = { topic: "朝の会話", target_seconds: 10, characters: [{ description: "好奇心旺盛" }, { description: "落ち着いている" }] };
    const body = buildDialogueDraftRequest(brief);
    expect(body).toMatchObject({ model: "gemini-3.8-flash", store: false, response_format: { mime_type: "application/json" } });
    const turns = [{ speaker: "A", text: "何を作る？", style: "curious" }, { speaker: "B", text: "動画を作ろう。", style: "relaxed" }];
    const interaction = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ turns }) }] }] };
    expect(parseDialogueDraft(interaction).turns).toEqual(turns);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(interaction)));
    const directory = await mkdtemp(join(tmpdir(), "tsugite-dialogue-draft-"));
    const draftPath = join(directory, "draft.json");
    await generateDialogueDraft(brief, draftPath, { apiKey: "fixture-key", fetchImpl });
    await expect(generateDialogueDraft(brief, draftPath, { apiKey: "fixture-key", fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const projectPath = join(directory, "project.yaml");
    await copyFile(new URL("../templates/google-dialogue-h3/tts/project.yaml", import.meta.url), projectPath);
    await copyFile(new URL("../templates/google-dialogue-h3/tts/manifest.json", import.meta.url), join(directory, "manifest.json"));
    await applyDialogueDraft(draftPath, projectPath);
    const updated = await readFile(projectPath, "utf8");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    expect(updated).toContain("A: 何を作る？");
    expect(updated).toContain("- curious");
    expect(manifest.captions.map((caption) => caption.text)).toEqual(["A: 何を作る？", "B: 動画を作ろう。"]);
  });
});
