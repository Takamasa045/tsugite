/**
 * PO-7 active Mission Tree through unmocked writeWorkflowViewer.
 * Fixture-only: no provider, network, billing, Gate mutation, finalize apply.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../src/orchestrator/plan.js";
import {
  AUTHORITATIVE_TASK_TREE_ARTIFACT_ID,
  ArtifactStore,
  compileTaskTree,
  createDefaultTaskTreeTemplate,
  createInitialMissionState,
  compileProductionContract,
  missionStateDigest,
  SnapshotStore,
  validateTaskTreeSpec
} from "../src/productionControl/index.js";
import type { Project } from "../src/project/schema.js";
import {
  loadActiveMissionTreeProjection,
  writeWorkflowViewer
} from "../src/viewer/artifact.js";

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

function samplePlan(runId = "viewer-run"): ExecutionPlan {
  return {
    run_id: runId,
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
}

function activeProject(overrides: Partial<Project> = {}): Project {
  return {
    slug: "viewer-project",
    name: "Active Viewer",
    run_id: "viewer-run",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    orchestration: { mode: "active" },
    ...overrides
  };
}

async function createBundle(root: string): Promise<string> {
  const bundleDir = join(root, "viewer-bundle");
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><meta name="tsugite-viewer-source-version" content="test-bundle-v1"><div id="root"></div><script type="module" src="./assets/app.js"></script>\n'
  );
  await writeFile(join(bundleDir, "assets", "app.js"), "export {};\n");
  await writeFile(join(bundleDir, "assets", "app.css"), "body{}\n");
  return bundleDir;
}

async function writeCoordination(
  projectRoot: string,
  options: {
    productionId: string;
    treeRevision: number;
    taskTree?: boolean;
    treeProductionId?: string;
    treeRevisionOverride?: number;
    corruptDigest?: boolean;
  }
): Promise<{ treeDigest?: string }> {
  const coordinationRoot = join(projectRoot, "coordination");
  const state = createInitialMissionState(options.productionId);
  state.mission_status = "ready";
  state.tree_revision = options.treeRevision;
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

  const snapshotStore = new SnapshotStore(coordinationRoot);
  await snapshotStore.write(state, null);

  if (!options.taskTree) return {};

  const contract = compileProductionContract({
    project: {
      slug: "viewer-project",
      name: "Active Viewer",
      manifest: "manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" }
    },
    production_id: options.treeProductionId ?? options.productionId
  });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract),
    tree_revision: options.treeRevisionOverride ?? options.treeRevision
  });
  const payload = options.corruptDigest
    ? { ...tree, digest: "d".repeat(64) }
    : tree;
  const artifacts = new ArtifactStore(coordinationRoot);
  await artifacts.create({
    artifact_id: AUTHORITATIVE_TASK_TREE_ARTIFACT_ID,
    bytes: `${JSON.stringify(payload)}\n`
  });
  return { treeDigest: tree.digest };
}

describe("writeWorkflowViewer active Mission Tree (unmocked)", () => {
  it("writes workflow.json with exact task_tree nodes/edges and camelCase missionTree", async () => {
    const root = await realTempDir("tsugite-viewer-active-mt-");
    try {
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, "slug: viewer-project\n");
      await writeCoordination(root, {
        productionId: "prod-active-tree",
        treeRevision: 1,
        taskTree: true
      });
      const bundleDir = await createBundle(root);
      const project = activeProject();

      const result = await writeWorkflowViewer({
        configPath,
        project,
        plan: samplePlan(),
        bundleDir
      });

      const workflow = JSON.parse(await readFile(result.workflowPath, "utf8")) as {
        nodes: Array<{ id: string }>;
        edges: Array<{ id: string; source: string; target: string }>;
        missionTree?: {
          productionId: string;
          mode: string;
          taskTreeReadOnly: boolean;
          legacyWorkflowPreserved: boolean;
          currentDecision: { kind: string };
          treeRevision: number;
        };
        mission_tree?: unknown;
      };

      expect(workflow.missionTree?.mode).toBe("active");
      expect(workflow.missionTree?.productionId).toBe("prod-active-tree");
      expect(workflow.missionTree?.taskTreeReadOnly).toBe(true);
      expect(workflow.missionTree?.legacyWorkflowPreserved).toBe(true);
      expect(workflow.missionTree?.treeRevision).toBe(1);
      expect(workflow.missionTree?.currentDecision.kind).toBe("awaiting_human");
      expect(workflow.nodes.length).toBeGreaterThan(1);
      expect(workflow.edges.length).toBeGreaterThan(0);
      expect(workflow.nodes.some((node) => node.id === "generation-batch-01")).toBe(true);
      expect(JSON.stringify(workflow)).toMatch(/"missionTree"/);
      expect(JSON.stringify(workflow)).not.toMatch(/"mission_tree"\s*:/);
      expect(JSON.stringify(workflow)).not.toMatch(/subject_digest|decision_digest|approved_input_digest/);
      // snake_case mission tree keys rejected at DTO boundary
      expect(workflow.mission_tree).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy fixed 8-step path when orchestration is not active", async () => {
    const root = await realTempDir("tsugite-viewer-legacy-8-");
    try {
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, "slug: viewer-project\n");
      const bundleDir = await createBundle(root);
      const project = activeProject({ orchestration: undefined });

      const result = await writeWorkflowViewer({
        configPath,
        project,
        plan: samplePlan(),
        bundleDir
      });
      const workflow = JSON.parse(await readFile(result.workflowPath, "utf8")) as {
        nodes: Array<{ id: string }>;
        edges: unknown[];
        missionTree?: unknown;
      };
      expect(workflow.nodes).toHaveLength(9); // 8 plan steps + completed
      expect(workflow.edges).toHaveLength(8);
      expect(workflow.missionTree).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks degraded/blocked when TaskTree artifact is missing (no invented edges)", async () => {
    const root = await realTempDir("tsugite-viewer-degraded-");
    try {
      const configPath = join(root, "project.yaml");
      await writeFile(configPath, "slug: viewer-project\n");
      await writeCoordination(root, {
        productionId: "prod-missing-tree",
        treeRevision: 1,
        taskTree: false
      });
      const projection = await loadActiveMissionTreeProjection(root, activeProject());
      expect(projection?.current_decision.kind).toBe("blocked");
      expect(projection?.current_decision.reason_code).toBe("mission_tree.task_tree_unavailable");
      expect(projection?.nodes).toEqual([]);
      expect(projection?.edges).toEqual([]);
      expect(JSON.stringify(projection)).not.toMatch(/subject_digest|decision_digest/);

      const bundleDir = await createBundle(root);
      const result = await writeWorkflowViewer({
        configPath,
        project: activeProject(),
        plan: samplePlan(),
        bundleDir
      });
      const workflow = JSON.parse(await readFile(result.workflowPath, "utf8")) as {
        nodes: unknown[];
        edges: unknown[];
        missionTree?: { currentDecision: { kind: string; reasonCode?: string } };
      };
      expect(workflow.nodes).toHaveLength(0);
      expect(workflow.edges).toHaveLength(0);
      expect(workflow.missionTree?.currentDecision.kind).toBe("blocked");
      expect(workflow.missionTree?.currentDecision.reasonCode).toBe(
        "mission_tree.task_tree_unavailable"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fail-closes on production_id / tree_revision / digest mismatch", async () => {
    const root = await realTempDir("tsugite-viewer-mismatch-");
    try {
      await writeCoordination(root, {
        productionId: "prod-match",
        treeRevision: 1,
        taskTree: true,
        treeProductionId: "prod-other"
      });
      await expect(loadActiveMissionTreeProjection(root, activeProject())).rejects.toThrow(
        /production_id mismatch|task tree/
      );

      const revRoot = await realTempDir("tsugite-viewer-rev-");
      try {
        await writeCoordination(revRoot, {
          productionId: "prod-rev",
          treeRevision: 2,
          taskTree: true,
          treeRevisionOverride: 1
        });
        await expect(loadActiveMissionTreeProjection(revRoot, activeProject())).rejects.toThrow(
          /tree_revision mismatch|task tree/
        );
      } finally {
        await rm(revRoot, { recursive: true, force: true });
      }

      const digRoot = await realTempDir("tsugite-viewer-dig-");
      try {
        await writeCoordination(digRoot, {
          productionId: "prod-dig",
          treeRevision: 1,
          taskTree: true,
          corruptDigest: true
        });
        await expect(loadActiveMissionTreeProjection(digRoot, activeProject())).rejects.toThrow(
          /digest|task tree|invalid/i
        );
      } finally {
        await rm(digRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves snapshot state_digest identity and never invents tree structure", async () => {
    const root = await realTempDir("tsugite-viewer-identity-");
    try {
      await writeCoordination(root, {
        productionId: "prod-identity",
        treeRevision: 1,
        taskTree: true
      });
      const snapshot = await new SnapshotStore(join(root, "coordination")).read();
      expect(snapshot).toBeDefined();
      expect(snapshot!.state_digest).toBe(missionStateDigest(snapshot!.state));

      const projection = await loadActiveMissionTreeProjection(root, activeProject());
      expect(projection?.production_id).toBe("prod-identity");
      expect(projection?.tree_revision).toBe(1);
      expect(projection?.task_tree_read_only).toBe(true);
      // validate tree on disk is still exact
      const raw = await new ArtifactStore(join(root, "coordination")).read(
        AUTHORITATIVE_TASK_TREE_ARTIFACT_ID
      );
      const tree = validateTaskTreeSpec(JSON.parse(raw.toString("utf8")));
      expect(tree.production_id).toBe("prod-identity");
      expect(projection?.edges.length).toBeGreaterThan(0);
      expect(projection?.nodes.map((node) => node.node_id).sort()).toEqual(
        tree.nodes.map((node) => node.node_id).sort()
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
