import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

function cappedCollector(maximumBytes) {
  const chunks = [];
  let retained = 0;
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maximumBytes - retained);
      if (remaining > 0) {
        const slice = buffer.subarray(0, remaining);
        chunks.push(slice);
        retained += slice.length;
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export function createPipelineRunner({
  nodeExecutable,
  cliModulePath,
  runtimeRoot,
  platform = process.platform,
  baseEnv = process.env,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  terminationGraceMs = 1_500,
  spawnProcess = spawn,
  execFileProcess = execFile,
  killProcess = process.kill.bind(process)
}) {
  const active = new Map();
  let disposed = false;

  const run = async (_command, args, options = {}) => {
    if (disposed) throw new Error("Desktop pipeline runner is disposed");
    const requestedArgs = Array.isArray(args) ? args.slice(1) : [];
    const environment = { ...baseEnv, ...(options.env ?? {}) };
    const runtimeBin = dirname(nodeExecutable);
    const currentPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
    const pathDelimiter = platform === "win32" ? ";" : ":";
    environment.PATH = currentPath ? `${runtimeBin}${pathDelimiter}${currentPath}` : runtimeBin;
    delete environment.Path;
    delete environment.path;
    const child = spawnProcess(nodeExecutable, [cliModulePath, ...requestedArgs], {
      cwd: runtimeRoot,
      env: environment,
      shell: false,
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = cappedCollector(maxOutputBytes);
    const stderr = cappedCollector(maxOutputBytes);
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));

    return await new Promise((resolveProcess, rejectProcess) => {
      const finish = (result, error) => {
        if (!active.has(child)) return;
        active.delete(child);
        if (error) rejectProcess(error);
        else resolveProcess(result);
      };
      active.set(child, { finish });
      child.once("error", (error) => finish(undefined, error));
      child.once("close", (code) => finish({
        exitCode: code ?? 1,
        stdout: stdout.text(),
        stderr: stderr.text()
      }));
    });
  };

  const terminate = async (child) => {
    if (!child.pid) {
      child.kill?.("SIGTERM");
      return;
    }
    if (platform === "win32") {
      await new Promise((resolveKill, rejectKill) => {
        execFileProcess(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, shell: false },
          (error) => error ? rejectKill(error) : resolveKill()
        );
      });
      await wait(terminationGraceMs);
      if (active.has(child)) throw new Error(`Windows child process ${child.pid} did not stop`);
      return;
    }
    try {
      killProcess(-child.pid, "SIGTERM");
    } catch {
      child.kill?.("SIGTERM");
    }
    await wait(terminationGraceMs);
    if (active.has(child)) {
      try {
        killProcess(-child.pid, "SIGKILL");
      } catch {
        child.kill?.("SIGKILL");
      }
      await wait(terminationGraceMs);
      if (active.has(child)) throw new Error(`Child process ${child.pid} did not stop`);
    }
  };

  const dispose = async () => {
    disposed = true;
    const children = [...active.keys()];
    await Promise.all(children.map(terminate));
    await Promise.allSettled([...active.keys()].map((child) => new Promise((resolveClose) => {
      if (!active.has(child)) return resolveClose();
      child.once("close", resolveClose);
      setTimeout(resolveClose, Math.max(100, terminationGraceMs));
    })));
  };

  return {
    run,
    dispose,
    hasActive: () => active.size > 0
  };
}
