/**
 * Fail-closed, idempotent patches for the pinned HyperFrames 0.8.24 install.
 * Does not rewrite upstream package.json or the lockfile. npm overrides handle
 * the adm-zip alias; this script only rewrites exact, hashed source bytes.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCH_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PINNED_HYPERFRAMES_VERSION = "0.8.24";

export const PINNED_HYPERFRAMES_PATCHES = [
  {
    id: "served-studio-html-guard",
    relative: "node_modules/hyperframes/dist/studio/assets/index-Bq3M0sjr.js",
    sha256: "08632acb78028449e8e01e1217108581d487615283af71179cc03f55c0110749",
    from: "function ZD(t,e){var r;if(!e)return null;const n=(r=t.defaultView)==null?void 0:r.HTMLElement;return n&&e instanceof n?e:null}",
    to: "function ZD(t,e){return!e||e.nodeType!==1||e.ownerDocument!==t||!e.isConnected||e.namespaceURI!==\"http://www.w3.org/1999/xhtml\"?null:e}"
  },
  {
    id: "studio-index-html-guard",
    relative: "node_modules/hyperframes/dist/studio/index.js",
    sha256: "7459fed81c815288708d2bc7e0f2b25dc47c533c2d8cb0ad7863c84d56875f80",
    from: "function asHtmlElement(doc, node) {\n  if (!node) return null;\n  const ctor = doc.defaultView?.HTMLElement;\n  return ctor && node instanceof ctor ? node : null;\n}",
    to: "function asHtmlElement(doc, node) {\n  if (!node || node.nodeType !== 1) return null;\n  if (node.ownerDocument !== doc || !node.isConnected) return null;\n  if (node.namespaceURI !== \"http://www.w3.org/1999/xhtml\") return null;\n  return node;\n}"
  },
  {
    id: "cli-adm-zip-static-import",
    relative: "node_modules/hyperframes/dist/cli.js",
    sha256: "e3ac2670128874500eeedaf561737273a31c79772168bc1cd9461ab452c064c9",
    from: "import AdmZip from \"adm-zip\";",
    to: "import AdmZip from \"@tsugite/hyperframes-in-memory-zip\";"
  },
  {
    id: "cli-adm-zip-dynamic-import",
    relative: "node_modules/hyperframes/dist/cli.js",
    sha256: "e3ac2670128874500eeedaf561737273a31c79772168bc1cd9461ab452c064c9",
    from: "(await import(\"adm-zip\"))",
    to: "(await import(\"@tsugite/hyperframes-in-memory-zip\"))"
  }
];

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function groupByFile(patches) {
  const grouped = new Map();
  for (const patch of patches) {
    const list = grouped.get(patch.relative) ?? [];
    list.push(patch);
    grouped.set(patch.relative, list);
  }
  return grouped;
}

export async function applyPinnedHyperframesPatches(root = PATCH_ROOT, options = {}) {
  const patches = options.patches ?? PINNED_HYPERFRAMES_PATCHES;
  const packagePath = join(root, "node_modules/hyperframes/package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { skipped: true, reason: "hyperframes-not-installed" };
    }
    throw error;
  }
  if (manifest.version !== PINNED_HYPERFRAMES_VERSION) {
    throw new Error(
      `HyperFrames ${manifest.version} is not the pinned ${PINNED_HYPERFRAMES_VERSION}; refuse to patch`
    );
  }

  const applied = [];
  const already = [];

  for (const [relative, group] of groupByFile(patches)) {
    const originalHash = group[0].sha256;
    if (group.some((patch) => patch.sha256 !== originalHash)) {
      throw new Error(`${relative}: mixed original hashes in one file group`);
    }
    const path = join(root, relative);
    const text = await readFile(path, "utf8");
    const originalNeedles = group.map((patch) => count(text, patch.from));
    const patchedNeedles = group.map((patch) => count(text, patch.to));
    const looksOriginal = originalNeedles.every((n) => n === 1) && patchedNeedles.every((n) => n === 0);
    const looksPatched = originalNeedles.every((n) => n === 0) && patchedNeedles.every((n) => n === 1);

    if (looksPatched) {
      const reversed = group.reduce((body, patch) => body.replace(patch.to, patch.from), text);
      if (sha256Text(reversed) !== originalHash) {
        throw new Error(
          `${relative} looks patched, but reversing it does not restore pinned ${PINNED_HYPERFRAMES_VERSION} bytes`
        );
      }
      already.push(...group.map((patch) => patch.id));
      continue;
    }

    if (!looksOriginal) {
      throw new Error(
        `${relative} is neither the pinned ${PINNED_HYPERFRAMES_VERSION} original nor the expected patch`
      );
    }
    if (sha256Text(text) !== originalHash) {
      throw new Error(`${relative} sha256 ${sha256Text(text)} != pinned ${originalHash}`);
    }

    let next = text;
    for (const patch of group) {
      if (count(next, patch.from) !== 1) {
        throw new Error(`${patch.id}: expected exactly one original occurrence`);
      }
      next = next.replace(patch.from, patch.to);
      applied.push(patch.id);
    }
    await writeFile(path, next);
  }

  return { skipped: false, version: PINNED_HYPERFRAMES_VERSION, applied, already };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await applyPinnedHyperframesPatches();
  console.log(JSON.stringify(result));
}
