import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
import { validateProject } from "../src/project/validateProject.js";

describe("backend capabilities", () => {
  it("loads backend render preflight checks from capabilities", async () => {
    const backend = await loadBackendCapabilities("hyperframes");

    expect(backend?.checks.render_preflight).toEqual([
      {
        name: "lint",
        command: ["npx", "--no-install", "hyperframes", "lint", "--json"]
      }
    ]);
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

  it("renders through the HyperFrames CLI contract when preflight succeeds", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-render-"));
    const binDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-bin-"));
    const manifestPath = join(runDir, "manifest.json");
    const outputPath = join(runDir, "final.mp4");
    const reportPath = join(runDir, "render-report.json");
    const sourceVideo = resolve("fixtures/media/render-001.mp4");
    const fakeNpx = join(binDir, "npx");

    await writeFile(
      manifestPath,
      JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "hyperframes-test" },
        clips: [
          {
            id: "clip-001",
            src: "assets/clips/clip-001.mp4",
            in: 0,
            out: 1,
            duration: 1,
            fps: 30,
            resolution: { width: 320, height: 180 },
            audio: false
          }
        ],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [{ text: "hello", start: 0, end: 1 }],
        provenance: []
      })
    );
    await writeFile(
      fakeNpx,
      `#!/usr/bin/env node
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
`
    );
    await chmod(fakeNpx, 0o755);

    const result = spawnSync(process.execPath, [resolve("backends/hyperframes/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({ runDir, manifestPath, outputPath, reportPath }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      report_path: reportPath,
      output_path: outputPath
    });
    expect(await readFile(join(runDir, "index.html"), "utf8")).toContain('data-composition-id="tsugite-render"');
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      backend: "hyperframes",
      status: "rendered",
      output_path: outputPath,
      clip_count: 1
    });
  });
});
