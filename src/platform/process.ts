import { spawnSync as nativeSpawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";

const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as { sync: typeof nativeSpawnSync };
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export const spawnCommandSync = crossSpawn.sync as typeof nativeSpawnSync;

export function commandCandidates(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd()
): string[] {
  const pathApi = platform === "win32" ? win32 : posix;
  const pathValue = environmentValue(environment, "PATH", platform) ?? "";
  const directories = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" && pathApi.extname(command) === ""
    ? ["", ...windowsPathExtensions(environment)]
    : [""];
  const names = extensions.map((extension) => `${command}${extension}`);
  const explicitPath = pathApi.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const candidates = explicitPath
    ? names.map((name) => pathApi.isAbsolute(name) ? name : pathApi.resolve(cwd, name))
    : directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
  return [...new Set(candidates)];
}

export async function commandExists(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd()
): Promise<boolean> {
  if (command === "node" || command === process.execPath) return true;
  for (const candidate of commandCandidates(command, environment, platform, cwd)) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile()) continue;
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      // Continue through PATH and PATHEXT candidates.
    }
  }
  return false;
}

function windowsPathExtensions(environment: NodeJS.ProcessEnv): string[] {
  const value = environmentValue(environment, "PATHEXT", "win32") ?? DEFAULT_WINDOWS_PATHEXT;
  return [...new Set(
    value
      .split(";")
      .map((extension) => extension.trim())
      .filter(Boolean)
      .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)
  )];
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}
