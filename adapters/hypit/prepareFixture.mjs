import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hypitChildEnv } from "./runtimeAdapter.mjs";
import {
  OFFICIAL_EXAMPLE_RELATIVE,
  assertCopyMatchesOfficial,
  listUnexpectedJs,
  officialExampleDir,
  phase1HostStateDir,
  phase1WorkspaceDir
} from "./trust.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

export function prepareLabeledOfficialExample(repo = REPO, adapterRoot) {
  const source = officialExampleDir(adapterRoot);
  if (!existsSync(source)) {
    throw new Error(`Official example missing at ${source}. Run npm run hypit:install.`);
  }
  const workspace = phase1WorkspaceDir(repo);
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(source, workspace, { recursive: true });
  writeFileSync(join(workspace, "SYNTHETIC-FIXTURE.txt"), [
    "SYNTHETIC / OFFICIAL-EXAMPLE FIXTURE — NOT a user reference analysis.",
    `Byte-copied from pinned @hypit/hypit@0.1.8 ${OFFICIAL_EXAMPLE_RELATIVE}.`,
    "No input video was supplied for this Phase 1 spike.",
    ""
  ].join("\n"));
  return workspace;
}

export function rewriteChatSceneDependency(workspace, distributionRoot) {
  const manifestPath = join(workspace, "packages", "chat-scene", "package.json");
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (pkg.name !== "@example/chat-scene") {
    throw new Error(`Refusing to compile unexpected package ${pkg.name}`);
  }
  pkg.devDependencies = { ...pkg.devDependencies, "@hypit/hypit": distributionRoot };
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return manifestPath;
}

export function buildChatScene(workspace) {
  const pkg = join(workspace, "packages", "chat-scene");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: pkg,
    encoding: "utf8",
    env: hypitChildEnv(process.env)
  });
  if (install.status !== 0) {
    throw new Error(`chat-scene npm install failed: ${install.stderr || install.stdout}`);
  }
  const tsc = join(pkg, "node_modules", ".bin", "tsc");
  const build = spawnSync(tsc, ["-p", "tsconfig.json"], {
    cwd: pkg,
    encoding: "utf8",
    env: hypitChildEnv(process.env)
  });
  if (build.status !== 0) {
    throw new Error(`chat-scene tsc failed: ${build.stderr || build.stdout}`);
  }
  return join(pkg, "dist", "activation.js");
}

export async function prepareTrustedOfficialWorkspace(repo = REPO, adapterRoot) {
  const workspace = prepareLabeledOfficialExample(repo, adapterRoot);
  await assertCopyMatchesOfficial(workspace, adapterRoot);
  const unexpected = listUnexpectedJs(workspace);
  if (unexpected.length > 0) {
    throw new Error(`Official copy has unexpected JS: ${unexpected.join(", ")}`);
  }
  return workspace;
}

export function isolatedHypitEnv(source = process.env, repo = REPO) {
  const host = phase1HostStateDir(repo);
  return hypitChildEnv(source, {
    home: join(host, "home"),
    tmpdir: join(host, "tmp"),
    stateHome: host
  });
}
