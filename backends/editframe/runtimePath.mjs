import { existsSync, readFileSync } from "node:fs";
import { lstat, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DIR = fileURLToPath(new URL("./runtime", import.meta.url));

export const PINNED_RUNTIME = Object.freeze({
  "@editframe/cli": "0.60.11",
  "@editframe/elements": "0.60.11",
  "@editframe/vite-plugin": "0.60.11",
  vite: "8.3.1"
});

export function runtimeRoot() {
  const override = process.env.TSUGITE_EDITFRAME_RUNTIME;
  return override ? resolve(override) : RUNTIME_DIR;
}

export function missingRuntimeMessage() {
  return "Editframe CLI runtime is missing. Run `npm run editframe:install` from the Tsugite repository root, then retry.";
}

function readVersion(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

export function resolveEditframeCli() {
  const root = runtimeRoot();
  const cliDir = join(root, "node_modules", "@editframe", "cli");
  const elementsDir = join(root, "node_modules", "@editframe", "elements");
  const pluginDir = join(root, "node_modules", "@editframe", "vite-plugin");
  const viteDir = join(root, "node_modules", "vite");
  const cliPath = join(cliDir, "dist", "index.js");
  const viteBin = join(viteDir, "bin", "vite.js");
  const viteModulePath = join(viteDir, "dist", "node", "index.js");
  const pluginPath = join(pluginDir, "dist", "index.js");
  const elementsPath = join(elementsDir, "dist", "index.js");
  const elementsCss = join(elementsDir, "dist", "style.css");
  const required = [cliPath, viteBin, viteModulePath, pluginPath, elementsPath, elementsCss];
  if (required.some((path) => !existsSync(path))) {
    return { ok: false, root, message: missingRuntimeMessage() };
  }
  const versions = {
    "@editframe/cli": readVersion(join(cliDir, "package.json")),
    "@editframe/elements": readVersion(join(elementsDir, "package.json")),
    "@editframe/vite-plugin": readVersion(join(pluginDir, "package.json")),
    vite: readVersion(join(viteDir, "package.json"))
  };
  const mismatched = Object.entries(PINNED_RUNTIME).filter(([name, pinned]) => versions[name] !== pinned);
  if (mismatched.length > 0) {
    return {
      ok: false,
      root,
      versions,
      message: `Editframe runtime versions do not match the pin (${mismatched
        .map(([name, pinned]) => `${name}@${pinned}`)
        .join(", ")}). Run \`npm run editframe:install\`.`
    };
  }
  return {
    ok: true,
    root,
    cliPath,
    viteBin,
    viteModulePath,
    pluginPath,
    elementsPath,
    elementsCss,
    versions
  };
}

export async function ensureRuntimeModuleLink(compositionDir, runtime) {
  const linkPath = join(compositionDir, "node_modules");
  const target = join(runtime.root, "node_modules");
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink()) {
      await unlink(linkPath);
    } else {
      throw new Error("composition node_modules must be a link to the pinned Editframe runtime");
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}
