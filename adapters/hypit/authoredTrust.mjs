/**
 * Trust for real authored Hypit sources. Distinct from Phase 1 spike lock.
 * Fail closed on unknown imports, parent paths, extra package roots, and symlinks.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "./digest.mjs";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));
const SOURCE_EXT = new Set([".svml", ".svs", ".svrun"]);
const DEFAULT_SOURCES = ["main.svml", "recipes.svs", "build.svrun"];
/** Creative proposal files bound into the approved source closure. */
export const PROPOSAL_SOURCE_FILES = Object.freeze(["BRIEF.md", "TREATMENT.md", "TIMELINE.md"]);
const IMPORT_ATTR = /\b(from|using|source)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

export function loadAllowlist(adapterRoot = ADAPTER_ROOT) {
  return JSON.parse(readFileSync(join(adapterRoot, "allowlist.json"), "utf8"));
}

export function allowlistDigest(adapterRoot = ADAPTER_ROOT) {
  return sha256Bytes(readFileSync(join(adapterRoot, "allowlist.json")));
}

export function extractImportSpecs(text) {
  const found = [];
  const unsupported = [];
  const pattern = new RegExp(IMPORT_ATTR.source, "g");
  for (const match of text.matchAll(pattern)) {
    if (match[4] !== undefined) {
      // Graph references such as source={typography.track} are not imports.
      if (match[4].startsWith("{")) continue;
      unsupported.push(match[0]);
      continue;
    }
    found.push(match[2] ?? match[3]);
  }
  return { specs: found, unsupported };
}

export function classifyImport(spec, allowlist) {
  if (spec.startsWith("./") || spec.startsWith("../")) return { kind: "relative", spec };
  if (spec.startsWith(allowlist.distributionScope)) return { kind: "distribution", spec };
  // Authored production refuses every project-package import, including names
  // listed in allowlist.projectPackages. Phase 1 spike uses trust.mjs instead.
  return { kind: "denied", spec };
}

function withinReal(rootReal, candidateReal) {
  const relation = relative(rootReal, candidateReal);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function assertRegularNoSymlink(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw Object.assign(new Error(`symlink refused: ${path}`), { code: "HYPIT_PATH_UNSAFE" });
  }
  return st;
}

function posixRelative(rootReal, fileReal) {
  return relative(rootReal, fileReal).split(sep).join("/");
}

export function assertAuthoredWorkspace(workspace, options = {}) {
  const resolved = resolve(workspace);
  assertRegularNoSymlink(resolved);
  if (!statSync(resolved).isDirectory()) {
    throw Object.assign(new Error("authored workspace is not a directory"), { code: "HYPIT_UNTRUSTED_SOURCE" });
  }
  const root = realpathSync(resolved);
  const allowlist = options.allowlist ?? loadAllowlist(options.adapterRoot ?? ADAPTER_ROOT);
  const denied = [];
  const visited = new Set();
  const sourceFiles = [];
  const queue = [...(options.sources ?? DEFAULT_SOURCES)].map((name) => join(root, name));

  while (queue.length > 0) {
    const path = queue.shift();
    if (!existsSync(path)) continue;
    const st = assertRegularNoSymlink(path);
    if (!st.isFile()) {
      denied.push(`not-file:${path}`);
      continue;
    }
    const real = realpathSync(path);
    if (!withinReal(root, real)) {
      denied.push(`escape:${path}`);
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    const rel = posixRelative(root, real);
    const bytes = readFileSync(real);
    sourceFiles.push({
      relative_path: rel,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length
    });
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
    if (!SOURCE_EXT.has(ext) && !DEFAULT_SOURCES.includes(rel)) continue;
    const extracted = extractImportSpecs(bytes.toString("utf8"));
    if (extracted.unsupported.length > 0) {
      denied.push(`${rel}:unsupported-syntax:${extracted.unsupported.join(",")}`);
    }
    for (const spec of extracted.specs) {
      const classified = classifyImport(spec, allowlist);
      if (classified.kind === "denied" || classified.kind === "project-package") {
        denied.push(`${rel}:${spec}`);
      }
      if (classified.kind === "relative") {
        const target = resolve(dirname(real), spec);
        if (!existsSync(target)) {
          denied.push(`${rel}:missing:${spec}`);
          continue;
        }
        const targetSt = lstatSync(target);
        if (targetSt.isSymbolicLink()) {
          denied.push(`${rel}:symlink:${spec}`);
          continue;
        }
        const targetReal = realpathSync(target);
        if (!withinReal(root, targetReal)) {
          denied.push(`${rel}:escape:${spec}`);
          continue;
        }
        const targetExt = targetReal.slice(targetReal.lastIndexOf(".")).toLowerCase();
        if (SOURCE_EXT.has(targetExt) || targetSt.isFile()) queue.push(target);
      }
    }
  }

  if (denied.length > 0) {
    throw Object.assign(new Error(`Untrusted authored imports: ${denied.join(", ")}`), {
      code: "HYPIT_UNTRUSTED_IMPORT"
    });
  }
  sourceFiles.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return {
    workspace: root,
    allowlistDigest: allowlistDigest(options.adapterRoot ?? ADAPTER_ROOT),
    sourceFiles: mergeFileRefs(sourceFiles, collectProposalFiles(root))
  };
}

function mergeFileRefs(left, right) {
  const byPath = new Map();
  for (const item of [...left, ...right]) byPath.set(item.relative_path, item);
  return [...byPath.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}

export function collectProposalFiles(workspace) {
  const resolved = resolve(workspace);
  assertRegularNoSymlink(resolved);
  const root = realpathSync(resolved);
  const files = [];
  for (const name of PROPOSAL_SOURCE_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const st = assertRegularNoSymlink(path);
    if (!st.isFile()) {
      throw Object.assign(new Error(`proposal is not a file: ${name}`), { code: "HYPIT_UNTRUSTED_SOURCE" });
    }
    const real = realpathSync(path);
    if (!withinReal(root, real)) {
      throw Object.assign(new Error(`proposal path escapes workspace: ${name}`), { code: "HYPIT_PATH_UNSAFE" });
    }
    const bytes = readFileSync(real);
    files.push({
      relative_path: name,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length
    });
  }
  return files;
}

export function collectAssetFiles(workspace) {
  const resolved = resolve(workspace);
  assertRegularNoSymlink(resolved);
  const root = realpathSync(resolved);
  const assetsRoot = join(root, "assets");
  const files = [];
  if (!existsSync(assetsRoot)) return files;
  assertRegularNoSymlink(assetsRoot);
  const stack = [assetsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const st = assertRegularNoSymlink(current);
    const real = realpathSync(current);
    if (!withinReal(root, real)) {
      throw Object.assign(new Error(`asset path escapes workspace: ${current}`), { code: "HYPIT_PATH_UNSAFE" });
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
      continue;
    }
    if (!st.isFile()) continue;
    const bytes = readFileSync(real);
    files.push({
      relative_path: posixRelative(root, real),
      sha256: sha256Bytes(bytes),
      bytes: bytes.length
    });
  }
  files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return files;
}

export function assertContainedExportPath(workspace, destination) {
  const resolvedRoot = resolve(workspace);
  assertRegularNoSymlink(resolvedRoot);
  const root = realpathSync(resolvedRoot);
  const dest = isAbsolute(destination) ? resolve(destination) : resolve(root, destination);
  const parent = dirname(dest);
  if (!existsSync(parent)) {
    throw Object.assign(new Error("export parent directory is missing"), { code: "HYPIT_PATH_UNSAFE" });
  }
  if (lstatSync(parent).isSymbolicLink()) {
    throw Object.assign(new Error("export parent is a symlink"), { code: "HYPIT_PATH_UNSAFE" });
  }
  const parentReal = realpathSync(parent);
  if (!withinReal(root, parentReal)) {
    throw Object.assign(new Error("export path escapes workspace"), { code: "HYPIT_PATH_UNSAFE" });
  }
  if (existsSync(dest)) {
    if (lstatSync(dest).isSymbolicLink()) {
      throw Object.assign(new Error("export destination is a symlink"), { code: "HYPIT_PATH_UNSAFE" });
    }
    if (!withinReal(root, realpathSync(dest))) {
      throw Object.assign(new Error("export path escapes workspace"), { code: "HYPIT_PATH_UNSAFE" });
    }
  }
  return dest;
}

export function assertNoOverrideFlags(argv) {
  for (const flag of ["--package-root", "--runtime", "--asset-root"]) {
    const index = argv.findIndex((item) => item === flag || item.startsWith(`${flag}=`));
    if (index === -1) continue;
    const value = argv[index].includes("=") ? argv[index].slice(flag.length + 1) : argv[index + 1];
    throw Object.assign(
      new Error(`authored check/plan/build refuse ${flag} (${value ?? ""}); extra roots are not a sandbox`),
      { code: "HYPIT_UNTRUSTED_SOURCE" }
    );
  }
}

export { ADAPTER_ROOT, DEFAULT_SOURCES };
