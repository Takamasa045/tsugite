import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliAnalysisAdapter } from "../src/adapters/cliAnalysis.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { readJsonFile } from "../src/io.js";
import type { Manifest } from "../src/manifest/schema.js";
import type { AnalysisRequest } from "../src/project/schema.js";

describe("local media scene analysis", () => {
  it("falls back to one full-clip observation and writes a run-relative representative JPEG", async () => {
    const adapter = await loadAdapterDefinition("local-media-analysis", ["adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const sourcePath = resolve(dirname(manifestPath), manifest.clips[0]!.src);
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-scene-fallback-"));
    const sourceBefore = await readFile(sourcePath);

    const result = runCliAnalysisAdapter(adapter, [sceneRequest()], manifest, {
      runId: "scene-fallback",
      runDir,
      manifestDir: dirname(manifestPath),
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "must-not-be-used"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({
      output: "scene_observations",
      data: {
        scene_observations: [{
          id: "scene-scan-scene-0001",
          source_start: 0,
          source_end: 1,
          confidence: 0.5,
          evidence: {
            representative_frame: "analysis/representative-frames/scene-scan-scene-0001.jpg",
            timestamp_seconds: 0.5
          }
        }]
      },
      metadata: {
        engine: "ffmpeg-scenedetect",
        api_used: false,
        network_used: false
      }
    });
    const frame = await stat(join(runDir, "analysis/representative-frames/scene-scan-scene-0001.jpg"));
    expect(frame.isFile()).toBe(true);
    expect(frame.size).toBeGreaterThan(0);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
  }, 15_000);

  it("detects local scene changes and generates one representative frame per interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-scene-detection-"));
    const sourcePath = join(root, "two-scenes.mp4");
    createTwoSceneVideo(sourcePath);
    const adapter = await loadAdapterDefinition("local-media-analysis", ["adapters"]);
    const manifest = sceneManifest(sourcePath, 0.5, 1.5);
    const runDir = join(root, "run");

    const result = runCliAnalysisAdapter(
      adapter,
      [sceneRequest({ scene_threshold: 0.1 })],
      manifest,
      {
        runId: "scene-detection",
        runDir,
        manifestDir: root,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME }
      }
    );

    expect(result.ok).toBe(true);
    const observations = result.results?.[0]?.output === "scene_observations"
      ? result.results[0].data.scene_observations
      : [];
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => [observation.source_start, observation.source_end])).toEqual([
      [0.5, 1],
      [1, 1.5]
    ]);
    expect(observations.map((observation) => observation.evidence.timestamp_seconds)).toEqual([0.75, 1.25]);
    for (const observation of observations) {
      expect(observation.technical_notes).not.toHaveLength(0);
      expect(observation.selection_reasons).not.toHaveLength(0);
      const relativeFrame = observation.evidence.representative_frame;
      expect(relativeFrame).toMatch(/^analysis\/representative-frames\/[^/]+\.jpg$/);
      expect((await stat(join(runDir, relativeFrame!))).size).toBeGreaterThan(0);
    }
  }, 15_000);

  it("declares scene observations without adding network, API, or credential use", async () => {
    const adapter = await loadAdapterDefinition("local-media-analysis", ["adapters"]);
    const source = await readFile("adapters/local-media-analysis/analyze.mjs", "utf8");

    expect(adapter).toMatchObject({
      offline: true,
      outputs: ["cut_points", "scene_observations"]
    });
    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|ELEVENLABS_API_KEY/);
    expect(source).toMatch(/"-protocol_whitelist",\s*"file,pipe"/);
  });

  it("rejects HLS playlists before FFmpeg can follow nested local file references", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-scene-playlist-"));
    const playlistPath = join(root, "disguised.mp4");
    const runDir = join(root, "run");
    await writeFile(
      playlistPath,
      "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///tmp/outside-project.ts\n#EXT-X-ENDLIST\n"
    );
    const executed = spawnSync(
      process.execPath,
      ["adapters/local-media-analysis/analyze.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: `${JSON.stringify({
          request: { id: "scene-scan", output: "scene_observations", params: {} },
          run_id: "playlist-rejection",
          run_dir: runDir,
          source: {
            clip_id: "render-001",
            path: playlistPath,
            analysis_start_seconds: 0,
            analysis_end_seconds: 1,
            duration_seconds: 1,
            sha256: "0".repeat(64)
          }
        })}\n`
      }
    );

    expect(executed.status).toBe(40);
    expect(executed.stderr).toContain("playlist and indirect media sources are not allowed");
    await expect(stat(join(runDir, "analysis"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a leaf symlink without overwriting its target outside run_dir", async () => {
    const adapter = await loadAdapterDefinition("local-media-analysis", ["adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const root = await mkdtemp(join(tmpdir(), "tsugite-scene-symlink-"));
    const runDir = join(root, "run");
    const frameDirectory = join(runDir, "analysis/representative-frames");
    const outsideTarget = join(root, "outside.txt");
    const framePath = join(frameDirectory, "scene-scan-scene-0001.jpg");
    await mkdir(frameDirectory, { recursive: true });
    await writeFile(outsideTarget, "must stay unchanged");
    await symlink(outsideTarget, framePath);

    const result = runCliAnalysisAdapter(adapter, [sceneRequest()], manifest, {
      runId: "scene-symlink",
      runDir,
      manifestDir: dirname(manifestPath),
      environment: { PATH: process.env.PATH, HOME: process.env.HOME }
    });

    expect(result.ok).toBe(true);
    expect(await readFile(outsideTarget, "utf8")).toBe("must stay unchanged");
    expect((await lstat(framePath)).isSymbolicLink()).toBe(false);
    expect((await stat(framePath)).size).toBeGreaterThan(0);
  }, 15_000);

  it("rejects an analysis-directory symlink before creating anything outside run_dir", async () => {
    const adapter = await loadAdapterDefinition("local-media-analysis", ["adapters"]);
    const manifestPath = resolve("fixtures/manifests/render-local.valid.json");
    const manifest = (await readJsonFile(manifestPath)) as Manifest;
    const root = await mkdtemp(join(tmpdir(), "tsugite-scene-parent-symlink-"));
    const runDir = join(root, "run");
    const outsideDirectory = join(root, "outside");
    await mkdir(runDir);
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(runDir, "analysis"));

    const result = runCliAnalysisAdapter(adapter, [sceneRequest()], manifest, {
      runId: "scene-parent-symlink",
      runDir,
      manifestDir: dirname(manifestPath),
      environment: { PATH: process.env.PATH, HOME: process.env.HOME }
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("analysis.adapter_exit.invalid_request");
    await expect(stat(join(outsideDirectory, "representative-frames"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

function sceneRequest(params: Record<string, unknown> = {}): AnalysisRequest {
  return {
    id: "scene-scan",
    output: "scene_observations",
    source_clip_id: "render-001",
    depends_on: [],
    params
  };
}

function sceneManifest(sourcePath: string, clipIn = 0, clipOut = 2): Manifest {
  return {
    meta: {
      aspect: "16:9",
      fps: 10,
      target_duration_seconds: clipOut - clipIn,
      slug: "scene-analysis"
    },
    clips: [{
      id: "render-001",
      src: sourcePath,
      in: clipIn,
      out: clipOut,
      duration: clipOut - clipIn,
      fps: 10,
      resolution: { width: 160, height: 90 },
      audio: false
    }],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  };
}

function createTwoSceneVideo(path: string): void {
  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x90:d=1:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:d=1:r=10",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v",
      "mpeg4",
      "-y",
      resolve(path)
    ],
    { encoding: "utf8" }
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
}
