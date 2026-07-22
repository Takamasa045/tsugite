import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = new URL("../", import.meta.url);

test("Electron and Forge stay build-time dependencies at the pinned versions", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", desktopRoot), "utf8"));
  const mainSource = await readFile(new URL("src/main.mjs", desktopRoot), "utf8");

  assert.equal(manifest.main, "src/main.mjs");
  assert.equal(manifest.devDependencies.electron, "43.1.1");
  assert.equal(manifest.devDependencies["playwright-core"], "1.61.1");
  assert.equal(manifest.devDependencies["@electron-forge/cli"], "7.11.2");
  assert.equal(manifest.dependencies?.electron, undefined);
  assert.match(manifest.dependencies["node-pty"], /^\^\d+\.\d+\.\d+$/);
  assert.equal(manifest.devDependencies?.["node-pty"], undefined);
  assert.equal(manifest.overrides.tar, "7.5.20");
  assert.equal(manifest.overrides.tmp, "0.2.7");
  assert.match(manifest.scripts["build:runtime"], /^node scripts\/clean-generated\.mjs && .*prepare-runtime -- --install$/);
  assert.match(manifest.scripts.package, /package:audit/);
  assert.match(manifest.scripts.make, /package:audit/);
  assert.equal(manifest.scripts.test, "node --test test/*.test.mjs");
  assert.equal(
    manifest.scripts["test:packaged-workspace"],
    "node --test test/packaged-workspace.e2e.mjs"
  );
  assert.equal(
    manifest.scripts["security:audit"],
    "npm audit --omit=dev --audit-level=moderate && npm audit --audit-level=moderate"
  );
  assert.doesNotMatch(mainSource, /TSUGITE_DESKTOP_TEST_|test-hooks/);
});

test("Viewer keeps terminal rendering dependencies in its runtime manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../workflow-viewer/package.json", desktopRoot), "utf8")
  );

  assert.match(manifest.dependencies["@xterm/xterm"], /^\^\d+\.\d+\.\d+$/);
  assert.match(manifest.dependencies["@xterm/addon-fit"], /^\^\d+\.\d+\.\d+$/);
  assert.equal(manifest.devDependencies?.["@xterm/xterm"], undefined);
  assert.equal(manifest.devDependencies?.["@xterm/addon-fit"], undefined);
});

test("Forge makes macOS ZIP/DMG and Windows Squirrel with an external runtime", async () => {
  const { default: config } = await import("../forge.config.mjs");

  assert.deepEqual(config.packagerConfig.asar, {
    unpack: `{**/node_modules/node-pty/build/Release/**,**/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/**}`
  });
  assert.deepEqual(config.packagerConfig.extraResource, [fileURLToPath(new URL("../runtime", import.meta.url))]);
  assert.equal(config.packagerConfig.icon, fileURLToPath(new URL("../assets/icon", import.meta.url)));
  assert.equal(config.packagerConfig.ignore("/src/main.mjs"), false);
  assert.equal(config.packagerConfig.ignore("/src/preload.mjs"), false);
  assert.equal(config.packagerConfig.ignore("/src/agent-terminal.mjs"), false);
  assert.equal(config.packagerConfig.ignore("/src/workspace.mjs"), false);
  assert.equal(config.packagerConfig.ignore("/src/test-hooks.mjs"), true);
  assert.equal(config.packagerConfig.ignore("/node_modules/.bin/playwright-core"), true);
  assert.equal(config.packagerConfig.ignore("/node_modules/playwright-core/index.js"), true);
  assert.equal(config.packagerConfig.ignore("/node_modules/electron-squirrel-startup/index.js"), false);
  assert.equal(config.packagerConfig.ignore("/node_modules/node-pty/build/Release/pty.node"), false);
  assert.equal(config.packagerConfig.ignore("/runtime/secret.mov"), true);
  assert.equal(config.packagerConfig.ignore("/notes/private.txt"), true);

  const makers = new Map(config.makers.map((maker) => [maker.name, maker]));
  assert.deepEqual(makers.get("@electron-forge/maker-zip").platforms, ["darwin"]);
  assert.deepEqual(makers.get("@electron-forge/maker-dmg").platforms, ["darwin"]);
  assert.deepEqual(makers.get("@electron-forge/maker-squirrel").platforms, ["win32"]);

  assert.equal(JSON.stringify(config).includes("password"), false);
  assert.equal(JSON.stringify(config).includes("BEGIN PRIVATE KEY"), false);
});

if (process.platform !== "win32") {
  test("Forge makes rebuilt and prebuilt node-pty spawn helpers executable before ASAR", async () => {
    const { default: config } = await import("../forge.config.mjs");
    const buildPath = await mkdtemp(join(tmpdir(), "tsugite-native-permissions-"));
    const helpers = [
      join(buildPath, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
      join(buildPath, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
    ];
    for (const helper of helpers) {
      await mkdir(dirname(helper), { recursive: true });
      await writeFile(helper, "helper");
      await chmod(helper, 0o644);
    }

    await new Promise((resolve, reject) => {
      config.packagerConfig.beforeAsar[0](
        buildPath,
        "43.1.1",
        process.platform,
        process.arch,
        (error) => error ? reject(error) : resolve()
      );
    });

    for (const helper of helpers) assert.notEqual((await stat(helper)).mode & 0o111, 0);
  });
}

test("ships the Tsugite joinery icon in source, macOS, and Windows formats", async () => {
  const assets = new URL("../assets/", import.meta.url);
  const [svg, png, icns, ico] = await Promise.all([
    readFile(new URL("icon.svg", assets), "utf8"),
    readFile(new URL("icon.png", assets)),
    readFile(new URL("icon.icns", assets)),
    readFile(new URL("icon.ico", assets))
  ]);

  assert.match(svg, /aria-label="Tsugite"/);
  assert.match(svg, /href="icon\.png"/);
  assert.equal(
    createHash("sha256").update(png).digest("hex"),
    "a59fe205c9caf0a3c827bf7e5a4449543a436af23da2ef535da41d87d780abb3"
  );
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 6);
});

test("Desktop CI uploads unsigned macOS and Windows installers", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop.yml", desktopRoot), "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /os: macos-15/);
  assert.match(workflow, /artifact: macos-arm64/);
  assert.match(workflow, /os: windows-2022/);
  assert.match(workflow, /artifact: windows-x64/);
  assert.match(workflow, /npm --prefix apps\/desktop run make/);
  assert.match(workflow, /npm --prefix apps\/desktop run security:audit/);
  assert.match(
    workflow,
    /- name: Verify packaged workspace recovery\n\s+run: npm --prefix apps\/desktop run test:packaged-workspace/
  );
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /path: apps\/desktop\/out\/make\/\*\*/);
  assert.match(workflow, /retention-days: 14/);
});
