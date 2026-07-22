import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertNoIgnoredBuildInputs,
  assertUntrackedBuildInputsAllowed,
  cleanGeneratedOutputs
} from "../scripts/clean-generated.mjs";
import { stageRuntime } from "../scripts/prepare-runtime.mjs";

async function put(root, path, contents = path) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-desktop-package-"));
  const desktopRoot = join(root, "apps", "desktop");

  await put(root, "build/cli.js", "export const built = true;\n");
  await put(root, "apps/workflow-viewer/dist/index.html", "viewer");
  await put(root, "fake-node", "node-22");
  await put(root, "package.json", '{"name":"fixture","version":"1.0.0","type":"module"}\n');
  await put(root, "package-lock.json", '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n');
  await put(root, "adapters/demo/adapter.yaml", "id: demo\n");
  await put(root, "backends/demo/render.mjs", "export {};\n");
  await put(root, "backends/remotion/alpineTourism.js", "export const AlpineTourism = {};\n");
  await put(root, "connections/catalog.yaml", "connections: []\n");
  await put(root, "knowledge/story-frameworks/catalog.yaml", "frameworks: []\n");
  await put(root, "adapters/demo/.env", "TOKEN=do-not-copy\n");
  await put(root, "adapters/demo/private-key.pem", "do-not-copy\n");
  await put(root, "adapters/demo/untracked.txt", "do-not-copy\n");
  await put(root, "projects/client/project.yaml", "do-not-copy\n");
  await put(root, "templates/paid/project.yaml", "do-not-copy\n");
  await put(root, "media/source.mov", "do-not-copy\n");
  await put(root, "output/final.mp4", "do-not-copy\n");
  await put(root, "tmp/debug.txt", "do-not-copy\n");

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json", "package-lock.json", "adapters/demo/adapter.yaml", "adapters/demo/.env", "adapters/demo/private-key.pem", "backends", "connections", "knowledge", "projects", "templates", "media", "output", "tmp"], { cwd: root });
  return { root, desktopRoot, nodeExecutable: join(root, "fake-node") };
}

test("stages generated outputs and only safe tracked runtime assets", async () => {
  const { root, desktopRoot, nodeExecutable } = await fixture();

  const result = await stageRuntime({
    repoRoot: root,
    desktopRoot,
    install: false,
    nodeExecutable,
    nodeVersion: "22.12.0",
    nodeExecutableName: "node"
  });

  assert.equal(await readFile(join(result.runtimeRoot, "tsugite", "build", "cli.js"), "utf8"), "export const built = true;\n");
  assert.equal(await readFile(join(result.runtimeRoot, "viewer", "index.html"), "utf8"), "viewer");
  assert.equal(await readFile(join(result.runtimeRoot, "tsugite", "bin", "node"), "utf8"), "node-22");
  assert.equal(await readFile(join(result.runtimeRoot, "tsugite", "adapters", "demo", "adapter.yaml"), "utf8"), "id: demo\n");
  assert.equal(await readFile(join(result.runtimeRoot, "tsugite", "connections", "catalog.yaml"), "utf8"), "connections: []\n");
  assert.equal(
    await readFile(join(result.runtimeRoot, "tsugite", "backends", "remotion", "alpineTourism.js"), "utf8"),
    "export const AlpineTourism = {};\n"
  );

  const staged = new Set(result.files);
  for (const forbidden of [
    "tsugite/adapters/demo/.env",
    "tsugite/adapters/demo/private-key.pem",
    "tsugite/adapters/demo/untracked.txt",
    "tsugite/projects/client/project.yaml",
    "tsugite/templates/paid/project.yaml",
    "tsugite/media/source.mov",
    "tsugite/output/final.mp4",
    "tsugite/tmp/debug.txt"
  ]) {
    assert.equal(staged.has(forbidden), false, forbidden);
  }
});

test("rejects symlinks inside the tracked runtime allowlist", async () => {
  const { root, desktopRoot, nodeExecutable } = await fixture();
  await symlink("adapter.yaml", join(root, "adapters", "demo", "linked.yaml"));
  execFileSync("git", ["add", "adapters/demo/linked.yaml"], { cwd: root });

  await assert.rejects(
    stageRuntime({
      repoRoot: root,
      desktopRoot,
      install: false,
      nodeExecutable,
      nodeVersion: "22.12.0",
      nodeExecutableName: "node"
    }),
    /symlink/i
  );
});

test("rejects a non-Node-22 executable", async () => {
  const { root, desktopRoot, nodeExecutable } = await fixture();

  await assert.rejects(
    stageRuntime({
      repoRoot: root,
      desktopRoot,
      install: false,
      nodeExecutable,
      nodeVersion: "23.0.0",
      nodeExecutableName: "node"
    }),
    /requires a Node 22 executable/
  );
});

test("cleans only root build and Viewer dist before packaging builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsugite-desktop-clean-"));
  await put(root, "build/notes/private.txt", "stale");
  await put(root, "apps/workflow-viewer/dist/private.mov", "stale");
  await put(root, "output/keep.txt", "keep");

  await cleanGeneratedOutputs({ repoRoot: root });

  await assert.rejects(access(join(root, "build")));
  await assert.rejects(access(join(root, "apps", "workflow-viewer", "dist")));
  assert.equal(await readFile(join(root, "output", "keep.txt"), "utf8"), "keep");
});

test("rejects untracked build inputs outside the explicit Desktop source allowlist", () => {
  assert.doesNotThrow(() => assertUntrackedBuildInputsAllowed([
    "apps/workflow-viewer/public/assets/tsugite-favicon.png",
    "apps/workflow-viewer/src/components/launcher/WorkflowCanvas.tsx",
    "apps/workflow-viewer/src/components/workspace/DesktopWorkspaceRecovery.test.tsx",
    "apps/workflow-viewer/src/components/workspace/DesktopWorkspaceRecovery.tsx",
    "apps/workflow-viewer/src/components/workspace/workspace-bridge.ts",
    "src/cli/commandCatalog.ts"
  ]));
  assert.throws(
    () => assertUntrackedBuildInputsAllowed(["apps/workflow-viewer/public/customer-private.json"]),
    /rejects untracked build inputs/
  );
  assert.throws(
    () => assertUntrackedBuildInputsAllowed(["src/private.ts"]),
    /rejects untracked build inputs/
  );
  assert.doesNotThrow(() => assertNoIgnoredBuildInputs([]));
  assert.throws(
    () => assertNoIgnoredBuildInputs([
      "apps/workflow-viewer/public/coverage/customer-report.json",
      "apps/workflow-viewer/vite.config.js"
    ]),
    /rejects ignored build inputs/
  );
});
