import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "./digest.mjs";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

export const OFFICIAL_EXAMPLE_RELATIVE = "examples/semantic-composition";
export const OFFICIAL_SOURCE_FILES = Object.freeze([
  "chat.svml",
  "chat.svs",
  "chat.svrun",
  "hypit.runtime.json"
]);
export const OFFICIAL_PACKAGE_SOURCES = Object.freeze([
  "packages/chat-scene/src/activation.ts",
  "packages/chat-scene/src/render.ts"
]);
export const PHASE1_CHECK_SOURCE = "chat.svml";
export const PHASE1_PLAN_SOURCE = "chat.svrun";
export const PHASE1_ALLOWED_FLAGS = Object.freeze(["--workspace", "--json", "--no-color"]);
export const PHASE1_DENIED_OVERRIDES = Object.freeze([
  "--package-root",
  "--runtime",
  "--asset-root"
]);

export function officialExampleDir(adapterRoot = ADAPTER_ROOT) {
  return join(adapterRoot, "runtime", "node_modules", "@hypit", "hypit", OFFICIAL_EXAMPLE_RELATIVE);
}

export function phase1WorkspaceDir(repo = REPO) {
  return join(repo, ".tsugite", "tools", "hypit-phase1-workspace");
}

export function phase1HostStateDir(repo = REPO) {
  return join(repo, ".tsugite", "tools", "hypit-host-state");
}

function untrusted(message) {
  const error = new Error(message);
  error.code = "HYPIT_UNTRUSTED_SOURCE";
  return error;
}

export function realExisting(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw untrusted(`Path does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

export function assertCopyMatchesOfficial(workspace, adapterRoot = ADAPTER_ROOT) {
  const official = realExisting(officialExampleDir(adapterRoot));
  const copy = realExisting(workspace);
  const mismatches = [];
  for (const relativePath of [...OFFICIAL_SOURCE_FILES, ...OFFICIAL_PACKAGE_SOURCES]) {
    const left = readFileSync(join(official, relativePath));
    const right = readFileSync(join(copy, relativePath));
    if (sha256Bytes(left) !== sha256Bytes(right)) mismatches.push(relativePath);
  }
  if (mismatches.length > 0) {
    throw untrusted(`Workspace is not the pinned official example; drifted: ${mismatches.join(", ")}`);
  }
  return { official, copy };
}

export function loadExpectedBuild(adapterRoot = ADAPTER_ROOT) {
  const path = join(adapterRoot, "expected-build.json");
  if (!existsSync(path)) {
    throw untrusted(`Missing expected-build.json at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function assertExpectedActivationBytes(workspace, adapterRoot = ADAPTER_ROOT) {
  const expected = loadExpectedBuild(adapterRoot);
  const copy = realExisting(workspace);
  const mismatches = [];
  for (const [relativePath, want] of Object.entries(expected.files ?? {})) {
    const path = join(copy, relativePath);
    if (!existsSync(path)) {
      mismatches.push(`${relativePath} missing`);
      continue;
    }
    const bytes = readFileSync(path);
    const sha256 = sha256Bytes(bytes);
    if (sha256 !== want.sha256 || bytes.length !== want.bytes) {
      mismatches.push(relativePath);
    }
  }
  if (mismatches.length > 0) {
    throw untrusted(`Activation/build bytes do not match pinned expected-build.json: ${mismatches.join(", ")}`);
  }
}

export function assertExactPhase1Workspace(candidate, repo = REPO) {
  const prepared = phase1WorkspaceDir(repo);
  if (!existsSync(prepared)) {
    throw untrusted("Phase 1 workspace is not prepared. Run npm run hypit:spike.");
  }
  const path = realExisting(candidate);
  const expected = realpathSync(prepared);
  if (path !== expected) {
    throw untrusted(
      `Phase 1 check/plan require the exact prepared workspace ${expected}. This is not arbitrary-source isolation.`
    );
  }
  return path;
}

function flagName(item) {
  const eq = item.indexOf("=");
  return eq === -1 ? item : item.slice(0, eq);
}

/**
 * Exact Phase 1 check/plan argv: one official basename, required --workspace,
 * optional --json/--no-color, no root/runtime/package overrides anywhere.
 */
export function parsePhase1CheckPlanArgv(argv) {
  const command = argv[0];
  if (command !== "check" && command !== "plan") return undefined;
  const positionals = [];
  let workspace;
  const extras = [];
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") continue;
    if (item.startsWith("-")) {
      const name = flagName(item);
      if (PHASE1_DENIED_OVERRIDES.includes(name)) {
        throw untrusted(
          `Phase 1 refuses ${name} on check/plan, including after a positional source.`
        );
      }
      if (!PHASE1_ALLOWED_FLAGS.includes(name)) {
        throw untrusted(`Phase 1 check/plan refuse flag ${name}`);
      }
      if (name === "--workspace") {
        if (item.includes("=")) {
          throw untrusted("Phase 1 --workspace must be a separate argument");
        }
        const value = argv[index + 1];
        if (typeof value !== "string" || value.startsWith("-")) {
          throw untrusted("Phase 1 --workspace requires a path");
        }
        if (workspace !== undefined) {
          throw untrusted("Phase 1 --workspace may appear once");
        }
        workspace = value;
        index += 1;
        continue;
      }
      extras.push(name);
      continue;
    }
    positionals.push(item);
  }
  return { command, positionals, workspace, extras };
}

export function assertPhase1ObserveTarget(argv, cwd, adapterRoot = ADAPTER_ROOT, repo = REPO) {
  const parsed = parsePhase1CheckPlanArgv(argv);
  if (parsed === undefined) return;
  const expectedName = parsed.command === "check" ? PHASE1_CHECK_SOURCE : PHASE1_PLAN_SOURCE;
  if (parsed.positionals.length !== 1) {
    throw untrusted(`Phase 1 ${parsed.command} requires exactly one source: ${expectedName}`);
  }
  if (parsed.workspace === undefined) {
    throw untrusted("Phase 1 check/plan require --workspace <prepared-official-copy>");
  }
  const workspace = assertExactPhase1Workspace(parsed.workspace, repo);
  const sourceArg = parsed.positionals[0];
  if (basename(sourceArg) !== expectedName) {
    throw untrusted(`Phase 1 ${parsed.command} source must be named ${expectedName}`);
  }
  const source = realExisting(resolve(cwd, sourceArg));
  if (source !== join(workspace, expectedName)) {
    throw untrusted(`Phase 1 ${parsed.command} source must be ${join(workspace, expectedName)}`);
  }
  assertCopyMatchesOfficial(workspace, adapterRoot);
  assertExpectedActivationBytes(workspace, adapterRoot);
  const unexpected = listUnexpectedJs(workspace);
  if (unexpected.length > 0) {
    throw untrusted(`Unexpected JS in official copy: ${unexpected.join(", ")}`);
  }
}

export function listUnexpectedJs(workspace) {
  const unexpected = [];
  const allowedDist = new Set([
    `packages${sep}chat-scene${sep}dist${sep}activation.js`,
    `packages${sep}chat-scene${sep}dist${sep}render.js`
  ]);
  walk(workspace, (path, stat) => {
    if (!stat.isFile()) return;
    if (!/\.(js|mjs|cjs)$/u.test(path)) return;
    const rel = relative(workspace, path);
    if (rel.split(sep).includes("node_modules")) return;
    if (allowedDist.has(rel)) return;
    unexpected.push(rel);
  });
  return unexpected;
}

function walk(root, visit) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    visit(path, stat);
    if (stat.isDirectory() && name !== ".git") walk(path, visit);
  }
}
