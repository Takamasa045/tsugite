import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Manifest } from "./schema.js";
import type { Issue, Result } from "../types.js";

export async function validateManifestAssets(
  manifest: Manifest,
  baseDir: string
): Promise<Result<{}>> {
  const issues: Issue[] = [];

  for (const [index, clip] of manifest.clips.entries()) {
    const path = isAbsolute(clip.src) ? clip.src : resolve(baseDir, clip.src);
    if (!(await exists(path))) {
      issues.push({
        code: "manifest.clip.src.exists",
        message: "clip src must point to an existing local file",
        path: `clips.${index}.src`
      });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
