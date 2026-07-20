#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BUILD_INPUT_ROOTS = ["src", join("apps", "workflow-viewer")];
const IGNORED_BUILD_INPUT_ROOTS = [
  "src",
  join("apps", "workflow-viewer", "src"),
  join("apps", "workflow-viewer", "public"),
  ":(glob)apps/workflow-viewer/.env*",
  ":(glob)apps/workflow-viewer/vite.config.*"
];
const ALLOWED_UNTRACKED_BUILD_INPUTS = new Set([
  "apps/workflow-viewer/public/assets/tsugite-favicon.png",
  "apps/workflow-viewer/src/components/launcher/WorkflowCanvas.test.tsx",
  "apps/workflow-viewer/src/components/launcher/WorkflowCanvas.tsx",
  "apps/workflow-viewer/src/components/launcher/index.ts",
  "apps/workflow-viewer/src/components/launcher/workflow-canvas.css"
]);

function assertSafeGeneratedPath(repoRoot, path) {
  const relativePath = relative(repoRoot, path);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to clean unsafe generated path: ${path}`);
  }
  if (relativePath !== "build" && relativePath !== join("apps", "workflow-viewer", "dist")) {
    throw new Error(`Refusing to clean non-generated path: ${path}`);
  }
}

export async function cleanGeneratedOutputs({ repoRoot } = {}) {
  const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
  const resolvedRepoRoot = resolve(repoRoot ?? join(desktopRoot, "..", ".."));
  const generatedPaths = [
    join(resolvedRepoRoot, "build"),
    join(resolvedRepoRoot, "apps", "workflow-viewer", "dist")
  ];
  for (const path of generatedPaths) {
    assertSafeGeneratedPath(resolvedRepoRoot, path);
    await rm(path, { recursive: true, force: true });
  }
  return generatedPaths;
}

export function assertUntrackedBuildInputsAllowed(paths, allowed = ALLOWED_UNTRACKED_BUILD_INPUTS) {
  const unexpected = paths.filter((path) => !allowed.has(path.replaceAll("\\", "/"))).sort();
  if (unexpected.length > 0) {
    throw new Error(`Desktop packaging rejects untracked build inputs: ${unexpected.join(", ")}`);
  }
}

export function assertNoIgnoredBuildInputs(paths) {
  if (paths.length > 0) {
    throw new Error(`Desktop packaging rejects ignored build inputs: ${paths.sort().join(", ")}`);
  }
}

export async function verifyBuildInputBoundary({ repoRoot } = {}) {
  const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
  const resolvedRepoRoot = resolve(repoRoot ?? join(desktopRoot, "..", ".."));
  const { stdout } = await execFile(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...BUILD_INPUT_ROOTS],
    { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  const untracked = stdout.split("\0").filter(Boolean);
  assertUntrackedBuildInputsAllowed(untracked);
  const { stdout: ignoredStdout } = await execFile(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...IGNORED_BUILD_INPUT_ROOTS],
    { cwd: resolvedRepoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  const ignored = ignoredStdout.split("\0").filter(Boolean);
  assertNoIgnoredBuildInputs(ignored);
  return { untracked: untracked.sort(), ignored: ignored.sort() };
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const buildInputs = await verifyBuildInputBoundary();
  const cleaned = await cleanGeneratedOutputs();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    cleaned,
    allowed_untracked_inputs: buildInputs.untracked,
    ignored_build_inputs: buildInputs.ignored
  })}\n`);
}
