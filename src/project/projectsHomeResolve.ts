/**
 * Durable projects-home resolution and launcher placement planning.
 */

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isSymbolicLinkPath,
  isWithinDirectory,
  resolveExistingPath,
  sanitizeProjectDirName,
  type LauncherHomePlan,
  type ResolveDurableProjectsHomeOptions
} from "./projectsHomeShared.js";

const execFileAsync = promisify(execFile);

/**
 * Durable projects directory that the launcher treats as the production shelf.
 * Priority:
 * 1. TSUGITE_PROJECTS_HOME
 * 2. <TSUGITE_WORKSPACE_ROOT>/projects
 * 3. <git-common-dir parent>/projects  (main worktree, even when cwd is a feature worktree)
 * 4. <cwd>/projects
 */
export async function resolveDurableProjectsHome(
  options: ResolveDurableProjectsHomeOptions = {}
): Promise<string> {
  const env = options.env ?? process.env;
  const explicitHome = env.TSUGITE_PROJECTS_HOME?.trim();
  if (explicitHome) return resolve(explicitHome);

  const workspaceRoot = env.TSUGITE_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) return join(resolve(workspaceRoot), "projects");

  const cwd = resolve(options.cwd ?? process.cwd());
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8" }
    );
    const commonDir = stdout.trim();
    if (commonDir) return join(dirname(resolve(commonDir)), "projects");
  } catch {
    // Git is optional; fall back to cwd.
  }
  return join(cwd, "projects");
}

export async function planLauncherHome(
  configPath: string,
  projectSlug: string,
  options: ResolveDurableProjectsHomeOptions = {}
): Promise<LauncherHomePlan> {
  const lexicalProjectRoot = dirname(resolve(configPath));
  const projectRoot = await resolveExistingPath(lexicalProjectRoot);
  const projectsHome = await resolveDurableProjectsHome(options);
  const projectsHomeReal = await resolveExistingPath(projectsHome);
  const destinationRoot = join(projectsHome, sanitizeProjectDirName(projectSlug, projectRoot));
  // Use real paths so a shelf symlink into a worktree is not treated as already-home.
  const alreadyHome = !await isSymbolicLinkPath(lexicalProjectRoot)
    && isWithinDirectory(projectsHomeReal, projectRoot);
  return {
    projectsHome,
    projectRoot,
    destinationRoot: alreadyHome ? projectRoot : destinationRoot,
    alreadyHome,
    willPromote: !alreadyHome
  };
}
