import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDirectory, assertNoSymlinkBetween, confinedError, isPathWithin, writeSafeFile } from "./confine.mjs";
import {
  allocateLoopbackPort,
  assertOwnedListener,
  childEnv,
  spawnOwnedUntil,
  stopOwned,
  waitForHttp
} from "./processGroup.mjs";
import { canonicalPath, renderViteConfig } from "./document.mjs";
import { ensureRuntimeModuleLink, resolveEditframeCli } from "./runtimePath.mjs";

export async function createAuthoringCopy(sourceDir, destinationDir) {
  const source = resolve(sourceDir);
  const destination = resolve(destinationDir);
  if (source === destination) {
    throw confinedError("authoring copy destination must differ from the source composition");
  }
  if (isPathWithin(source, destination)) {
    throw confinedError("refusing to write an authoring copy inside the source composition");
  }
  await assertDirectory(source, "preview source");
  await assertNoSymlinkBetween(destination, dirname(destination), "preview destination");
  await assertTreeHasNoSymlinks(source, "preview source");
  try {
    await lstat(destination);
    throw confinedError("preview destination already exists");
  } catch (error) {
    if (error && error.exitCode === 10) throw error;
    if (error && error.code !== "ENOENT") {
      throw confinedError(`preview destination is not usable: ${error.message}`);
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await assertNoSymlinkBetween(dirname(destination), dirname(destination), "preview destination parent");
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (entry) => {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) return false;
      if (info.isDirectory() && (entry.endsWith("/node_modules") || entry.endsWith("/cache"))) return false;
      return info.isFile() || info.isDirectory();
    }
  });
  await assertDirectory(destination, "authoring copy");
  await assertTreeHasNoSymlinks(destination, "authoring copy");
  return destination;
}

async function assertTreeHasNoSymlinks(root, label) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const info = await lstat(current);
    if (info.isDirectory()) {
      const entries = await readdir(current);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "cache") continue;
        stack.push(join(current, entry));
      }
      continue;
    }
    if (info.isSymbolicLink()) {
      throw confinedError(`${label} must not contain symlinks: ${current}`);
    }
  }
}

export function defaultAuthoringDir(sourceDir) {
  const resolved = resolve(sourceDir);
  return join(dirname(resolved), `${basename(resolved)}-authoring`);
}

export async function rebaseAuthoringConfig(compositionDir, runtime, port) {
  const root = canonicalPath(compositionDir);
  await writeSafeFile(
    join(root, "vite.config.js"),
    renderViteConfig({
      port,
      compositionDir: root,
      runtimeRoot: runtime.root
    }),
    root
  );
}

export async function startPreviewServer(compositionDir, options = {}) {
  const runtime = resolveEditframeCli();
  if (!runtime.ok) {
    throw new Error(runtime.message);
  }
  const root = canonicalPath(compositionDir);
  const port = await allocateLoopbackPort();
  await writeSafeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "tsugite-editframe-authoring", private: true, type: "module" }, null, 2)}\n`,
    root
  );
  await rebaseAuthoringConfig(root, runtime, port);
  await ensureRuntimeModuleLink(root, runtime);
  const handle = await spawnOwnedUntil(
    [process.execPath, runtime.viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: root,
      env: childEnv(),
      signal: options.signal
    },
    async (ownedHandle) => {
      await waitForHttp(`http://127.0.0.1:${port}/`, {
        expectedStatus: 200,
        expectedType: "text/html",
        expectedText: "<ef-timegroup",
        signal: options.signal
      });
      await assertOwnedListener(port, ownedHandle.pgid);
    }
  );
  return { handle, url: `http://127.0.0.1:${port}/`, port, compositionDir: root };
}

export async function runPreviewCli(argv) {
  const source = argv[0];
  if (!source) {
    console.error("Usage: node backends/editframe/preview.mjs <composition-dir>");
    process.exitCode = 1;
    return;
  }
  const abort = new AbortController();
  let server = null;
  const stopAfterReady = async (code) => {
    abort.abort();
    if (server) {
      try {
        await stopOwned(server.handle);
      } catch {
        // still exit
      }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => {
    if (server) void stopAfterReady(130);
    else abort.abort();
  });
  process.on("SIGTERM", () => {
    if (server) void stopAfterReady(143);
    else abort.abort();
  });
  const sourceDir = resolve(source);
  const authoringDir = defaultAuthoringDir(sourceDir);
  try {
    const copy = await createAuthoringCopy(sourceDir, authoringDir);
    server = await startPreviewServer(copy, { signal: abort.signal });
    console.log(
      JSON.stringify({
        ok: true,
        url: server.url,
        authoring_dir: copy,
        source_dir: sourceDir,
        pid: server.handle.pid,
        note: "Authoring copy only. Browser Export is not a Gate. WebMCP and disk-save API are unverified."
      })
    );
  } catch (error) {
    if (abort.signal.aborted) {
      process.exitCode = 143;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runPreviewCli(process.argv.slice(2));
}
