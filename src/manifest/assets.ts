import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Manifest } from "./schema.js";
import type { Issue, Result } from "../types.js";

type AssetValidationOptions = {
  assetRoot?: string;
};

export async function validateManifestAssets(
  manifest: Manifest,
  baseDir: string,
  options: AssetValidationOptions = {}
): Promise<Result<{}>> {
  const issues: Issue[] = [];
  const assetRoot = resolve(options.assetRoot ?? baseDir);

  for (const [index, clip] of manifest.clips.entries()) {
    const path = `clips.${index}.src`;
    const sourcePath = safeLocalAssetPath(clip.src, baseDir, assetRoot, path, "manifest.clip.src.safe");
    if (!sourcePath.ok) {
      issues.push(...sourcePath.issues);
      continue;
    }

    if (!(await exists(sourcePath.path))) {
      issues.push({
        code: "manifest.clip.src.exists",
        message: "clip src must point to an existing local file",
        path
      });
    }
  }

  const audioTracks = [
    ["bgm", manifest.audio.bgm],
    ["narration", manifest.audio.narration],
    ["sfx", manifest.audio.sfx]
  ] as const;

  for (const [track, entries] of audioTracks) {
    for (const [index, entry] of entries.entries()) {
      if (!entry.src) continue;
      const path = `audio.${track}.${index}.src`;
      const sourcePath = safeLocalAssetPath(entry.src, baseDir, assetRoot, path, "manifest.audio.src.safe");
      if (!sourcePath.ok) {
        issues.push(...sourcePath.issues);
        continue;
      }

      if (!(await exists(sourcePath.path))) {
        issues.push({
          code: "manifest.audio.src.exists",
          message: "audio track src must point to an existing local file",
          path
        });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

function safeLocalAssetPath(
  src: string,
  baseDir: string,
  assetRoot: string,
  path: string,
  code: string
): Result<{ path: string }> {
  if (isAbsolute(src)) {
    return {
      ok: false,
      issues: [{ code, message: "asset src must be relative to the project asset root", path }]
    };
  }

  const resolved = resolve(baseDir, src);
  if (!isWithinRoot(resolved, assetRoot)) {
    return {
      ok: false,
      issues: [{ code, message: "asset src must stay within the project asset root", path }]
    };
  }

  return { ok: true, issues: [], path: resolved };
}

function isWithinRoot(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  const fromRoot = relative(parent, child);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
