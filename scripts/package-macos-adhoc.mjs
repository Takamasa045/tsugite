#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

export function parsePackageArguments(argv, cwd = process.cwd()) {
  let app;
  let output;
  let overwrite = false;
  let volumeName = "Tsugite";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }

    if (argument === "--app" || argument === "--output" || argument === "--volume-name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--app") app = value;
      if (argument === "--output") output = value;
      if (argument === "--volume-name") volumeName = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${argument}`);
  }

  if (!app) throw new Error("--app is required");
  if (!output) throw new Error("--output is required");

  const appPath = resolve(cwd, app);
  const outputPath = resolve(cwd, output);
  if (!appPath.endsWith(".app")) throw new Error("--app must end with .app");
  if (!outputPath.endsWith(".dmg")) throw new Error("--output must end with .dmg");

  const outputFromApp = relative(appPath, outputPath);
  if (outputFromApp === "" || (!outputFromApp.startsWith("..") && !isAbsolute(outputFromApp))) {
    throw new Error("--output must not be inside the source app");
  }

  return { appPath, outputPath, overwrite, volumeName };
}

export function buildDistributionCommands({
  stagedAppPath,
  stagingDirectory,
  outputPath,
  volumeName,
}) {
  return [
    {
      command: "codesign",
      args: ["--force", "--deep", "--sign", "-", stagedAppPath],
    },
    {
      command: "codesign",
      args: ["--verify", "--deep", "--strict", "--verbose=2", stagedAppPath],
    },
    {
      command: "hdiutil",
      args: [
        "create",
        "-volname",
        volumeName,
        "-srcfolder",
        stagingDirectory,
        "-ov",
        "-format",
        "UDZO",
        outputPath,
      ],
    },
    {
      command: "hdiutil",
      args: ["verify", outputPath],
    },
  ];
}

async function runCommand(command, args, { capture = false } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }

    child.on("error", rejectCommand);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        return;
      }
      rejectCommand(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

export async function packageMacosAdhoc(argv, dependencies = {}) {
  const {
    platform = process.platform,
    accessPath = access,
    statPath = lstat,
    makeDirectory = mkdir,
    makeTemporaryDirectory = mkdtemp,
    renamePath = rename,
    removePath = rm,
    createSymlink = symlink,
    systemTemporaryDirectory = tmpdir,
    executeCommand = runCommand,
    writeOutput = (value) => process.stdout.write(value),
  } = dependencies;

  if (platform !== "darwin") {
    throw new Error("macOS ad-hoc packaging must run on macOS");
  }

  const options = parsePackageArguments(argv);
  await accessPath(options.appPath);
  if (!(await statPath(options.appPath)).isDirectory()) {
    throw new Error("--app must be an app directory");
  }

  try {
    await accessPath(options.outputPath);
    if (!options.overwrite) throw new Error("output already exists; pass --overwrite to replace it");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await makeDirectory(dirname(options.outputPath), { recursive: true });
  const temporaryRoot = await makeTemporaryDirectory(
    join(systemTemporaryDirectory(), "tsugite-adhoc-"),
  );
  const stagingDirectory = join(temporaryRoot, "volume");
  const stagedAppPath = join(stagingDirectory, basename(options.appPath));
  let outputStagingDirectory;

  try {
    outputStagingDirectory = await makeTemporaryDirectory(
      join(dirname(options.outputPath), ".tsugite-adhoc-output-"),
    );
    const temporaryOutputPath = join(outputStagingDirectory, basename(options.outputPath));
    await makeDirectory(stagingDirectory);
    await executeCommand("ditto", [options.appPath, stagedAppPath]);
    await createSymlink("/Applications", join(stagingDirectory, "Applications"));

    const commands = buildDistributionCommands({
      stagedAppPath,
      stagingDirectory,
      outputPath: temporaryOutputPath,
      volumeName: options.volumeName,
    });
    for (const { command, args } of commands) await executeCommand(command, args);

    const signature = await executeCommand(
      "codesign",
      ["-dv", "--verbose=4", stagedAppPath],
      { capture: true },
    );
    const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
    if (!signatureDetails.includes("Signature=adhoc")) {
      throw new Error("packaged app is not ad-hoc signed");
    }
    if (!signatureDetails.includes("TeamIdentifier=not set")) {
      throw new Error("packaged app unexpectedly contains a Developer ID team");
    }

    // The candidate lives beside the destination, so rename replaces an existing
    // DMG atomically instead of deleting the known-good output before a move that
    // could fail across filesystems.
    await renamePath(temporaryOutputPath, options.outputPath);

    writeOutput(`${JSON.stringify({
      output: options.outputPath,
      signature: "adhoc",
      notarized: false,
      firstOpen: "manual Gatekeeper approval required",
    })}\n`);
  } finally {
    const cleanup = [removePath(temporaryRoot, { recursive: true, force: true })];
    if (outputStagingDirectory) cleanup.push(
      removePath(outputStagingDirectory, { recursive: true, force: true }),
    );
    await Promise.all(cleanup);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  packageMacosAdhoc(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
