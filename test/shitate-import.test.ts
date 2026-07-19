import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { importShitateSnapshot } from "../src/integrations/shitate.js";

describe("optional Shitate snapshot import", () => {
  it("copies an immutable snapshot and binds the anchor to the manifest and I2V request", async () => {
    const fixture = await createFixture();

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1",
      requestId: "shot-1",
      displayName: "Hero"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyImported).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "shitate_import.negative_prompt_not_applied" })
    ]);

    const lock = JSON.parse(await readFile(result.lockPath, "utf8"));
    expect(lock).toMatchObject({
      schema_version: 1,
      source: {
        kind: "shitate",
        character: "hero",
        run_id: "run-1",
        base_version: "v1",
        base_sha: "abc1234"
      },
      binding: {
        image_id: "hero-anchor",
        speaker_id: "hero",
        request_id: "shot-1"
      }
    });
    expect(lock.files.map((file: { role: string }) => file.role)).toEqual([
      "prompt",
      "negative",
      "shitate-manifest",
      "anchor"
    ]);
    expect(lock.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);

    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(manifest.images).toContainEqual({
      id: "hero-anchor",
      src: "media/shitate/hero/run-1/anchor.png",
      alt: "Hero Shitate anchor"
    });
    expect(manifest.speakers).toContainEqual(expect.objectContaining({
      id: "hero",
      display_name: "Hero",
      side: "left",
      accent: "#6B7A5A",
      poses: { neutral: "hero-anchor" }
    }));

    const project = parse(await readFile(fixture.configPath, "utf8"));
    const request = project.generation.requests.find((entry: { id: string }) => entry.id === "shot-1");
    expect(request.input_mode).toBe("image-to-video");
    expect(request.params.image).toBe(result.requestImagePath);
    expect(request.prompt).toBe("Hero walks forward while the camera tracks from the side.");
  });

  it("is idempotent when the source and copied snapshot are unchanged", async () => {
    const fixture = await createFixture();
    const options = {
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1",
      requestId: "shot-1"
    };

    const first = await importShitateSnapshot(options);
    const second = await importShitateSnapshot(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyImported).toBe(true);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(manifest.images.filter((image: { id: string }) => image.id === "hero-anchor")).toHaveLength(1);
    expect(manifest.speakers.filter((speaker: { id: string }) => speaker.id === "hero")).toHaveLength(1);
  });

  it("rejects a copied snapshot whose checksum no longer matches its lock", async () => {
    const fixture = await createFixture();
    const options = {
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1"
    };
    const first = await importShitateSnapshot(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await writeFile(join(first.destination, "prompt.txt"), "tampered\n");

    const result = await importShitateSnapshot(options);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.destination_conflict");
  });

  it("rejects a symlink substituted inside an existing snapshot", async () => {
    const fixture = await createFixture();
    const options = baseOptions(fixture);
    const first = await importShitateSnapshot(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const copiedAnchor = join(first.destination, "anchor.png");
    const outside = join(await mkdtemp(join(tmpdir(), "shitate-snapshot-outside-")), "anchor.png");
    await writeFile(outside, Buffer.from("anchor-image"));
    await rm(copiedAnchor);
    await symlink(outside, copiedAnchor);

    const result = await importShitateSnapshot(options);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.destination_conflict");
  });

  it("rejects a changed source instead of overwriting an existing snapshot", async () => {
    const fixture = await createFixture();
    const options = {
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1"
    };
    expect((await importShitateSnapshot(options)).ok).toBe(true);
    await writeFile(join(fixture.runRoot, "prompt.txt"), "changed source\n");

    const result = await importShitateSnapshot(options);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.destination_conflict");
  });

  it("rejects path traversal before reading from Shitate", async () => {
    const fixture = await createFixture();

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "../hero",
      runId: "run-1"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.safe_id");
  });

  it("rejects an anchor symlink that escapes the character directory", async () => {
    const fixture = await createFixture();
    const outside = join(await mkdtemp(join(tmpdir(), "shitate-outside-")), "outside.png");
    await writeFile(outside, Buffer.from("outside"));
    const linkPath = join(fixture.characterRoot, "references/images/escape-anchor.png");
    await symlink(outside, linkPath);

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1",
      anchor: "references/images/escape-anchor.png"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.anchor_escape");
  });

  it("rejects conflicting manifest bindings without modifying them", async () => {
    const fixture = await createFixture({
      images: [{ id: "hero-anchor", src: "media/existing.png", alt: "Existing" }]
    });

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.image_conflict");
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(manifest.images).toEqual([{ id: "hero-anchor", src: "media/existing.png", alt: "Existing" }]);
  });

  it("requires an explicit anchor when multiple candidates exist", async () => {
    const fixture = await createFixture({ manifestReferences: [] });
    await writeFile(join(fixture.characterRoot, "references/images/second-anchor.png"), Buffer.from("second"));

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.anchor_ambiguous");
  });

  it.each([
    [{ side: "center" }, "shitate_import.side"],
    [{ anchor: "references/../escape.png" }, "shitate_import.anchor_path"]
  ])("rejects invalid import options before copying", async (extra, code) => {
    const fixture = await createFixture();

    const result = await importShitateSnapshot({
      configPath: fixture.configPath,
      shitateRoot: fixture.shitateRoot,
      character: "hero",
      runId: "run-1",
      ...extra
    } as Parameters<typeof importShitateSnapshot>[0]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects multiple anchors declared by the forge manifest", async () => {
    const fixture = await createFixture({
      manifestReferences: [
        "references/images/main-anchor.png",
        "references/images/second-anchor.png"
      ]
    });

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.anchor_ambiguous");
  });

  it("rejects unsupported anchor media types", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.characterRoot, "references/images/anchor.gif"), "gif");

    const result = await importShitateSnapshot({
      ...baseOptions(fixture),
      anchor: "references/images/anchor.gif"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.anchor_type");
  });

  it("rejects a missing fallback anchor", async () => {
    const fixture = await createFixture({ manifestReferences: [] });
    await writeFile(join(fixture.characterRoot, "references/images/main-anchor.png"), "renamed");
    const noAnchorRoot = join(fixture.characterRoot, "references/images-no-anchor");
    await mkdir(noAnchorRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(join(fixture.runRoot, "manifest.json"), "utf8"));
    manifest.references = ["notes/not-an-image.txt"];
    await writeFile(join(fixture.runRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(fixture.characterRoot, "references/images/main-anchor.png"), "still anchor");
    await writeFile(join(fixture.characterRoot, "references/images/plain.png"), "plain");

    const result = await importShitateSnapshot({
      ...baseOptions(fixture),
      anchor: "references/images/missing-anchor.png"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.anchor_escape");
  });

  it.each([
    ["malformed", "shitate_import.manifest"],
    ["mismatch", "shitate_import.manifest_mismatch"]
  ])("rejects %s Shitate manifest identity", async (mode, code) => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.runRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (mode === "malformed") delete manifest.base_sha;
    if (mode === "mismatch") manifest.character = "other";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(code);
  });

  it("rejects an invalid project before creating a snapshot", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.configPath, "slug: invalid-only\n");

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.project_schema");
  });

  it("rejects an invalid manifest before creating a snapshot", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.manifestPath, "{}\n");

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.manifest_schema");
  });

  it("rejects a project manifest path that escapes the project directory", async () => {
    const fixture = await createFixture();
    const outsideManifest = join(dirname(fixture.projectRoot), "outside-manifest.json");
    await writeFile(outsideManifest, await readFile(fixture.manifestPath));
    const config = (await readFile(fixture.configPath, "utf8"))
      .replace("manifest: manifest.json", "manifest: ../outside-manifest.json");
    await writeFile(fixture.configPath, config);

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.manifest_escape");
  });

  it("rejects an import that would violate a dialogue presentation cast", async () => {
    const fixture = await createFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    manifest.presentation = { preset: "article-dialogue-16x9", title: "Dialogue", draft: true };
    manifest.images = [
      { id: "left-image", src: "media/existing-left.png" },
      { id: "right-image", src: "media/existing-right.png" }
    ];
    manifest.speakers = [
      { id: "left", display_name: "Left", side: "left", accent: "#111111", poses: { neutral: "left-image" } },
      { id: "right", display_name: "Right", side: "right", accent: "#222222", poses: { neutral: "right-image" } }
    ];
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.manifest_update_invalid");
  });

  it("rejects conflicting speaker and request bindings", async () => {
    const fixture = await createFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    manifest.images = [{ id: "other", src: "media/existing.png" }];
    manifest.speakers = [
      { id: "hero", display_name: "Other", side: "right", accent: "#000000", poses: { neutral: "other" } }
    ];
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);

    const speakerResult = await importShitateSnapshot(baseOptions(fixture));
    expect(speakerResult.ok).toBe(false);
    expect(speakerResult.issues[0]?.code).toBe("shitate_import.speaker_conflict");

    manifest.speakers = [];
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
    const config = parse(await readFile(fixture.configPath, "utf8"));
    config.generation.requests[0].input_mode = "image-to-video";
    config.generation.requests[0].params.image = "another.png";
    await writeFile(fixture.configPath, `${JSON.stringify(config)}\n`);

    const requestResult = await importShitateSnapshot({ ...baseOptions(fixture), requestId: "shot-1" });
    expect(requestResult.ok).toBe(false);
    expect(requestResult.issues[0]?.code).toBe("shitate_import.request_conflict");
  });

  it("rejects a missing generation request", async () => {
    const fixture = await createFixture();

    const result = await importShitateSnapshot({ ...baseOptions(fixture), requestId: "missing" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.request_missing");
  });

  it("rejects a snapshot destination symlink that escapes the project", async () => {
    const fixture = await createFixture();
    const destination = join(fixture.projectRoot, "media/shitate/hero/run-1");
    const outside = await mkdtemp(join(tmpdir(), "tsugite-import-destination-outside-"));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(outside, destination);

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.destination_escape");
  });

  it("rejects a parent symlink that would redirect a new snapshot outside the project", async () => {
    const fixture = await createFixture();
    const redirectedParent = join(fixture.projectRoot, "media/shitate/hero");
    const outside = await mkdtemp(join(tmpdir(), "tsugite-import-parent-outside-"));
    await mkdir(dirname(redirectedParent), { recursive: true });
    await symlink(outside, redirectedParent);

    const result = await importShitateSnapshot(baseOptions(fixture));

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("shitate_import.destination_escape");
  });
});

describe("optional shitate-import CLI", () => {
  it("does not require Shitate configuration for core pipeline commands", async () => {
    const fixture = await createFixture();
    const env = { ...process.env };
    delete env.SHITATE_ROOT;

    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "validate",
      "--config",
      fixture.configPath,
      "--json"
    ], { cwd: process.cwd(), encoding: "utf8", env });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "validate" });
  });

  it("imports a snapshot through the pipeline command without running generation", async () => {
    const fixture = await createFixture();

    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "shitate-import",
      "--config",
      fixture.configPath,
      "--shitate-root",
      fixture.shitateRoot,
      "--character",
      "hero",
      "--run-id",
      "run-1",
      "--request-id",
      "shot-1",
      "--json"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "shitate-import",
      character: "hero",
      run_id: "run-1",
      already_imported: false
    });
  });

  it("reports missing shitate-import arguments as structured issues", async () => {
    const fixture = await createFixture();
    const env = { ...process.env };
    delete env.SHITATE_ROOT;

    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "shitate-import",
      "--config",
      fixture.configPath,
      "--json"
    ], { cwd: process.cwd(), encoding: "utf8", env });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues.map((issue: { code: string }) => issue.code)).toEqual([
      "shitate_import.root_required",
      "shitate_import.character_required",
      "shitate_import.run_id_required"
    ]);
  });

  it("leaves the imported project ready for validate, plan, review, and dry-run", async () => {
    const fixture = await createFixture();
    const imported = runPipeline([
      "shitate-import",
      "--config",
      fixture.configPath,
      "--shitate-root",
      fixture.shitateRoot,
      "--character",
      "hero",
      "--run-id",
      "run-1",
      "--request-id",
      "shot-1",
      "--json"
    ]);
    expect(imported.status).toBe(0);

    const commands = [
      ["validate", "--config", fixture.configPath, "--json"],
      ["plan", "--config", fixture.configPath, "--json"],
      ["review", "--config", fixture.configPath, "--json"],
      ["run", "--config", fixture.configPath, "--dry-run", "--json"]
    ];
    const results = commands.map(runPipeline);

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(results[2]!.stdout)).toMatchObject({
      ok: true,
      command: "review",
      asset_count: 1,
      gate_state: "unchanged"
    });
    expect(JSON.parse(results[3]!.stdout).dry_run.executed).toBe(false);
  }, 15_000);
});

type FixtureOptions = {
  images?: Array<Record<string, unknown>>;
  manifestReferences?: string[];
};

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "tsugite-shitate-import-"));
  const shitateRoot = join(root, "shitate");
  const characterRoot = join(shitateRoot, "characters/hero");
  const runRoot = join(characterRoot, "outputs/run-1");
  const anchorPath = join(characterRoot, "references/images/main-anchor.png");
  const projectRoot = join(root, "tsugite-project");
  const configPath = join(projectRoot, "project.yaml");
  const manifestPath = join(projectRoot, "manifest.json");

  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(dirname(anchorPath), { recursive: true }),
    mkdir(join(projectRoot, "media"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(runRoot, "prompt.txt"), "hero identity prompt\n"),
    writeFile(join(runRoot, "negative.txt"), "text, watermark\n"),
    writeFile(anchorPath, Buffer.from("anchor-image")),
    writeFile(join(projectRoot, "media/background.mp4"), Buffer.from("video"))
  ]);

  const references = options.manifestReferences ?? ["references/images/main-anchor.png"];
  await writeFile(join(runRoot, "manifest.json"), `${JSON.stringify({
    run_id: "run-1",
    character: "hero",
    variant_id: "three-view",
    base_version: "v1",
    base_sha: "abc1234",
    tool: "prompt-compile",
    tool_version: "def5678",
    references,
    compiled_prompt: "hero identity prompt\n",
    compiled_negative: "text, watermark\n"
  }, null, 2)}\n`);

  await writeFile(configPath, `slug: shitate-import-test
run_id: shitate-import-test-r1
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
generation:
  connection: pixverse
  adapter: pixverse
  requests:
    - id: shot-1
      prompt: Hero walks forward while the camera tracks from the side.
      model: pixverse-v6
      duration: 5
      aspect: "16:9"
      params: {}
`);
  await writeFile(manifestPath, `${JSON.stringify({
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "shitate-import-test" },
    clips: [{
      id: "background",
      src: "media/background.mp4",
      in: 0,
      out: 5,
      duration: 5,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      audio: false
    }],
    images: options.images ?? [],
    speakers: [],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [],
    chapters: [],
    provenance: []
  }, null, 2)}\n`);

  return { shitateRoot, characterRoot, runRoot, projectRoot, configPath, manifestPath };
}

function baseOptions(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    configPath: fixture.configPath,
    shitateRoot: fixture.shitateRoot,
    character: "hero",
    runId: "run-1"
  };
}

function runPipeline(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}
