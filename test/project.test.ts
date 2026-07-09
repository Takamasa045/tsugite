import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadProject } from "../src/project/loadProject.js";
import { projectSchema, toExecutionProject } from "../src/project/schema.js";
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

  it.each(["generation", "analysis"] as const)("rejects unsafe %s request ids", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "fixture-adapter",
      requests: [requestDefinition(requestKind, "../escape")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([requestKind, "requests", 0, "id"]);
    }
  });

  it.each(["generation", "analysis"] as const)("rejects unsafe %s adapter names", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "../outside-adapter",
      requests: [requestDefinition(requestKind, "safe-request")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([requestKind, "adapter"]);
    }
  });

  it.each(["generation", "analysis"] as const)("rejects duplicate %s request ids", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "fixture-adapter",
      requests: [requestDefinition(requestKind, "duplicate"), requestDefinition(requestKind, "duplicate")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "request ids must be unique",
            path: [requestKind, "requests", 1, "id"]
          })
        ])
      );
    }
  });

  it("accepts explicit prompt guidance metadata without defaulting existing requests", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [
        {
          ...requestDefinition("generation", "guided-request"),
          input_mode: "image-to-video",
          prompt_guide: { catalog: "seedance" }
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generation?.requests[0]).toMatchObject({
        input_mode: "image-to-video",
        prompt_guide: { catalog: "seedance" }
      });
    }
  });

  it("keeps advisory guide selectors out of execution input while retaining input mode", () => {
    const parsed = projectSchema.parse({
      ...validProjectDefinition(),
      generation: {
        adapter: "fixture-adapter",
        requests: [
          {
            ...requestDefinition("generation", "guided-execution"),
            input_mode: "image-to-video",
            prompt_guide: { catalog: "seedance" }
          }
        ]
      }
    });

    const execution = toExecutionProject(parsed);

    expect(execution.generation?.requests[0]).not.toHaveProperty("prompt_guide");
    expect(execution.generation?.requests[0]?.input_mode).toBe("image-to-video");
    expect(parsed.generation?.requests[0]?.prompt_guide?.catalog).toBe("seedance");
  });

  it("rejects unsafe prompt guide catalog ids", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [
        {
          ...requestDefinition("generation", "unsafe-guide"),
          prompt_guide: { catalog: "../outside" }
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["generation", "requests", 0, "prompt_guide", "catalog"]);
    }
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

  it("rejects clip assets that escape the project asset root through a symbolic link", async () => {
    const root = await createProjectRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "tsugite-outside-"));
    const outsideVideo = join(outsideRoot, "outside.mp4");
    await writeFile(outsideVideo, "not a real video");
    await symlink(outsideVideo, join(root, "media/link.mp4"));
    await writeProject(root, {
      clips: [clip({ src: "../media/link.mp4" })]
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.safe");
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

function validProjectDefinition(): Record<string, unknown> {
  return {
    slug: "request-validation",
    run_id: "request-validation-run",
    manifest: "../manifests/manifest.json",
    dist_dir: "dist",
    edit: {
      backend: "remotion"
    }
  };
}

function requestDefinition(kind: "generation" | "analysis", id: string) {
  if (kind === "analysis") {
    return {
      id,
      output: "captions",
      params: {}
    };
  }
  return {
    id,
    prompt: "fixture prompt",
    model: "fixture-model",
    duration: 1,
    aspect: "16:9",
    params: {}
  };
}
