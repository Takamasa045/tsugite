/**
 * Selected Hypit Runtime Profile pointer + profile bytes + package.json.
 * Does not hash Worker dataRoot / sqlite. Pointer and profile must be
 * contained regular files (no symlink). Endpoint packages must be @hypit/.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./digest.mjs";

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

function readContainedFile(rootReal, candidate) {
  assertRegularNoSymlink(candidate);
  const real = realpathSync(candidate);
  if (!withinReal(rootReal, real)) {
    throw Object.assign(new Error(`path escapes workspace: ${candidate}`), { code: "HYPIT_PATH_UNSAFE" });
  }
  const bytes = readFileSync(real);
  return { real, bytes, sha256: sha256Bytes(bytes) };
}

function assertOfficialEndpoints(profile) {
  if (!profile || typeof profile !== "object") {
    throw Object.assign(new Error("runtime profile is not an object"), { code: "HYPIT_UNTRUSTED_SOURCE" });
  }
  const endpoints = profile.endpoints;
  if (!endpoints || typeof endpoints !== "object") return;
  for (const [name, spec] of Object.entries(endpoints)) {
    const use = spec && typeof spec === "object" ? spec.use : undefined;
    if (typeof use !== "string" || !use.startsWith("@hypit/")) {
      throw Object.assign(
        new Error(`runtime endpoint ${name} is not an official @hypit/ package (${use ?? "missing"})`),
        { code: "HYPIT_UNTRUSTED_SOURCE" }
      );
    }
  }
}

/** Marker-only project package.json. Activation / package overrides are executable, not a digest. */
const PACKAGE_MARKER_KEYS = new Set(["name", "version", "private", "type", "description", "license"]);
const PACKAGE_OVERRIDE_KEYS = new Set([
  "hypit",
  "activation",
  "main",
  "module",
  "browser",
  "exports",
  "imports",
  "bin",
  "scripts",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "workspaces",
  "overrides",
  "resolutions",
  "files"
]);

export function assertSafeProjectPackageManifest(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw Object.assign(new Error("project package.json must be an object"), { code: "HYPIT_UNTRUSTED_SOURCE" });
  }
  for (const key of Object.keys(pkg)) {
    if (PACKAGE_OVERRIDE_KEYS.has(key) || key === "hypit" || key.startsWith("hypit.")) {
      throw Object.assign(
        new Error(`project package.json refuses ${key} override; authored production does not bind custom activation or packages`),
        { code: "HYPIT_UNTRUSTED_SOURCE" }
      );
    }
    if (!PACKAGE_MARKER_KEYS.has(key)) {
      throw Object.assign(
        new Error(`project package.json refuses unknown key ${key}`),
        { code: "HYPIT_UNTRUSTED_SOURCE" }
      );
    }
  }
}

export function collectRuntimeSelection(workspace) {
  const resolved = resolve(workspace);
  assertRegularNoSymlink(resolved);
  const root = realpathSync(resolved);
  const pkgPath = join(root, "package.json");
  let package_manifest_digest = null;
  if (existsSync(pkgPath)) {
    const manifest = readContainedFile(root, pkgPath);
    let parsed;
    try {
      parsed = JSON.parse(manifest.bytes.toString("utf8"));
    } catch {
      throw Object.assign(new Error("project package.json is not JSON"), { code: "HYPIT_UNTRUSTED_SOURCE" });
    }
    assertSafeProjectPackageManifest(parsed);
    package_manifest_digest = manifest.sha256;
  }
  const pointerPath = join(root, ".hypit", "runtime");
  if (!existsSync(pointerPath)) {
    return {
      runtime_pointer_digest: null,
      runtime_profile_digest: null,
      package_manifest_digest,
      pointer: null,
      profile_path: null
    };
  }
  const pointer = readContainedFile(root, pointerPath);
  const named = pointer.bytes.toString("utf8").trim();
  if (!named || named.includes("\0") || named.includes("\\") || named.split("/").some((part) => part === ".." || part === "")) {
    throw Object.assign(new Error("runtime pointer is not a contained relative path"), { code: "HYPIT_PATH_UNSAFE" });
  }
  if (isAbsolute(named)) {
    throw Object.assign(new Error("runtime pointer must be a relative path"), { code: "HYPIT_PATH_UNSAFE" });
  }
  const profilePath = resolve(root, named);
  const profile = readContainedFile(root, profilePath);
  let parsed;
  try { parsed = JSON.parse(profile.bytes.toString("utf8")); } catch {
    throw Object.assign(new Error("runtime profile is not JSON"), { code: "HYPIT_UNTRUSTED_SOURCE" });
  }
  assertOfficialEndpoints(parsed);
  return {
    runtime_pointer_digest: pointer.sha256,
    runtime_profile_digest: profile.sha256,
    package_manifest_digest,
    pointer: named,
    profile_path: profile.real
  };
}
