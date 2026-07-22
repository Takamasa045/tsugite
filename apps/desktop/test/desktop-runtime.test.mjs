import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, lstat, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertCanonicalWorkspaceOutsideProtectedDirectory,
  assertWorkspaceOutsideProtectedDirectory,
  createIpcOriginGuard,
  createSecureWindowOptions,
  denyAllSessionPermissions,
  installNavigationGuards,
  prepareDesktopWorkspace,
  prepareWorkspaceDirectories,
  readWorkspacePreference,
  requestedWorkspaceRoot,
  resolveNodeExecutable,
  resolveRuntimeValidationOptions,
  resolveRuntimePaths,
  resolveWorkspaceRoot,
  writeWorkspacePreference
} from "../src/runtime.mjs";

test("dev runtime paths resolve from the desktop source module to the repo", () => {
  const repoRoot = resolve("desktop-runtime-fixture");
  const paths = resolveRuntimePaths({
    isPackaged: false,
    moduleUrl: pathToFileURL(join(repoRoot, "apps", "desktop", "src", "runtime.mjs")).href
  });

  assert.deepEqual(paths, {
    runtimeRoot: repoRoot,
    launcherModulePath: join(repoRoot, "build", "viewer", "launcher.js"),
    cliModulePath: join(repoRoot, "build", "cli.js"),
    viewerBundleDir: join(repoRoot, "apps", "workflow-viewer", "dist")
  });
});

test("packaged runtime paths resolve below resourcesPath", () => {
  const resourcesPath = resolve("packaged-resources");
  const runtimeRoot = join(resourcesPath, "runtime", "tsugite");
  const paths = resolveRuntimePaths({
    isPackaged: true,
    resourcesPath
  });

  assert.deepEqual(paths, {
    runtimeRoot,
    launcherModulePath: join(runtimeRoot, "build", "viewer", "launcher.js"),
    cliModulePath: join(runtimeRoot, "build", "cli.js"),
    viewerBundleDir: join(resourcesPath, "runtime", "viewer")
  });
});

test("runtime validation paths are rooted in the bundled runtime", () => {
  const runtimeRoot = resolve("packaged-resources", "runtime", "tsugite");
  assert.deepEqual(resolveRuntimeValidationOptions(runtimeRoot), {
    adapterDirs: [join(runtimeRoot, "adapters")],
    backendDirs: [join(runtimeRoot, "backends")],
    connectionCatalogPath: join(runtimeRoot, "connections", "catalog.yaml"),
    promptGuideDirs: [join(runtimeRoot, "knowledge", "video-models")]
  });
});

test("Node executable uses packaged runtime and the dev npm Node when available", () => {
  assert.equal(resolveNodeExecutable({
    isPackaged: true,
    runtimeRoot: "/runtime/tsugite",
    platform: "darwin",
    env: {}
  }), "/runtime/tsugite/bin/node");
  assert.equal(resolveNodeExecutable({
    isPackaged: true,
    runtimeRoot: "C:\\runtime\\tsugite",
    platform: "win32",
    env: {}
  }), "C:\\runtime\\tsugite\\bin\\node.exe");
  assert.equal(resolveNodeExecutable({
    isPackaged: false,
    runtimeRoot: "/repo",
    platform: "darwin",
    env: { npm_node_execpath: "/opt/node22/bin/node" }
  }), "/opt/node22/bin/node");
  assert.equal(resolveNodeExecutable({
    isPackaged: false,
    runtimeRoot: "/repo",
    platform: "darwin",
    env: {}
  }), "node");
});

test("workspace selection follows CLI, environment, dev repo, packaged userData priority", () => {
  const common = {
    cwd: resolve("current"),
    repoRoot: resolve("repo"),
    userDataPath: resolve("user-data")
  };

  assert.equal(resolveWorkspaceRoot({
    ...common,
    argv: ["electron", ".", "--workspace", "chosen"],
    env: { TSUGITE_WORKSPACE_ROOT: resolve("from-env") },
    isPackaged: false
  }), resolve(common.cwd, "chosen"));
  assert.equal(resolveWorkspaceRoot({
    ...common,
    argv: ["electron", "."],
    env: { TSUGITE_WORKSPACE_ROOT: resolve("from-env") },
    isPackaged: false
  }), resolve("from-env"));
  assert.equal(resolveWorkspaceRoot({
    ...common,
    argv: ["electron", "."],
    env: {},
    isPackaged: false
  }), common.repoRoot);
  assert.equal(resolveWorkspaceRoot({
    ...common,
    argv: ["Tsugite"],
    env: {},
    isPackaged: true
  }), join(common.userDataPath, "workspace"));
  assert.equal(resolveWorkspaceRoot({
    ...common,
    argv: ["electron", ".", "--workspace=inline"],
    env: {},
    isPackaged: false
  }), resolve(common.cwd, "inline"));
});

test("explicit workspace selection can be detected before packaged first-run selection", () => {
  const cwd = resolve("current");
  assert.equal(requestedWorkspaceRoot({
    argv: ["Tsugite", "--workspace", "chosen"],
    env: { TSUGITE_WORKSPACE_ROOT: resolve("from-env") },
    cwd
  }), resolve(cwd, "chosen"));
  assert.equal(requestedWorkspaceRoot({
    argv: ["Tsugite"],
    env: {},
    cwd
  }), undefined);
});

test("workspace preference is written atomically and ignores malformed or relative values", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-desktop-config-"));
  const configPath = join(parent, "desktop-config.json");
  const workspaceRoot = resolve(parent, "workspace");

  await writeWorkspacePreference(configPath, workspaceRoot);
  assert.equal(await readWorkspacePreference(configPath), workspaceRoot);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { workspaceRoot });

  await writeFile(configPath, "not-json\n", "utf8");
  assert.equal(await readWorkspacePreference(configPath), undefined);
  await writeFile(configPath, JSON.stringify({ workspaceRoot: "relative" }), "utf8");
  assert.equal(await readWorkspacePreference(configPath), undefined);
  await assert.rejects(writeWorkspacePreference(configPath, "relative"), /absolute path/);
});

test("packaged resources cannot be selected as a writable workspace", () => {
  const resources = resolve("Tsugite.app", "Contents", "Resources");
  assert.throws(
    () => assertWorkspaceOutsideProtectedDirectory(join(resources, "runtime"), resources),
    /outside the packaged application resources/
  );
  assert.doesNotThrow(() => assertWorkspaceOutsideProtectedDirectory(resolve("user-workspace"), resources));
});

test("desktop workspace rejects a protected destination before creating managed directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-protected-workspace-"));
  const protectedRoot = join(parent, "resources");
  const workspaceRoot = join(protectedRoot, "new-workspace");
  await mkdir(protectedRoot);

  await assert.rejects(
    prepareDesktopWorkspace(workspaceRoot, { protectedRoot }),
    /outside the packaged application resources/
  );
  await assert.rejects(access(workspaceRoot));
});

test("desktop workspace resolves a symlinked ancestor before creating below protected resources", {
  skip: process.platform === "win32" ? "Windows CI may not grant symlink privileges" : false
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-protected-workspace-link-"));
  const protectedRoot = join(parent, "real-resources");
  const protectedAlias = join(parent, "resources-alias");
  const workspaceRoot = join(protectedAlias, "existing", "new-workspace");
  await mkdir(join(protectedRoot, "existing"), { recursive: true });
  await symlink(protectedRoot, protectedAlias);

  await assert.rejects(
    prepareDesktopWorkspace(workspaceRoot, { protectedRoot }),
    /outside the packaged application resources/
  );
  await assert.rejects(access(join(protectedRoot, "existing", "new-workspace")));
});

test("desktop workspace rejects filesystem and home roots before creating managed directories", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "tsugite-home-root-"));

  await assert.rejects(
    prepareDesktopWorkspace(resolve(homeRoot), { homeRoot }),
    /dedicated subdirectory/
  );
  await assert.rejects(
    prepareDesktopWorkspace(parse(homeRoot).root, { homeRoot }),
    /filesystem root/
  );
  await assert.rejects(access(join(homeRoot, "projects")));
  await assert.rejects(access(join(homeRoot, "templates")));
});

test("protected resources are canonicalized before workspace comparison", {
  skip: process.platform === "win32" ? "Windows CI may not grant symlink privileges" : false
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-protected-link-"));
  const realProtected = join(parent, "real-resources");
  const protectedAlias = join(parent, "resources-alias");
  const workspace = join(realProtected, "nested-workspace");
  await mkdir(workspace, { recursive: true });
  await symlink(realProtected, protectedAlias);

  await assert.rejects(
    assertCanonicalWorkspaceOutsideProtectedDirectory(workspace, protectedAlias),
    /outside the packaged application resources/
  );
});

test("workspace preparation creates absolute real directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-desktop-"));
  const result = await prepareWorkspaceDirectories(join(parent, "workspace"));
  const canonicalRoot = await realpath(join(parent, "workspace"));

  assert.deepEqual(result, {
    root: canonicalRoot,
    projectsDir: join(canonicalRoot, "projects"),
    templatesDir: join(canonicalRoot, "templates")
  });
  assert.equal((await lstat(result.root)).isDirectory(), true);
  assert.equal((await lstat(result.projectsDir)).isDirectory(), true);
  assert.equal((await lstat(result.templatesDir)).isDirectory(), true);
});

test("workspace preparation canonicalizes an existing leaf below a symlinked ancestor", {
  skip: process.platform === "win32" ? "Windows CI may not grant symlink privileges" : false
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-desktop-link-"));
  const outside = await mkdtemp(join(tmpdir(), "tsugite-desktop-real-"));
  await symlink(outside, join(parent, "workspace-link"));
  const requested = join(parent, "workspace-link", "nested");
  await mkdir(requested);

  const result = await prepareWorkspaceDirectories(requested);

  assert.equal(result.root, await realpath(requested));
  assert.equal(result.projectsDir, join(result.root, "projects"));
});

test("workspace preparation rejects symlinked managed directories", {
  skip: process.platform === "win32" ? "Windows CI may not grant symlink privileges" : false
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "tsugite-desktop-"));
  const outside = await mkdtemp(join(tmpdir(), "tsugite-outside-"));
  const workspace = join(parent, "workspace");
  await prepareWorkspaceDirectories(workspace);
  await symlink(outside, join(workspace, "projects-link"));

  await assert.rejects(
    prepareWorkspaceDirectories(join(workspace, "projects-link", "nested")),
    /symbolic link/i
  );
});

test("BrowserWindow options keep renderer capabilities disabled and load only the trusted preload", () => {
  assert.deepEqual(createSecureWindowOptions({ preloadPath: "/app/src/preload.mjs" }), {
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: "/app/src/preload.mjs"
    }
  });
  assert.throws(() => createSecureWindowOptions({ preloadPath: "relative/preload.mjs" }), /absolute preload/);
});

test("IPC origin guard accepts only the launcher main frame from the owning window", () => {
  const mainFrame = { url: "http://127.0.0.1:4100/project" };
  const webContents = { mainFrame };
  const isTrusted = createIpcOriginGuard({
    launcherUrl: "http://127.0.0.1:4100",
    webContents
  });

  assert.equal(isTrusted({ sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(isTrusted({ sender: webContents, senderFrame: { url: "http://127.0.0.1:4200/review/index.html" } }), false);
  assert.equal(isTrusted({ sender: webContents, senderFrame: { url: "http://localhost:4100/project" } }), false);
  assert.equal(isTrusted({ sender: {}, senderFrame: mainFrame }), false);
  assert.equal(isTrusted({ sender: webContents, senderFrame: null }), false);
});

test("navigation guards allow only the exact launcher and artifact origins", () => {
  const listeners = new Map();
  let openHandler;
  const forwarded = [];
  const webContents = {
    on(name, handler) { listeners.set(name, handler); },
    setWindowOpenHandler(handler) { openHandler = handler; }
  };
  installNavigationGuards(webContents, {
    launcherUrl: "http://127.0.0.1:4100",
    artifactUrl: "http://127.0.0.1:4200",
    onAllowedWindowOpen: (url) => forwarded.push(url)
  });

  for (const name of ["will-navigate", "will-redirect"]) {
    const allowedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners.get(name)(allowedEvent, "http://127.0.0.1:4200/viewer/index.html");
    assert.equal(allowedEvent.prevented, false);

    const deniedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners.get(name)(deniedEvent, "http://127.0.0.1:4201/steal");
    assert.equal(deniedEvent.prevented, true);
  }

  assert.deepEqual(openHandler({ url: "http://127.0.0.1:4100/project" }), { action: "deny" });
  assert.deepEqual(forwarded, ["http://127.0.0.1:4100/project"]);
  assert.deepEqual(openHandler({ url: "https://example.com" }), { action: "deny" });
  assert.deepEqual(forwarded, ["http://127.0.0.1:4100/project"]);

  const webviewEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-attach-webview")(webviewEvent);
  assert.equal(webviewEvent.prevented, true);
});

test("navigation guards keep an active embedded CLI on the launcher", () => {
  const listeners = new Map();
  let openHandler;
  const blocked = [];
  const webContents = {
    on(name, handler) { listeners.set(name, handler); },
    setWindowOpenHandler(handler) { openHandler = handler; }
  };
  installNavigationGuards(webContents, {
    launcherUrl: "http://127.0.0.1:4100",
    artifactUrl: "http://127.0.0.1:4200",
    canNavigate: () => false,
    onAllowedWindowOpen() {},
    onNavigationBlocked: (url) => blocked.push(url)
  });

  const navigateEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-navigate")(navigateEvent, "http://127.0.0.1:4200/viewer/index.html");
  assert.equal(navigateEvent.prevented, true);
  assert.deepEqual(blocked, ["http://127.0.0.1:4200/viewer/index.html"]);

  assert.deepEqual(openHandler({ url: "http://127.0.0.1:4200/review/index.html" }), { action: "deny" });
  assert.deepEqual(blocked, [
    "http://127.0.0.1:4200/viewer/index.html",
    "http://127.0.0.1:4200/review/index.html"
  ]);
});

test("navigation setup rejects non-loopback base origins", () => {
  assert.throws(() => installNavigationGuards({
    on() {},
    setWindowOpenHandler() {}
  }, {
    launcherUrl: "https://example.com",
    artifactUrl: "http://127.0.0.1:4200",
    onAllowedWindowOpen() {}
  }), /loopback HTTP origin/);
});

test("session permission handlers always deny requests and checks", () => {
  let requestHandler;
  let checkHandler;
  denyAllSessionPermissions({
    setPermissionRequestHandler(handler) { requestHandler = handler; },
    setPermissionCheckHandler(handler) { checkHandler = handler; }
  });

  let result;
  requestHandler({}, "camera", (allowed) => { result = allowed; });
  assert.equal(result, false);
  assert.equal(checkHandler({}, "clipboard-read", "http://127.0.0.1:4100"), false);
});
