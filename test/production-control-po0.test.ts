import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "../src/integrity/canonical.js";
import {
  computeRequestDigest
} from "../src/generationJobs/approval.js";
import {
  canTransition,
  isResumableWithProviderJob
} from "../src/generationJobs/transitions.js";
import { parseGenerationJobRecord } from "../src/generationJobs/schema.js";
import { manifestSchema } from "../src/manifest/schema.js";
import { CLEANUP_ROOT_NAMES } from "../src/orchestrator/finalizePlanHelpers.js";
import { parseRunState } from "../src/orchestrator/statePersistence.js";
import { loadProject } from "../src/project/loadProject.js";
import {
  startWorkflowViewerLauncher,
  type LauncherProject,
  type WorkflowViewerLauncher
} from "../src/viewer/launcher.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "production-control", "legacy");

const DESIGN_DOCUMENTS = [
  "docs/design/README.md",
  "docs/design/production-orchestration-v1/README.md",
  "docs/design/production-orchestration-v1/architecture.md",
  "docs/design/production-orchestration-v1/contracts.md",
  "docs/design/production-orchestration-v1/h3-prompt-v3.md",
  "docs/design/production-orchestration-v1/implementation-plan.md",
  "docs/design/production-orchestration-v1/launcher-and-visualization.md",
  "docs/design/production-orchestration-v1/learning-loop.md",
  "docs/design/production-orchestration-v1/migration-and-release.md",
  "docs/design/production-orchestration-v1/mv-workflow.md",
  "docs/design/production-orchestration-v1/observability-and-evaluation.md",
  "docs/design/production-orchestration-v1/runtime-and-recovery.md"
] as const;

type JsonRecord = Record<string, unknown>;

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8")) as T;
}

function walkJson(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walkJson(child, visit);
  }
}

function normalizeLauncherProject(project: LauncherProject): JsonRecord {
  const normalized: JsonRecord = JSON.parse(JSON.stringify(project)) as JsonRecord;
  normalized.id = "<opaque-project-id>";
  normalized.revision = "<sha256-project-revision>";
  for (const key of ["viewerUrl", "gate1ReviewUrl", "gate2ReviewUrl", "thumbnailUrl"]) {
    if (key in normalized) normalized[key] = "<loopback-url>";
  }
  return normalized;
}

async function launchLegacyProject(): Promise<{
  launcher: WorkflowViewerLauncher;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-po0-launcher-"));
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "local-fixture");
  const templatesDir = join(root, "templates");
  const bundleDir = join(root, "bundle");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await cp(join(REPO_ROOT, "examples", "local-fixture"), projectDir, { recursive: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>\n"
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "globalThis.__po0 = true;\n");

  const launcher = await startWorkflowViewerLauncher({
    projectsDir,
    templatesDir,
    bundleDir,
    linkProjectShelves: false,
    port: 0
  });
  const response = await fetch(`${launcher.url}/api/projects`);
  const payload = await response.json() as { projects: LauncherProject[] };
  const project = payload.projects.find((candidate) => candidate.slug === "local-fixture");
  if (!project) {
    await launcher.close();
    await rm(root, { recursive: true, force: true });
    throw new Error("legacy launcher fixture project was not discovered");
  }
  return { launcher, root };
}

describe("PO-0 legacy baseline freeze", () => {
  it("proves the design pack is byte-identical and every frozen file matches its inventory hash", async () => {
    const manifest = await readJson<{
      schema_version: number;
      design_pack: { documents: Array<{ path: string; sha256: string; byte_length: number }> };
      fixtures: Array<{
        path: string;
        sha256: string;
        byte_length: number;
        canonical_sha256?: string;
      }>;
    }>("manifest.json");

    expect(manifest.schema_version).toBe(1);
    expect(manifest.design_pack.documents.map((document) => document.path)).toEqual([...DESIGN_DOCUMENTS]);
    for (const document of manifest.design_pack.documents) {
      const bytes = await readFile(join(REPO_ROOT, document.path));
      expect(bytes.byteLength, document.path).toBe(document.byte_length);
      expect(sha256Bytes(bytes), document.path).toBe(document.sha256);
    }

    const fixturePaths = new Set(manifest.fixtures.map((fixture) => fixture.path));
    expect(fixturePaths.size).toBe(manifest.fixtures.length);
    for (const fixture of manifest.fixtures) {
      expect(fixture.path.startsWith("/"), fixture.path).toBe(false);
      expect(fixture.path.includes(".."), fixture.path).toBe(false);
      const bytes = await readFile(join(FIXTURE_ROOT, fixture.path));
      expect(bytes.byteLength, fixture.path).toBe(fixture.byte_length);
      expect(sha256Bytes(bytes), fixture.path).toBe(fixture.sha256);
      if (fixture.canonical_sha256) {
        expect(fixture.path.endsWith(".json"), fixture.path).toBe(true);
        expect(sha256Canonical(JSON.parse(bytes.toString("utf8"))), fixture.path)
          .toBe(fixture.canonical_sha256);
      }
    }

    const diskFiles = (await readdir(FIXTURE_ROOT)).filter((name) => name !== "manifest.json");
    expect(diskFiles.sort()).toEqual([...fixturePaths].sort());
  });

  it("uses sorted object keys while preserving meaningful array order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(sha256Canonical({ order: ["first", "second"] }))
      .not.toBe(sha256Canonical({ order: ["second", "first"] }));
  });

  it("freezes project and Gate state from the current legacy parser", async () => {
    const snapshot = await readJson<{
      project: JsonRecord;
      manifest: JsonRecord;
    }>("project.json");
    const project = await loadProject(join(REPO_ROOT, "examples", "local-fixture", "project.yaml"));
    const manifest = manifestSchema.parse(JSON.parse(
      await readFile(join(REPO_ROOT, "examples", "local-fixture", "manifest.json"), "utf8")
    ));

    expect(snapshot.project).toEqual({
      slug: project.slug,
      name: project.name,
      run_id: project.run_id,
      manifest: project.manifest,
      dist_dir: project.dist_dir,
      edit: project.edit
    });
    expect(snapshot.manifest).toEqual({
      meta: manifest.meta,
      clips: manifest.clips,
      images: manifest.images,
      speakers: manifest.speakers,
      audio: manifest.audio,
      captions: manifest.captions,
      chapters: manifest.chapters,
      provenance: manifest.provenance
    });

    const gateState = await readJson<unknown>("gate-state.json");
    expect(parseRunState(gateState)).toEqual(gateState);
    expect(gateState).toMatchObject({
      run_id: "legacy-baseline-run",
      status: "completed",
      gates: {
        gate_1: { status: "approved", decision_source: "human" },
        gate_2: { status: "approved", decision_source: "auto_qc" },
        gate_3: { status: "approved", decision_source: "human" }
      }
    });
  });

  it("freezes finalize retention and completion-record boundaries as relative data", async () => {
    const snapshot = await readJson<{
      retention_roots: string[];
      relative_media: { retained: string[]; candidates: string[] };
      result_shape: string[];
      apply_requirements: JsonRecord;
    }>("finalize.json");
    expect(snapshot.retention_roots).toEqual([...CLEANUP_ROOT_NAMES]);
    expect(snapshot.relative_media.retained.every((path) => !path.startsWith("/"))).toBe(true);
    expect(snapshot.relative_media.candidates.every((path) => !path.startsWith("/"))).toBe(true);
    expect(snapshot.result_shape).toEqual(expect.arrayContaining([
      "ok", "issues", "applied", "mediaFiles", "retainedMedia", "plannedBytes",
      "deletedFiles", "deletedBytes", "planDigest"
    ]));
    expect(snapshot.apply_requirements).toEqual({
      expected_plan_digest: "required",
      completion_record: "retained",
      superseded_media_only: true,
      control_plane_records: "legacy_not_recorded"
    });
  });

  it("freezes generation-job no-resubmit truth and an H3 artifact metadata-only snapshot", async () => {
    const jobSnapshot = await readJson<{ record: Parameters<typeof parseGenerationJobRecord>[0] }>("generation-job.json");
    const job = parseGenerationJobRecord(jobSnapshot.record);
    expect(computeRequestDigest(job.request)).toBe(job.request.digest);
    expect(job.status).toBe("submission_unknown");
    expect(job.submission_unknown).toBe(true);
    expect(job.provider_job_id).toBeUndefined();
    expect(canTransition("submission_unknown", "submitting")).toBe(false);
    expect(isResumableWithProviderJob("submission_unknown")).toBe(true);

    const h3Snapshot = await readJson<JsonRecord>("h3-artifact.json");
    const legacyGolden = JSON.parse(await readFile(
      join(REPO_ROOT, "test", "fixtures", "h3", "goldens", "t2v.json"),
      "utf8"
    )) as JsonRecord;
    expect(h3Snapshot).toMatchObject({
      workflow_id: legacyGolden.workflow_id,
      workflow_version: legacyGolden.workflow_version,
      creative_ir_sha256: legacyGolden.creative_ir_hash,
      canonical_prompt_sha256: legacyGolden.canonical_prompt_hash,
      adapter_prompt_sha256: legacyGolden.adapter_prompt_hash,
      validation_ok: legacyGolden.validation_ok,
      warning_codes: legacyGolden.warning_codes,
      compile_ok: legacyGolden.compile_ok
    });
    expect(h3Snapshot).not.toHaveProperty("canonical_prompt");
    expect(h3Snapshot).not.toHaveProperty("adapter_prompt");
    expect(h3Snapshot).not.toHaveProperty("provider_response");
  });

  it("keeps historical metric gaps explicit as legacy_not_recorded", async () => {
    const inventory = await readJson<{
      schema_version: number;
      fields: Array<{ path: string; status: "recorded" | "legacy_not_recorded"; source: string; value?: unknown }>;
    }>("baseline-metric-fields.json");
    expect(inventory.schema_version).toBe(1);
    expect(inventory.fields.length).toBeGreaterThan(0);
    expect(inventory.fields.some((field) => field.status === "legacy_not_recorded")).toBe(true);
    for (const field of inventory.fields) {
      expect(field.path).not.toMatch(/^\//);
      expect(field.source).not.toMatch(/^\//);
      if (field.status === "legacy_not_recorded") expect(field).not.toHaveProperty("value");
    }
    expect(inventory.fields.filter((field) => field.status === "recorded").map((field) => field.path))
      .toEqual(expect.arrayContaining(["plan.estimated_credits", "manifest.provenance[].credits"]));
    expect(inventory.fields.filter((field) => field.status === "legacy_not_recorded").map((field) => field.path))
      .toEqual(expect.arrayContaining([
        "mission.metrics.human_interventions_total",
        "mission.metrics.automatic_recovery_success_rate",
        "mission.metrics.safety.unauthorized_external_submit",
        "mission.metrics.mv.lyric_timing_coverage"
      ]));
  });

  it("freezes the current public Launcher DTO without identity URLs or paths", async () => {
    const expected = await readJson<JsonRecord>("launcher-dto.json");
    const { launcher, root } = await launchLegacyProject();
    try {
      const response = await fetch(`${launcher.url}/api/projects`);
      expect(response.status).toBe(200);
      const payload = await response.json() as { projects: LauncherProject[] };
      const project = payload.projects.find((candidate) => candidate.slug === "local-fixture");
      expect(project).toBeDefined();
      const normalized = normalizeLauncherProject(project!);
      expect(normalized).toEqual(expected);
      expect(JSON.stringify(normalized)).not.toContain(REPO_ROOT);
      expect(JSON.stringify(normalized)).not.toMatch(/\/(?:Users|private|tmp|var)\//);
    } finally {
      await launcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects secret, prompt body, provider body, and absolute path leakage in all legacy fixture JSON", async () => {
    const manifest = await readJson<{ fixtures: Array<{ path: string }> }>("manifest.json");
    const forbiddenKeys = /^(?:secret|api_key|password|authorization|provider_response|raw_provider_response|provider_body|prompt|token)$/i;
    for (const fixture of manifest.fixtures.filter((entry) => entry.path.endsWith(".json"))) {
      const value = await readJson<unknown>(fixture.path);
      walkJson(value, (key, child) => {
        expect(key, `${fixture.path}:${key}`).not.toMatch(forbiddenKeys);
        if (typeof child === "string") {
          expect(child, fixture.path).not.toMatch(/\/(?:Users|private|tmp|var)\//);
        }
      });
    }
  });
});
