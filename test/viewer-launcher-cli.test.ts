import { beforeEach, describe, expect, it, vi } from "vitest";

const { openLauncherMock, startLauncherMock } = vi.hoisted(() => ({
  openLauncherMock: vi.fn(),
  startLauncherMock: vi.fn()
}));

vi.mock("../src/viewer/launcher.js", () => ({
  openWorkflowViewerLauncher: openLauncherMock,
  startWorkflowViewerLauncher: startLauncherMock
}));

import { main } from "../src/cli.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

describe("pipeline viewer-launcher", () => {
  beforeEach(() => {
    openLauncherMock.mockReset();
    startLauncherMock.mockReset();
    startLauncherMock.mockResolvedValue({
      url: "http://127.0.0.1:43123",
      port: 43123,
      token: "secret",
      projectCount: 3,
      close: vi.fn(),
      closed: Promise.resolve()
    });
  });

  it("starts without --config, prints the result, opens it, and waits for close", async () => {
    const result = await capture([
      "viewer-launcher",
      "--projects-dir",
      "projects",
      "--port",
      "0",
      "--open",
      "--json"
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "viewer-launcher",
      url: "http://127.0.0.1:43123",
      port: 43123,
      project_count: 3,
      opened: true
    });
    expect(startLauncherMock).toHaveBeenCalledWith(expect.objectContaining({
      projectsDir: "projects",
      port: 0
    }));
    expect(openLauncherMock).toHaveBeenCalledWith("http://127.0.0.1:43123");
  });

  it("rejects an invalid port with a stable issue code", async () => {
    const result = await capture(["viewer-launcher", "--port", "not-a-port", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "viewer-launcher",
      issues: [{ code: "viewer_launcher.port" }]
    });
    expect(startLauncherMock).not.toHaveBeenCalled();
  });

  it("closes the launcher on SIGINT before returning", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const close = vi.fn(async () => {
      resolveClosed();
    });
    startLauncherMock.mockResolvedValue({
      url: "http://127.0.0.1:43123",
      port: 43123,
      token: "secret",
      projectCount: 3,
      close,
      closed
    });
    const existingHandlers = new Set(process.listeners("SIGINT"));

    const pending = capture(["viewer-launcher", "--json"]);
    await vi.waitFor(() => {
      expect(process.listeners("SIGINT").some((handler) => !existingHandlers.has(handler)))
        .toBe(true);
    });
    const closeHandler = process.listeners("SIGINT")
      .find((handler) => !existingHandlers.has(handler));
    expect(closeHandler).toBeDefined();
    closeHandler!();

    await expect(pending).resolves.toMatchObject({ status: 0 });
    expect(close).toHaveBeenCalledOnce();
    expect(process.listeners("SIGINT").some((handler) => !existingHandlers.has(handler)))
      .toBe(false);
  });
});
