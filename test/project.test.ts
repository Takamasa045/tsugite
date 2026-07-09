import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadProject } from "../src/project/loadProject.js";
import { validateProject } from "../src/project/validateProject.js";

describe("project validation", () => {
  it("loads a valid project.yaml", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");

    expect(project.slug).toBe("local-fixture");
    expect(project.edit.backend).toBe("remotion");
  });

  it("rejects an unknown backend during validation", async () => {
    const result = await validateProject("fixtures/projects/unknown-backend.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.not_found");
  });

  it("reports project schema errors", async () => {
    const result = await validateProject("fixtures/projects/invalid-schema.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects unsafe run ids before state paths can be written", async () => {
    const result = await validateProject("fixtures/projects/bad-run-id.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects unsafe backend ids before runner paths can be built", async () => {
    const root = await createProjectRoot();
    await writeProject(root, {
      clips: [clip({ src: "../media/clip.mp4" })]
    });
    await writeFile(join(root, "media/clip.mp4"), "not a real video");
    await writeFile(
      join(root, "projects/project.yaml"),
      [
        "slug: unsafe-backend",
        "run_id: unsafe-backend-run",
        "manifest: ../manifests/manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: ../outside"
      ].join("\n")
    );

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects manifest paths that escape beyond the project asset root", async () => {
    const root = await createProjectRoot();
    await writeFile(
      join(root, "projects/project.yaml"),
      [
        "slug: unsafe-manifest",
        "run_id: unsafe-manifest-run",
        "manifest: ../../outside/manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: remotion"
      ].join("\n")
    );

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("reports missing manifest files as validation issues", async () => {
    const result = await validateProject("fixtures/projects/missing-manifest.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.read_failed");
  });

  it("reports malformed backend definitions as structured issues", async () => {
    const result = await validateProject("fixtures/projects/malformed-backend.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.schema");
    expect(result.issues.map((issue) => issue.code)).not.toContain("backend.not_found");
  });

  it("resolves manifest paths relative to the config file", async () => {
    const result = await validateProject("fixtures/projects/local-valid.yaml");

    expect(result.ok).toBe(true);
    expect(result.manifest?.clips[0]?.src).toBe("../media/clip-001.mp4");
  });

  it("accepts local media projects without generation requests", async () => {
    const result = await validateProject("fixtures/projects/local-media-only.yaml");

    expect(result.ok).toBe(true);
    expect(result.project?.generation).toBeUndefined();
  });

  it("reports missing local clip assets", async () => {
    const result = await validateProject("fixtures/projects/missing-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.exists");
  });

  it("rejects asset paths that point to directories", async () => {
    const result = await validateProject("fixtures/projects/directory-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.exists");
  });

  it("reports missing local audio track assets", async () => {
    const result = await validateProject("fixtures/projects/missing-audio-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.audio.src.exists");
  });

  it("rejects absolute clip asset paths before copying into a run", async () => {
    const root = await createProjectRoot();
    const outside = join(root, "outside.mp4");
    await writeFile(outside, "not a real video");
    await writeProject(root, {
      clips: [clip({ src: outside })]
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.safe");
  });

  it("rejects audio asset paths that escape the project asset root", async () => {
    const root = await createProjectRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "tsugite-outside-"));
    const outsideAudio = join(outsideRoot, "outside.mp3");
    await writeFile(join(root, "media/clip.mp4"), "not a real video");
    await writeFile(outsideAudio, "not real audio");
    await writeProject(root, {
      clips: [clip({ src: "../media/clip.mp4" })],
      audio: {
        bgm: [{ id: "outside-audio", src: relative(join(root, "manifests"), outsideAudio) }],
        narration: [],
        sfx: []
      }
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.audio.src.safe");
  });
});

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-project-"));
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "manifests"), { recursive: true });
  await mkdir(join(root, "media"), { recursive: true });
  return root;
}

async function writeProject(
  root: string,
  manifest: {
    clips: Array<ReturnType<typeof clip>>;
    audio?: {
      bgm: Array<{ id: string; src: string }>;
      narration: Array<{ id: string; src: string }>;
      sfx: Array<{ id: string; src: string }>;
    };
  }
): Promise<void> {
  await writeFile(
    join(root, "projects/project.yaml"),
    [
      "slug: safe-assets",
      "run_id: safe-assets-run",
      "manifest: ../manifests/manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion"
    ].join("\n")
  );
  await writeFile(
    join(root, "manifests/manifest.json"),
    `${JSON.stringify(
      {
        meta: {
          aspect: "16:9",
          fps: 30,
          target_duration_seconds: 3,
          slug: "safe-assets"
        },
        clips: manifest.clips,
        audio: manifest.audio ?? { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      },
      null,
      2
    )}\n`
  );
}

function clip(overrides: { src: string }) {
  return {
    id: "clip-001",
    src: overrides.src,
    in: 0,
    out: 3,
    duration: 3,
    fps: 30,
    resolution: {
      width: 1920,
      height: 1080
    },
    audio: true
  };
}
