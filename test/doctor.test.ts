import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectEnvironment } from "../src/doctor.js";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((path) => rm(path, { force: true })));
});

describe("environment doctor", () => {
  it("fails closed outside the supported Node 22 release line", async () => {
    const report = await inspectEnvironment(undefined, {
      nodeVersion: "v23.1.0",
      commandExists: async () => true
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "node", ok: false, status: "missing", version: "v23.1.0" })
    );
  });

  it("fails closed when a required dependency is unavailable", async () => {
    const report = await inspectEnvironment(undefined, {
      commandExists: async (command) => command !== "ffprobe"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "ffprobe",
        ok: false,
        status: "missing",
        remediation: expect.stringContaining("ffmpeg")
      })
    );
  });

  it("requires ffmpeg for Gate 3 black-frame and silence analysis", async () => {
    const report = await inspectEnvironment(undefined, {
      commandExists: async (command) => command !== "ffmpeg"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "ffmpeg", ok: false, status: "missing" })
    );
  });

  it("fails closed when npm is older than the supported major version", async () => {
    const report = await inspectEnvironment(undefined, {
      commandExists: async () => true,
      probeCommand: async (command) =>
        command[0] === "npm" ? { ok: true, version: "9.9.0" } : { ok: true, version: "test" }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "npm", ok: false, status: "missing", version: "9.9.0" })
    );
  });

  it("checks the selected project and runs only declared setup probes", async () => {
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
    expect(checkedCommands).toEqual(expect.arrayContaining(["npm", "ffprobe", "ffmpeg", "npx"]));
  });

  it("fails closed when npx exists but the installed HyperFrames CLI cannot be probed", async () => {
    const probedCommands: string[][] = [];
    const report = await inspectEnvironment("fixtures/projects/hyperframes-local-media.yaml", {
      commandExists: async () => true,
      probeCommand: async (command) => {
        probedCommands.push([...command]);
        return { ok: false, detail: "hyperframes executable was not found" };
      }
    });

    expect(report.ok).toBe(false);
    expect(probedCommands).toContainEqual(["npx", "--no-install", "hyperframes", "--version"]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "tool:hyperframes",
        ok: false,
        detail: expect.stringContaining("hyperframes executable was not found"),
        remediation: expect.stringMatching(/npm (ci|install)/)
      })
    );
  });

  it.each(["pixverse", "kling"])(
    "checks the shared PixVerse provider CLI for the %s adapter with a non-charging version probe",
    async (adapterName) => {
      const configPath = await projectUsingAdapter(adapterName);
      const checkedCommands: string[] = [];
      const probedCommands: string[][] = [];

      const report = await inspectEnvironment(configPath, {
        commandExists: async (command) => {
          checkedCommands.push(command);
          return command !== "pixverse";
        },
        probeCommand: async (command) => {
          probedCommands.push([...command]);
          return { ok: true, version: "pixverse 1.2.3" };
        }
      });

      expect(report.ok).toBe(false);
      expect(checkedCommands).toContain("pixverse");
      expect(probedCommands).not.toContainEqual(expect.arrayContaining(["create", "video"]));
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          name: `provider:pixverse (${adapterName})`,
          ok: false,
          remediation: expect.stringMatching(/PixVerse CLI.*install|install.*PixVerse CLI/i)
        })
      );
    }
  );

  it("records the PixVerse provider version when its non-charging probe succeeds", async () => {
    const probedCommands: string[][] = [];
    const report = await inspectEnvironment("fixtures/projects/local-valid.yaml", {
      commandExists: async () => true,
      probeCommand: async (command) => {
        probedCommands.push([...command]);
        return { ok: true, version: "pixverse 1.2.3" };
      }
    });

    expect(report.ok).toBe(true);
    expect(probedCommands).toContainEqual(["pixverse", "--version"]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "provider:pixverse (pixverse)",
        ok: true,
        version: "pixverse 1.2.3"
      })
    );
  });

  it("probes the Topview CLI without submitting a generation task", async () => {
    const probedCommands: string[][] = [];
    const report = await inspectEnvironment("fixtures/projects/topview-generation.yaml", {
      commandExists: async () => true,
      probeCommand: async (command) => {
        probedCommands.push([...command]);
        return { ok: true, version: "topview-video-gen ready" };
      }
    });

    expect(report.ok).toBe(true);
    expect(probedCommands).toContainEqual(["node", "adapters/topview/check.mjs"]);
    expect(probedCommands.flat()).not.toContain("run");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "provider:topview-cli (topview)",
        ok: true,
        status: "ready",
        version: "topview-video-gen ready"
      })
    );
  });

  it("checks every selected analysis adapter once and ignores unselected adapters", async () => {
    const report = await inspectEnvironment("fixtures/projects/multi-analysis-adapters.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"],
      commandExists: async () => true,
      probeCommand: async () => ({ ok: true, version: "test" })
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.name === "adapter:mock-cli-transcription")).toHaveLength(1);
    expect(report.checks.filter((check) => check.name === "adapter:mock-cli-analysis")).toHaveLength(1);
    expect(report.checks.filter((check) => check.name === "tool:mock-local-stt (mock-cli-transcription)")).toHaveLength(1);
    expect(report.checks.some((check) => check.name.includes("mock-cli-analysis-online"))).toBe(false);
  });

  it("reports required external analysis credential names without exposing values", async () => {
    const secret = "doctor-secret-value";
    const report = await inspectEnvironment("fixtures/projects/hybrid-analysis.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"],
      commandExists: async () => true,
      probeCommand: async () => ({ ok: true, version: "test" }),
      environment: { TSUGITE_TEST_ANALYSIS_TOKEN: secret }
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "credential:TSUGITE_TEST_ANALYSIS_TOKEN (mock-cli-external-refinement)",
      ok: true,
      status: "ready"
    }));
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("checks a declared bridge environment variable without executing the bridge", async () => {
    const checkedCommands: string[] = [];
    const probedCommands: string[][] = [];
    const report = await inspectEnvironment("fixtures/projects/openclaw-generation.yaml", {
      commandExists: async (command) => {
        checkedCommands.push(command);
        return command === "node" || command === "npm" || command === "ffprobe" || command === "ffmpeg";
      },
      probeCommand: async (command) => {
        probedCommands.push([...command]);
        return { ok: true, version: "test" };
      },
      environment: {
        ...process.env,
        TSUGITE_OPENCLAW_GENERATE_COMMAND: '["node","bridge.mjs"]'
      }
    });

    expect(report.ok).toBe(true);
    expect(checkedCommands).toContain("node");
    expect(probedCommands.flat()).not.toContain("bridge.mjs");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "bridge:openclaw (openclaw)", ok: true, status: "ready" })
    );
  });

  it("fails closed when a declared bridge environment variable is missing", async () => {
    const report = await inspectEnvironment("fixtures/projects/openclaw-generation.yaml", {
      commandExists: async () => true,
      probeCommand: async () => ({ ok: true, version: "test" }),
      environment: {}
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "bridge:openclaw (openclaw)",
        ok: false,
        status: "missing",
        remediation: expect.stringContaining("TSUGITE_OPENCLAW_GENERATE_COMMAND")
      })
    );
  });
});

async function projectUsingAdapter(adapterName: string): Promise<string> {
  const source = await readFile("fixtures/projects/local-valid.yaml", "utf8");
  const path = join(
    "fixtures/projects",
    `.doctor-${adapterName}-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`
  );
  temporaryProjects.push(path);
  await writeFile(path, source.replace("adapter: pixverse", `adapter: ${adapterName}`));
  return path;
}
