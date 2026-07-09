import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { renderPreflightCommands } from "./backends/capabilities.js";
import { validateProject } from "./project/validateProject.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail?: string;
  version?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

type DoctorOptions = {
  commandExists?: (command: string) => Promise<boolean>;
  nodeVersion?: string;
};

export async function inspectEnvironment(configPath?: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const commandExists = options.commandExists ?? executableExists;
  const nodeVersion = options.nodeVersion ?? process.version;
  const checks: DoctorCheck[] = [
    { name: "node", ok: nodeMajor(nodeVersion) === 22, version: nodeVersion },
    { name: "ffprobe", ok: await commandExists("ffprobe") }
  ];

  if (configPath) {
    const validation = await validateProject(configPath);
    checks.push({
      name: "project",
      ok: validation.ok,
      detail: validation.ok ? configPath : validation.issues.map((issue) => issue.code).join(", ")
    });

    if (validation.project) {
      const backendName = validation.project.edit.backend;
      checks.push({
        name: `backend:${backendName}`,
        ok: await isFile(resolve("backends", backendName, "render.mjs"))
      });

      for (const preflight of renderPreflightCommands(validation.backend)) {
        checks.push({
          name: `backend-preflight:${preflight.name}`,
          ok: await commandExists(preflight.command[0]!),
          detail: preflight.command.join(" ")
        });
      }
    }

    for (const adapter of [validation.adapter, validation.analysisAdapter]) {
      if (!adapter) continue;
      const executable = adapter.command?.executable;
      checks.push({
        name: `adapter:${adapter.name}`,
        ok: adapter.kind !== "cli" || (Boolean(executable) && (await commandExists(executable!))),
        detail: adapter.kind
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function nodeMajor(version: string): number | undefined {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) ? major : undefined;
}

async function executableExists(command: string): Promise<boolean> {
  if (command === "node" || resolve(command) === process.execPath) return true;
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
