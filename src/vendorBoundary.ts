import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Issue, Result } from "./types.js";

export async function checkVendorBoundary(
  paths: string[],
  vendorRoots = ["adapters", "backends"]
): Promise<Result<{}>> {
  const bannedTerms = await vendorNames(vendorRoots);
  const files = (await Promise.all(paths.map((path) => collectFiles(path)))).flat();
  const issues: Issue[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lower = text.toLowerCase();
    for (const term of bannedTerms) {
      if (lower.includes(term)) {
        issues.push({
          code: "vendor_boundary.term",
          message: `core file contains vendor-specific term '${term}'`,
          path: file
        });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

async function vendorNames(paths: string[]): Promise<string[]> {
  const names = await Promise.all(paths.map((path) => childDirectoryNames(path)));
  return [...new Set(names.flat())];
}

async function childDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase());
  } catch {
    return [];
  }
}

async function collectFiles(path: string): Promise<string[]> {
  const current = await stat(path);
  if (current.isFile()) return [path];
  if (!current.isDirectory()) return [];

  const children = await readdir(path);
  const nested = await Promise.all(children.map((child) => collectFiles(join(path, child))));
  return nested.flat();
}
