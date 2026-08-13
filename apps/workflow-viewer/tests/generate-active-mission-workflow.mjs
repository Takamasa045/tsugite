/**
 * Fixture helper for R3 App E2E: unmocked writeWorkflowViewer → workflow.json.
 * Run from repo root with Node. No provider / Gate / finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, "../../..");

const { writeWorkflowViewer } = await import(join(repoRoot, "build/viewer/artifact.js"));
const { SnapshotStore } = await import(join(repoRoot, "build/productionControl/statePersistence.js"));
const { ArtifactStore } = await import(join(repoRoot, "build/productionControl/artifactStore.js"));
const { createInitialMissionState } = await import(join(repoRoot, "build/productionControl/reducer.js"));
const { compileProductionContract } = await import(join(repoRoot, "build/productionControl/contractCompiler.js"));
const { createDefaultTaskTreeTemplate } = await import(join(repoRoot, "build/productionControl/taskTreeTemplates.js"));
const { compileTaskTree } = await import(join(repoRoot, "build/productionControl/taskTreeCompiler.js"));
const { AUTHORITATIVE_TASK_TREE_ARTIFACT_ID } = await import(
  join(repoRoot, "build/productionControl/authoritativeCoordination.js")
);

const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const root = await realpath(await mkdtemp(join(base, "tsugite-viewer-r3-e2e-")));

try {
  const configPath = join(root, "project.yaml");
  await writeFile(configPath, "slug: viewer-project\n");

  const productionId = "prod-r3-e2e";
  const state = createInitialMissionState(productionId);
  state.mission_status = "ready";
  state.tree_revision = 1;
  state.applied_event_sequence = 1;
  state.applied_event_digest = "a".repeat(64);
  state.nodes["generation-batch-01"] = {
    node_id: "generation-batch-01",
    status: "awaiting_human",
    task_revision: 1,
    input_digest: "b".repeat(64),
    dependency_closure_digest: "c".repeat(64),
    stale: false
  };
  await new SnapshotStore(join(root, "coordination")).write(state, null);

  const contract = compileProductionContract({
    project: {
      slug: "viewer-project",
      name: "R3 E2E",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" }
    },
    production_id: productionId
  });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract),
    tree_revision: 1
  });
  await new ArtifactStore(join(root, "coordination")).create({
    artifact_id: AUTHORITATIVE_TASK_TREE_ARTIFACT_ID,
    bytes: `${JSON.stringify(tree)}\n`
  });

  const bundleDir = join(root, "viewer-bundle");
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><meta name="tsugite-viewer-source-version" content="test-bundle-v1"><div id="root"></div><script type="module" src="./assets/app.js"></script>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "export {};\n");
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");

  const plan = {
    run_id: "viewer-run",
    slug: "viewer-project",
    name: "viewer-project",
    backend: "remotion",
    target_duration_seconds: 30,
    total_clip_duration_seconds: 30,
    estimated_credits: 0,
    clips: [],
    agent_handoffs: [],
    steps: [
      { name: "validate", status: "pending" },
      { name: "analysis-handoff", status: "pending" },
      { name: "creative-review", status: "pending" },
      { name: "gate-1", status: "gate" },
      { name: "assemble-manifest", status: "pending" },
      { name: "gate-2", status: "gate" },
      { name: "render", status: "pending" },
      { name: "gate-3", status: "gate" }
    ]
  };

  const result = await writeWorkflowViewer({
    configPath,
    project: {
      slug: "viewer-project",
      name: "R3 E2E Active",
      run_id: "viewer-run",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      orchestration: { mode: "active" }
    },
    plan,
    bundleDir
  });

  const workflow = JSON.parse(await readFile(result.workflowPath, "utf8"));
  process.stdout.write(JSON.stringify({ workflowPath: result.workflowPath, workflow }));
} finally {
  await rm(root, { recursive: true, force: true });
}
