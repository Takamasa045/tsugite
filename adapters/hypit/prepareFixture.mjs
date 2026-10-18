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
    `Byte-copied from pinned @hypit/hypit@0.3.1 ${OFFICIAL_EXAMPLE_RELATIVE}.`,
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
  // 0.3.1 examples use independent video SDK packages. Resolve their workspace
  // declarations from this selected Distribution, only in the synthetic copy.
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith("@hypit/") && version.startsWith("workspace:")) {
      const installed = join(distributionRoot, "..", name.slice("@hypit/".length));
      const selected = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
      if (selected.name !== name) throw new Error(`Unexpected SDK package for ${name}`);
      pkg.dependencies[name] = installed;
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  // The 0.3.1 loader requires the Source's font to be a project dependency;
  // use the already pinned local font package, never a fetched user asset.
  const fontRoot = join(distributionRoot, "..", "..", "@fontsource-variable", "inter");
  const font = JSON.parse(readFileSync(join(fontRoot, "package.json"), "utf8"));
  if (font.name !== "@fontsource-variable/inter" || font.version !== "5.3.0") throw new Error("Unexpected fixture font package");
  writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "tsugite-hypit-synthetic", private: true, dependencies: { "@fontsource-variable/inter": fontRoot } }, null, 2)}\n`);
  return manifestPath;
}

export function buildChatScene(workspace) {
  const pkg = join(workspace, "packages", "chat-scene");
  const fontInstall = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: workspace, encoding: "utf8", env: hypitChildEnv(process.env)
  });
  if (fontInstall.status !== 0) throw new Error(`fixture font install failed: ${fontInstall.stderr || fontInstall.stdout}`);
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
