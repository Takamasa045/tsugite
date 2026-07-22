import assert from "node:assert/strict";
import test from "node:test";

import { createBeforeQuitCoordinator } from "../src/lifecycle.mjs";

function quitEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

test("active work can cancel quit without disposing or closing the launcher", async () => {
  const calls = [];
  const coordinator = createBeforeQuitCoordinator({
    beginShutdown: () => {
      calls.push("pause");
      return () => calls.push("resume");
    },
    runner: { hasActive: () => true, dispose: async () => calls.push("dispose") },
    confirmActiveQuit: async () => { calls.push("confirm"); return false; },
    closeLauncher: async () => calls.push("close"),
    quit: () => calls.push("quit")
  });
  const event = quitEvent();

  await coordinator.beforeQuit(event);

  assert.equal(event.prevented, true);
  assert.deepEqual(calls, ["pause", "confirm", "resume"]);
  assert.equal(coordinator.readyToQuit(), false);
});

test("confirmed quit stops children before closing the launcher and quitting", async () => {
  const calls = [];
  const coordinator = createBeforeQuitCoordinator({
    beginShutdown: () => {
      calls.push("pause");
      return () => calls.push("resume");
    },
    runner: { hasActive: () => true, dispose: async () => calls.push("dispose") },
    confirmActiveQuit: async () => { calls.push("confirm"); return true; },
    closeLauncher: async () => calls.push("close"),
    quit: () => calls.push("quit")
  });
  const event = quitEvent();

  await coordinator.beforeQuit(event);

  assert.deepEqual(calls, ["pause", "confirm", "dispose", "close", "quit"]);
  assert.equal(coordinator.readyToQuit(), true);
});

test("cleanup failure keeps new launcher work paused", async () => {
  const calls = [];
  const confirmations = [true, false];
  let pauseCount = 0;
  const coordinator = createBeforeQuitCoordinator({
    beginShutdown: () => {
      calls.push("pause");
      pauseCount += 1;
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        pauseCount -= 1;
        calls.push("resume");
      };
    },
    runner: {
      hasActive: () => true,
      dispose: async () => {
        calls.push("dispose");
        throw new Error("child did not stop");
      }
    },
    confirmActiveQuit: async () => confirmations.shift() ?? false,
    closeLauncher: async () => calls.push("close"),
    quit: () => calls.push("quit")
  });

  await assert.rejects(coordinator.beforeQuit(quitEvent()), /child did not stop/);

  assert.deepEqual(calls, ["pause", "dispose"]);
  assert.equal(pauseCount, 1);
  await coordinator.beforeQuit(quitEvent());
  assert.deepEqual(calls, ["pause", "dispose", "pause", "resume"]);
  assert.equal(pauseCount, 1);
  assert.equal(coordinator.readyToQuit(), false);
});

test("quit without active work skips confirmation", async () => {
  const calls = [];
  const coordinator = createBeforeQuitCoordinator({
    runner: { hasActive: () => false, dispose: async () => calls.push("dispose") },
    confirmActiveQuit: async () => { calls.push("confirm"); return true; },
    closeLauncher: async () => calls.push("close"),
    quit: () => calls.push("quit")
  });

  await coordinator.beforeQuit(quitEvent());
  assert.deepEqual(calls, ["dispose", "close", "quit"]);
});

test("closing the last window requests quit before destruction and can later be released", async () => {
  const calls = [];
  const coordinator = createBeforeQuitCoordinator({
    runner: { hasActive: () => false, dispose: async () => calls.push("dispose") },
    confirmActiveQuit: async () => true,
    closeLauncher: async () => calls.push("close"),
    quit: () => calls.push("quit")
  });
  const firstClose = quitEvent();

  coordinator.requestWindowClose(firstClose);
  assert.equal(firstClose.prevented, true);
  assert.deepEqual(calls, ["quit"]);

  await coordinator.beforeQuit(quitEvent());
  const finalClose = quitEvent();
  coordinator.requestWindowClose(finalClose);
  assert.equal(finalClose.prevented, false);
  assert.deepEqual(calls, ["quit", "dispose", "close", "quit"]);
});
