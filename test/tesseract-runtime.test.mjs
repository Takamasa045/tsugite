import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTesseractCli,
  runTesseractCli,
  TESSERACT_CLI_DEFAULT_MAX_BUFFER,
  TESSERACT_CLI_DEFAULT_TIMEOUT_MS,
  TESSERACT_CLI_VERSION
} from "../backends/tesseract/cli.mjs";
import { assertSupportedManifest } from "../backends/tesseract/manifest.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../backends/tesseract/cli.mjs", import.meta.url));

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "tsugite-tesseract-"));
  roots.push(root);
  return root;
}

function testHost(root) {
  if (process.platform === "darwin") {
    return { platform: "darwin", arch: process.arch, env: { HOME: root, PATH: "" }, pathApi: path.posix };
  }
  if (process.platform === "win32") {
    return {
      platform: "win32",
      arch: process.arch,
      env: { LOCALAPPDATA: root, PATH: "", PROCESSOR_ARCHITECTURE: "AMD64" },
      pathApi: path.win32,
      windowsRelease: "10.0.22631"
    };
  }
  if (process.platform === "linux") {
    return {
      platform: "linux",
      arch: process.arch,
      env: { HOME: root, XDG_DATA_HOME: path.join(root, ".local", "share"), PATH: "" },
      pathApi: path.posix,
      glibcVersion: "2.35"
    };
  }
  return null;
}

function fakeInstalledCli(root, host, version = TESSERACT_CLI_VERSION) {
  const api = host.pathApi;
  const cliPath = host.platform === "darwin"
    ? api.join(root, "Library", "Application Support", "Tesseract", "bin", "tsrct")
    : host.platform === "linux"
      ? api.join(host.env.XDG_DATA_HOME, "Tesseract", "bin", "tsrct")
      : api.join(root, "Tesseract", "bin", "tsrct.cmd");
  mkdirSync(api.dirname(cliPath), { recursive: true });
  if (host.platform === "darwin" || host.platform === "linux") {
    writeFileSync(cliPath, `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("tsrct ${version}");\nelse process.exit(2);\n`);
    chmodSync(cliPath, 0o755);
  } else {
    writeFileSync(cliPath, `@echo off\r\nif "%~1"=="--version" (echo tsrct ${version}& exit /b 0)\r\nexit /b 2\r\n`);
  }
  return cliPath;
}

describe("Tesseract CLI runtime", () => {
  it("uses a fake local CLI, then requires the exact official skill pin", ({ skip }) => {
    const root = tempRoot();
    const host = testHost(root);
    if (!host) return skip();
    const cliPath = fakeInstalledCli(root, host);
    const resolved = resolveTesseractCli(host);
    expect(resolved).toEqual({ ok: true, cliPath, version: TESSERACT_CLI_VERSION });
  });

  it("reports a clear missing-CLI result without downloading or installing", ({ skip }) => {
    const root = tempRoot();
    const host = testHost(root);
    if (!host) return skip();
    const resolved = resolveTesseractCli(host);
    expect(resolved).toMatchObject({ ok: false, code: "missing_cli" });
    expect(resolved.message).toContain("npm run tesseract:install");
  });

  it("makes the doctor --version probe fail when no pinned CLI is installed", ({ skip }) => {
    const root = tempRoot();
    const host = testHost(root);
    if (!host) return skip();
    const env = {
      ...process.env,
      HOME: root,
      LOCALAPPDATA: root,
      PATH: "",
      PROCESSOR_ARCHITECTURE: "AMD64"
    };
    const result = runTesseractCli(process.execPath, [CLI_ENTRY, "--version"], { env, timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Tesseract CLI ${TESSERACT_CLI_VERSION} is not installed or not on PATH`);
    expect(result.stderr).toContain("npm run tesseract:install");
  });

  it("makes the doctor --version probe print only the verified pinned version", ({ skip }) => {
    const root = tempRoot();
    const host = testHost(root);
    if (!host) return skip();
    fakeInstalledCli(root, host);
    const env = { ...process.env, HOME: root, LOCALAPPDATA: root };
    const result = runTesseractCli(process.execPath, [CLI_ENTRY, "--version"], { env, timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(TESSERACT_CLI_VERSION);
    expect(result.stderr).toBe("");
  });

  it("rejects unsupported hosts and architectures before attempting a version check", () => {
    const neverRun = () => { throw new Error("should not execute"); };
    expect(resolveTesseractCli({ platform: "darwin", arch: "ia32", env: {}, runCommand: neverRun }))
      .toMatchObject({ ok: false, code: "unsupported_arch" });
    expect(resolveTesseractCli({
      platform: "win32", arch: "x64", env: { PROCESSOR_ARCHITECTURE: "x86" },
      windowsRelease: "10.0.22631", runCommand: neverRun
    })).toMatchObject({ ok: false, code: "unsupported_arch" });
    expect(resolveTesseractCli({
      platform: "linux", arch: "arm64", env: {}, glibcVersion: "2.39", runCommand: neverRun
    })).toMatchObject({ ok: false, code: "unsupported_arch" });
    expect(resolveTesseractCli({
      platform: "linux", arch: "x64", env: {}, glibcVersion: "2.34", runCommand: neverRun
    })).toMatchObject({ ok: false, code: "unsupported_libc" });
  });

  it("rejects an installed CLI with a mismatched pin", ({ skip }) => {
    const root = tempRoot();
    const host = testHost(root);
    if (!host) return skip();
    fakeInstalledCli(root, host, "0.1.0");
    expect(resolveTesseractCli(host)).toMatchObject({ ok: false, code: "version_mismatch" });
  });

  for (const version of ["0.1.0-beta", "0.1.0+build.7", "0.1.0.windows"]) {
    it(`rejects a non-exact version token ${version}`, ({ skip }) => {
      const root = tempRoot();
      const host = testHost(root);
      if (!host) return skip();
      fakeInstalledCli(root, host, version);
      expect(resolveTesseractCli(host)).toMatchObject({ ok: false, code: "version_mismatch" });
    });
  }

  it("passes paths and special characters as discrete arguments with bounded defaults", () => {
    const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    const result = runTesseractCli(process.execPath, ["-e", script, "folder with spaces/file.json", "A&B;C"], {
      timeout: 5_000,
      shell: true
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["folder with spaces/file.json", "A&B;C"]);
    expect(TESSERACT_CLI_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TESSERACT_CLI_DEFAULT_MAX_BUFFER).toBeGreaterThan(0);
  });

  it("keeps required local environment values but excludes credentials from child processes", () => {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: "/tmp/tesseract-home",
      TMPDIR: "/tmp/tesseract-tmp",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "ja_JP.UTF-8",
      LC_API_KEY: "locale-shaped-secret",
      TESSERACT_API_KEY: "must-not-be-forwarded",
      OPENAI_API_KEY: "must-not-be-forwarded-either",
      DATABASE_URL: "postgres://secret"
    };
    const script = "process.stdout.write(JSON.stringify(process.env))";
    const result = runTesseractCli(process.execPath, ["-e", script], { env, timeout: 5_000 });
    expect(result.status).toBe(0);
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv).toMatchObject({
      PATH: env.PATH,
      HOME: env.HOME,
      TMPDIR: env.TMPDIR,
      LANG: env.LANG,
      LC_MESSAGES: env.LC_MESSAGES
    });
    expect(childEnv).not.toHaveProperty("TESSERACT_API_KEY");
    expect(childEnv).not.toHaveProperty("LC_API_KEY");
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnv).not.toHaveProperty("DATABASE_URL");
  });

  it("preserves Windows runtime paths and locale while excluding secrets in the simulated host mode", () => {
    const env = {
      PATH: "/fixture/windows/path",
      HOME: "C:\\Users\\fixture",
      LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
      USERPROFILE: "C:\\Users\\fixture",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "ja_JP.UTF-8",
      LC_API_KEY: "locale-shaped-secret",
      TESSERACT_API_KEY: "must-not-be-forwarded",
      OPENAI_API_KEY: "must-not-be-forwarded-either",
      DATABASE_URL: "postgres://secret"
    };
    const script = "process.stdout.write(JSON.stringify(process.env))";
    const result = runTesseractCli(process.execPath, ["-e", script], {
      env,
      platform: "win32",
      timeout: 5_000
    });
    expect(result.status).toBe(0);
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv).toMatchObject({
      PATH: env.PATH,
      HOME: env.HOME,
      LOCALAPPDATA: env.LOCALAPPDATA,
      USERPROFILE: env.USERPROFILE,
      SYSTEMROOT: env.SYSTEMROOT,
      TEMP: env.TEMP,
      LANG: env.LANG,
      LC_MESSAGES: env.LC_MESSAGES
    });
    expect(childEnv).not.toHaveProperty("TESSERACT_API_KEY");
    expect(childEnv).not.toHaveProperty("LC_API_KEY");
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnv).not.toHaveProperty("DATABASE_URL");
  });

  it("finds the pinned Linux CLI under XDG_DATA_HOME and checks its glibc floor", ({ skip }) => {
    if (process.platform === "win32") return skip();
    const root = tempRoot();
    const host = {
      platform: "linux",
      arch: "x64",
      env: { HOME: root, XDG_DATA_HOME: path.join(root, "xdg data"), PATH: "" },
      pathApi: path.posix,
      glibcVersion: "2.35"
    };
    const cliPath = fakeInstalledCli(root, host);
    expect(resolveTesseractCli(host)).toEqual({ ok: true, cliPath, version: TESSERACT_CLI_VERSION });
    expect(resolveTesseractCli({ ...host, glibcVersion: "2.34", runCommand: () => { throw new Error("must not run"); } }))
      .toMatchObject({ ok: false, code: "unsupported_libc" });
  });

  it("keeps Linux display and Vulkan selection values while excluding credentials", () => {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: "/tmp/tesseract-home",
      XDG_DATA_HOME: "/tmp/tesseract-data",
      XDG_CONFIG_HOME: "/tmp/tesseract-config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      VK_DRIVER_FILES: "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json",
      TESSERACT_API_KEY: "must-not-be-forwarded",
      OPENAI_API_KEY: "must-not-be-forwarded-either",
      DATABASE_URL: "postgres://secret"
    };
    const script = "process.stdout.write(JSON.stringify(process.env))";
    const result = runTesseractCli(process.execPath, ["-e", script], { env, platform: "linux", timeout: 5_000 });
    expect(result.status).toBe(0);
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv).toMatchObject({
      PATH: env.PATH,
      HOME: env.HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
      DISPLAY: env.DISPLAY,
      WAYLAND_DISPLAY: env.WAYLAND_DISPLAY,
      VK_DRIVER_FILES: env.VK_DRIVER_FILES
    });
    expect(childEnv).not.toHaveProperty("TESSERACT_API_KEY");
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnv).not.toHaveProperty("DATABASE_URL");
  });
});

describe("Tesseract native audio manifest contract", () => {
  it("accepts an ID-preserving native audio asset and rejects a duplicate timeline track", () => {
    const manifest = {
      meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "native-audio" },
      clips: [],
      images: [],
      audio: { bgm: [], narration: [], sfx: [] },
      captions: [],
      provenance: [],
      native_edit: {
        mode: "replace",
        payload: { document: {
          dimensions: { width: 1920, height: 1080 },
          duration: 1,
          composition: { id: "main", layers: [
            { type: "audio", id: 1, activeRange: { start: 0, duration: 1 }, source: { assetId: "voice-track" } }
          ] }
        } },
        assets: [{
          asset_id: "voice-track",
          src: "assets/native-edit/generated-audio/001-voice-track.wav",
          kind: "audio"
        }],
        primary_output: { width: 1920, height: 1080, fps: 30, audio_required: true }
      }
    };

    expect(assertSupportedManifest(manifest)).toEqual({ width: 1920, height: 1080 });
    expect(() => assertSupportedManifest({
      ...manifest,
      audio: { bgm: [], narration: [{ id: "voice-track", src: "assets/audio/narration/001-voice-track.wav", start: 0 }], sfx: [] }
    })).toThrow(/native_edit\.document replaces generated clip, title, caption, and audio layers/);
  });
});
