import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliAudioAdapter } from "../src/adapters/cliAudio.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import type { AdapterDefinition } from "../src/adapters/registry.js";
import type { AudioRequest } from "../src/project/schema.js";

const emptyOutput = {
  credits: 0,
  sfx: [] as unknown[],
  metadata: { elevenlabs_used: false, fallback_used: false }
};

async function audioFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const runDir = join(root, "run");
  await mkdir(runDir);
  const script = join(root, "adapter.mjs");
  const base = await loadAdapterDefinition("mock-cli-audio", ["fixtures/adapters"]);
  return { root, runDir, script, base };
}

function withScript(base: AdapterDefinition, script: string, retry?: AdapterDefinition["retry"]): AdapterDefinition {
  return {
    ...base,
    ...(retry ? { retry } : {}),
    command: { executable: process.execPath, args: [script], input: "stdin-json" as const }
  };
}

function request(overrides: Partial<AudioRequest> = {}): AudioRequest {
  return {
    adapter: "mock-cli-audio",
    fallback: "fail",
    sfx: [],
    params: {},
    ...overrides
  };
}

function writeJsonAdapter(script: string, payload: unknown) {
  return writeFile(
    script,
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`
  );
}

describe("CLI audio adapter boundary", () => {
  it("rejects a BGM id that does not match the request", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-mismatch-");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "wrong-bgm", src: "missing.wav", start: 0 },
      sfx: [],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });

    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" }
    }), {
      runId: "audio-mismatch",
      runDir,
      targetDurationSeconds: 2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_bgm_mismatch");
  });

  it("enforces fail-closed metadata from the adapter", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-fallback-");
    await writeJsonAdapter(script, {
      ...emptyOutput,
      metadata: { elevenlabs_used: true, fallback_used: true }
    });

    const result = runCliAudioAdapter(withScript(base, script), request(), {
      runId: "audio-fallback",
      runDir,
      targetDurationSeconds: 2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_fallback_forbidden");
  });

  it("rejects a non-cli audio adapter before spawning", async () => {
    const { runDir, base } = await audioFixture("tsugite-cli-audio-kind-");
    const result = runCliAudioAdapter(
      { ...base, kind: "mcp-agent", class: "audio" },
      request(),
      { runId: "audio-kind", runDir, targetDurationSeconds: 2 }
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_kind_unsupported");
  });

  it("rejects a generation-class adapter used as audio", async () => {
    const { runDir, base } = await audioFixture("tsugite-cli-audio-class-");
    const result = runCliAudioAdapter(
      { ...base, class: "generation" },
      request(),
      { runId: "audio-class", runDir, targetDurationSeconds: 2 }
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_kind_unsupported");
  });

  it("rejects an audio adapter that does not declare a command", async () => {
    const { runDir, base } = await audioFixture("tsugite-cli-audio-command-");
    const result = runCliAudioAdapter(
      { ...base, command: undefined },
      request(),
      { runId: "audio-command", runDir, targetDurationSeconds: 2 }
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_command_missing");
  });

  it("fails closed when the audio adapter executable cannot start", async () => {
    const { runDir, base } = await audioFixture("tsugite-cli-audio-spawn-");
    const result = runCliAudioAdapter(
      {
        ...base,
        command: {
          executable: join(runDir, "missing-audio-adapter"),
          args: [],
          input: "stdin-json"
        }
      },
      request(),
      { runId: "audio-spawn", runDir, targetDurationSeconds: 2 }
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_spawn_failed");
  });

  it("retries a mapped retryable exit once then accepts valid empty audio", async () => {
    const { root, runDir, script, base } = await audioFixture("tsugite-cli-audio-retry-");
    const marker = join(root, "attempt");
    await writeFile(script, `
      import { existsSync, writeFileSync } from "node:fs";
      const marker = ${JSON.stringify(marker)};
      if (!existsSync(marker)) {
        writeFileSync(marker, "1");
        process.exit(40);
      }
      process.stdout.write(${JSON.stringify(JSON.stringify(emptyOutput))});
    `);

    const result = runCliAudioAdapter(
      withScript(base, script, { max_attempts: 1, retryable_exit_codes: [40] }),
      request(),
      { runId: "audio-retry", runDir, targetDurationSeconds: 2 }
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("stops after a non-retryable unmapped exit", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-exit-");
    await writeFile(script, "process.exit(99);\n");
    const result = runCliAudioAdapter(withScript(base, script), request(), {
      runId: "audio-exit",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_exit.failed");
  });

  it("rejects non-JSON adapter output", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-json-");
    await writeFile(script, "process.stdout.write('not-json');\n");
    const result = runCliAudioAdapter(withScript(base, script), request(), {
      runId: "audio-json",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_output_json");
  });

  it("rejects a track whose end is not after start", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-schema-");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "main-bgm", src: "clip.wav", start: 2, end: 1 },
      sfx: [],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" }
    }), {
      runId: "audio-schema",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_output_schema");
  });

  it("rejects a missing requested BGM", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-bgm-missing-");
    await writeJsonAdapter(script, emptyOutput);
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" }
    }), {
      runId: "audio-bgm-missing",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_bgm_missing");
  });

  it("rejects unexpected BGM when the request has none", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-bgm-extra-");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "extra-bgm", src: "clip.wav", start: 0 },
      sfx: [],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request(), {
      runId: "audio-bgm-extra",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_bgm_mismatch");
  });

  it("rejects SFX ids that do not match the request", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-sfx-");
    await writeJsonAdapter(script, {
      credits: 0,
      sfx: [{ id: "wrong-hit", src: "hit.wav", start: 0 }],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      sfx: [{ id: "hit", prompt: "soft hit", start: 0.2 }]
    }), {
      runId: "audio-sfx",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_sfx_mismatch");
  });

  it("rejects duplicate track ids across BGM and SFX", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-dup-");
    const bgm = join(runDir, "bgm.wav");
    const hit = join(runDir, "hit.wav");
    await writeFile(bgm, "bgm");
    await writeFile(hit, "hit");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "shared", src: bgm, start: 0 },
      sfx: [{ id: "shared", src: hit, start: 0 }],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "shared", prompt: "warm music", start: 0, mode: "generate" },
      sfx: [{ id: "shared", prompt: "soft hit", start: 0.2 }]
    }), {
      runId: "audio-dup",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_track_id_duplicate");
  });

  it("rejects an audio src that is not an existing regular file", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-src-missing-");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "main-bgm", src: join(runDir, "missing.wav"), start: 0 },
      sfx: [],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" }
    }), {
      runId: "audio-src-missing",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_output_src_invalid");
  });

  it("rejects an audio src that resolves outside runDir", async () => {
    const { root, runDir, script, base } = await audioFixture("tsugite-cli-audio-src-outside-");
    const outside = join(root, "outside.wav");
    await writeFile(outside, "wav");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "main-bgm", src: outside, start: 0 },
      sfx: [],
      metadata: { elevenlabs_used: false, fallback_used: false }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" }
    }), {
      runId: "audio-src-outside",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_adapter_output_src_outside_run_dir");
  });

  it("accepts BGM and SFX files that stay inside runDir", async () => {
    const { runDir, script, base } = await audioFixture("tsugite-cli-audio-ok-");
    const bgm = join(runDir, "bgm.wav");
    const hit = join(runDir, "hit.wav");
    await writeFile(bgm, "bgm");
    await writeFile(hit, "hit");
    await writeJsonAdapter(script, {
      credits: 0,
      bgm: { id: "main-bgm", src: bgm, start: 0, volume: 0.4 },
      sfx: [{ id: "hit", src: hit, start: 0.2 }],
      metadata: { elevenlabs_used: false, fallback_used: false, provider: "fixture" }
    });
    const result = runCliAudioAdapter(withScript(base, script), request({
      bgm: { id: "main-bgm", prompt: "warm music", start: 0, mode: "generate" },
      sfx: [{ id: "hit", prompt: "soft hit", start: 0.2 }]
    }), {
      runId: "audio-ok",
      runDir,
      targetDurationSeconds: 2
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    if (result.ok) {
      expect(result.bgm).toMatchObject({ id: "main-bgm", src: bgm });
      expect(result.sfx).toEqual([expect.objectContaining({ id: "hit", src: hit })]);
    }
  });
});
