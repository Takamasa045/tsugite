import { basename, isAbsolute, resolve } from "node:path";

export const DESKTOP_WORKSPACE_IPC_CHANNELS = Object.freeze({
  current: "tsugite:workspace:current",
  select: "tsugite:workspace:select"
});

function workspaceInfo(workspaceRoot) {
  return Object.freeze({ label: basename(workspaceRoot) || workspaceRoot });
}

export function relaunchArgumentsForWorkspace(argv, workspaceRoot) {
  if (!Array.isArray(argv)) throw new TypeError("Desktop relaunch arguments must be an array");
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("Desktop relaunch workspace must be a non-empty string");
  }
  const args = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--workspace") {
      index += 1;
      continue;
    }
    if (typeof value === "string" && value.startsWith("--workspace=")) continue;
    args.push(value);
  }
  args.push("--workspace", workspaceRoot);
  return args;
}

export async function choosePackagedWorkspace({
  persistedWorkspaceRoot,
  fallbackWorkspaceRoot,
  chooseWorkspace,
  prepareWorkspace,
  persistWorkspace
}) {
  if (persistedWorkspaceRoot) {
    try {
      return await prepareWorkspace(persistedWorkspaceRoot);
    } catch {
      // A stale or invalid preference must not trap Desktop in a startup loop.
    }
  }
  const selectedRoot = await chooseWorkspace();
  const workspace = await prepareWorkspace(selectedRoot ?? fallbackWorkspaceRoot);
  if (!workspace || typeof workspace.root !== "string" || !isAbsolute(workspace.root)) {
    throw new Error("Desktop workspace preparation did not return an absolute root");
  }
  await persistWorkspace(resolve(workspace.root));
  return workspace;
}

export function createDesktopWorkspaceController({
  workspaceRoot,
  argv,
  isBusy,
  chooseWorkspace,
  prepareWorkspace,
  persistWorkspace,
  relaunch,
  quit,
  schedule = setImmediate
}) {
  if (!isAbsolute(workspaceRoot)) throw new Error("Desktop workspace root must be absolute");
  for (const [name, operation] of Object.entries({
    isBusy,
    chooseWorkspace,
    prepareWorkspace,
    persistWorkspace,
    relaunch,
    quit,
    schedule
  })) {
    if (typeof operation !== "function") throw new TypeError(`Desktop workspace ${name} must be a function`);
  }

  const currentRoot = resolve(workspaceRoot);
  const currentWorkspace = workspaceInfo(currentRoot);
  let selecting = false;
  let restarting = false;

  const current = async () => currentWorkspace;
  const busyResult = () => ({ status: "busy", workspace: currentWorkspace });

  const select = async () => {
    if (selecting || restarting || isBusy()) return busyResult();
    selecting = true;
    try {
      const selectedRoot = await chooseWorkspace();
      if (selectedRoot === undefined) {
        return { status: "canceled", workspace: currentWorkspace };
      }
      if (typeof selectedRoot !== "string" || selectedRoot.length === 0) {
        throw new TypeError("Desktop workspace selection must be an absolute directory path");
      }
      if (isBusy()) return busyResult();

      const prepared = await prepareWorkspace(selectedRoot);
      if (!prepared || typeof prepared.root !== "string" || !isAbsolute(prepared.root)) {
        throw new Error("Desktop workspace preparation did not return an absolute root");
      }
      const nextRoot = resolve(prepared.root);
      if (nextRoot === currentRoot) {
        return { status: "unchanged", workspace: currentWorkspace };
      }
      if (isBusy()) return busyResult();

      await persistWorkspace(nextRoot);
      relaunch({ args: relaunchArgumentsForWorkspace(argv, nextRoot) });
      restarting = true;
      schedule(() => quit());
      return { status: "restarting", workspace: workspaceInfo(nextRoot) };
    } finally {
      if (!restarting) selecting = false;
    }
  };

  return {
    current,
    select,
    isSwitching: () => selecting || restarting
  };
}

export function registerDesktopWorkspaceIpc({ ipcMain, controller, isTrustedEvent }) {
  const methods = [
    [DESKTOP_WORKSPACE_IPC_CHANNELS.current, () => controller.current()],
    [DESKTOP_WORKSPACE_IPC_CHANNELS.select, () => controller.select()]
  ];
  for (const [channel, invoke] of methods) {
    ipcMain.handle(channel, async (event) => {
      if (!isTrustedEvent(event)) throw new Error("Untrusted Desktop IPC origin");
      return invoke();
    });
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [channel] of methods) ipcMain.removeHandler(channel);
    }
  };
}
