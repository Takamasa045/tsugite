import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionPlan } from "../src/orchestrator/plan.js";
import type { Project } from "../src/project/schema.js";

const { createViewerWorkflowMock } = vi.hoisted(() => ({
  createViewerWorkflowMock: vi.fn()
}));

vi.mock("../src/viewer/workflow.js", () => ({
  createViewerWorkflow: createViewerWorkflowMock
}));

import {
  createWorkflowViewerSnapshotManifest,
  getWorkflowViewerOpenCommand,
  WORKFLOW_VIEWER_EVIDENCE_FILE,
  writeWorkflowViewer
} from "../src/viewer/artifact.js";

function sampleProject(): Project {
  return {
    slug: "viewer-project",
    run_id: "viewer-run",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" }
  };
}

function samplePlan(): ExecutionPlan {
  return {
    run_id: "viewer-run",
    slug: "viewer-project",
    backend: "remotion",
    target_duration_seconds: 30,
    total_clip_duration_seconds: 30,
    estimated_credits: 0,
    clips: [],
    agent_handoffs: [],
    steps: [
      { name: "validate", status: "pending" },
      { name: "gate-1", status: "gate" }
    ]
  };
}

async function createBundle(root: string): Promise<string> {
  const bundleDir = join(root, "viewer-bundle");
  await mkdir(join(bundleDir, "assets", "chunks"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><link rel="stylesheet" href="./assets/app.css"><div id="root"></div><script type="module" src="./assets/app.js"></script>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.css"), "body { color: #fff; }\n");
  await writeFile(
    join(bundleDir, "assets", "app.js"),
    "console.log('</script><script>alert(1)</script>');\n"
  );
  await writeFile(join(bundleDir, "assets", "chunks", "scene.js"), "export {};\n");
  return bundleDir;
}

describe("workflow viewer artifact", () => {
  beforeEach(() => {
    createViewerWorkflowMock.mockClear();
    createViewerWorkflowMock.mockReturnValue({
      id: "viewer-run",
      name: "</script><script>alert('viewer')</script>",
      description: "A & B\u2028C",
      status: "pending",
      duration: 30,
      nodes: [],
      edges: [],
      events: []
    });
  });

  it("writes a self-contained snapshot without creating pipeline state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const configPath = join(root, "project.yaml");
    const bundleDir = await createBundle(root);
    await writeFile(configPath, "slug: viewer-project\n");
    await mkdir(join(root, "dist", "viewer-run", "review"), { recursive: true });
    await writeFile(join(root, "dist", "viewer-run", "review", "review-data.json"), "{}\n");

    const result = await writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir
    });

    expect(result).toEqual({
      viewerPath: join(root, "dist", "viewer-run", "viewer", "index.html"),
      workflowPath: join(root, "dist", "viewer-run", "viewer", "workflow.json"),
      outputDir: join(root, "dist", "viewer-run", "viewer"),
      stateFound: false
    });
    expect(createViewerWorkflowMock).toHaveBeenCalledWith(
      sampleProject(),
      samplePlan(),
      expect.objectContaining({ run_id: "viewer-run", status: "planned" }),
      expect.not.objectContaining({ reviewPresent: true })
    );
    await expect(stat(join(root, "dist", "viewer-run", "state.json"))).rejects.toThrow();
    await expect(readFile(join(result.outputDir, "assets", "chunks", "scene.js"), "utf8"))
      .resolves.toBe("export {};\n");

    const workflowText = await readFile(result.workflowPath, "utf8");
    expect(JSON.parse(workflowText)).toMatchObject({ id: "viewer-run" });
    const html = await readFile(result.viewerPath, "utf8");
    expect(html.indexOf('id="tsugite-workflow-data"')).toBeLessThan(
      html.indexOf('script type="module"')
    );
    expect(html).not.toContain("</script><script>alert('viewer')</script>");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u0026");
    expect(html).toContain("\\u2028");
    expect(html).toContain("<style>body { color: #fff; }");
    expect(html).toContain("<script type=\"module\">console.log('<\\/script>");
    expect(html).not.toContain('src="./assets/app.js"');
    expect(html).not.toContain('href="./assets/app.css"');
  });

  it("reads existing state and complete Gate evidence without modifying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const configPath = join(root, "project.yaml");
    const stateDir = join(root, "custom-state");
    const runDir = join(stateDir, "viewer-run");
    const bundleDir = await createBundle(root);
    const state = {
      run_id: "viewer-run",
      status: "completed",
      updated_at: "2026-07-13T09:00:00.000Z",
      gates: {
        gate_1: { status: "approved", updated_at: "2026-07-13T09:01:00.000Z" },
        gate_2: { status: "approved", updated_at: "2026-07-13T09:02:00.000Z" },
        gate_3: { status: "approved", updated_at: "2026-07-13T09:03:00.000Z" }
      }
    };
    await mkdir(join(runDir, "review", "assets"), { recursive: true });
    await writeFile(configPath, "slug: viewer-project\n");
    await writeFile(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(join(runDir, "review", "index.html"), '<!doctype html><img src="assets/storyboard.png">\n');
    await writeFile(join(runDir, "review", "assets", "storyboard.png"), "storyboard-preview");
    await writeFile(join(runDir, "review", "review-data.json"), '{"schema_version":1}\n');
    const gate2Qc = JSON.stringify({
      ok: false,
      target_duration_seconds: 30,
      total_clip_duration_seconds: 30.2,
      duration_delta_seconds: 0.2,
      asset_count: 3,
      assets: [{ kind: "clip" }, { kind: "image" }, { kind: "audio" }],
      issues: [{ code: "asset", message: "missing" }]
    });
    await writeFile(join(runDir, "gate2-qc.json"), gate2Qc);
    await writeFile(join(runDir, "gate3-qc.json"), JSON.stringify({
      ok: true,
      output_path: "/tmp/final.mp4",
      expected: { duration_seconds: 30, width: 1280, height: 720, fps: 30, audio_required: true },
      actual: { duration_seconds: 30.1, width: 1280, height: 720, fps: 30, has_audio: true },
      content: { longest_black_seconds: 0, longest_silence_seconds: 0.25 },
      issues: []
    }));
    const stateBefore = await readFile(join(runDir, "state.json"), "utf8");

    const result = await writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      stateDir,
      outputDir: join(root, "snapshot"),
      bundleDir
    });

    expect(result.stateFound).toBe(true);
    expect(createViewerWorkflowMock).toHaveBeenCalledWith(
      sampleProject(),
      samplePlan(),
      state,
      {
        reviewPresent: true,
        reviewHref: "./review/index.html",
        gate2Qc: {
          ok: false,
          issues: [{ code: "asset", message: "missing" }],
          targetDurationSeconds: 30,
          totalClipDurationSeconds: 30.2,
          durationDeltaSeconds: 0.2,
          assetCount: 3,
          assetKinds: { clip: 1, image: 1, audio: 1 }
        },
        gate3Qc: {
          ok: true,
          issues: [],
          outputPath: "/tmp/final.mp4",
          expected: { durationSeconds: 30, width: 1280, height: 720, fps: 30, audioRequired: true },
          actual: { durationSeconds: 30.1, width: 1280, height: 720, fps: 30, hasAudio: true },
          content: { longestBlackSeconds: 0, longestSilenceSeconds: 0.25 }
        }
      }
    );
    await expect(readFile(join(runDir, "state.json"), "utf8")).resolves.toBe(stateBefore);
    await expect(readFile(join(result.outputDir, "review", "index.html"), "utf8"))
      .resolves.toContain('src="assets/storyboard.png"');
    await expect(readFile(join(result.outputDir, "review", "assets", "storyboard.png"), "utf8"))
      .resolves.toBe("storyboard-preview");
    const snapshotEvidence = JSON.parse(
      await readFile(join(result.outputDir, WORKFLOW_VIEWER_EVIDENCE_FILE), "utf8")
    );
    expect(snapshotEvidence).toEqual({
      schema_version: 1,
      review_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      gate2_qc_digest: createHash("sha256").update(gate2Qc).digest("hex"),
      viewer_index_digest: createHash("sha256")
        .update(await readFile(result.viewerPath))
        .digest("hex"),
      workflow_digest: createHash("sha256")
        .update(await readFile(result.workflowPath))
        .digest("hex"),
      files: expect.arrayContaining([
        expect.objectContaining({ path: "index.html", size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "workflow.json", size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "review/index.html", size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ path: "review/assets/storyboard.png", size: 18, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      ])
    });
    expect(JSON.stringify(snapshotEvidence)).not.toContain(root);
    expect(snapshotEvidence.files.length).toBeLessThanOrEqual(512);
    expect(snapshotEvidence.files.every((file: { path: string; size: number; sha256: string }) =>
      !file.path.startsWith("/")
      && !file.path.includes("\\")
      && file.path.length <= 512
      && Number.isInteger(file.size)
      && file.size >= 0
      && /^[a-f0-9]{64}$/.test(file.sha256)
    )).toBe(true);
    expect(snapshotEvidence.files.reduce(
      (sum: number, file: { size: number }) => sum + file.size,
      0
    )).toBeLessThanOrEqual(16 * 1024 * 1024 * 1024);
  });

  it("copies a bounded set of real media into the snapshot and exposes browser-safe previews", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const configPath = join(root, "project.yaml");
    const runDir = join(root, "dist", "viewer-run");
    const bundleDir = await createBundle(root);
    await mkdir(join(runDir, "assets", "clips"), { recursive: true });
    await mkdir(join(runDir, "assets", "images"), { recursive: true });
    await mkdir(join(runDir, "assets", "audio"), { recursive: true });
    await writeFile(configPath, "slug: viewer-project\n");
    await writeFile(join(runDir, "assets", "clips", "opening.mp4"), "clip-preview");
    await writeFile(join(runDir, "assets", "images", "keyframe.jpg"), "image-preview");
    await writeFile(join(runDir, "assets", "audio", "narration.mp3"), "audio-preview");
    await writeFile(join(runDir, "final.mp4"), "final-preview");
    await writeFile(join(runDir, "gate2-qc.json"), JSON.stringify({
      ok: true,
      assets: [
        { id: "opening", kind: "clip", src: "assets/clips/opening.mp4" },
        { id: "keyframe", kind: "image", src: "assets/images/keyframe.jpg" },
        { id: "narration", kind: "audio", src: "assets/audio/narration.mp3" },
        { id: "unsafe", kind: "image", src: "../../outside.jpg" }
      ],
      issues: []
    }));
    await writeFile(join(runDir, "gate3-qc.json"), JSON.stringify({
      ok: true,
      output_path: join(runDir, "final.mp4"),
      issues: []
    }));

    const result = await writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir
    });

    expect(createViewerWorkflowMock).toHaveBeenCalledWith(
      sampleProject(),
      samplePlan(),
      expect.any(Object),
      expect.objectContaining({
        previews: [
          {
            id: "generated-video-01",
            role: "material",
            kind: "video",
            label: "生成した映像 1",
            description: "完成動画に使った映像素材です。",
            src: "./previews/generated-video-01.mp4"
          },
          {
            id: "generated-image-01",
            role: "material",
            kind: "image",
            label: "生成した画像 1",
            description: "映像制作に使った画像素材です。",
            src: "./previews/generated-image-01.jpg"
          },
          {
            id: "generated-audio-01",
            role: "material",
            kind: "audio",
            label: "生成した音声 1",
            description: "完成動画に使った音声素材です。",
            src: "./previews/generated-audio-01.mp3"
          },
          {
            id: "final-video",
            role: "final",
            kind: "video",
            label: "完成動画",
            description: "確認・承認を終えた完成版です。",
            src: "./previews/final-video.mp4"
          }
        ]
      })
    );
    await expect(readFile(join(result.outputDir, "previews", "generated-video-01.mp4"), "utf8"))
      .resolves.toBe("clip-preview");
    await expect(readFile(join(result.outputDir, "previews", "generated-image-01.jpg"), "utf8"))
      .resolves.toBe("image-preview");
    await expect(readFile(join(result.outputDir, "previews", "generated-audio-01.mp3"), "utf8"))
      .resolves.toBe("audio-preview");
    await expect(readFile(join(result.outputDir, "previews", "final-video.mp4"), "utf8"))
      .resolves.toBe("final-preview");
    await expect(stat(join(result.outputDir, "previews", "generated-image-02.jpg"))).rejects.toThrow();
  });

  it("reads a validated run log summary and generation request records", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const configPath = join(root, "project.yaml");
    const runDir = join(root, "dist", "viewer-run");
    const bundleDir = await createBundle(root);
    await mkdir(runDir, { recursive: true });
    await writeFile(configPath, "slug: viewer-project\n");
    await writeFile(join(runDir, "run-log.md"), [
      "# Run Log: viewer-run",
      "",
      "- mode: generation",
      "- asset_count: 27",
      "- actual_credits: 1500",
      `- input_digest: ${"a".repeat(64)}`,
      "- generated_at: 2026-07-12T05:27:55.418Z",
      "",
      "## Requests",
      "- mountain-omen: attempts=1, credits=125, clips=1",
      "- monk-pride: attempts=2, credits=250.5, clips=1",
      ""
    ].join("\n"));

    await writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir
    });

    expect(createViewerWorkflowMock).toHaveBeenCalledWith(
      sampleProject(),
      samplePlan(),
      expect.objectContaining({ run_id: "viewer-run", status: "planned" }),
      expect.objectContaining({
        runLog: {
          runId: "viewer-run",
          mode: "generation",
          assetCount: 27,
          actualCredits: 1500,
          inputDigest: "a".repeat(64),
          generatedAt: "2026-07-12T05:27:55.418Z",
          requests: [
            { id: "mountain-omen", attempts: 1, credits: 125, clips: 1 },
            { id: "monk-pride", attempts: 2, credits: 250.5, clips: 1 }
          ]
        }
      })
    );
  });

  it("rejects malformed or mismatched run logs instead of presenting them as trusted", async () => {
    const invalidLogs = [
      "# Run Log: other-run\n\n- mode: generation\n- asset_count: 1\n- actual_credits: 2\n- input_digest: " + "a".repeat(64) + "\n\n## Requests\n",
      "# Run Log: viewer-run\n\n- mode: generation\n- asset_count: many\n- actual_credits: 2\n- input_digest: " + "a".repeat(64) + "\n\n## Requests\n",
      "# Run Log: viewer-run\n\n- mode: generation\n- asset_count: 1\n- actual_credits: 2\n- input_digest: " + "a".repeat(64) + "\n\n## Requests\n- broken request\n"
    ];

    for (const runLog of invalidLogs) {
      const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
      const runDir = join(root, "dist", "viewer-run");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
      await writeFile(join(runDir, "run-log.md"), runLog);

      await expect(writeWorkflowViewer({
        configPath: join(root, "project.yaml"),
        project: sampleProject(),
        plan: samplePlan(),
        bundleDir: await createBundle(root)
      })).rejects.toThrow(/run log/i);
    }
  });

  it("rejects invalid existing state instead of replacing it with a planned snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const runDir = join(root, "dist", "viewer-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
    await writeFile(join(runDir, "state.json"), "{not-json\n");

    await expect(writeWorkflowViewer({
      configPath: join(root, "project.yaml"),
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir: await createBundle(root)
    })).rejects.toThrow();
    expect(createViewerWorkflowMock).not.toHaveBeenCalled();
  });

  it("rejects state that belongs to another run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const runDir = join(root, "dist", "viewer-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
    await writeFile(join(runDir, "state.json"), JSON.stringify({
      run_id: "other-run",
      status: "planned",
      updated_at: "2026-07-13T09:00:00.000Z",
      gates: {
        gate_1: { status: "pending" },
        gate_2: { status: "pending" },
        gate_3: { status: "pending" }
      }
    }));

    await expect(writeWorkflowViewer({
      configPath: join(root, "project.yaml"),
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir: await createBundle(root)
    })).rejects.toThrow("does not match project run_id");
  });

  it("rejects malformed Gate evidence instead of presenting it as trusted", async () => {
    const invalidReports = [
      "{}",
      '{"ok":true,"issues":{}}',
      '{"ok":false,"issues":[{"code":"broken"}]}',
      '{"ok":false,"issues":[{"code":"broken","message":"bad","path":1}]}'
    ];

    for (const report of invalidReports) {
      const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
      const runDir = join(root, "dist", "viewer-run");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
      await writeFile(join(runDir, "gate2-qc.json"), report);
      await expect(writeWorkflowViewer({
        configPath: join(root, "project.yaml"),
        project: sampleProject(),
        plan: samplePlan(),
        bundleDir: await createBundle(root)
      })).rejects.toThrow(/Gate 2 QC/);
    }
  });

  it("rejects incomplete and escaping custom bundles", async () => {
    const invalidIndexes = [
      "<!doctype html><div id=\"root\"></div>",
      '<link rel="stylesheet"><script type="module" src="./assets/app.js"></script>',
      '<link rel="stylesheet" href="https://example.com/app.css"><script type="module" src="./assets/app.js"></script>',
      '<link rel="stylesheet" href="..\\app.css"><script type="module" src="./assets/app.js"></script>',
      '<link rel="stylesheet" href="../app.css"><script type="module" src="./assets/app.js"></script>'
    ];

    for (const indexHtml of invalidIndexes) {
      const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
      const bundleDir = await createBundle(root);
      await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
      await writeFile(join(bundleDir, "index.html"), indexHtml);
      await expect(writeWorkflowViewer({
        configPath: join(root, "project.yaml"),
        project: sampleProject(),
        plan: samplePlan(),
        bundleDir
      })).rejects.toThrow();
    }

    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const bundleDir = await createBundle(root);
    await writeFile(join(root, "project.yaml"), "slug: viewer-project\n");
    await rm(join(bundleDir, "assets"), { recursive: true });
    await writeFile(join(bundleDir, "app.js"), "export {};\n");
    await writeFile(
      join(bundleDir, "index.html"),
      '<div id="root"></div><script type="module" src="./app.js"></script>'
    );
    await expect(writeWorkflowViewer({
      configPath: join(root, "project.yaml"),
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir
    })).rejects.toThrow("assets directory was not found");
  });

  it("rejects missing and overlapping custom bundle directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-viewer-artifact-"));
    const configPath = join(root, "project.yaml");
    await writeFile(configPath, "slug: viewer-project\n");
    await expect(writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir: join(root, "missing")
    })).rejects.toThrow("bundle directory was not found");

    const bundleDir = await createBundle(root);
    await expect(writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir,
      outputDir: join(bundleDir, "snapshot")
    })).rejects.toThrow("must not overlap");

    const runDir = join(root, "dist", "viewer-run");
    await mkdir(runDir, { recursive: true });
    await expect(writeWorkflowViewer({
      configPath,
      project: sampleProject(),
      plan: samplePlan(),
      bundleDir,
      outputDir: runDir
    })).rejects.toThrow("must not be the run directory or its ancestor");
  });

  it("maps platform-specific open commands without a shell", () => {
    expect(getWorkflowViewerOpenCommand("/tmp/viewer/index.html", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/viewer/index.html"]
    });
    expect(getWorkflowViewerOpenCommand("C:\\viewer\\index.html", "win32")).toEqual({
      command: "explorer.exe",
      args: ["C:\\viewer\\index.html"]
    });
    expect(getWorkflowViewerOpenCommand("/tmp/viewer/index.html", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/viewer/index.html"]
    });
  });

  it("rejects snapshot directory trees that exceed entry or depth limits", async () => {
    const entriesRoot = await mkdtemp(join(tmpdir(), "tsugite-viewer-entries-"));
    await writeFile(join(entriesRoot, "index.html"), "index\n");
    await writeFile(join(entriesRoot, "workflow.json"), "{}\n");
    for (let start = 0; start < 513; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 513 - start) }, (_, offset) =>
        mkdir(join(entriesRoot, "assets", `empty-${start + offset}`), { recursive: true })
      ));
    }
    await expect(createWorkflowViewerSnapshotManifest(entriesRoot))
      .rejects.toThrow("too many entries");

    const depthRoot = await mkdtemp(join(tmpdir(), "tsugite-viewer-depth-"));
    await writeFile(join(depthRoot, "index.html"), "index\n");
    await writeFile(join(depthRoot, "workflow.json"), "{}\n");
    let nested = join(depthRoot, "assets");
    for (let depth = 0; depth < 33; depth += 1) nested = join(nested, "d");
    await mkdir(nested, { recursive: true });
    await expect(createWorkflowViewerSnapshotManifest(depthRoot))
      .rejects.toThrow("too deeply nested");
  }, 15_000);
});
