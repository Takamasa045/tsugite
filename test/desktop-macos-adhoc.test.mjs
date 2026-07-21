import { expect, test } from "vitest";

const macosPackaging = process.platform === "win32"
  ? null
  : await import("../scripts/package-macos-adhoc.mjs");
const macosTest = process.platform === "win32" ? test.skip : test;
const {
  buildDistributionCommands,
  packageMacosAdhoc,
  parsePackageArguments,
} = macosPackaging ?? {};

macosTest("parses an explicit app and DMG output without enabling overwrite", () => {
  expect(
    parsePackageArguments(
      ["--app", "build/Tsugite.app", "--output", "dist/Tsugite.dmg"],
      "/repo",
    ),
  ).toEqual({
      appPath: "/repo/build/Tsugite.app",
      outputPath: "/repo/dist/Tsugite.dmg",
      overwrite: false,
      volumeName: "Tsugite",
    });
});

macosTest("rejects ambiguous or unsafe package targets", () => {
  expect(() => parsePackageArguments([], "/repo")).toThrow(/--app is required/);
  expect(
    () => parsePackageArguments(["--app", "build/Tsugite", "--output", "dist/Tsugite.dmg"], "/repo"),
  ).toThrow(/must end with \.app/);
  expect(
    () => parsePackageArguments(["--app", "build/Tsugite.app", "--output", "dist/Tsugite.zip"], "/repo"),
  ).toThrow(/must end with \.dmg/);
  expect(
    () => parsePackageArguments(["--app", "build/Tsugite.app", "--output", "build/Tsugite.app/output.dmg"], "/repo"),
  ).toThrow(/must not be inside the source app/);
});

macosTest("builds a free ad-hoc signing and verification sequence", () => {
  expect(
    buildDistributionCommands({
      stagedAppPath: "/tmp/stage/Tsugite.app",
      stagingDirectory: "/tmp/stage",
      outputPath: "/repo/dist/Tsugite.dmg",
      volumeName: "Tsugite",
    }),
  ).toEqual([
      {
        command: "codesign",
        args: ["--force", "--deep", "--sign", "-", "/tmp/stage/Tsugite.app"],
      },
      {
        command: "codesign",
        args: ["--verify", "--deep", "--strict", "--verbose=2", "/tmp/stage/Tsugite.app"],
      },
      {
        command: "hdiutil",
        args: [
          "create",
          "-volname",
          "Tsugite",
          "-srcfolder",
          "/tmp/stage",
          "-ov",
          "-format",
          "UDZO",
          "/repo/dist/Tsugite.dmg",
        ],
      },
      {
        command: "hdiutil",
        args: ["verify", "/repo/dist/Tsugite.dmg"],
      },
  ]);
});

macosTest("replaces an existing DMG atomically from a verified sibling candidate", async () => {
  const calls = [];
  const removals = [];
  let temporaryDirectoryCount = 0;

  await packageMacosAdhoc(
    ["--app", "/repo/build/Tsugite.app", "--output", "/repo/dist/Tsugite.dmg", "--overwrite"],
    {
      platform: "darwin",
      accessPath: async () => {},
      statPath: async () => ({ isDirectory: () => true }),
      makeDirectory: async (...args) => calls.push(["mkdir", ...args]),
      makeTemporaryDirectory: async (prefix) => {
        temporaryDirectoryCount += 1;
        calls.push(["mkdtemp", prefix]);
        return temporaryDirectoryCount === 1
          ? "/private/tmp/tsugite-source"
          : "/repo/dist/.tsugite-adhoc-output-candidate";
      },
      renamePath: async (...args) => calls.push(["rename", ...args]),
      removePath: async (path) => removals.push(path),
      createSymlink: async (...args) => calls.push(["symlink", ...args]),
      systemTemporaryDirectory: () => "/private/tmp",
      executeCommand: async (command, args, options) => {
        calls.push(["command", command, args, options]);
        if (command === "codesign" && args[0] === "-dv") {
          return { stdout: "", stderr: "Signature=adhoc\nTeamIdentifier=not set\n" };
        }
        return { stdout: "", stderr: "" };
      },
      writeOutput: () => {},
    },
  );

  expect(calls).toContainEqual([
    "mkdtemp",
    "/repo/dist/.tsugite-adhoc-output-",
  ]);
  expect(calls).toContainEqual([
    "rename",
    "/repo/dist/.tsugite-adhoc-output-candidate/Tsugite.dmg",
    "/repo/dist/Tsugite.dmg",
  ]);
  expect(removals).toEqual(expect.arrayContaining([
    "/private/tmp/tsugite-source",
    "/repo/dist/.tsugite-adhoc-output-candidate",
  ]));
  expect(removals).not.toContain("/repo/dist/Tsugite.dmg");
});

macosTest("cleans both staging directories when packaging fails", async () => {
  const removals = [];
  let temporaryDirectoryCount = 0;

  await expect(packageMacosAdhoc(
    ["--app", "/repo/build/Tsugite.app", "--output", "/repo/dist/Tsugite.dmg"],
    {
      platform: "darwin",
      accessPath: async (path) => {
        if (path.endsWith(".dmg")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
      },
      statPath: async () => ({ isDirectory: () => true }),
      makeDirectory: async () => {},
      makeTemporaryDirectory: async () => {
        temporaryDirectoryCount += 1;
        return temporaryDirectoryCount === 1
          ? "/private/tmp/tsugite-source"
          : "/repo/dist/.tsugite-adhoc-output-candidate";
      },
      renamePath: async () => {},
      removePath: async (path) => removals.push(path),
      createSymlink: async () => {},
      systemTemporaryDirectory: () => "/private/tmp",
      executeCommand: async (command) => {
        if (command === "hdiutil") throw new Error("create failed");
        return { stdout: "", stderr: "" };
      },
      writeOutput: () => {},
    },
  )).rejects.toThrow(/create failed/);

  expect(removals).toEqual(expect.arrayContaining([
    "/private/tmp/tsugite-source",
    "/repo/dist/.tsugite-adhoc-output-candidate",
  ]));
});
