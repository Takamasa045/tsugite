import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../types.js";

const execFileAsync = promisify(execFile);

export type ResolveDurableProjectsHomeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type LauncherHomePlan = {
  projectsHome: string;
  projectRoot: string;
  destinationRoot: string;
  alreadyHome: boolean;
  willPromote: boolean;
};

export type EnsureLauncherHomeOptions = {
  configPath: string;
  projectSlug: string;
  apply: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
};

export type EnsureLauncherHomeResult = {
  ok: boolean;
  issues: Issue[];
  projectsHome: string;
  projectRoot: string;
  destinationRoot: string;
  alreadyHome: boolean;
  promoted: boolean;
  destinationConfigPath?: string;
};

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

export function isWithinDirectory(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
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

export type EnsureProjectVisibleOptions = {
  configPath: string;
  projectSlug: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type EnsureProjectVisibleResult = {
  ok: boolean;
  issues: Issue[];
  alreadyHome: boolean;
  linked: boolean;
  projectsHome: string;
  launcherProjectRoot: string;
  launcherConfigPath: string;
};

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
  try {
    await mkdir(plan.projectsHome, { recursive: true });
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
    return {
      ok: false,
      issues: [{
        code: "launcher_home.register_failed",
        message: error instanceof Error ? error.message : String(error),
        path: destinationRoot
      }],
      alreadyHome: false,
      linked: false,
      projectsHome: plan.projectsHome,
      launcherProjectRoot: destinationRoot,
      launcherConfigPath
    };
  }
}

/**
 * After finalize, ensure the completed project is present under the durable
 * launcher projects home so feature-worktree cleanup cannot hide it.
 */
export async function ensureFinalizedProjectInLauncherHome(
  options: EnsureLauncherHomeOptions
): Promise<EnsureLauncherHomeResult> {
  const plan = await planLauncherHome(options.configPath, options.projectSlug, {
    cwd: options.cwd,
    env: options.env
  });
  const base: EnsureLauncherHomeResult = {
    ok: true,
    issues: [],
    projectsHome: plan.projectsHome,
    projectRoot: plan.projectRoot,
    destinationRoot: plan.destinationRoot,
    alreadyHome: plan.alreadyHome,
    promoted: false,
    destinationConfigPath: options.configPath
  };

  if (plan.alreadyHome) {
    return {
      ...base,
      destinationConfigPath: resolve(options.configPath)
    };
  }

  if (!options.apply) {
    return {
      ...base,
      destinationConfigPath: join(plan.destinationRoot, basename(resolve(options.configPath)))
    };
  }

  try {
    await assertSafePromotion(plan.projectRoot, plan.destinationRoot, plan.projectsHome, options.projectSlug);
    await mkdir(plan.projectsHome, { recursive: true });
    // Replace the destination atomically from a temp tree so deleted media does not linger.
    // Also replaces a pre-production shelf symlink with a real completed copy.
    await replaceDirectoryWithCopy(plan.projectRoot, plan.destinationRoot);
    const destinationConfigPath = join(
      plan.destinationRoot,
      basename(resolve(options.configPath))
    );
    await writePromotionMarker(plan.destinationRoot, {
      sourceProjectRoot: plan.projectRoot,
      projectsHome: plan.projectsHome,
      projectSlug: options.projectSlug,
      promotedAt: options.now ?? new Date().toISOString()
    });
    return {
      ...base,
      promoted: true,
      destinationConfigPath
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      issues: [{
        code: "finalize.launcher_home_promote_failed",
        message: error instanceof Error ? error.message : String(error),
        path: plan.destinationRoot
      }]
    };
  }
}

function sanitizeProjectDirName(projectSlug: string, projectRoot: string): string {
  const slug = projectSlug.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return slug;
  return basename(projectRoot);
}

async function assertSafePromotion(
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

async function replaceDirectoryWithCopy(sourceRoot: string, destinationRoot: string): Promise<void> {
  const parent = dirname(destinationRoot);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.promote-${basename(destinationRoot)}-`));
  const stagedProject = join(staging, "project");
  try {
    await cp(sourceRoot, stagedProject, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return name !== "node_modules" && name !== ".git";
      }
    });
    const backup = `${destinationRoot}.replaced-${Date.now()}`;
    let hadDestination = false;
    try {
      await lstat(destinationRoot);
      hadDestination = true;
      await rename(destinationRoot, backup);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    try {
      await rename(stagedProject, destinationRoot);
    } catch (error) {
      if (hadDestination) {
        try {
          await rename(backup, destinationRoot);
        } catch {
          // best effort restore
        }
      }
      throw error;
    }
    if (hadDestination) {
      await rm(backup, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writePromotionMarker(
  destinationRoot: string,
  input: {
    sourceProjectRoot: string;
    projectsHome: string;
    projectSlug: string;
    promotedAt: string;
  }
): Promise<void> {
  const markerPath = join(destinationRoot, "launcher-home.json");
  await writeFile(
    markerPath,
    `${JSON.stringify({
      schema_version: 1,
      project_slug: input.projectSlug,
      projects_home: input.projectsHome,
      source_project_root: input.sourceProjectRoot,
      promoted_at: input.promotedAt
    }, null, 2)}\n`,
    "utf8"
  );
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

async function resolveExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function isSymbolicLinkPath(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
