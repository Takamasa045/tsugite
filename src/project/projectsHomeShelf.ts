/**
 * Pre-production launcher shelf visibility: directory links under durable home.
 */

import {
  lstat,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink
} from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  acquireDestinationLock,
  DestinationLockedError,
  DestinationLockBoundaryError,
  type DestinationLock
} from "./destinationLock.js";
import { recoverPromotionTransactions } from "./promotionJournal.js";
import { planLauncherHome } from "./projectsHomeResolve.js";
import {
  isNodeError,
  type EnsureProjectVisibleOptions,
  type EnsureProjectVisibleResult
} from "./projectsHomeShared.js";

/**
 * Ensure a project is addressable from the durable launcher shelf even before
 * production. Outside the durable home, create a directory link so main
 * launcher and Desktop both list the project immediately.
 */
export async function ensureProjectVisibleOnLauncherShelf(
  options: EnsureProjectVisibleOptions
): Promise<EnsureProjectVisibleResult> {
  const plan = await planLauncherHome(options.configPath, options.projectSlug, {
    cwd: options.cwd,
    env: options.env
  });
  const configName = basename(resolve(options.configPath));

  // Crash recovery for durable promotions (same home as finalize shelf).
  const recovery = await recoverPromotionTransactions(plan.projectsHome);
  if (!recovery.ok) {
    return {
      ok: false,
      issues: recovery.issues,
      alreadyHome: plan.alreadyHome,
      linked: false,
      projectsHome: plan.projectsHome,
      launcherProjectRoot: plan.alreadyHome ? plan.projectRoot : plan.destinationRoot,
      launcherConfigPath: plan.alreadyHome
        ? resolve(options.configPath)
        : join(plan.destinationRoot, configName)
    };
  }

  if (plan.alreadyHome) {
    return {
      ok: true,
      issues: [],
      alreadyHome: true,
      linked: false,
      projectsHome: plan.projectsHome,
      launcherProjectRoot: plan.projectRoot,
      launcherConfigPath: resolve(options.configPath)
    };
  }

  const destinationRoot = plan.destinationRoot;
  const launcherConfigPath = join(destinationRoot, configName);
  // Destination lock is the first shared destination mutation boundary (safe home
  // creation under real parents only). Never recursive-mkdir before the lock —
  // an ancestor symlink to an external directory would otherwise write outside.
  // Serializes shelf registration against concurrent promotion/recovery.
  let destinationLock: DestinationLock | undefined;
  try {
    destinationLock = await acquireDestinationLock(plan.projectsHome, destinationRoot);
    const linked = await ensureDirectoryLink(plan.projectRoot, destinationRoot, options.projectSlug);
    return {
      ok: true,
      issues: [],
      alreadyHome: false,
      linked,
      projectsHome: plan.projectsHome,
      launcherProjectRoot: destinationRoot,
      launcherConfigPath
    };
  } catch (error) {
    const code = error instanceof DestinationLockedError
      ? error.code
      : error instanceof DestinationLockBoundaryError
        ? error.code
        : "launcher_home.register_failed";
    return {
      ok: false,
      issues: [{
        code,
        message: error instanceof Error ? error.message : String(error),
        path: destinationRoot
      }],
      alreadyHome: false,
      linked: false,
      projectsHome: plan.projectsHome,
      launcherProjectRoot: destinationRoot,
      launcherConfigPath
    };
  } finally {
    if (destinationLock) {
      await destinationLock.release().catch(() => undefined);
    }
  }
}

async function ensureDirectoryLink(
  sourceRoot: string,
  destinationRoot: string,
  projectSlug: string
): Promise<boolean> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      const current = await readlink(destination);
      const resolvedCurrent = isAbsolute(current) ? resolve(current) : resolve(dirname(destination), current);
      let currentReal = resolvedCurrent;
      let dangling = false;
      try {
        currentReal = await realpath(resolvedCurrent);
      } catch {
        dangling = true;
      }
      let sourceReal = source;
      try {
        sourceReal = await realpath(source);
      } catch {
        // source may be mid-create
      }
      if (!dangling && (currentReal === sourceReal || resolvedCurrent === source)) return false;
      // Replace dangling or mismatched links so a new project with the same slug can register.
      await unlink(destination);
    } else if (existing.isDirectory()) {
      try {
        const text = await readFile(join(destination, "project.yaml"), "utf8");
        const match = /^slug:\s*["']?([^\s"']+)/m.exec(text);
        if (!match || match[1] === projectSlug) return false;
        throw new Error(
          `refusing to replace ${destination}; existing slug '${match[1]}' differs from '${projectSlug}'`
        );
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return false;
        throw error;
      }
    } else {
      throw new Error(`launcher shelf path exists and is not a project directory: ${destination}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const linkType = platform() === "win32" ? "junction" : "dir";
  await symlink(source, destination, linkType);
  return true;
}
