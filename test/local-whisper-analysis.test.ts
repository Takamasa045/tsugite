import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { analysisAdapterOutputSchema } from "../src/adapters/cliAnalysis.js";

const adapterScript = resolve("adapters/local-whisper-analysis/analyze.mjs");

describe("local Whisper analysis adapter", () => {
  it("declares every offline analysis output without network or provider credentials", async () => {
    const definition = YAML.parse(await readFile("adapters/local-whisper-analysis/adapter.yaml", "utf8"));
    const source = await readFile(adapterScript, "utf8");

    expect(definition).toMatchObject({
      name: "local-whisper-analysis",
      kind: "cli",
      class: "analysis",
      offline: true,
      outputs: ["transcript", "cut_points", "chapters", "summary", "subtitle_track"]
    });
    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|\bfetch\s*\(/);
    expect(source).toMatch(/"-protocol_whitelist",\s*"file,pipe"/);
  });

  it("transcribes with a local model path and removes high no-speech hallucinations", async () => {
    const fixture = await whisperFixture();
    const result = runAdapter(
      {
        request: {
          id: "transcript-ja",
          output: "transcript",
          params: {
            model_path: fixture.modelPath,
            model_sha256: fixture.modelSha256,
            language: "ja",
            no_speech_threshold: 0.8
          }
        },
        source: source(fixture.sourcePath)
      },
      fixture.binDir
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(analysisAdapterOutputSchema.safeParse(output).success).toBe(true);
    expect(output).toMatchObject({
      schema_version: 1,
      request_id: "transcript-ja",
      output: "transcript",
      data: {
        language: "ja",
        segments: [
          {
            id: "segment-0001",
            source_start: 10,
            source_end: 11.25,
            text: "本題です",
            words: [
              { text: "本題", source_start: 10, source_end: 10.6, confidence: 0.97 },
              { text: "です", source_start: 10.6, source_end: 11.25, confidence: 0.95 }
            ]
          }
        ]
      },
      metadata: {
        engine: "local-whisper-cli",
        api_used: false,
        network_used: false,
        filtered_no_speech_segments: 1
      }
    });
    expect(output.metadata.model_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates an English subtitle track with source timestamps", async () => {
    const fixture = await whisperFixture();
    const result = runAdapter(
      {
        request: {
          id: "subtitle-en",
          output: "subtitle_track",
          params: {
            model_path: fixture.modelPath,
            model_sha256: fixture.modelSha256,
            language: "ja",
            target_language: "en"
          }
        },
        source: source(fixture.sourcePath),
        inputs: [{ output: "transcript", data: transcriptDependency() }]
      },
      fixture.binDir
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(analysisAdapterOutputSchema.safeParse(output).success).toBe(true);
    expect(output).toMatchObject({
      output: "subtitle_track",
      data: {
        source_language: "ja",
        target_language: "en",
        captions: [
          {
            id: "caption-0001",
            source_segment_id: "segment-a",
            source_start: 10,
            source_end: 11.25,
            text: "Main topic"
          }
        ]
      }
    });
  });

  it.each([
    ["a model name", "tiny", "model_path must point to an existing local .pt file"],
    ["a wrong extension", "model.bin", "model_path must point to an existing local .pt file"]
  ])("rejects %s before starting Whisper", async (_label, modelName, message) => {
    const fixture = await whisperFixture();
    const modelPath = modelName === "tiny" ? modelName : join(fixture.root, modelName);
    if (modelName !== "tiny") await writeFile(modelPath, "not-a-whisper-model");

    const result = runAdapter(
      {
        request: { id: "bad-model", output: "transcript", params: { model_path: modelPath, language: "ja" } },
        source: source(fixture.sourcePath)
      },
      fixture.binDir
    );

    expect(result.status).toBe(40);
    expect(result.stderr.trim()).toBe(message);
  });

  it("requires a pinned model SHA-256 before loading a local .pt file", async () => {
    const fixture = await whisperFixture();
    const result = runAdapter(
      {
        request: {
          id: "unpinned-model",
          output: "transcript",
          params: { model_path: fixture.modelPath, language: "ja" }
        },
        source: source(fixture.sourcePath)
      },
      fixture.binDir
    );

    expect(result.status).toBe(40);
    expect(result.stderr.trim()).toBe("model_sha256 is required for local .pt models");
  });

  it("allows only English as the local Whisper translation target", async () => {
    const fixture = await whisperFixture();
    const result = runAdapter(
      {
        request: {
          id: "subtitle-fr",
          output: "subtitle_track",
          params: {
            model_path: fixture.modelPath,
            model_sha256: fixture.modelSha256,
            language: "ja",
            target_language: "fr"
          }
        },
        source: source(fixture.sourcePath)
      },
      fixture.binDir
    );

    expect(result.status).toBe(40);
    expect(result.stderr.trim()).toBe("local Whisper translation supports target_language: en only");
  });

  it.each([
    [
      "cut_points",
      {
        cut_points: [
          {
            id: "filler-0001",
            kind: "filler",
            source_start: 10,
            source_end: 10.3,
            action: "review",
            evidence: { transcript_segment_id: "segment-a", matched_text: "えー" }
          }
        ]
      }
    ],
    [
      "chapters",
      {
        chapters: [
          { id: "chapter-0001", source_start: 10, source_end: 25, title: "えー 本題を説明します" }
        ]
      }
    ],
    [
      "summary",
      {
        language: "ja",
        summaries: [
          { id: "summary-0001", source_start: 10, source_end: 25, text: "えー 本題を説明します。次の話題です。" }
        ]
      }
    ]
  ])("generates deterministic %s from a transcript dependency", async (output, expectedData) => {
    const fixture = await whisperFixture();
    const result = runAdapter({
      request: { id: `${output}-local`, output, params: { filler_words: ["えー", "あの"] } },
      source: source(fixture.sourcePath),
      inputs: { transcript: transcriptDependency() }
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(analysisAdapterOutputSchema.safeParse(parsed).success).toBe(true);
    expect(parsed).toMatchObject({
      request_id: `${output}-local`,
      output,
      data: expectedData,
      metadata: { api_used: false, network_used: false, deterministic: true }
    });
  });

  it("fails closed when deterministic outputs have no transcript dependency", async () => {
    const fixture = await whisperFixture();
    const result = runAdapter({
      request: { id: "summary-local", output: "summary", params: {} },
      source: source(fixture.sourcePath),
      inputs: {}
    });

    expect(result.status).toBe(40);
    expect(result.stderr.trim()).toBe("summary requires a transcript dependency");
  });
});

function runAdapter(payload: unknown, binDir?: string) {
  return spawnSync(process.execPath, [adapterScript], {
    cwd: resolve("."),
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ...(binDir ? { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` } : {})
    }
  });
}

function source(path: string) {
  return {
    clip_id: "seminar-main",
    path,
    analysis_start_seconds: 10,
    analysis_end_seconds: 25,
    duration_seconds: 15,
    sha256: "a".repeat(64)
  };
}

function transcriptDependency() {
  return {
    language: "ja",
    segments: [
      {
        id: "segment-a",
        source_start: 10,
        source_end: 15,
        text: "えー 本題を説明します。",
        words: [
          { text: "えー", source_start: 10, source_end: 10.3, confidence: 0.92 },
          { text: "本題を説明します", source_start: 10.3, source_end: 15, confidence: 0.95 }
        ]
      },
      {
        id: "segment-b",
        source_start: 15,
        source_end: 25,
        text: "次の話題です。",
        words: [{ text: "次の話題です", source_start: 15, source_end: 25, confidence: 0.96 }]
      }
    ]
  };
}

async function whisperFixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-local-whisper-"));
  const binDir = join(root, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDir);
  const modelPath = join(root, "small.pt");
  const sourcePath = join(root, "seminar.mp4");
  await writeFile(modelPath, "fixture-model");
  await writeFile(sourcePath, "fixture-media");

  await writeFakeCli(
    binDir,
    "ffmpeg",
    `import { writeFileSync } from "node:fs";\n` +
      `const args = process.argv.slice(2);\n` +
      `const protocol = args.indexOf("-protocol_whitelist");\n` +
      `if (protocol < 0 || args[protocol + 1] !== "file,pipe") process.exit(7);\n` +
      `writeFileSync(args.at(-1), "fixture-wav");\n`
  );
  await writeFakeCli(
    binDir,
    "whisper",
    `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `import { basename, extname, join } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `const value = (name) => args[args.indexOf(name) + 1];\n` +
      `const outputDir = value("--output_dir");\n` +
      `const audio = args[0];\n` +
      `const translated = value("--task") === "translate";\n` +
      `mkdirSync(outputDir, { recursive: true });\n` +
      `const result = { language: "ja", text: translated ? "Main topic" : "本題です", segments: [\n` +
      `  { id: 0, start: 0, end: 1.25, text: translated ? " Main topic" : " 本題です", avg_logprob: -0.1, no_speech_prob: 0.1, words: translated ? [] : [\n` +
      `    { word: "本題", start: 0, end: 0.6, probability: 0.97 },\n` +
      `    { word: "です", start: 0.6, end: 1.25, probability: 0.95 }\n` +
      `  ] },\n` +
      `  { id: 1, start: 1.25, end: 2, text: " ご視聴ありがとうございました", avg_logprob: -0.2, no_speech_prob: 0.91, words: [] }\n` +
      `] };\n` +
      `writeFileSync(join(outputDir, basename(audio, extname(audio)) + ".json"), JSON.stringify(result));\n`
  );
  const modelSha256 = createHash("sha256").update("fixture-model").digest("hex");
  return { root, binDir, modelPath, modelSha256, sourcePath, sourceName: basename(sourcePath) };
}

async function writeFakeCli(binDir: string, name: string, source: string) {
  if (process.platform === "win32") {
    await writeFile(join(binDir, `${name}.mjs`), source);
    await writeFile(
      join(binDir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`
    );
    return;
  }

  const command = join(binDir, name);
  await writeFile(command, `#!${process.execPath}\n${source}`);
  await chmod(command, 0o755);
}
