import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { renderPreflightCommands } from "./backends/capabilities.js";
import {
  commandExists as platformCommandExists,
  spawnCommandSync
} from "./platform/process.js";
import { validateProject } from "./project/validateProject.js";
import { remediationForPlatform, type SetupCheck } from "./setupChecks.js";

export type DoctorCheckStatus = "ready" | "missing" | "manual";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  status: DoctorCheckStatus;
  blocking: boolean;
  detail?: string;
  version?: string;
  remediation?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

type CommandProbeResult = {
  ok: boolean;
  detail?: string;
  version?: string;
};

type DoctorOptions = {
  adapterDirs?: string[];
  commandExists?: (command: string) => Promise<boolean>;
  probeCommand?: (command: string[]) => Promise<CommandProbeResult>;
  nodeVersion?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export async function inspectEnvironment(configPath?: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? ((command) => platformCommandExists(command, environment, platform));
  const probeCommand = async (command: string[]): Promise<CommandProbeResult> =>
    options.probeCommand ? options.probeCommand(command) : executeProbe(command, environment);
  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeOk = nodeSupported(nodeVersion);
  const npm = await commandCheck("npm", ["npm", "--version"], {
    commandExists,
    probeCommand,
    remediation: "Install npm 10 or newer together with Node.js 22, then rerun doctor.",
    captureVersion: true
  });
  const npmMajor = npm.version ? leadingMajor(npm.version) : undefined;
  const npmCheck = npm.ok && npmMajor !== undefined && npmMajor < 10
    ? check("npm", false, {
        version: npm.version,
        detail: "Tsugite requires npm 10 or newer",
        remediation: "Install npm 10 or newer together with Node.js 22, then rerun doctor."
      })
    : npm;
  const checks: DoctorCheck[] = [
    check("node", nodeOk, {
      version: nodeVersion,
      remediation: nodeRemediation(platform)
    }),
    npmCheck,
    await commandCheck("ffprobe", ["ffprobe", "-version"], {
      commandExists,
      probeCommand,
      remediation: ffmpegRemediation(platform),
      captureVersion: true
    }),
    await commandCheck("ffmpeg", ["ffmpeg", "-version"], {
      commandExists,
      probeCommand,
      remediation: ffmpegRemediation(platform),
      captureVersion: true
    })
  ];

  if (configPath) {
    const validation = await validateProject(configPath, { adapterDirs: options.adapterDirs });
    checks.push(
      check("project", validation.ok, {
        detail: validation.ok ? configPath : validation.issues.map((issue) => issue.code).join(", "),
        remediation: "Fix the reported project or manifest validation issues, then rerun doctor."
      })
    );

    if (validation.project) {
      const backendName = validation.project.edit.backend;
      checks.push(
        check(`backend:${backendName}`, await isFile(resolve("backends", backendName, "render.mjs")), {
          remediation: `Restore backends/${backendName}/render.mjs or select an installed backend.`
        })
      );

      if (validation.backend) {
        for (const setup of validation.backend.checks.setup) {
          checks.push(await inspectSetupCheck(setup, { commandExists, probeCommand, environment, platform }));
        }
      }

      for (const preflight of renderPreflightCommands(validation.backend)) {
        checks.push(
          check(`backend-preflight:${preflight.name}`, await commandExists(preflight.command[0]!), {
            detail: preflight.command.join(" "),
            remediation: `Install the executable '${preflight.command[0]}' required by the selected backend.`
          })
        );
      }
    }

    const selectedAdapters = uniqueAdapters([
      validation.adapter,
      ...(validation.analysisAdapters ?? (validation.analysisAdapter ? [validation.analysisAdapter] : []))
    ]);
    for (const adapter of selectedAdapters) {
      if (!adapter) continue;
      for (const variable of adapter.network?.credential_env ?? []) {
        checks.push(
          check(`credential:${variable} (${adapter.name})`, Boolean(environment[variable]), {
            detail: `environment variable ${variable}`,
            remediation: `Set ${variable} only in the execution environment, then rerun doctor.`
          })
        );
      }
      if (adapter.kind === "cli") {
        const executable = adapter.command?.executable;
        checks.push(
          check(
            `adapter:${adapter.name}`,
            Boolean(executable) && (await commandExists(executable!)),
            {
              detail: adapter.kind,
              remediation: `Install the executable declared by adapter '${adapter.name}', then rerun doctor.`
            }
          )
        );
      }

      if (adapter.checks.setup.length === 0 && adapter.kind !== "cli") {
        checks.push({
          name: `handoff:${adapter.name}`,
          ok: false,
          status: "manual",
          blocking: true,
          detail: `The ${adapter.kind} handoff has no machine-checkable setup contract.`,
          remediation: `Verify the external '${adapter.name}' handoff before execution.`
        });
      }

      for (const setup of adapter.checks.setup) {
        checks.push(
          await inspectSetupCheck(setup, {
            commandExists,
            probeCommand,
            environment,
            platform,
            nameSuffix: ` (${adapter.name})`
          })
        );
      }
    }
  }

  return { ok: checks.every((item) => !item.blocking || item.ok), checks };
}

function uniqueAdapters<T extends { name: string }>(adapters: Array<T | undefined>): T[] {
  const byName = new Map<string, T>();
  for (const adapter of adapters) {
    if (adapter && !byName.has(adapter.name)) byName.set(adapter.name, adapter);
  }
  return [...byName.values()];
}

type SetupInspectionOptions = {
  commandExists: (command: string) => Promise<boolean>;
  probeCommand: (command: string[]) => Promise<CommandProbeResult>;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nameSuffix?: string;
};

async function inspectSetupCheck(setup: SetupCheck, options: SetupInspectionOptions): Promise<DoctorCheck> {
  const name = `${setup.name}${options.nameSuffix ?? ""}`;
  const remediation = remediationForPlatform(setup.remediation, options.platform);

  if (setup.type === "manual") {
    return {
      name,
      ok: false,
      status: "manual",
      blocking: setup.blocking,
      detail: setup.detail,
      remediation
    };
  }

  if (setup.type === "environment") {
    const value = options.environment[setup.variable];
    const parsed = setup.format === "json-command" ? parseJsonCommand(value) : undefined;
    const valueOk = setup.format === "non-empty" ? Boolean(value?.trim()) : Boolean(parsed);
    const executableOk = parsed ? await options.commandExists(parsed[0]!) : valueOk;
    return check(name, valueOk && executableOk, {
      detail: valueOk && executableOk ? `${setup.variable} is configured` : `${setup.variable} is missing or invalid`,
      remediation,
      blocking: setup.blocking
    });
  }

  return commandCheck(name, setup.command, {
    commandExists: options.commandExists,
    probeCommand: options.probeCommand,
    remediation,
    captureVersion: setup.capture_version,
    blocking: setup.blocking
  });
}

type CommandCheckOptions = {
  commandExists: (command: string) => Promise<boolean>;
  probeCommand: (command: string[]) => Promise<CommandProbeResult>;
  remediation: string;
  captureVersion?: boolean;
  blocking?: boolean;
};

async function commandCheck(name: string, command: string[], options: CommandCheckOptions): Promise<DoctorCheck> {
  if (!(await options.commandExists(command[0]!))) {
    return check(name, false, {
      detail: `Executable '${command[0]}' is unavailable`,
      remediation: options.remediation,
      blocking: options.blocking
    });
  }

  const result = await options.probeCommand(command);
  return check(name, result.ok, {
    detail: result.detail ?? command.join(" "),
    version: options.captureVersion ? result.version : undefined,
    remediation: options.remediation,
    blocking: options.blocking
  });
}

function check(
  name: string,
  ok: boolean,
  options: Partial<Pick<DoctorCheck, "detail" | "version" | "remediation" | "blocking">> = {}
): DoctorCheck {
  return {
    name,
    ok,
    status: ok ? "ready" : "missing",
    blocking: options.blocking ?? true,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(!ok && options.remediation ? { remediation: options.remediation } : {})
  };
}

function executeProbe(command: string[], environment: NodeJS.ProcessEnv): CommandProbeResult {
  const result = spawnCommandSync(command[0]!, command.slice(1), {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: `Command exited with status ${result.status ?? "unknown"}` };
  const version = firstOutputLine(result.stdout, result.stderr);
  return { ok: true, version };
}

function firstOutputLine(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return line?.slice(0, 200);
}

function parseJsonCommand(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((item) => typeof item === "string" && item.length > 0)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function nodeSupported(version: string): boolean {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major === 22 && Number.isInteger(minor) && minor >= 12;
}

function leadingMajor(version: string): number | undefined {
  const match = version.trim().match(/^(\d+)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

function nodeRemediation(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Install Node.js 22.12 or newer in the 22.x LTS line, reopen the terminal, then rerun doctor.";
  return "Install and select Node.js 22.12 or newer in the 22.x LTS line, then rerun doctor.";
}

function ffmpegRemediation(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Install FFmpeg with `brew install ffmpeg`, then rerun doctor.";
  if (platform === "linux") return "Install FFmpeg with `sudo apt-get update && sudo apt-get install -y ffmpeg`, then rerun doctor.";
  if (platform === "win32") return "Install FFmpeg with `winget install --id Gyan.FFmpeg -e`, reopen the terminal, then rerun doctor.";
  return "Install FFmpeg including ffprobe, add it to PATH, then rerun doctor.";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
