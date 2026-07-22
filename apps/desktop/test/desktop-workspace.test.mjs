import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  DESKTOP_WORKSPACE_IPC_CHANNELS,
  createDesktopWorkspaceController,
  choosePackagedWorkspace,
  registerDesktopWorkspaceIpc,
  relaunchArgumentsForWorkspace
} from "../src/workspace.mjs";

const CURRENT_WORKSPACE = resolve("desktop-workspace-fixture", "current-workspace");
const PICKED_WORKSPACE = resolve("desktop-workspace-fixture", "picked-workspace");
const PREPARED_WORKSPACE = resolve("desktop-workspace-fixture", "canonical", "picked-workspace");

function controllerFixture(overrides = {}) {
  const calls = [];
  const controller = createDesktopWorkspaceController({
    workspaceRoot: CURRENT_WORKSPACE,
    argv: ["electron", ".", "--workspace", "/old", "--inspect", "--workspace=/older"],
    isBusy: () => false,
    chooseWorkspace: async () => PICKED_WORKSPACE,
    prepareWorkspace: async () => ({ root: PREPARED_WORKSPACE }),
    persistWorkspace: async (root) => calls.push(["persist", root]),
    relaunch: (options) => calls.push(["relaunch", options]),
    quit: () => calls.push(["quit"]),
    schedule: (callback) => callback(),
    ...overrides
  });
  return { calls, controller };
}

test("relaunch arguments replace every previous workspace option and preserve unrelated arguments", () => {
  const newWorkspace = resolve("desktop-workspace-fixture", "new workspace");
  assert.deepEqual(relaunchArgumentsForWorkspace(
    ["electron", ".", "--workspace", "/old", "--inspect", "--workspace=/older"],
    newWorkspace
  ), [".", "--inspect", "--workspace", newWorkspace]);
  assert.deepEqual(relaunchArgumentsForWorkspace(
    ["Tsugite.exe", "--workspace"],
    "C:\\Tsugite Workspace"
  ), ["--workspace", "C:\\Tsugite Workspace"]);
});

test("workspace controller exposes the current workspace without accepting a renderer path", async () => {
  const { controller } = controllerFixture();

  assert.deepEqual(await controller.current(), {
    label: "current-workspace"
  });
});

test("workspace controller validates, persists, and relaunches a newly selected workspace", async () => {
  const { calls, controller } = controllerFixture();

  assert.deepEqual(await controller.select(), {
    status: "restarting",
    workspace: {
      label: "picked-workspace"
    }
  });
  assert.equal(controller.isSwitching(), true);
  assert.deepEqual(calls, [
    ["persist", PREPARED_WORKSPACE],
    ["relaunch", { args: [".", "--inspect", "--workspace", PREPARED_WORKSPACE] }],
    ["quit"]
  ]);
});

test("workspace controller preserves the current session when selection is canceled or unchanged", async () => {
  const canceled = controllerFixture({ chooseWorkspace: async () => undefined });
  assert.deepEqual(await canceled.controller.select(), {
    status: "canceled",
    workspace: { label: "current-workspace" }
  });
  assert.deepEqual(canceled.calls, []);

  const unchanged = controllerFixture({
    chooseWorkspace: async () => resolve("desktop-workspace-fixture", "same-via-alias"),
    prepareWorkspace: async () => ({ root: CURRENT_WORKSPACE })
  });
  assert.deepEqual(await unchanged.controller.select(), {
    status: "unchanged",
    workspace: { label: "current-workspace" }
  });
  assert.deepEqual(unchanged.calls, []);
});

test("workspace controller blocks selection while a pipeline or agent terminal is active", async () => {
  let choseWorkspace = false;
  const { controller } = controllerFixture({
    isBusy: () => true,
    chooseWorkspace: async () => {
      choseWorkspace = true;
      return PICKED_WORKSPACE;
    }
  });

  assert.deepEqual(await controller.select(), {
    status: "busy",
    workspace: { label: "current-workspace" }
  });
  assert.equal(choseWorkspace, false);
});

test("workspace controller serializes concurrent selection requests", async () => {
  let resolveSelection;
  const pendingSelection = new Promise((resolve) => { resolveSelection = resolve; });
  const { controller } = controllerFixture({ chooseWorkspace: () => pendingSelection });

  const first = controller.select();
  assert.equal(controller.isSwitching(), true);
  assert.deepEqual(await controller.select(), {
    status: "busy",
    workspace: { label: "current-workspace" }
  });
  resolveSelection(undefined);
  assert.equal((await first).status, "canceled");
  assert.equal(controller.isSwitching(), false);
});

test("packaged startup replaces an invalid saved workspace only after validating the replacement", async () => {
  const calls = [];
  const invalidSaved = resolve("desktop-workspace-fixture", "invalid-saved");
  const fallback = resolve("desktop-workspace-fixture", "fallback");
  const selected = resolve("desktop-workspace-fixture", "selected");
  const prepared = resolve("desktop-workspace-fixture", "canonical", "selected");
  const result = await choosePackagedWorkspace({
    persistedWorkspaceRoot: invalidSaved,
    fallbackWorkspaceRoot: fallback,
    chooseWorkspace: async () => {
      calls.push(["choose"]);
      return selected;
    },
    prepareWorkspace: async (root) => {
      calls.push(["prepare", root]);
      if (root === invalidSaved) throw new Error("missing");
      return { root: prepared };
    },
    persistWorkspace: async (root) => calls.push(["persist", root])
  });

  assert.deepEqual(result, { root: prepared });
  assert.deepEqual(calls, [
    ["prepare", invalidSaved],
    ["choose"],
    ["prepare", selected],
    ["persist", prepared]
  ]);
});

test("packaged startup never persists a replacement that fails validation", async () => {
  let persisted = false;
  await assert.rejects(choosePackagedWorkspace({
    persistedWorkspaceRoot: undefined,
    fallbackWorkspaceRoot: resolve("desktop-workspace-fixture", "fallback"),
    chooseWorkspace: async () => resolve("desktop-workspace-fixture", "invalid-selected"),
    prepareWorkspace: async () => { throw new Error("invalid workspace"); },
    persistWorkspace: async () => { persisted = true; }
  }), /invalid workspace/);
  assert.equal(persisted, false);
});

test("workspace IPC accepts only the owning launcher main frame and removes both handlers", async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { removed.push(channel); handlers.delete(channel); }
  };
  const controller = {
    current: async () => ({ label: "current" }),
    select: async () => ({ status: "canceled", workspace: { label: "current" } })
  };
  const trustedEvent = {};
  const registration = registerDesktopWorkspaceIpc({
    ipcMain,
    controller,
    isTrustedEvent: (event) => event === trustedEvent
  });

  assert.deepEqual(
    await handlers.get(DESKTOP_WORKSPACE_IPC_CHANNELS.current)(trustedEvent),
    { label: "current" }
  );
  await assert.rejects(
    handlers.get(DESKTOP_WORKSPACE_IPC_CHANNELS.select)({}),
    /Untrusted Desktop IPC origin/
  );

  registration.dispose();
  registration.dispose();
  assert.deepEqual(removed.sort(), Object.values(DESKTOP_WORKSPACE_IPC_CHANNELS).sort());
});
