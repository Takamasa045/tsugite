import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import { validateProject } from "../src/project/validateProject.js";

describe("backend capabilities", () => {
  it("loads backend render preflight checks from capabilities", async () => {
    const backend = await loadBackendCapabilities("hyperframes");

    expect(backend?.capabilities.captions).toBe(true);
    expect(backend?.checks.render_preflight).toEqual([
      {
        name: "lint",
        command: ["npx", "--no-install", "hyperframes", "lint", "--json"]
      }
    ]);
    expect(backend?.checks.setup).toContainEqual({
      type: "command",
      name: "tool:hyperframes",
      command: ["npx", "--no-install", "hyperframes", "--version"],
      capture_version: true,
      blocking: true,
      remediation: expect.any(Object)
    });
  });

  it("rejects captions, vertical, and fps demands unsupported by a backend", async () => {
    const result = await validateProject("fixtures/projects/captions-limited.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "backend.capability.captions",
        "backend.capability.vertical",
        "backend.capability.fps"
      ])
    );
  });

  it("rejects audio mix and transition demands unsupported by a backend", async () => {
    const result = await validateProject("fixtures/projects/audio-transition-limited.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "backend.capability.audio_mix",
        "backend.capability.transitions"
      ])
    );
  });

  it("rejects a presentation preset unsupported by the selected backend", async () => {
    const result = await validateProject("fixtures/projects/dialogue-limited.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.capability.preset");
  });
});

describe("hyperframes render runner", () => {
  it("rejects backend payload paths outside the run directory contract", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-payload-"));
    const script = resolve("backends/hyperframes/render.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath: join(runDir, "manifest.json"),
        outputPath: join(runDir, "..", "escaped.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8"
    });

    expect(result.status).toBe(40);
    expect(result.stderr).toContain("outputPath must equal");
  });

  it("returns a structured dependency-missing result without running npx hyperframes", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-missing-"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "hyperframes-test" },
        clips: [],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      })
    );

    const result = spawnSync(process.execPath, [resolve("backends/hyperframes/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({ runDir, manifestPath, outputPath, reportPath }),
      encoding: "utf8",
      env: { ...process.env, PATH: "" }
    });

    expect(result.status).toBe(30);
    const stdout = JSON.parse(result.stdout);
    expect(stdout).toMatchObject({
      ok: false,
      code: "hyperframes.dependency_missing",
      report_path: reportPath,
      output_path: outputPath
    });

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      backend: "hyperframes",
      status: "dependency_missing",
      output_path: outputPath,
      manifest_path: manifestPath,
      issue: {
        code: "hyperframes.dependency_missing"
      }
    });
  });

  it("rejects external media before invoking HyperFrames", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-network-"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "hyperframes-test" },
        clips: [{ id: "external", src: "https://example.invalid/video.mp4", in: 0, out: 1, duration: 1, audio: false }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      })
    );

    const result = spawnSync(process.execPath, [resolve("backends/hyperframes/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({ runDir, manifestPath, outputPath, reportPath }),
      encoding: "utf8",
      env: { ...process.env, PATH: "" }
    });

    expect(result.status).toBe(10);
    expect(result.stderr).toContain("clips[0].src must be a local asset path");
  });

  it("rejects absolute local media paths before invoking HyperFrames", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-absolute-"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "hyperframes-test" },
        clips: [{ id: "absolute", src: resolve("fixtures/media/render-001.mp4"), in: 0, out: 1, duration: 1, audio: false }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      })
    );

    const result = spawnSync(process.execPath, [resolve("backends/hyperframes/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({ runDir, manifestPath, outputPath, reportPath }),
      encoding: "utf8",
      env: { ...process.env, PATH: "" }
    });

    expect(result.status).toBe(10);
    expect(result.stderr).toContain("clips[0].src must stay inside runDir");
  });

  it("renders through the HyperFrames CLI contract when preflight succeeds", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-render-"));
    const binDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-bin-"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const sourceVideo = resolve("fixtures/media/render-001.mp4");
    const fakeNpx = join(binDir, "npx");

    await mkdir(join(runDir, "assets/clips"), { recursive: true });
    await copyFile(sourceVideo, join(runDir, "assets/clips/clip-001.mp4"));

    await writeFile(
      manifestPath,
      JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "hyperframes-test" },
        clips: [
          {
            id: "clip-001",
            src: "assets/clips/clip-001.mp4",
            in: 2.5,
            out: 3.5,
            duration: 1,
            fps: 30,
            resolution: { width: 320, height: 180 },
            audio: true
          }
        ],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [{ id: "caption-001", text: "<hello & goodbye>", start: 0.125, end: 0.875 }],
        provenance: []
      })
    );
    const fakeNpxProgram = `
const { copyFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--no-install") args.shift();
if (args[0] !== "hyperframes") process.exit(40);
if (args[1] === "--version") {
  console.log("0.0.0-fixture");
  process.exit(0);
}
if (args[1] === "lint") {
  if (!existsSync("index.html")) process.exit(10);
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[1] === "render") {
  const output = args[args.indexOf("--output") + 1];
  copyFileSync(${JSON.stringify(sourceVideo)}, output);
  console.log(JSON.stringify({ ok: true, output }));
  process.exit(0);
}
process.exit(40);
`;
    if (process.platform === "win32") {
      await writeFile(join(binDir, "npx.cjs"), fakeNpxProgram);
      await writeFile(
        join(binDir, "npx.cmd"),
        `@echo off\r\n"${process.execPath}" "%~dp0npx.cjs" %*\r\n`
      );
    } else {
      await writeFile(fakeNpx, `#!/usr/bin/env node\n${fakeNpxProgram}`);
      await chmod(fakeNpx, 0o755);
    }

    const result = spawnSync(process.execPath, [resolve("backends/hyperframes/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({ runDir, manifestPath, outputPath, reportPath }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` }
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      report_path: reportPath,
      output_path: outputPath
    });
    const html = await readFile(join(runDir, "index.html"), "utf8");
    expect(html).toContain('data-composition-id="tsugite-render"');
    expect(html).toContain('data-width="320" data-height="180"');
    const video = html.match(/<video[^>]+>/)?.[0] ?? "";
    const sourceAudio = html.match(/<audio[^>]+id="clip-001-audio"[^>]+>/)?.[0] ?? "";
    expect(video).toContain('class="clip"');
    expect(video).toContain('data-start="0"');
    expect(video).toContain('data-duration="1"');
    expect(video).toContain('data-track-index="0"');
    expect(video).toContain('data-media-start="2.5"');
    expect(video).toContain(" muted");
    expect(sourceAudio).toContain('class="clip"');
    expect(sourceAudio).toContain('data-start="0"');
    expect(sourceAudio).toContain('data-duration="1"');
    expect(sourceAudio).toContain('data-track-index="1"');
    expect(sourceAudio).toContain('data-media-start="2.5"');
    expect(sourceAudio).toContain('src="assets/clips/clip-001.mp4"');
    expect(html).toContain(
      '<div id="caption-001" class="clip caption" data-start="0.125" data-duration="0.75" data-track-index="20">&lt;hello &amp; goodbye&gt;</div>'
    );
    expect(html).not.toMatch(/https?:\/\//);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      backend: "hyperframes",
      status: "rendered",
      output_path: outputPath,
      clip_count: 1
    });
  });
});
