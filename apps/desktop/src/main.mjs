import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import squirrelStartup from "electron-squirrel-startup";

import { createAgentTerminalManager, registerAgentTerminalIpc } from "./agent-terminal.mjs";
import { createBeforeQuitCoordinator } from "./lifecycle.mjs";
import { createPipelineRunner } from "./process-runner.mjs";
import {
  createIpcOriginGuard,
  createSecureWindowOptions,
  denyAllSessionPermissions,
  installNavigationGuards,
  prepareDesktopWorkspace,
  readWorkspacePreference,
  requestedWorkspaceRoot,
  resolveNodeExecutable,
  resolveRuntimeValidationOptions,
  resolveRuntimePaths,
  resolveWorkspaceRoot,
  writeWorkspacePreference
} from "./runtime.mjs";
import {
  choosePackagedWorkspace,
  createDesktopWorkspaceController,
  registerDesktopWorkspaceIpc
} from "./workspace.mjs";

const shouldStart = !squirrelStartup;
if (!shouldStart) app.quit();

let mainWindow;
let launcher;
let runner;
let agentTerminals;
let agentTerminalIpc;
let workspaceIpc;
let workspaceController;
let quitCoordinator;

function logDevelopmentStatus(message) {
  if (!app.isPackaged) console.info(`[tsugite-desktop] ${message}`);
}

const hasSingleInstanceLock = shouldStart && app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

async function startDesktop() {
  logDevelopmentStatus("starting");
  const paths = resolveRuntimePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
  const workspace = await chooseWorkspace(paths);
  logDevelopmentStatus("workspace ready");
  const nodeExecutable = resolveNodeExecutable({
    isPackaged: app.isPackaged,
    runtimeRoot: paths.runtimeRoot,
    platform: process.platform,
    env: process.env
  });
  runner = createPipelineRunner({
    nodeExecutable,
    cliModulePath: paths.cliModulePath,
    runtimeRoot: paths.runtimeRoot
  });
  const ptyModule = await import("node-pty");
  agentTerminals = createAgentTerminalManager({
    workspaceRoot: workspace.root,
    pty: ptyModule.default ?? ptyModule
  });

  const launcherModule = await import(pathToFileURL(paths.launcherModulePath).href);
  logDevelopmentStatus("launcher module loaded");
  launcher = await launcherModule.startWorkflowViewerLauncher({
    projectsDir: workspace.projectsDir,
    templatesDir: workspace.templatesDir,
    bundleDir: paths.viewerBundleDir,
    validationOptions: resolveRuntimeValidationOptions(paths.runtimeRoot),
    allowProjectActions: false,
    executePipeline: runner.run,
    runGeneration: runner.runGeneration,
    canStartWork: () => Boolean(workspaceController && !workspaceController.isSwitching())
  });
  logDevelopmentStatus(`launcher ready at ${launcher.url}`);

  const desktopProcesses = {
    hasActive: () => launcher.hasActive() || runner.hasActive() || agentTerminals.hasActive(),
    dispose: async () => {
      const results = await Promise.allSettled([
        agentTerminals.dispose(),
        runner.dispose()
      ]);
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Desktop processes could not be stopped");
      agentTerminalIpc?.dispose();
      workspaceIpc?.dispose();
    }
  };
  quitCoordinator = createBeforeQuitCoordinator({
    beginShutdown: () => launcher.suspendWork(),
    runner: desktopProcesses,
    confirmActiveQuit: async () => {
      if (launcher.hasBlockingWork()) {
        const options = {
          type: "info",
          title: "更新処理の完了を待っています",
          message: "workspaceの更新処理が完了してから、もう一度終了してください。",
          buttons: ["わかりました"],
          noLink: true
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, options);
        } else {
          await dialog.showMessageBox(options);
        }
        return false;
      }
      const options = {
        type: "warning",
        title: "実行中の処理があります",
        message: "Tsugiteで処理を実行中です。終了すると処理を停止します。",
        buttons: ["処理を停止して終了", "キャンセル"],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    closeLauncher: () => launcher?.close(),
    quit: () => app.quit()
  });

  denyAllSessionPermissions(session.defaultSession);
  mainWindow = new BrowserWindow(createSecureWindowOptions({
    preloadPath: fileURLToPath(new URL("./preload.mjs", import.meta.url))
  }));
  installNavigationGuards(mainWindow.webContents, {
    launcherUrl: launcher.url,
    artifactUrl: launcher.artifactUrl,
    canNavigate: (url) => new URL(url).origin === new URL(launcher.url).origin || !agentTerminals.hasActive(),
    onAllowedWindowOpen: (url) => {
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.loadURL(url);
      return undefined;
    },
    onNavigationBlocked: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "AI CLIと作業中です",
        message: "制作画面へ移動する前に、画面下部の「停止」を押してください。",
        buttons: ["わかりました"],
        noLink: true
      });
    }
  });
  const isTrustedIpcEvent = createIpcOriginGuard({
    launcherUrl: launcher.url,
    webContents: mainWindow.webContents
  });
  workspaceController = createDesktopWorkspaceController({
    workspaceRoot: workspace.root,
    argv: process.argv,
    isBusy: () => desktopProcesses.hasActive(),
    chooseWorkspace: () => showWorkspaceDialog(mainWindow),
    prepareWorkspace: (workspaceRoot) => prepareDesktopWorkspace(workspaceRoot, {
      ...(app.isPackaged ? { protectedRoot: process.resourcesPath } : {}),
      homeRoot: app.getPath("home")
    }),
    persistWorkspace: (workspaceRoot) => writeWorkspacePreference(
      join(app.getPath("userData"), "desktop-config.json"),
      workspaceRoot
    ),
    relaunch: (options) => app.relaunch(options),
    quit: () => app.quit()
  });
  agentTerminalIpc = registerAgentTerminalIpc({
    ipcMain,
    manager: agentTerminals,
    isTrustedEvent: (event) => (
      isTrustedIpcEvent(event) && !workspaceController.isSwitching()
    ),
    send: (channel, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const eventLike = {
        sender: mainWindow.webContents,
        senderFrame: mainWindow.webContents.mainFrame
      };
      if (isTrustedIpcEvent(eventLike)) mainWindow.webContents.send(channel, payload);
    }
  });
  workspaceIpc = registerDesktopWorkspaceIpc({
    ipcMain,
    controller: workspaceController,
    isTrustedEvent: isTrustedIpcEvent
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => quitCoordinator?.requestWindowClose(event));
  mainWindow.on("closed", () => { mainWindow = undefined; });
  await mainWindow.loadURL(launcher.url);
  logDevelopmentStatus("window ready");
}

async function chooseWorkspace(paths) {
  const requested = requestedWorkspaceRoot({
    argv: process.argv,
    env: process.env,
    cwd: process.cwd()
  });
  if (requested || !app.isPackaged) {
    const workspaceRoot = requested ?? resolveWorkspaceRoot({
      argv: process.argv,
      env: process.env,
      isPackaged: false,
      cwd: process.cwd(),
      repoRoot: paths.runtimeRoot,
      userDataPath: app.getPath("userData")
    });
    return prepareDesktopWorkspace(workspaceRoot, {
      ...(app.isPackaged ? { protectedRoot: process.resourcesPath } : {}),
      homeRoot: app.getPath("home")
    });
  }

  const preferencePath = join(app.getPath("userData"), "desktop-config.json");
  const persisted = await readWorkspacePreference(preferencePath);
  return choosePackagedWorkspace({
    persistedWorkspaceRoot: persisted,
    fallbackWorkspaceRoot: join(app.getPath("userData"), "workspace"),
    chooseWorkspace: () => showWorkspaceDialog(),
    prepareWorkspace: (workspaceRoot) => prepareDesktopWorkspace(workspaceRoot, {
      protectedRoot: process.resourcesPath,
      homeRoot: app.getPath("home")
    }),
    persistWorkspace: (workspaceRoot) => writeWorkspacePreference(preferencePath, workspaceRoot)
  });
}

async function showWorkspaceDialog(parentWindow) {
  const options = {
    title: "Tsugite workspaceを選択",
    message: "projects と templates を保存するフォルダを選択してください。",
    properties: ["openDirectory", "createDirectory"]
  };
  const selection = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  return selection.canceled || !selection.filePaths[0] ? undefined : selection.filePaths[0];
}

app.on("before-quit", (event) => {
  if (quitCoordinator) {
    void quitCoordinator.beforeQuit(event).catch((error) => {
      dialog.showErrorBox("Tsugiteを終了できませんでした", error instanceof Error ? error.message : String(error));
    });
  }
});
app.on("window-all-closed", () => app.quit());

if (hasSingleInstanceLock) {
  app.whenReady()
    .then(startDesktop)
    .catch(async (error) => {
      if (!quitCoordinator) {
        agentTerminalIpc?.dispose();
        workspaceIpc?.dispose();
        await agentTerminals?.dispose().catch(() => {});
        await runner?.dispose().catch(() => {});
        await launcher?.close().catch(() => {});
      }
      dialog.showErrorBox(
        "Tsugiteを起動できませんでした",
        error instanceof Error ? error.message : String(error)
      );
      app.quit();
    });
}
