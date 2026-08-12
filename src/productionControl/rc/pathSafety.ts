/**
 * Migration path safety: fail-closed for Windows drive/UNC, symlink, escape.
 * Reuses recovery confinement rules for RC migration artifact roots.
 */
import {
  assertContainedUnderProjectRoot,
  isWithinPath,
  type ContainedPathResult
} from "../recoveryPathSafety.js";
import { pcError } from "../errors.js";
import {
  isExtendedWindowsPath,
  isUncPath,
  isWindowsDrivePath,
  isWindowsDriveRelativePath
} from "../windowsPathLex.js";

export { isWithinPath, isExtendedWindowsPath, isUncPath, isWindowsDrivePath, isWindowsDriveRelativePath };

/**
 * Fail-closed preflight for migration/rollback write candidates.
 * Rejects UNC and extended Windows paths always. Drive-absolute paths are
 * rejected off Windows hosts; on Windows they still require project containment.
 */
export function assertMigrationPathLexicalSafe(
  path: string,
  label: string,
  options: { platform?: NodeJS.Platform } = {}
): void {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) throw pcError("PC_PATH_UNSAFE", `${label}: path is required`);
  if (isExtendedWindowsPath(raw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: extended Windows paths are not allowed`);
  }
  if (isUncPath(raw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: UNC paths are not allowed`);
  }
  if (isWindowsDriveRelativePath(raw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: Windows drive-relative paths are not allowed`);
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && isWindowsDrivePath(raw)) {
    throw pcError("PC_PATH_UNSAFE", `${label}: Windows drive paths are fail-closed off Windows hosts`);
  }
}

export async function assertMigrationPathContained(input: {
  projectRoot: string;
  candidate: string;
  label: string;
  allowMissingLeaf?: boolean;
  platform?: NodeJS.Platform;
}): Promise<ContainedPathResult> {
  assertMigrationPathLexicalSafe(input.projectRoot, `${input.label}:project`, {
    platform: input.platform
  });
  assertMigrationPathLexicalSafe(input.candidate, input.label, {
    platform: input.platform
  });
  return assertContainedUnderProjectRoot({
    projectRoot: input.projectRoot,
    candidate: input.candidate,
    label: input.label,
    allowMissingLeaf: input.allowMissingLeaf
  });
}
