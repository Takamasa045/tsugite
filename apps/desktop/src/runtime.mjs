import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";

export function resolveRuntimePaths({
  isPackaged,
  resourcesPath,
  moduleUrl = import.meta.url
}) {
  const runtimeRoot = isPackaged
    ? join(resourcesPath, "runtime", "tsugite")
    : resolve(fileURLToPath(new URL("../../../", moduleUrl)));
  const viewerBundleDir = isPackaged
    ? join(resourcesPath, "runtime", "viewer")
    : join(runtimeRoot, "apps", "workflow-viewer", "dist");
  return {
    runtimeRoot,
    launcherModulePath: join(runtimeRoot, "build", "viewer", "launcher.js"),
    cliModulePath: join(runtimeRoot, "build", "cli.js"),
    viewerBundleDir
  };
}

export function resolveRuntimeValidationOptions(runtimeRoot) {
  const root = resolve(runtimeRoot);
  return {
    adapterDirs: [join(root, "adapters")],
    backendDirs: [join(root, "backends")],
    connectionCatalogPath: join(root, "connections", "catalog.yaml"),
    promptGuideDirs: [join(root, "knowledge", "video-models")]
  };
}

export function resolveNodeExecutable({ isPackaged, runtimeRoot, platform, env }) {
  if (!isPackaged) return env.npm_node_execpath || "node";
  const pathApi = platform === "win32" ? win32 : posix;
  return pathApi.join(runtimeRoot, "bin", platform === "win32" ? "node.exe" : "node");
}

function workspaceArgument(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--workspace") return argv[index + 1];
    if (value?.startsWith("--workspace=")) return value.slice("--workspace=".length);
  }
  return undefined;
}

export function requestedWorkspaceRoot({ argv, env, cwd }) {
  const requested = workspaceArgument(argv) || env.TSUGITE_WORKSPACE_ROOT;
  if (!requested) return undefined;
  return isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
}

export function resolveWorkspaceRoot({ argv, env, isPackaged, cwd, repoRoot, userDataPath }) {
  const requested = requestedWorkspaceRoot({ argv, env, cwd });
  if (requested) return requested;
  return isPackaged ? join(userDataPath, "workspace") : resolve(repoRoot);
}

export function assertWorkspaceOutsideProtectedDirectory(workspaceRoot, protectedRoot) {
  const relation = relative(resolve(protectedRoot), resolve(workspaceRoot));
  const isInside = relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
  if (isInside) throw new Error("Workspace must be outside the packaged application resources");
}

export async function assertCanonicalWorkspaceOutsideProtectedDirectory(workspaceRoot, protectedRoot) {
  const [canonicalWorkspace, canonicalProtected] = await Promise.all([
    realpath(workspaceRoot),
    realpath(protectedRoot)
  ]);
  assertWorkspaceOutsideProtectedDirectory(canonicalWorkspace, canonicalProtected);
}

export async function readWorkspacePreference(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return typeof parsed?.workspaceRoot === "string" && isAbsolute(parsed.workspaceRoot)
      ? resolve(parsed.workspaceRoot)
      : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function writeWorkspacePreference(configPath, workspaceRoot) {
  if (!isAbsolute(workspaceRoot)) throw new Error("Workspace preference must be an absolute path");
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ workspaceRoot: resolve(workspaceRoot) }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, configPath);
}

async function assertNearestExistingPathIsSafe(path) {
  let current = resolve(path);
  while (true) {
    const stats = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) {
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
      continue;
    }
    if (stats.isSymbolicLink()) throw new Error(`Workspace path must not contain a symbolic link: ${current}`);
    if (!stats.isDirectory()) throw new Error(`Workspace path component must be a directory: ${current}`);
    return;
  }
}

async function ensureRealDirectory(path) {
  await assertNearestExistingPathIsSafe(path);
  await mkdir(path, { recursive: true });
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Workspace directory must not be a symbolic link: ${path}`);
  if (!stats.isDirectory()) throw new Error(`Workspace path must be a directory: ${path}`);
}

export async function prepareWorkspaceDirectories(workspaceRoot) {
  const root = resolve(workspaceRoot);
  await ensureRealDirectory(root);
  const canonicalRoot = await realpath(root);
  const projectsDir = join(canonicalRoot, "projects");
  const templatesDir = join(canonicalRoot, "templates");
  await ensureRealDirectory(projectsDir);
  await ensureRealDirectory(templatesDir);
  return { root: canonicalRoot, projectsDir, templatesDir };
}

export function createSecureWindowOptions({ preloadPath } = {}) {
  if (!isAbsolute(preloadPath || "")) throw new Error("Desktop requires an absolute preload path");
  return {
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath
    }
  };
}

function allowedOrigins(launcherUrl, artifactUrl) {
  const origins = new Set();
  for (const input of [launcherUrl, artifactUrl]) {
    const url = new URL(input);
    if (url.protocol !== "http:" || url.hostname !== LOOPBACK_HOST || url.username || url.password) {
      throw new Error(`Desktop navigation requires a loopback HTTP origin: ${input}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function createIpcOriginGuard({ launcherUrl, webContents }) {
  const url = new URL(launcherUrl);
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK_HOST || url.username || url.password) {
    throw new Error(`Desktop IPC requires a loopback HTTP origin: ${launcherUrl}`);
  }
  const launcherOrigin = url.origin;
  return (event) => {
    if (event?.sender !== webContents || event?.senderFrame !== webContents?.mainFrame) return false;
    const input = event?.senderFrame?.url;
    if (typeof input !== "string") return false;
    try {
      const url = new URL(input);
      return url.protocol === "http:" && url.hostname === LOOPBACK_HOST && url.origin === launcherOrigin;
    } catch {
      return false;
    }
  };
}

export function installNavigationGuards(webContents, {
  launcherUrl,
  artifactUrl,
  onAllowedWindowOpen
}) {
  const origins = allowedOrigins(launcherUrl, artifactUrl);
  const isAllowed = (candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" && url.hostname === LOOPBACK_HOST && origins.has(url.origin);
    } catch {
      return false;
    }
  };
  const guard = (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  };
  webContents.on("will-navigate", guard);
  webContents.on("will-redirect", guard);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) onAllowedWindowOpen(url);
    return { action: "deny" };
  });
  return { isAllowed };
}

export function denyAllSessionPermissions(session) {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
