import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliAudioAdapter } from "../src/adapters/cliAudio.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import type { AudioRequest } from "../src/project/schema.js";

describe("CLI audio adapter boundary", () => {
  it("rejects a BGM id that does not match the request", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-cli-audio-mismatch-"));
    const runDir = join(root, "run");
    const script = join(root, "adapter.mjs");
    await writeFile(script, `process.stdout.write(JSON.stringify({credits:0,bgm:{id:"wrong-bgm",src:"missing.wav",start:0},sfx:[],metadata:{elevenlabs_used:false,fallback_used:false}}));\n`);
    await mkdir(runDir);
    const base = await loadAdapterDefinition("mock-cli-audio", ["fixtures/adapters"]);
    const adapter = {
      ...base,
      command: { executable: process.execPath, args: [script], input: "stdin-json" as const }
    };
    const request: AudioRequest = {
      adapter: "mock-cli-audio",
      fallback: "fail",
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" },
      sfx: [],
      params: {}
    };

    const result = runCliAudioAdapter(adapter, request, {
      runId: "audio-mismatch",
      runDir,
      targetDurationSeconds: 2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_bgm_mismatch");
  });

  it("enforces fail-closed metadata from the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-cli-audio-fallback-"));
    const runDir = join(root, "run");
    const script = join(root, "adapter.mjs");
    await writeFile(script, `process.stdout.write(JSON.stringify({credits:0,sfx:[],metadata:{elevenlabs_used:true,fallback_used:true}}));\n`);
    await mkdir(runDir);
    const base = await loadAdapterDefinition("mock-cli-audio", ["fixtures/adapters"]);
    const adapter = {
      ...base,
      command: { executable: process.execPath, args: [script], input: "stdin-json" as const }
    };
    const request: AudioRequest = {
      adapter: "mock-cli-audio",
      fallback: "fail",
      sfx: [],
      params: {}
    };

    const result = runCliAudioAdapter(adapter, request, {
      runId: "audio-fallback",
      runDir,
      targetDurationSeconds: 2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_fallback_forbidden");
  });
});
