#!/usr/bin/env node
/**
 * Allowlisted After Effects local helper.
 * DoScriptFile runs fixed JSX. Results are read from a new result.json, not stdout.
 * app.exitCode / osascript stdout JSON is not treated as success.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const COMMANDS = Object.freeze(["probe", "inspect", "fixture", "add-title"]);
export const DEFAULT_APP_NAME = "Adobe After Effects 2026";
export const DEFAULT_TIMEOUT_MS = 45_000;
export const FIXTURE_MARKER = "tsugite-ae-fixture";
export const TITLE_LAYER = "tsugite-title";
export const TMP_ISOLATION_PREFIXES = Object.freeze(["/tmp/tsugite-ae-", "/private/tmp/tsugite-ae-"]);
export const REQUEST_ROOT = "/tmp/tsugite-ae-helper";

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command.startsWith("-")) {
    throw fail("usage", "command required: probe | inspect | fixture | add-title");
  }
  if (!COMMANDS.includes(command)) {
    throw fail("unknown_command", `unsupported command: ${command}`);
  }
  if (args.includes("--eval") || args.includes("--script") || args.includes("--jsx")) {
    throw fail("raw_eval_forbidden", "caller-supplied ExtendScript is not accepted");
  }

  const opts = {
    command,
    json: false,
    launch: false,
    appName: DEFAULT_APP_NAME,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    workdir: "",
    expectedProject: "",
    output: "",
    comp: FIXTURE_MARKER,
    title: "Tsugite Title"
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--json") {
      opts.json = true;
      continue;
    }
    if (token === "--launch") {
      opts.launch = true;
      continue;
    }
    if (token === "--retry" || token === "--allowed-prefix") {
      throw fail("flag_forbidden", `${token} is not allowed`);
    }
    const next = args[i + 1];
    if (token === "--app") {
      const value = requireValue(token, next);
      if (value !== DEFAULT_APP_NAME) {
        throw fail("app_not_supported", "only Adobe After Effects 2026 is supported");
      }
      opts.appName = value;
      i += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const value = Number(requireValue(token, next));
      if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
        throw fail("invalid_timeout", "--timeout-ms must be 1000..120000");
      }
      opts.timeoutMs = value;
      i += 1;
      continue;
    }
    if (token === "--workdir") {
      opts.workdir = requireValue(token, next);
      i += 1;
      continue;
    }
    if (token === "--expected-project") {
      opts.expectedProject = requireValue(token, next);
      i += 1;
      continue;
    }
    if (token === "--output") {
      opts.output = requireValue(token, next);
      i += 1;
      continue;
    }
    if (token === "--comp") {
      opts.comp = requireValue(token, next);
      i += 1;
      continue;
    }
    if (token === "--title") {
      opts.title = requireValue(token, next);
      i += 1;
      continue;
    }
    throw fail("unknown_flag", `unsupported flag: ${token}`);
  }

  if (opts.command === "fixture" && !opts.workdir) {
    throw fail("workdir_required", "fixture requires --workdir under /tmp/tsugite-ae-");
  }
  if (opts.command === "add-title") {
    if (!opts.workdir || !opts.expectedProject || !opts.output) {
      throw fail("add_title_args", "add-title requires --workdir --expected-project --output");
    }
  }
  return opts;
}

export function normalizeTmpPath(path) {
  const resolved = resolve(path);
  if (resolved === "/tmp" || resolved.startsWith(`/tmp${sep}`)) {
    return `/private${resolved}`;
  }
  return resolved;
}

export function isTmpIsolationPath(candidate) {
  const normalized = normalizeTmpPath(candidate);
  return TMP_ISOLATION_PREFIXES.some((prefix) => {
    const p = normalizeTmpPath(prefix);
    return normalized === p || normalized.startsWith(p);
  });
}

export function isInsideDir(candidate, root) {
  const c = resolve(candidate);
  const r = resolve(root);
  return c === r || c.startsWith(`${r}${sep}`);
}

export function sameFsPath(left, right) {
  if (!left || !right) return false;
  return normalizeTmpPath(left) === normalizeTmpPath(right);
}

export function titleKeyPlan({ width, height, duration }) {
  if (!(duration > 0) || !(width > 0) || !(height > 0)) return null;
  const x = width / 2;
  const y1 = height * 0.18;
  const y2 = height * 0.22;
  let tEnd = duration < 1 ? duration * 0.8 : 1;
  if (tEnd >= duration) tEnd = duration * 0.9;
  if (tEnd <= 0) tEnd = duration;
  let tFade = duration < 1 ? duration * 0.5 : 0.5;
  if (tFade >= duration) tFade = duration * 0.5;
  return {
    position: [
      { time: 0, value: [x, y1] },
      { time: tEnd, value: [x, y2] }
    ],
    opacity: [
      { time: 0, value: 0 },
      { time: tFade, value: 100 }
    ]
  };
}

function keysMatch(actual, expected, valueIsArray) {
  if (!Array.isArray(actual) || actual.length < expected.length) return false;
  return expected.every((want, index) => {
    const got = actual[index];
    if (!got || Math.abs(Number(got.time) - want.time) > 1e-6) return false;
    if (valueIsArray) {
      if (!Array.isArray(got.value) || got.value.length < 2) return false;
      return Math.abs(got.value[0] - want.value[0]) < 0.51 && Math.abs(got.value[1] - want.value[1]) < 0.51;
    }
    return Math.abs(Number(got.value) - want.value) < 0.51;
  });
}

export function verifyFixtureIdentity(parsed, { aepPath, requestId }) {
  if (parsed.request_id !== requestId) return { ok: false, code: "identity_mismatch" };
  if (!sameFsPath(parsed.file, aepPath) || !sameFsPath(parsed.saved, aepPath)) {
    return { ok: false, code: "identity_mismatch" };
  }
  const comps = Array.isArray(parsed.comps) ? parsed.comps.filter((item) => item?.name === FIXTURE_MARKER) : [];
  if (comps.length !== 1 || !Array.isArray(comps[0].layers) || comps[0].layers.length < 1) {
    return { ok: false, code: "identity_mismatch" };
  }
  return { ok: true };
}

export function verifyAddTitleIdentity(parsed, { outputPath, requestId, comp, title }) {
  if (parsed.request_id !== requestId) return { ok: false, code: "identity_mismatch" };
  if (!sameFsPath(parsed.file, outputPath) || !sameFsPath(parsed.saved, outputPath)) {
    return { ok: false, code: "identity_mismatch" };
  }
  const comps = Array.isArray(parsed.comps) ? parsed.comps.filter((item) => item?.name === comp) : [];
  if (comps.length !== 1) return { ok: false, code: "identity_mismatch" };
  const dest = comps[0];
  const plan = titleKeyPlan(dest);
  const layer = Array.isArray(dest.layers) ? dest.layers.find((item) => item?.name === TITLE_LAYER) : null;
  if (!plan || !layer || layer.text !== title) return { ok: false, code: "identity_mismatch" };
  if (!keysMatch(layer.position_keys, plan.position, true) || !keysMatch(layer.opacity_keys, plan.opacity, false)) {
    return { ok: false, code: "identity_mismatch" };
  }
  return { ok: true };
}

export function assertNoForbiddenChars(path) {
  if (!isAbsolute(path)) {
    throw fail("path_not_absolute", "path must be absolute");
  }
  if (/[\0\n\r"\\]/.test(path)) {
    throw fail("path_invalid", "path contains forbidden characters");
  }
}

export function assertTmpWorkdir(workdir) {
  assertNoForbiddenChars(workdir);
  const resolved = resolve(workdir);
  const real = resolveExistingPath(resolved);
  if (!isTmpIsolationPath(resolved) || !isTmpIsolationPath(real)) {
    throw fail("path_not_allowed", "fixture workdir is outside /tmp/tsugite-ae-");
  }
  return resolved;
}

export function assertExactWorkdir(workdir, io = {}) {
  assertNoForbiddenChars(workdir);
  const exists = io.exists ?? existsSync;
  const lstat = io.lstat ?? lstatSync;
  const resolved = resolve(workdir);
  if (!exists(resolved) || !lstat(resolved).isDirectory()) {
    throw fail("workdir_missing", "add-title --workdir must be an existing directory");
  }
  if (lstat(resolved).isSymbolicLink()) {
    throw fail("symlink_forbidden", "workdir must not be a symlink");
  }
  const home = resolve(homedir());
  if (
    resolved === "/" ||
    resolved === "/tmp" ||
    resolved === "/private/tmp" ||
    resolved === home ||
    isInsideDir(home, resolved)
  ) {
    throw fail("workdir_too_wide", "--workdir must be a project after-effects folder, not / or the home directory");
  }
  return resolved;
}

export function assertInsideWorkdir(path, workdir, { mustExist = false, mustNotExist = false } = {}, io = {}) {
  assertNoForbiddenChars(path);
  const exists = io.exists ?? existsSync;
  const lstat = io.lstat ?? lstatSync;
  const resolved = resolve(path);
  const root = resolve(workdir);
  if (!isInsideDir(resolved, root)) {
    throw fail("path_not_allowed", "path is outside --workdir");
  }
  if (exists(resolved) && lstat(resolved).isSymbolicLink()) {
    throw fail("symlink_forbidden", "path must not be a symlink");
  }
  const realRoot = realpathSync(root);
  const real = resolveExistingPath(resolved);
  if (!isInsideDir(real, realRoot)) {
    throw fail("symlink_forbidden", "path real location leaves --workdir");
  }
  if (mustExist && !exists(resolved)) {
    throw fail("expected_missing", "expected project does not exist");
  }
  if (mustExist && exists(resolved) && !lstat(resolved).isFile()) {
    throw fail("expected_missing", "expected project is not a file");
  }
  if (mustNotExist && exists(resolved)) {
    throw fail("output_exists", "output already exists");
  }
  return resolved;
}

export function resolveExistingPath(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    missing.unshift(current.slice(dirname(current).length).replace(new RegExp(`^${sep}`), ""));
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const realRoot = existsSync(current) ? realpathSync(current) : current;
  return missing.length ? join(realRoot, ...missing) : realRoot;
}

export function jsxStringEscape(value) {
  let out = "";
  const s = String(value);
  for (const char of s) {
    const code = char.codePointAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === "\"") out += "\\\"";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code === 0x2028) out += "\\u2028";
    else if (code === 0x2029) out += "\\u2029";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out;
}

export function buildRuntimeJsx(resultPath, requestId = "") {
  const result = jsxStringEscape(resultPath);
  const rid = jsxStringEscape(requestId);
  return [
    `var RESULT_PATH = "${result}";`,
    `var REQUEST_ID = "${rid}";`,
    "function jstr(value) {",
    "  if (value === null || value === undefined) return 'null';",
    "  var s = String(value);",
    "  var out = '';",
    "  for (var i = 0; i < s.length; i++) {",
    "    var c = s.charAt(i);",
    "    var code = s.charCodeAt(i);",
    "    if (c === '\\\\') out += '\\\\\\\\';",
    "    else if (c === '\"') out += '\\\\\"';",
    "    else if (c === '\\n') out += '\\\\n';",
    "    else if (c === '\\r') out += '\\\\r';",
    "    else if (c === '\\t') out += '\\\\t';",
    "    else if (code === 0x2028) out += '\\\\u2028';",
    "    else if (code === 0x2029) out += '\\\\u2029';",
    "    else if (code < 32) {",
    "      var hex = code.toString(16);",
    "      while (hex.length < 4) hex = '0' + hex;",
    "      out += '\\\\u' + hex;",
    "    } else out += c;",
    "  }",
    "  return '\"' + out + '\"';",
    "}",
    "function writeResult(json) {",
    "  var f = new File(RESULT_PATH);",
    "  if (f.exists) return false;",
    "  f.encoding = 'UTF-8';",
    "  if (!f.open('w')) return false;",
    "  f.write(json);",
    "  f.close();",
    "  return true;",
    "}",
    "function failJson(code, extra) {",
    "  extra = extra || '';",
    "  writeResult('{\"ok\":false,\"code\":' + jstr(code) + extra + '}');",
    "}",
    "function keyList(prop) {",
    "  var keys = [];",
    "  if (!prop) return '[]';",
    "  for (var k = 1; k <= prop.numKeys; k++) {",
    "    var v = prop.keyValue(k);",
    "    var vs = (v instanceof Array) ? '[' + v.join(',') + ']' : String(v);",
    "    keys.push('{\"time\":' + prop.keyTime(k) + ',\"value\":' + vs + '}');",
    "  }",
    "  return '[' + keys.join(',') + ']';",
    "}",
    "function layerText(layer) {",
    "  try {",
    "    var doc = layer.property('ADBE Text Properties').property('ADBE Text Document');",
    "    if (!doc || !doc.value) return '';",
    "    return String(doc.value.text);",
    "  } catch (e) { return ''; }",
    "}",
    "function inspectJson() {",
    "  var p = app.project;",
    "  var file = (p && p.file) ? p.file.fsName : '';",
    "  var dirty = p ? p.dirty : false;",
    "  var items = p ? p.numItems : 0;",
    "  var comps = [];",
    "  if (p) {",
    "    for (var i = 1; i <= p.numItems; i++) {",
    "      var item = p.item(i);",
    "      if (item instanceof CompItem) {",
    "        var layers = [];",
    "        for (var n = 1; n <= item.numLayers; n++) {",
    "          var layer = item.layer(n);",
    "          var tr = layer.property('ADBE Transform Group');",
    "          var pos = tr.property('ADBE Position');",
    "          var opa = tr.property('ADBE Opacity');",
    "          layers.push('{\"name\":' + jstr(layer.name) + ',\"index\":' + layer.index + ',\"text\":' + jstr(layerText(layer)) + ',\"position_keys\":' + keyList(pos) + ',\"opacity_keys\":' + keyList(opa) + '}');",
    "        }",
    "        comps.push('{\"id\":' + item.id + ',\"name\":' + jstr(item.name) + ',\"width\":' + item.width + ',\"height\":' + item.height + ',\"frameRate\":' + item.frameRate + ',\"duration\":' + item.duration + ',\"layers\":[' + layers.join(',') + ']}');",
    "      }",
    "    }",
    "  }",
    "  return '{\"ok\":true,\"op\":\"inspect\",\"file\":' + jstr(file) + ',\"dirty\":' + dirty + ',\"numItems\":' + items + ',\"request_id\":' + jstr(REQUEST_ID) + ',\"comps\":[' + comps.join(',') + ']}';",
    "}"
  ].join("\n");
}

export function buildInspectJsx(resultPath, requestId = "") {
  return [buildRuntimeJsx(resultPath, requestId), "writeResult(inspectJson());"].join("\n");
}

export function buildFixtureJsx(resultPath, aepPath, marker, requestId = "") {
  const target = jsxStringEscape(aepPath);
  const name = jsxStringEscape(marker);
  return [
    buildRuntimeJsx(resultPath, requestId),
    "function fixture() {",
    "  var p = app.project;",
    "  var file = (p && p.file) ? p.file.fsName : '';",
    `  var targetFile = new File("${target}");`,
    "  var target = targetFile.fsName;",
    "  if (file && file !== target) { failJson('unrelated_project', ',\"file\":' + jstr(file)); return; }",
    "  if (!file && p && p.numItems > 0) { failJson('unsaved_or_busy'); return; }",
    "  if (targetFile.exists) { failJson('aep_exists'); return; }",
    `  var comp = p.items.addComp("${name}", 1920, 1080, 1, 5, 30);`,
    `  var layer = comp.layers.addText("${name}");`,
    "  var pos = layer.property('ADBE Transform Group').property('ADBE Position');",
    "  pos.setValueAtTime(0, [comp.width / 2, comp.height / 2]);",
    "  pos.setValueAtTime(Math.min(1, comp.duration * 0.8), [comp.width / 2 + 80, comp.height / 2]);",
    "  p.save(targetFile);",
    "  var json = inspectJson();",
    "  writeResult(json.slice(0, json.length - 1) + ',\"saved\":' + jstr(target) + '}');",
    "}",
    "fixture();"
  ].join("\n");
}

export function buildAddTitleJsx(resultPath, expectedPath, outputPath, compName, title, requestId = "") {
  const expected = jsxStringEscape(expectedPath);
  const output = jsxStringEscape(outputPath);
  const comp = jsxStringEscape(compName);
  const text = jsxStringEscape(title);
  const layerName = jsxStringEscape(TITLE_LAYER);
  return [
    buildRuntimeJsx(resultPath, requestId),
    "function addTitle() {",
    "  var p = app.project;",
    `  var expectedFile = new File("${expected}");`,
    `  var outputFile = new File("${output}");`,
    "  var expectedName = expectedFile.fsName;",
    "  var file = (p && p.file) ? p.file.fsName : '';",
    "  if (!file || file !== expectedName) { failJson('unrelated_project', ',\"file\":' + jstr(file) + ',\"expected\":' + jstr(expectedName)); return; }",
    "  if (p.dirty) { failJson('dirty_project'); return; }",
    "  if (!expectedFile.exists) { failJson('expected_missing'); return; }",
    "  if (outputFile.exists) { failJson('output_exists'); return; }",
    "  var matches = [];",
    "  for (var i = 1; i <= p.numItems; i++) {",
    "    var item = p.item(i);",
    `    if (item instanceof CompItem && item.name === "${comp}") matches.push(item);`,
    "  }",
    "  if (matches.length !== 1) { failJson('comp_not_unique', ',\"count\":' + matches.length); return; }",
    "  var dest = matches[0];",
    "  if (!(dest.duration > 0)) { failJson('bad_duration'); return; }",
    `  var layer = dest.layers.addText("${text}");`,
    `  layer.name = "${layerName}";`,
    "  var tr = layer.property('ADBE Transform Group');",
    "  var pos = tr.property('ADBE Position');",
    "  var opa = tr.property('ADBE Opacity');",
    "  var x = dest.width / 2;",
    "  var y1 = dest.height * 0.18;",
    "  var y2 = dest.height * 0.22;",
    "  var tEnd = dest.duration < 1 ? dest.duration * 0.8 : 1;",
    "  if (tEnd >= dest.duration) tEnd = dest.duration * 0.9;",
    "  if (tEnd <= 0) tEnd = dest.duration;",
    "  var tFade = dest.duration < 1 ? dest.duration * 0.5 : 0.5;",
    "  if (tFade >= dest.duration) tFade = dest.duration * 0.5;",
    "  pos.setValueAtTime(0, [x, y1]);",
    "  pos.setValueAtTime(tEnd, [x, y2]);",
    "  opa.setValueAtTime(0, 0);",
    "  opa.setValueAtTime(tFade, 100);",
    "  p.save(outputFile);",
    "  var json = inspectJson();",
    "  writeResult(json.slice(0, json.length - 1) + ',\"saved\":' + jstr(outputFile.fsName) + '}');",
    "}",
    "addTitle();"
  ].join("\n");
}

export function readResultFile(resultPath, io = {}) {
  const exists = io.exists ?? existsSync;
  const lstat = io.lstat ?? lstatSync;
  const read = io.readFile ?? ((path) => readFileSync(path, "utf8"));
  if (!exists(resultPath)) {
    return { ok: false, code: "result_missing", retry: false };
  }
  if (lstat(resultPath).isSymbolicLink()) {
    return { ok: false, code: "symlink_forbidden", retry: false };
  }
  try {
    const parsed = JSON.parse(read(resultPath));
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, code: "unparseable", retry: false };
    }
    if (parsed.ok === true) return parsed;
    return { ...parsed, ok: false, retry: false };
  } catch {
    return { ok: false, code: "unparseable", retry: false };
  }
}

export function finalizeCommand(parsed, result, timedOut, extra = {}) {
  if (timedOut) {
    return { ...parsed, ...extra, ok: false, code: "timeout", retry: false, timedOut: true, exit: result.status };
  }
  if (result.status !== 0) {
    return {
      ...parsed,
      ...extra,
      ok: false,
      code: parsed.code && parsed.code !== "result_missing" ? parsed.code : "osascript_failed",
      retry: false,
      timedOut: false,
      exit: result.status,
      stderr: result.stderr?.trim() || ""
    };
  }
  if (parsed.ok !== true) {
    return { ...parsed, ...extra, ok: false, retry: false, timedOut: false, exit: result.status };
  }
  return { ...parsed, ...extra, ok: true, retry: false, timedOut: false, exit: result.status };
}

export function runningAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  try {
    if (!argv1) return false;
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function writeExclusive(path, contents) {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

export function createRequestDir(io = {}) {
  const mkdir = io.mkdir ?? mkdirSync;
  const chmod = io.chmod ?? chmodSync;
  const id = `req-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = join(REQUEST_ROOT, id);
  mkdir(dir, { recursive: true });
  chmod(dir, 0o700);
  return { dir, id };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("-")) {
    throw fail("missing_value", `${flag} requires a value`);
  }
  return value;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const PROCESS_LIST_SCRIPT = [
  'tell application "System Events"',
  '  set aeProcs to every process whose name contains "After Effects"',
  '  set aeLines to {}',
  '  repeat with aeProc in aeProcs',
  '    set aeAppPath to ""',
  '    try',
  '      set aeAppPath to POSIX path of application file of aeProc',
  '    end try',
  '    set end of aeLines to (name of aeProc) & tab & aeAppPath',
  '  end repeat',
  "  set AppleScript's text item delimiters to linefeed",
  '  return aeLines as text',
  'end tell'
].join("\n");

export function parseAeProcessList(stdout, appName = DEFAULT_APP_NAME) {
  const rows = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const processes = rows.map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return { name: line, path: "" };
    return { name: line.slice(0, tab).trim(), path: line.slice(tab + 1).trim() };
  });
  const names = processes.map((item) => item.name);
  const selectedRunning = processes.some((item) => {
    if (item.path.includes("/Adobe After Effects 2026/")) return appName === DEFAULT_APP_NAME;
    if (item.path.includes("/Adobe After Effects 2024/")) return false;
    return item.name === appName;
  });
  return { running: names, selectedRunning, processes };
}

export function listRunningAe(appName, exec = spawnSync) {
  const listed = exec("osascript", ["-e", PROCESS_LIST_SCRIPT], { encoding: "utf8", timeout: 8_000 });
  if (listed.status !== 0) {
    return { running: [], selectedRunning: false, processes: [], error: listed.stderr?.trim() || "osascript failed" };
  }
  return { ...parseAeProcessList(listed.stdout, appName), error: null };
}

function runDoScriptFile(appName, jsxPath, timeoutMs, exec = spawnSync) {
  const source = [
    `tell application "${appName.replace(/"/g, "")}"`,
    `  DoScriptFile POSIX file "${jsxPath.replace(/"/g, "")}"`,
    "end tell"
  ].join("\n");
  return exec("osascript", ["-e", source], { encoding: "utf8", timeout: timeoutMs });
}

export function runHelper(opts, io = {}) {
  const exec = io.exec ?? spawnSync;
  const exists = io.exists ?? existsSync;
  const installs = detectInstalls(exists);
  const selected = installs.find((item) => item.appName === opts.appName && item.installed);
  const running = listRunningAe(opts.appName, exec);

  if (opts.command === "probe") {
    const ok = Boolean(selected) && !running.error;
    return {
      ok,
      op: "probe",
      connected: false,
      appName: opts.appName,
      selected_installed: Boolean(selected),
      selected_running: running.selectedRunning,
      installs,
      running: running.running,
      error: running.error,
      execution_path: "applescript-DoScriptFile-result-file",
      result_channel: "result.json",
      mcp_not_used: true,
      live_verified: false,
      code: ok ? undefined : selected ? "process_list_failed" : "app_not_installed"
    };
  }

  if (!selected) {
    return { ok: false, code: "app_not_installed", appName: opts.appName, installs, connected: false, live_verified: false };
  }
  if (!running.selectedRunning && !opts.launch) {
    return {
      ok: false,
      code: running.running.length ? "selected_ae_not_running" : "ae_not_running",
      running: running.running,
      connected: false,
      live_verified: false
    };
  }

  let projectWorkdir = "";
  let aepPath;
  let outputPath;
  let expectedPath;
  try {
    if (opts.command === "fixture") {
      projectWorkdir = assertTmpWorkdir(opts.workdir);
      mkdirSync(projectWorkdir, { recursive: true });
      aepPath = join(projectWorkdir, `${FIXTURE_MARKER}.aep`);
      if (exists(aepPath)) {
        return { ok: false, code: "aep_exists", aep: aepPath, retry: false, live_verified: false };
      }
    } else if (opts.command === "add-title") {
      projectWorkdir = assertExactWorkdir(opts.workdir, io);
      expectedPath = assertInsideWorkdir(opts.expectedProject, projectWorkdir, { mustExist: true }, io);
      outputPath = assertInsideWorkdir(opts.output, projectWorkdir, { mustNotExist: true }, io);
    }
  } catch (error) {
    return {
      ok: false,
      code: error.code || "path_invalid",
      message: error.message,
      retry: false,
      live_verified: false
    };
  }

  const request = createRequestDir(io);
  const requestDir = request.dir;
  const requestId = request.id;
  const jsxPath = join(requestDir, "command.jsx");
  const resultPath = join(requestDir, "result.json");
  let jsx;
  if (opts.command === "fixture") {
    jsx = buildFixtureJsx(resultPath, aepPath, FIXTURE_MARKER, requestId);
  } else if (opts.command === "add-title") {
    jsx = buildAddTitleJsx(resultPath, expectedPath, outputPath, opts.comp, opts.title, requestId);
  } else {
    jsx = buildInspectJsx(resultPath, requestId);
  }

  try {
    writeExclusive(jsxPath, jsx);
  } catch (error) {
    return { ok: false, code: "jsx_exists", path: jsxPath, retry: false, message: error.message, live_verified: false };
  }

  const result = runDoScriptFile(opts.appName, jsxPath, opts.timeoutMs, exec);
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  let parsed = {
    ok: false,
    code: "result_missing",
    retry: false,
    hint: "result.json was not written; scripting file access may be off, or the script did not finish"
  };
  if (!timedOut) {
    parsed = readResultFile(resultPath);
    if (parsed.code === "result_missing") {
      parsed.hint =
        "result.json was not written; scripting file access may be off, or the script did not finish";
    }
  }
  const extra = {
    op: opts.command,
    jsx: jsxPath,
    request_dir: requestDir,
    request_id: requestId,
    result_file: resultPath,
    aep: aepPath,
    output: outputPath,
    aep_exists: aepPath ? exists(aepPath) : undefined,
    output_exists: outputPath ? exists(outputPath) : undefined,
    stdout_ignored: true,
    live_verified: false
  };
  const finalized = finalizeCommand(parsed, result, timedOut, extra);
  if (opts.command === "fixture" && finalized.ok && !extra.aep_exists) {
    finalized.ok = false;
    finalized.code = "aep_missing";
  }
  if (opts.command === "add-title" && finalized.ok && !extra.output_exists) {
    finalized.ok = false;
    finalized.code = "output_missing";
  }
  if (finalized.ok && opts.command === "fixture") {
    const identity = verifyFixtureIdentity(parsed, { aepPath, requestId });
    if (!identity.ok) {
      finalized.ok = false;
      finalized.code = identity.code;
    }
  }
  if (finalized.ok && opts.command === "add-title") {
    const identity = verifyAddTitleIdentity(parsed, {
      outputPath,
      requestId,
      comp: opts.comp,
      title: opts.title
    });
    if (!identity.ok) {
      finalized.ok = false;
      finalized.code = identity.code;
    }
  }
  finalized.connected = finalized.ok === true && finalized.exit === 0 && !timedOut;
  finalized.retry = false;
  return finalized;
}

export function detectInstalls(fsExists = existsSync) {
  const candidates = [
    {
      appName: "Adobe After Effects 2026",
      appPath: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
    },
    {
      appName: "Adobe After Effects 2024",
      appPath: "/Applications/Adobe After Effects 2024/Adobe After Effects 2024.app"
    }
  ];
  return candidates.map((item) => ({
    ...item,
    installed: fsExists(item.appPath)
  }));
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (runningAsMain()) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = runHelper(opts);
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    printResult({ ok: false, code: error.code || "error", message: error.message, retry: false, live_verified: false });
    process.exit(1);
  }
}
