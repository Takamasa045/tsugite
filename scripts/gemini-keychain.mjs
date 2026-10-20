#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE = "tsugite.google-gemini-api";
const ACCOUNT = userInfo().username;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECURITY = "/usr/bin/security";
const PBCOPY = "/usr/bin/pbcopy";
const PBPASTE = "/usr/bin/pbpaste";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16_384,
    ...options
  });
}

function keyFromKeychain() {
  const result = run(SECURITY, ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
  const key = result.status === 0 ? result.stdout.trim() : "";
  if (!validKey(key)) throw new Error("Gemini API key is not available in the Tsugite Keychain entry");
  return key;
}

function validKey(key) {
  return typeof key === "string" && key.length >= 20 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key);
}

const [action, ...args] = process.argv.slice(2);
try {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required");
  if (action === "status" && args.length === 0) {
    const found = run(SECURITY, ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
    process.stdout.write(JSON.stringify({ keychain_entry_present: found.status === 0, secret_value_exposed: false }) + "\n");
  } else if (action === "save-from-clipboard" && args.length === 0) {
    const copied = run(PBPASTE, []);
    const key = copied.status === 0 ? copied.stdout.trim() : "";
    if (!validKey(key)) throw new Error("Clipboard does not contain one plausible API key");
    const saved = run(SECURITY, ["add-generic-password", "-U", "-a", ACCOUNT, "-s", SERVICE, "-w"], {
      input: `${key}\n${key}\n`
    });
    if (saved.status !== 0) throw new Error("Could not save the Gemini API key to Keychain");
    const persisted = keyFromKeychain();
    if (persisted !== key) throw new Error("Keychain read-back did not match the copied key");
    run(PBCOPY, [], { input: "" });
    process.stdout.write("Gemini API key saved in macOS Keychain; clipboard cleared. No API request was sent.\n");
  } else if ((action === "run-pipeline" || action === "run-dialogue") && args.length > 0) {
    const key = keyFromKeychain();
    const entry = action === "run-pipeline"
      ? resolve(ROOT, "bin/pipeline")
      : resolve(ROOT, "adapters/google-gemini-tts/dialogue.mjs");
    const child = spawnSync(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env: { ...process.env, GEMINI_API_KEY: key },
      stdio: "inherit"
    });
    process.exitCode = child.status ?? 1;
  } else {
    throw new Error("Usage: gemini-keychain.mjs status | save-from-clipboard | run-pipeline <pipeline args> | run-dialogue <dialogue args>");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Gemini Keychain operation failed"}\n`);
  process.exitCode = 1;
}
