import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const MAIN_PROCESS_HOOK = "__tsugitePackagedWorkspaceE2E";

async function resolvePackagedExecutable() {
  const outRoot = resolve("out");
  const platformTargets = {
    darwin: join(
      outRoot,
      `Tsugite-darwin-${process.arch}`,
      "Tsugite.app",
      "Contents",
      "MacOS",
      "Tsugite"
    ),
    win32: join(outRoot, `Tsugite-win32-${process.arch}`, "Tsugite.exe")
  };
  const executable = platformTargets[process.platform];
  if (!executable) {
    throw new Error(`Packaged workspace E2E is not configured for ${process.platform}`);
  }
  if (!(await stat(executable)).isFile()) {
    throw new Error(`Packaged Desktop executable is not a file: ${executable}`);
  }
  return executable;
}

async function prepareWorkspace(root, projectSource) {
  const projectsDir = join(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(join(root, "templates"), { recursive: true });
  if (projectSource) {
    await cp(projectSource, join(projectsDir, "valid-project"), { recursive: true });
  }
}

async function installMainProcessStubs(application, selectedWorkspace) {
  await application.evaluate(({ app, dialog }, payload) => {
    const state = {
      dialogCalls: 0,
      dialogOptions: undefined,
      quitCalls: 0,
      relaunchOptions: undefined
    };
    globalThis[payload.hookName] = {
      originalQuit: app.quit,
      originalRelaunch: app.relaunch,
      originalShowOpenDialog: dialog.showOpenDialog,
      state
    };
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1) ?? {};
      state.dialogCalls += 1;
      state.dialogOptions = {
        properties: Array.isArray(options.properties) ? [...options.properties] : [],
        title: options.title
      };
      return { canceled: false, filePaths: [payload.selectedWorkspace] };
    };
    app.relaunch = (options = {}) => {
      state.relaunchOptions = {
        args: Array.isArray(options.args) ? [...options.args] : []
      };
    };
    app.quit = () => {
      state.quitCalls += 1;
    };
  }, { hookName: MAIN_PROCESS_HOOK, selectedWorkspace });
}

async function readMainProcessState(application) {
  return application.evaluate((_electron, hookName) => {
    const hook = globalThis[hookName];
    return hook ? structuredClone(hook.state) : undefined;
  }, MAIN_PROCESS_HOOK);
}

async function waitForRelaunch(application) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await readMainProcessState(application);
    if (state?.relaunchOptions && state.quitCalls > 0) return state;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Packaged Desktop did not request a relaunch after workspace selection");
}

async function restoreMainProcessStubs(application) {
  if (!application) return;
  await application.evaluate(({ app, dialog }, hookName) => {
    const hook = globalThis[hookName];
    if (!hook) return;
    app.quit = hook.originalQuit;
    app.relaunch = hook.originalRelaunch;
    dialog.showOpenDialog = hook.originalShowOpenDialog;
    delete globalThis[hookName];
  }, MAIN_PROCESS_HOOK).catch(() => {});
}

function removePlaywrightDebugArguments(args) {
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (/^--(?:inspect|inspect-brk|remote-debugging-port)(?:=|$)/.test(argument)) {
      if (!argument.includes("=") && args[index + 1] && !args[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    sanitized.push(argument);
  }
  return sanitized;
}

test(
  "packaged Desktop recovers from an empty workspace and restores projects after relaunch",
  { timeout: 120_000 },
  async (context) => {
    if (!new Set(["darwin", "win32"]).has(process.platform)) {
      context.skip(`packaged Desktop E2E is unsupported on ${process.platform}`);
      return;
    }

    const { _electron } = await import("playwright-core");
    const fixtureRoot = await mkdtemp(join(tmpdir(), "tsugite-desktop-packaged-e2e-"));
    const emptyWorkspace = join(fixtureRoot, "empty-workspace");
    const populatedWorkspace = join(fixtureRoot, "populated-workspace");
    const userDataRoot = join(fixtureRoot, "user-data");
    const projectSource = resolve("..", "..", "examples", "local-fixture");
    let firstApp;
    let secondApp;

    context.after(async () => {
      await restoreMainProcessStubs(firstApp);
      await firstApp?.close().catch(() => {});
      await secondApp?.close().catch(() => {});
      await rm(fixtureRoot, { recursive: true, force: true });
    });

    await Promise.all([
      prepareWorkspace(emptyWorkspace),
      prepareWorkspace(populatedWorkspace, projectSource),
      mkdir(userDataRoot, { recursive: true })
    ]);
    const [canonicalEmptyWorkspace, canonicalPopulatedWorkspace, canonicalUserDataRoot] =
      await Promise.all([
        realpath(emptyWorkspace),
        realpath(populatedWorkspace),
        realpath(userDataRoot)
      ]);
    const executablePath = await resolvePackagedExecutable();
    const userDataArgument = `--user-data-dir=${userDataRoot}`;

    firstApp = await _electron.launch({
      executablePath,
      args: [userDataArgument, "--workspace", emptyWorkspace],
      env: { ...process.env }
    });
    const firstWindow = await firstApp.firstWindow();
    await firstWindow.getByText("表示できる制作案件はまだありません。").waitFor();
    await firstWindow.getByText(`現在のworkspace：${basename(canonicalEmptyWorkspace)}`).waitFor();
    assert.equal(await firstApp.evaluate(({ app }) => app.isPackaged), true);
    const actualUserDataRoot = await firstApp.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(
      await realpath(actualUserDataRoot),
      canonicalUserDataRoot
    );

    await installMainProcessStubs(firstApp, canonicalPopulatedWorkspace);
    await firstWindow.getByRole("button", { name: "workspaceを選び直す" }).click();
    const state = await waitForRelaunch(firstApp);

    assert.equal(state.dialogCalls, 1);
    assert.deepEqual(state.dialogOptions, {
      properties: ["openDirectory", "createDirectory"],
      title: "Tsugite workspaceを選択"
    });
    assert.equal(state.quitCalls, 1);
    const relaunchArgs = state.relaunchOptions.args;
    const workspaceIndexes = relaunchArgs
      .map((argument, index) => argument === "--workspace" || argument.startsWith("--workspace=")
        ? index
        : -1)
      .filter((index) => index >= 0);
    assert.equal(workspaceIndexes.length, 1);
    assert.equal(relaunchArgs[workspaceIndexes[0]], "--workspace");
    assert.equal(relaunchArgs[workspaceIndexes[0] + 1], canonicalPopulatedWorkspace);
    assert.ok(relaunchArgs.some((argument) => argument.startsWith("--user-data-dir=")));

    const savedPreference = JSON.parse(
      await readFile(join(canonicalUserDataRoot, "desktop-config.json"), "utf8")
    );
    assert.deepEqual(savedPreference, { workspaceRoot: canonicalPopulatedWorkspace });

    await restoreMainProcessStubs(firstApp);
    await firstApp.close();
    firstApp = undefined;

    secondApp = await _electron.launch({
      executablePath,
      args: removePlaywrightDebugArguments(relaunchArgs),
      env: { ...process.env }
    });
    const secondWindow = await secondApp.firstWindow();
    await secondWindow.getByText("全案件").waitFor();
    await secondWindow
      .getByRole("button", { name: "valid-projectの制作工程を選ぶ" })
      .waitFor();
    assert.equal(await secondApp.evaluate(({ app }) => app.isPackaged), true);
    await secondWindow
      .getByText("表示できる制作案件はまだありません。")
      .waitFor({ state: "detached" });
    await secondWindow
      .getByRole("button", { name: "workspaceを選び直す" })
      .waitFor({ state: "detached" });
  }
);
