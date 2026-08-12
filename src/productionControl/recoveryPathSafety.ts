/**
 * Fail-closed path confinement for recovery package / jobs / production-control roots.
 * Candidate paths must stay under the authoritative project realpath (no absolute escape,
 * no `..`, no symlink ancestor/leaf, no cross-drive/UNC jump). TOCTOU re-check after resolve.
 */
import { lstat, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { pcError } from "./errors.js";

export type ContainedPathResult = {
  /** Lexical resolve under project before realpath. */
  resolved: string;
  /** Realpath when the leaf exists; otherwise realpath of the deepest existing prefix + missing tail. */
  real_path: string;
  project_real_path: string;
};

/**
 * Assert `candidate` is contained under authoritative project root.
 * @param allowMissingLeaf when true, missing final segment is ok if existing prefix is clean.
 */
export async function assertContainedUnderProjectRoot(input: {
  projectRoot: string;
  candidate: string;
  label: string;
  allowMissingLeaf?: boolean;
}): Promise<ContainedPathResult> {
  const label = input.label;
  const projectRaw = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
  const candidateRaw = typeof input.candidate === "string" ? input.candidate.trim() : "";
  if (!projectRaw) {
    throw pcError("PC_PATH_UNSAFE", `${label}: project root is required`);
  }
  if (!candidateRaw) {
    throw pcError("PC_PATH_UNSAFE", `${label}: path is required`);
  }

  // Reject Windows extended / UNC paths that skip normal containment semantics.
  if (isExtendedWinPath(candidateRaw) || isExtendedWinPath(projectRaw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: extended Windows paths are not allowed`);
  }
  if (isUncPath(candidateRaw) || isUncPath(projectRaw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: UNC paths are not allowed for recovery confinement`);
  }

  let projectReal: string;
  try {
    const projectResolved = resolve(projectRaw);
    const projectStat = await lstat(projectResolved);
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
      throw pcError("PC_PATH_UNSAFE", `${label}: project root must be a real directory`);
    }
    if (await hasSymlinkAncestorFromRoot(projectResolved)) {
      throw pcError("PC_PATH_UNSAFE", `${label}: project root has a symbolic-link ancestor`);
    }
    projectReal = await realpath(projectResolved);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "PC_PATH_UNSAFE") {
      throw error;
    }
    throw pcError("PC_PATH_UNSAFE", `${label}: project root is not usable`);
  }

  // Resolve candidate relative to project when not absolute; absolute must still fall under projectReal.
  const candidateResolved = isAbsolute(candidateRaw)
    ? resolve(candidateRaw)
    : resolve(projectReal, candidateRaw);

  if (!isWithinPath(projectReal, candidateResolved)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: path escapes project root`);
  }

  // Lexical walk: refuse symlink components and non-dir intermediates.
  const rel = relative(projectReal, candidateResolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: path escapes project root`);
  }

  const parts = rel.split(sep).filter(Boolean);
  let current = projectReal;
  let missingFrom = -1;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw pcError("PC_PATH_UNSAFE", `${label}: symbolic link component is not allowed`);
      }
      const isLast = i === parts.length - 1;
      if (!isLast && !stats.isDirectory()) {
        throw pcError("PC_PATH_UNSAFE", `${label}: intermediate path component is not a directory`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: string }).code;
        if (code === "PC_PATH_UNSAFE") throw error;
        if (code === "ENOENT") {
          missingFrom = i;
          break;
        }
      }
      throw pcError("PC_PATH_UNSAFE", `${label}: path is not usable`);
    }
  }

  if (missingFrom >= 0) {
    if (!input.allowMissingLeaf) {
      throw pcError("PC_PATH_UNSAFE", `${label}: path does not exist`);
    }
    // Existing prefix realpath + missing tail (no TOCTOU promotion of outside targets).
    const existingParts = parts.slice(0, missingFrom);
    const existingPath = existingParts.length === 0
      ? projectReal
      : join(projectReal, ...existingParts);
    let existingReal: string;
    try {
      existingReal = await realpath(existingPath);
    } catch {
      throw pcError("PC_PATH_UNSAFE", `${label}: existing path prefix is not usable`);
    }
    if (!isWithinPath(projectReal, existingReal)) {
      throw pcError("PC_PATH_UNSAFE", `${label}: path prefix realpath escaped project root`);
    }
    const missingTail = parts.slice(missingFrom);
    const composed = missingTail.length === 0 ? existingReal : join(existingReal, ...missingTail);
    if (!isWithinPath(projectReal, composed)) {
      throw pcError("PC_PATH_UNSAFE", `${label}: composed path escapes project root`);
    }
    // TOCTOU re-check: re-verify project identity and containment.
    await recheckProjectRoot(projectReal, label);
    return {
      resolved: candidateResolved,
      real_path: composed,
      project_real_path: projectReal
    };
  }

  // Leaf exists: realpath and re-check containment (symlink leaf already rejected via lstat).
  let leafReal: string;
  try {
    leafReal = await realpath(candidateResolved);
  } catch {
    throw pcError("PC_PATH_UNSAFE", `${label}: path realpath is not usable`);
  }
  if (!isWithinPath(projectReal, leafReal)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: path realpath escaped project root`);
  }

  // TOCTOU: re-stat leaf and project; refuse swap.
  await recheckProjectRoot(projectReal, label);
  try {
    const again = await lstat(candidateResolved);
    if (again.isSymbolicLink()) {
      throw pcError("PC_PATH_UNSAFE", `${label}: path became a symbolic link (TOCTOU)`);
    }
    const againReal = await realpath(candidateResolved);
    if (againReal !== leafReal || !isWithinPath(projectReal, againReal)) {
      throw pcError("PC_PATH_UNSAFE", `${label}: path identity changed (TOCTOU)`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "PC_PATH_UNSAFE") {
      throw error;
    }
    throw pcError("PC_PATH_UNSAFE", `${label}: path revalidation failed`);
  }

  return {
    resolved: candidateResolved,
    real_path: leafReal,
    project_real_path: projectReal
  };
}

export function isWithinPath(parent: string, candidate: string): boolean {
  const parentResolved = resolve(parent);
  const candidateResolved = resolve(candidate);
  // Cross-drive / different root on Windows → relative is absolute.
  const relativePath = relative(parentResolved, candidateResolved);
  if (relativePath === "") return true;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return false;
  }
  return true;
}

function isExtendedWinPath(path: string): boolean {
  return /^\\\\\?\\/i.test(path) || /^\/\/\?\//.test(path);
}

function isUncPath(path: string): boolean {
  return /^\\\\[^\\/]+\\[^\\/]+/.test(path) || /^\/\/[^\\/]+\/[^\\/]+/.test(path);
}

async function hasSymlinkAncestorFromRoot(dir: string): Promise<boolean> {
  let current = resolve(dir);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

async function recheckProjectRoot(projectReal: string, label: string): Promise<void> {
  try {
    const stats = await lstat(projectReal);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw pcError("PC_PATH_UNSAFE", `${label}: project root changed (TOCTOU)`);
    }
    const again = await realpath(projectReal);
    if (again !== projectReal) {
      throw pcError("PC_PATH_UNSAFE", `${label}: project root identity changed (TOCTOU)`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "PC_PATH_UNSAFE") {
      throw error;
    }
    throw pcError("PC_PATH_UNSAFE", `${label}: project root revalidation failed`);
  }
}
