import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const VIEWER_BUNDLE_MANIFEST_FILE = "bundle-manifest.json";
export const VIEWER_BUNDLE_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 32;

export async function createViewerBundleManifest(viewerRoot) {
  const root = resolve(viewerRoot);
  const indexPath = join(root, "index.html");
  const indexStat = await regularFile(indexPath, "Viewer entry");
  const indexHtml = await readFile(indexPath, "utf8");
  const sourceVersion = readSourceVersion(indexHtml);
  const files = [];
  const state = { entries: 0 };
  await collectFiles(root, root, files, state, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === "index.html" && file.size === indexStat.size)) {
    throw new Error("Viewer bundle manifest did not include index.html");
  }

  const digest = createHash("sha256");
  digest.update(`tsugite-viewer-bundle-v${VIEWER_BUNDLE_SCHEMA_VERSION}\0`);
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return {
    schema_version: VIEWER_BUNDLE_SCHEMA_VERSION,
    source_version: sourceVersion,
    bundle_digest: digest.digest("hex"),
    files
  };
}

export async function writeViewerBundleManifest(viewerRoot) {
  const manifest = await createViewerBundleManifest(viewerRoot);
  await writeFile(
    join(viewerRoot, VIEWER_BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  return manifest;
}

async function collectFiles(root, directory, output, state, depth) {
  if (depth > MAX_DEPTH) throw new Error("Viewer bundle contains directories that are too deeply nested");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    state.entries += 1;
    if (state.entries > MAX_ENTRIES) throw new Error("Viewer bundle contains too many entries");
    if (entry.name === VIEWER_BUNDLE_MANIFEST_FILE && directory === root) continue;
    if (entry.isSymbolicLink()) throw new Error(`Viewer bundle contains a symbolic link: ${entry.name}`);
    const absolutePath = join(directory, entry.name);
    const logicalPath = portable(relative(root, absolutePath));
    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, output, state, depth + 1);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Viewer bundle contains a non-regular entry: ${logicalPath}`);
    const stats = await regularFile(absolutePath, `Viewer bundle file ${logicalPath}`);
    const bytes = await readFile(absolutePath);
    output.push({
      path: logicalPath,
      size: stats.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
}

async function regularFile(path, description) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${description} is missing or unsafe: ${path}`);
  }
  return stats;
}

function readSourceVersion(indexHtml) {
  const tags = indexHtml.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = attribute(tag, "name");
    if (name !== "tsugite-viewer-source-version") continue;
    const value = attribute(tag, "content");
    if (value && /^[A-Za-z0-9._-]+$/.test(value)) return value;
  }
  throw new Error("Viewer bundle index.html is missing a valid source version");
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function portable(path) {
  return path.split("\\").join("/");
}
