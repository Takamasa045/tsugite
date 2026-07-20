import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";

import { auditPackagedResources, auditRuntimeBoundary } from "../scripts/audit-package.mjs";

async function put(root, path, contents = path) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function fixture(runtimeRoot) {
  runtimeRoot ??= await mkdtemp(join(tmpdir(), "tsugite-package-audit-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const files = [
    "tsugite/build/cli.js",
    "tsugite/adapters/demo/adapter.yaml",
    "tsugite/backends/demo/render.mjs",
    "tsugite/connections/catalog.yaml",
    "tsugite/knowledge/story-frameworks/catalog.yaml",
    `tsugite/bin/${nodeName}`,
    "tsugite/package.json",
    "tsugite/package-lock.json",
    "viewer/index.html"
  ];
  for (const path of files) await put(runtimeRoot, path);
  await chmod(join(runtimeRoot, "tsugite", "bin", nodeName), 0o755);
  await put(runtimeRoot, "stage-manifest.json", `${JSON.stringify({
    schema_version: 1,
    generated_from: "test",
    production_dependencies_installed: false,
    files
  })}\n`);
  return { runtimeRoot, files };
}

async function packagedFixture({ extraAppFile } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-packaged-audit-"));
  const resourcesRoot = join(parent, "Resources");
  const runtimeRoot = join(resourcesRoot, "runtime");
  const appRoot = join(parent, "app");
  await fixture(runtimeRoot);
  for (const path of [
    "package.json",
    "src/main.mjs",
    "src/lifecycle.mjs",
    "src/process-runner.mjs",
    "src/runtime.mjs"
  ]) await put(appRoot, path);
  if (extraAppFile) await put(appRoot, extraAppFile, "private");
  await mkdir(resourcesRoot, { recursive: true });
  await createPackage(appRoot, join(resourcesRoot, "app.asar"));
  return resourcesRoot;
}

test("audits the stage manifest against the actual runtime directory", async () => {
  const { runtimeRoot, files } = await fixture();

  const result = await auditRuntimeBoundary(runtimeRoot);

  assert.deepEqual(result, { ok: true, runtimeRoot, stagedFileCount: files.length });
});

test("rejects forbidden and unlisted creative/runtime files", async () => {
  const { runtimeRoot } = await fixture();
  await put(runtimeRoot, "tsugite/projects/client/project.yaml", "private");

  await assert.rejects(auditRuntimeBoundary(runtimeRoot), /unlisted runtime file/);
});

test("rejects an untracked file even under an allowed runtime root", async () => {
  const { runtimeRoot } = await fixture();
  await put(runtimeRoot, "tsugite/adapters/demo/untracked.mov", "private");

  await assert.rejects(auditRuntimeBoundary(runtimeRoot), /unlisted runtime file/);
});

test("audits an app.asar containing only the explicit Desktop source allowlist", async () => {
  const resourcesRoot = await packagedFixture();

  const result = await auditPackagedResources(resourcesRoot);

  assert.equal(result.ok, true);
  assert.ok(result.asarEntryCount >= 6);
});

test("rejects an arbitrary untracked file in app.asar", async () => {
  const resourcesRoot = await packagedFixture({ extraAppFile: "notes/private.txt" });

  await assert.rejects(auditPackagedResources(resourcesRoot), /forbidden app\.asar entries/);
});
