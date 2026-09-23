import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTesseractCli, TESSERACT_CLI_VERSION } from "../backends/tesseract/cli.mjs";
import {
  installTesseract,
  main,
  parseTesseractChecksum,
  resolveTesseractTarget,
  tesseractReleaseUrls
} from "../scripts/tesseract-install.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "tsugite-tesseract-install-test-"));
  roots.push(root);
  return root;
}

function fakeMacCli(home) {
  const cliPath = path.join(home, "Library", "Application Support", "Tesseract", "bin", "tsrct");
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("tsrct ${TESSERACT_CLI_VERSION}");\nelse process.exit(2);\n`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function offlineInstallOptions(root, fetchImpl, extra = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    env: { HOME: path.join(root, "home"), PATH: process.env.PATH ?? "" },
    translated: false,
    fetchImpl,
    runCommand: () => { throw new Error("must not invoke commands during a download failure"); },
    tempParent: root,
    downloadTimeoutMs: 35,
    logger: { log() {}, error() {} },
    ...extra
  };
}

describe("Tesseract explicit installer", () => {
  it("selects only official supported release targets", () => {
    expect(resolveTesseractTarget({ platform: "darwin", arch: "arm64", translated: false }))
      .toEqual({ ok: true, asset: "darwin-arm64" });
    expect(resolveTesseractTarget({ platform: "darwin", arch: "x64", translated: false }))
      .toEqual({ ok: true, asset: "darwin-x86_64" });
    expect(resolveTesseractTarget({ platform: "darwin", arch: "x64", translated: true }))
      .toEqual({ ok: true, asset: "darwin-arm64" });
    expect(resolveTesseractTarget({
      platform: "win32", arch: "ia32", env: { PROCESSOR_ARCHITEW6432: "AMD64" }, windowsRelease: "10.0.22631"
    })).toEqual({ ok: true, asset: "windows-x86_64" });
    expect(resolveTesseractTarget({ platform: "win32", env: { PROCESSOR_ARCHITECTURE: "x86" }, windowsRelease: "10.0.22631" }))
      .toMatchObject({ ok: false, code: "unsupported_arch" });
    expect(resolveTesseractTarget({ platform: "win32", env: { PROCESSOR_ARCHITECTURE: "AMD64" }, windowsRelease: "6.3.9600" }))
      .toMatchObject({ ok: false, code: "unsupported_os_version" });
    expect(resolveTesseractTarget({ platform: "linux", arch: "x64" })).toMatchObject({ ok: false, code: "unsupported_host" });
  });

  it("builds exact URLs from the official 0.1.0 pin", () => {
    expect(tesseractReleaseUrls("darwin-arm64")).toEqual({
      archiveName: "tesseract-0.1.0-darwin-arm64.zip",
      archiveUrl: "https://github.com/mirage-hq/tesseract/releases/download/v0.1.0/tesseract-0.1.0-darwin-arm64.zip",
      checksumUrl: "https://github.com/mirage-hq/tesseract/releases/download/v0.1.0/tesseract-0.1.0-darwin-arm64.zip.sha256"
    });
    expect(() => tesseractReleaseUrls("darwin-arm64", "latest")).toThrow(/official skill pin/);
  });

  it("parses one matching SHA-256 entry and rejects malformed or mislabeled sidecars", () => {
    const digest = "a".repeat(64);
    expect(parseTesseractChecksum(`${digest}  bundle.zip\n`, "bundle.zip")).toBe(digest);
    expect(parseTesseractChecksum(`${digest}\n`, "bundle.zip")).toBe(digest);
    expect(() => parseTesseractChecksum("not-a-checksum", "bundle.zip")).toThrow(/valid SHA-256/);
    expect(() => parseTesseractChecksum(`${digest}  other.zip`, "bundle.zip")).toThrow(/not bundle.zip/);
    expect(() => parseTesseractChecksum(`${digest}\n${digest}`, "bundle.zip")).toThrow(/exactly one/);
  });

  it("requires an explicit install command", async () => {
    const fetchImpl = () => { throw new Error("must not download without install"); };
    await expect(main([], { fetchImpl })).rejects.toThrow("Usage: npm run tesseract:install");
    await expect(main(["--help"], { fetchImpl })).rejects.toThrow("Usage: npm run tesseract:install");
  });

  it("verifies a fake archive before invoking only the official installer script", async ({ skip }) => {
    if (process.platform !== "darwin") return skip();
    const root = tempRoot();
    const home = path.join(root, "home with spaces");
    const bytes = Buffer.from("fake Tesseract release archive");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const urls = tesseractReleaseUrls("darwin-arm64");
    const requested = [];
    const commandCalls = [];
    const logger = { log() {}, error() {} };
    const env = {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: root,
      TESSERACT_API_KEY: "must-not-be-forwarded"
    };
    const fetchImpl = async (url, options) => {
      requested.push({ url, options });
      if (url === urls.archiveUrl) return new Response(bytes, { status: 200 });
      if (url === urls.checksumUrl) return new Response(`${digest}  ${urls.archiveName}\n`, { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const runCommand = (command, args, options) => {
      commandCalls.push({ command, args, options });
      expect(options.shell).toBe(false);
      expect(options.env).not.toHaveProperty("TESSERACT_API_KEY");
      if (command === "ditto") {
        const extractDir = args[3];
        const installer = path.join(extractDir, "tesseract-release", "install.sh");
        mkdirSync(path.dirname(installer), { recursive: true });
        writeFileSync(installer, "# fake official installer; intentionally not executed by this test\n");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "bash") {
        expect(args[0]).toMatch(/\/install\.sh$/);
        expect(options.env.HOME).toBe(home);
        fakeMacCli(home);
        return { status: 0, stdout: "fake installer completed", stderr: "" };
      }
      return runTesseractCli(command, args, options);
    };

    const result = await main(["install"], {
      platform: "darwin",
      arch: "arm64",
      env,
      translated: false,
      fetchImpl,
      runCommand,
      tempParent: root,
      logger
    });

    expect(result).toMatchObject({ ok: true, version: "0.1.0", asset: "darwin-arm64" });
    expect(requested.map((entry) => entry.url)).toEqual([urls.archiveUrl, urls.checksumUrl]);
    expect(requested.every(({ options }) => options.headers.Authorization === undefined)).toBe(true);
    expect(commandCalls.map(({ command }) => command)).toEqual(["ditto", "bash", result.cliPath]);
  });

  it("stops on a checksum mismatch before extraction or installation", async ({ skip }) => {
    if (process.platform !== "darwin") return skip();
    const root = tempRoot();
    const urls = tesseractReleaseUrls("darwin-arm64");
    const bytes = Buffer.from("tampered archive");
    const runCommand = () => { throw new Error("must not extract on checksum mismatch"); };
    const fetchImpl = async (url) => url === urls.archiveUrl
      ? new Response(bytes, { status: 200 })
      : new Response(`${"a".repeat(64)}  ${urls.archiveName}\n`, { status: 200 });

    await expect(installTesseract({
      platform: "darwin",
      arch: "arm64",
      env: { HOME: path.join(root, "home"), PATH: process.env.PATH },
      translated: false,
      fetchImpl,
      runCommand,
      tempParent: root,
      logger: { log() {}, error() {} }
    })).rejects.toThrow(/SHA-256 mismatch/);
  });

  it.each(["archive fetch", "archive stream", "checksum fetch", "checksum stream"])(
    "aborts a stalled %s within the configured download timeout",
    async (stall) => {
      const root = tempRoot();
      const urls = tesseractReleaseUrls("darwin-arm64");
      const bytes = Buffer.from("fake archive for timeout test");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const requests = [];
      const neverSettles = () => new Promise(() => {});
      const neverFinishes = () => new ReadableStream({ pull() {} });
      const fetchImpl = (url, { signal }) => {
        requests.push({ url, signal });
        if (stall === "archive fetch" && url === urls.archiveUrl) return neverSettles();
        if (stall === "archive stream" && url === urls.archiveUrl) {
          return Promise.resolve(new Response(neverFinishes(), { status: 200 }));
        }
        if (url === urls.archiveUrl) return Promise.resolve(new Response(bytes, { status: 200 }));
        if (stall === "checksum fetch") return neverSettles();
        if (stall === "checksum stream") return Promise.resolve(new Response(neverFinishes(), { status: 200 }));
        return Promise.resolve(new Response(`${digest}  ${urls.archiveName}${String.fromCharCode(10)}`, { status: 200 }));
      };

      const startedAt = Date.now();
      await expect(installTesseract(offlineInstallOptions(root, fetchImpl)))
        .rejects.toThrow(/timed out after 35 ms/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(requests.length).toBe(stall.startsWith("archive") ? 1 : 2);
      expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(requests.at(-1).signal.aborted).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    }
  );

  it("exercises the Windows extraction, official install and version verification branches through injected host tools", async () => {
    const root = tempRoot();
    const archiveBytes = Buffer.from("fake Windows release archive");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const urls = tesseractReleaseUrls("windows-x86_64");
    const calls = [];
    const env = {
      PATH: process.env.PATH ?? "",
      LOCALAPPDATA: path.join(root, "Local App Data"),
      USERPROFILE: path.join(root, "User Profile"),
      SYSTEMROOT: "C:\\Windows",
      TEMP: root,
      PROCESSOR_ARCHITECTURE: "AMD64",
      TESSERACT_API_KEY: "must-not-be-forwarded"
    };
    const fetchImpl = async (url, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return url === urls.archiveUrl
        ? new Response(archiveBytes, { status: 200 })
        : new Response(`${digest}  ${urls.archiveName}${String.fromCharCode(10)}`, { status: 200 });
    };
    const cliPath = "C:\\Users\\fixture\\AppData\\Local\\Tesseract\\bin\\tsrct.cmd";
    const runCommand = (command, args, options) => {
      calls.push({ command, args, options });
      expect(options.shell).toBe(false);
      expect(options.env).not.toHaveProperty("TESSERACT_API_KEY");
      if (command === "powershell.exe" && args.includes("-Command")) {
        const extractDir = options.env.TSUGITE_TESSERACT_EXTRACT_PATH;
        const installer = path.join(extractDir, "fixture-release", "install.ps1");
        expect(options.env.TSUGITE_TESSERACT_ARCHIVE_PATH).toContain("tesseract-0.1.0-windows-x86_64.zip");
        mkdirSync(path.dirname(installer), { recursive: true });
        writeFileSync(installer, "# fake official Windows installer; intentionally not executed");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "powershell.exe" && args.includes("-File")) {
        expect(args.at(-1).endsWith("install.ps1")).toBe(true);
        expect(options.env.LOCALAPPDATA).toBe(env.LOCALAPPDATA);
        return { status: 0, stdout: "fake installer completed", stderr: "" };
      }
      if (command === cliPath) {
        expect(args).toEqual(["--version"]);
        expect(options.env.SYSTEMROOT).toBe("C:\\Windows");
        return { status: 0, stdout: `tsrct ${TESSERACT_CLI_VERSION}`, stderr: "" };
      }
      throw new Error(`Unexpected command ${command}`);
    };
    const resolveCli = ({ platform, arch, env: verifyEnv, runCommand: verify }) => {
      expect(platform).toBe("win32");
      expect(arch).toBe("x64");
      expect(verifyEnv).not.toHaveProperty("TESSERACT_API_KEY");
      const result = verify(cliPath, ["--version"], { timeout: 1_000, maxBuffer: 1_024 });
      expect(result.status).toBe(0);
      return { ok: true, cliPath, version: TESSERACT_CLI_VERSION };
    };

    const result = await installTesseract({
      platform: "win32",
      arch: "x64",
      env,
      windowsRelease: "10.0.22631",
      fetchImpl,
      runCommand,
      resolveCli,
      tempParent: root,
      logger: { log() {}, error() {} }
    });

    expect(result).toMatchObject({ ok: true, cliPath, version: TESSERACT_CLI_VERSION, asset: "windows-x86_64" });
    expect(calls.map(({ command, args }) => [command, args[2] ?? args[4] ?? args[0]])).toEqual([
      ["powershell.exe", "-Command"],
      ["powershell.exe", "-ExecutionPolicy"],
      [cliPath, "--version"]
    ]);
  });
});
