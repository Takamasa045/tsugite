import { describe, expect, it } from "vitest";
import { inspectEnvironment } from "../src/doctor.js";

describe("environment doctor", () => {
  it("fails closed outside the supported Node 22 release line", async () => {
    const report = await inspectEnvironment(undefined, {
      nodeVersion: "v23.1.0",
      commandExists: async () => true
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({ name: "node", ok: false, version: "v23.1.0" });
  });

  it("fails closed when a required dependency is unavailable", async () => {
    const report = await inspectEnvironment(undefined, {
      commandExists: async (command) => command !== "ffprobe"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({ name: "ffprobe", ok: false });
  });

  it("checks the selected project and backend without running their commands", async () => {
    const checkedCommands: string[] = [];
    const report = await inspectEnvironment("fixtures/projects/hyperframes-local-media.yaml", {
      commandExists: async (command) => {
        checkedCommands.push(command);
        return true;
      }
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project", ok: true }),
        expect.objectContaining({ name: "backend:hyperframes", ok: true }),
        expect.objectContaining({ name: "backend-preflight:lint", ok: true })
      ])
    );
    expect(checkedCommands).toEqual(["ffprobe", "npx"]);
  });
});
