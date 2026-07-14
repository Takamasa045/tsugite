import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { openWorkflowViewerMock, writeWorkflowViewerMock } = vi.hoisted(() => ({
  openWorkflowViewerMock: vi.fn(),
  writeWorkflowViewerMock: vi.fn()
}));

vi.mock("../src/viewer/artifact.js", () => ({
  openWorkflowViewer: openWorkflowViewerMock,
  writeWorkflowViewer: writeWorkflowViewerMock
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

describe("pipeline viewer", () => {
  beforeEach(() => {
    openWorkflowViewerMock.mockReset();
    writeWorkflowViewerMock.mockReset();
  });

  it("routes a validated project and plan to the read-only Viewer writer", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-viewer-state-"));
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-viewer-output-"));
    writeWorkflowViewerMock.mockResolvedValue({
      viewerPath: join(outputDir, "index.html"),
      workflowPath: join(outputDir, "workflow.json"),
      outputDir,
      stateFound: false
    });

    const result = await capture([
      "viewer",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--state-dir",
      stateDir,
      "--output",
      outputDir,
      "--json"
    ]);

    const payload = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "viewer",
      opened: false,
      state_found: false,
      viewer_path: join(outputDir, "index.html"),
      workflow_path: join(outputDir, "workflow.json")
    });
    expect(writeWorkflowViewerMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath: "fixtures/projects/local-media-only.yaml",
      stateDir,
      outputDir,
      project: expect.objectContaining({ run_id: "local-media-only-run" }),
      plan: expect.objectContaining({ run_id: "local-media-only-run" })
    }));
    expect(openWorkflowViewerMock).not.toHaveBeenCalled();
    await expect(stat(join(stateDir, "local-media-only-run", "state.json"))).rejects.toThrow();
  });

  it("opens the generated local HTML only when --open is provided", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tsugite-viewer-output-"));
    const viewerPath = join(outputDir, "index.html");
    writeWorkflowViewerMock.mockResolvedValue({
      viewerPath,
      workflowPath: join(outputDir, "workflow.json"),
      outputDir,
      stateFound: true
    });

    const result = await capture([
      "viewer",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--output",
      outputDir,
      "--open",
      "--json"
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ opened: true, state_found: true });
    expect(openWorkflowViewerMock).toHaveBeenCalledWith(viewerPath);
  });

  it("reports writer failures with a stable CLI issue code", async () => {
    writeWorkflowViewerMock.mockRejectedValue(new Error("invalid state.json"));

    const result = await capture([
      "viewer",
      "--config",
      "fixtures/projects/local-media-only.yaml",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "viewer",
      issues: [{ code: "viewer.write_failed", message: "invalid state.json" }]
    });
  });
});
