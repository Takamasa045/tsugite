/**
 * Promotion path safety: destination containment checks and durable marker write.
 * Does not perform switch/commit/rollback — only preflight and marker IO.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hasSymlinkAlongPath } from "./promotionJournal.js";
import {
  isNodeError,
  isSymbolicLinkPath,
  isWithinDirectory,
  LAUNCHER_HOME_MARKER_NAME,
  resolveExistingPath
} from "./projectsHomeShared.js";

export async function assertSafePromotion(
  sourceRoot: string,
  destinationRoot: string,
  projectsHome: string,
  projectSlug: string
): Promise<void> {
  if (!isWithinDirectory(projectsHome, destinationRoot) || resolve(destinationRoot) === resolve(projectsHome)) {
    throw new Error("launcher home destination must stay inside the durable projects directory");
  }
  const sourceReal = await resolveExistingPath(sourceRoot);
  if (isWithinDirectory(sourceReal, destinationRoot) || isWithinDirectory(destinationRoot, sourceReal)) {
    // Destination may currently be a symlink into source (pre-production shelf link). That is OK
    // because replaceDirectoryWithCopy removes the link before writing a real tree.
    if (
      resolve(sourceReal) !== resolve(destinationRoot)
      && !await isSymbolicLinkPath(destinationRoot)
    ) {
      throw new Error("launcher home destination must not nest inside the source project");
    }
  }
  try {
    const stats = await lstat(destinationRoot);
    if (stats.isSymbolicLink()) {
      const linked = await readlink(destinationRoot);
      const resolvedLink = isAbsolute(linked) ? resolve(linked) : resolve(dirname(destinationRoot), linked);
      let linkedReal = resolvedLink;
      try {
        linkedReal = await realpath(resolvedLink);
      } catch {
        // Dangling link is replaceable.
        return;
      }
      if (linkedReal !== sourceReal && resolvedLink !== resolve(sourceRoot)) {
        throw new Error(
          `launcher shelf path already links elsewhere: ${destinationRoot} -> ${resolvedLink}`
        );
      }
      return;
    }
    if (!stats.isDirectory()) {
      throw new Error(`launcher home destination exists and is not a directory: ${destinationRoot}`);
    }
    const existingConfig = join(destinationRoot, "project.yaml");
    try {
      const text = await readFile(existingConfig, "utf8");
      const match = /^slug:\s*["']?([^\s"']+)/m.exec(text);
      if (match && match[1] !== projectSlug) {
        throw new Error(
          `refusing to overwrite ${destinationRoot}; existing slug '${match[1]}' differs from '${projectSlug}'`
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

/**
 * Write launcher-home.json as a regular file only.
 * Re-verifies destination containment under projectsHome, refuses symlink ancestors/leaves,
 * and uses O_CREAT|O_EXCL|O_NOFOLLOW temp + rename so a planted leaf symlink cannot redirect writes.
 */
export async function writePromotionMarker(
  destinationRoot: string,
  input: {
    sourceProjectRoot: string;
    projectsHome: string;
    projectSlug: string;
    promotedAt: string;
  }
): Promise<void> {
  const projectsHome = resolve(input.projectsHome);
  const destination = resolve(destinationRoot);
  const markerPath = join(destination, LAUNCHER_HOME_MARKER_NAME);
  const contents = `${JSON.stringify({
    schema_version: 1,
    project_slug: input.projectSlug,
    projects_home: input.projectsHome,
    source_project_root: input.sourceProjectRoot,
    promoted_at: input.promotedAt
  }, null, 2)}\n`;

  if (!isWithinDirectory(projectsHome, destination) || destination === projectsHome) {
    throw new Error("launcher home marker destination must stay inside the durable projects directory");
  }
  if (!isWithinDirectory(destination, markerPath) || !isWithinDirectory(projectsHome, markerPath)) {
    throw new Error("launcher home marker path escaped its destination root");
  }

  // Destination must be a real directory with no symlink ancestors under projectsHome.
  if (await hasSymlinkAlongPath(projectsHome, destination)) {
    throw new Error("launcher home destination must not be a symbolic link or have a symbolic-link ancestor");
  }
  let destStats;
  try {
    destStats = await lstat(destination);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `launcher home destination is not usable for marker write: ${error.message}`
        : "launcher home destination is not usable for marker write"
    );
  }
  if (destStats.isSymbolicLink() || !destStats.isDirectory()) {
    throw new Error("launcher home destination must be a real directory before writing the promotion marker");
  }
  const destReal = await realpath(destination);
  const homeReal = await resolveExistingPath(projectsHome);
  if (!isWithinDirectory(homeReal, destReal) || destReal === homeReal) {
    throw new Error("launcher home destination realpath escaped the durable projects directory");
  }

  // Refuse to follow or replace a leaf symlink (would overwrite an external target).
  try {
    const leaf = await lstat(markerPath);
    if (leaf.isSymbolicLink()) {
      throw new Error("refusing to follow or replace a leaf symbolic link for launcher-home.json");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  // TOCTOU: re-verify containment immediately before create.
  if (await hasSymlinkAlongPath(projectsHome, destination)) {
    throw new Error("launcher home destination path changed to include a symbolic link before marker write");
  }

  const nofollow = constants.O_NOFOLLOW ?? 0;
  const temporaryName = `.${LAUNCHER_HOME_MARKER_NAME}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(destination, temporaryName);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
      0o600
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-verify destination + leaf safety immediately before rename.
    if (await hasSymlinkAlongPath(projectsHome, destination)) {
      throw new Error("launcher home destination path changed to include a symbolic link before marker rename");
    }
    try {
      const leafAfter = await lstat(markerPath);
      if (leafAfter.isSymbolicLink()) {
        throw new Error("refusing to replace a leaf symbolic link for launcher-home.json");
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    await rename(temporaryPath, markerPath);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // preserve original error
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
