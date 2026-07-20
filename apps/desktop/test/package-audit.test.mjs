import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackageWithOptions } from "@electron/asar";

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

const nativeTarget = `${process.platform}-${process.arch}`;
const nativeRuntimeFiles = process.platform === "win32"
  ? ["pty.node", "winpty-agent.exe", "winpty.dll"]
  : ["pty.node", "spawn-helper"];
const nativeRoots = ["build/Release", `prebuilds/${nativeTarget}`];
const nativeUnpackPattern = `{**/node_modules/node-pty/build/Release/**,**/node_modules/node-pty/prebuilds/${nativeTarget}/**}`;

async function packagedFixture({
  extraAppFile,
  omitAppFile,
  omitTargetNativeFiles = false,
  executableHelper = true,
  extraUnpackedFile
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-packaged-audit-"));
  const resourcesRoot = join(parent, "Resources");
  const runtimeRoot = join(resourcesRoot, "runtime");
  const appRoot = join(parent, "app");
  await fixture(runtimeRoot);
  for (const path of [
    "package.json",
    "src/main.mjs",
    "src/preload.mjs",
    "src/agent-terminal.mjs",
    "src/lifecycle.mjs",
    "src/process-runner.mjs",
    "src/runtime.mjs"
  ]) {
    if (path !== omitAppFile) await put(appRoot, path);
  }
  await put(appRoot, "node_modules/node-pty/package.json", '{"name":"node-pty","version":"1.0.0"}\n');
  if (!omitTargetNativeFiles) {
    for (const root of nativeRoots) {
      for (const file of nativeRuntimeFiles) {
        const path = join(appRoot, "node_modules", "node-pty", root, file);
        await put(appRoot, `node_modules/node-pty/${root}/${file}`, "native");
        if (file === "spawn-helper" && executableHelper) await chmod(path, 0o755);
      }
    }
  } else {
    await put(appRoot, "node_modules/node-pty/prebuilds/wrong-arch/pty.node", "wrong native");
  }
  if (extraAppFile) await put(appRoot, extraAppFile, "private");
  await mkdir(resourcesRoot, { recursive: true });
  await createPackageWithOptions(appRoot, join(resourcesRoot, "app.asar"), {
    unpack: nativeUnpackPattern
  });
  if (extraUnpackedFile) {
    await put(resourcesRoot, `app.asar.unpacked/${extraUnpackedFile}`, "private");
  }
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
  assert.equal(result.unpackedNativeFileCount, nativeRoots.length * nativeRuntimeFiles.length);
});

test("rejects a package missing an allowlisted Desktop source", async () => {
  const resourcesRoot = await packagedFixture({ omitAppFile: "src/preload.mjs" });

  await assert.rejects(auditPackagedResources(resourcesRoot), /missing required app\.asar entries.*preload/i);
});

test("rejects a package missing native files for the target platform and architecture", async () => {
  const resourcesRoot = await packagedFixture({ omitTargetNativeFiles: true });

  await assert.rejects(auditPackagedResources(resourcesRoot), /targeted node-pty runtime/i);
});

if (process.platform !== "win32") {
  test("rejects a non-executable node-pty spawn helper", async () => {
    const resourcesRoot = await packagedFixture({ executableHelper: false });

    await assert.rejects(auditPackagedResources(resourcesRoot), /non-executable node-pty spawn helper/i);
  });
}

test("rejects unpacked files outside node-pty", async () => {
  const resourcesRoot = await packagedFixture({ extraUnpackedFile: "notes/private.txt" });

  await assert.rejects(auditPackagedResources(resourcesRoot), /forbidden app\.asar\.unpacked entries/);
});

test("rejects an arbitrary untracked file in app.asar", async () => {
  const resourcesRoot = await packagedFixture({ extraAppFile: "notes/private.txt" });

  await assert.rejects(auditPackagedResources(resourcesRoot), /forbidden app\.asar entries/);
});
