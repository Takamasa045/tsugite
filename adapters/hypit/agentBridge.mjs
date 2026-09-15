/**
 * HypitAgentBridge: real fixed Codex exec profile using the official full Skill.
 * This is not a prompt-only generator. Browser cannot choose argv.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_BIN,
  authorChildEnv,
  authorSandboxDir,
  assertCodexBinAvailable,
  defaultCodexExecArgv,
  parentAuthorCommand
} from "./authorProfile.mjs";
import { fileDigestSync, sha256Bytes } from "./digest.mjs";
import { hypitEntry } from "./runtimeAdapter.mjs";

const ADAPTER_ROOT = fileURLToPath(new URL(".", import.meta.url));
export const AUTHOR_STOPS_BEFORE = Object.freeze([
  "build",
  "runtime up",
  "programs up",
  "auth login",
  "transcribe",
  "studio"
]);

export const DEFAULT_SKILL_ROOT = join(ADAPTER_ROOT, "skill");
const REQUIRED_SOURCES = ["main.svml", "build.svrun"];

export const DEFAULT_AUTHOR_BRIEF = [
  "AIエージェント創作開発ラボの参加者募集動画を作る。30秒、縦型（9:16）、オリジナル日本語。",
  "職種採用・雇用・待遇の募集ではない。コミュニティの参加者を招く。",
  "ラボ名は「AIエージェント創作開発ラボ」。架空の職種・求人条件・応募URLは書かない。",
  "参考映像は構造・テンポ・文字組み・動きの着想だけに使う。歌詞・楽曲・映像は複製しない。",
  "提案は無音タイポグラフィでもよいが、それは未承認の創作選択として明示する。",
  "実ファイルを検査する。タイトルから解析を捏造しない。"
].join(" ");

export function authorProjectPrompt(input) {
  const hypitBin = input.hypitEntry ?? hypitEntry();
  return [
    "You are a coding agent with the official Hypit Skill (full references tree).",
    `Skill root: ${input.skillRoot ?? join(input.workspace, ".agents", "skills", "hypit")}`,
    `Installed Hypit CLI (use this exact Node entry, do not search PATH): ${hypitBin}`,
    "Example: node <that path> check main.svml --workspace <workspace> --json",
    "Work only inside the independent workspace named below. It is the only writable source root.",
    "Do not call hypit build, hypit runtime up, hypit programs up, hypit auth login, hypit transcribe, or hypit studio.",
    "Do not start provider processes or spend credits.",
    "Stop after editable sources exist and a summary of decisions is written.",
    "",
    `Workspace: ${input.workspace}`,
    `Brief: ${input.brief ?? DEFAULT_AUTHOR_BRIEF}`,
    input.instruction ? `Additional instruction: ${input.instruction}` : "",
    input.reference
      ? `Reference file (inspect this file; do not invent analysis from a title): ${input.reference}`
      : "No local reference file is available. Do not claim reference analysis.",
    "",
    "Create or revise:",
    "- main.svml (Author Source)",
    "- recipes.svs when Recipes are needed",
    "- build.svrun with <author source> and <target output>",
    "- BRIEF.md / TREATMENT.md / Analysis/Timeline only if the real reference file was inspected",
    "",
    "Reuse accepted media only through explicit <build-record> + <satisfy> in the Run Source.",
    "Captions-only revisions must keep accepted video Outputs as Candidates.",
    "Imports must stay on the official @hypit/ distribution or the project allowlist.",
    "Report structured output: files_written, decisions, unknowns, stopped_before_build, reference_inspected."
  ].filter((line) => line !== "").join("\n");
}

export function reviseProjectPrompt(input) {
  return authorProjectPrompt({
    ...input,
    brief: `Revise the existing Hypit project. Instruction: ${input.instruction}`
  });
}

export function stageAuthorWorkspace(workspace, input = {}) {
  const skillDest = join(workspace, ".agents", "skills", "hypit");
  mkdirSync(skillDest, { recursive: true });
  cpSync(input.skillRoot ?? DEFAULT_SKILL_ROOT, skillDest, { recursive: true });
  const sandbox = authorSandboxDir(workspace);
  mkdirSync(join(sandbox, "home"), { recursive: true });
  mkdirSync(join(sandbox, "tmp"), { recursive: true });
  const schemaDest = join(sandbox, "output.schema.json");
  writeFileSync(schemaDest, readFileSync(new URL("./author-output.schema.json", import.meta.url)));
  const promptPath = join(workspace, "AUTHOR_PROMPT.txt");
  writeFileSync(promptPath, authorProjectPrompt({ ...input, workspace, skillRoot: skillDest }));
  return { skillDest, promptPath, sandbox, schemaDest };
}

function snapshotSources(workspace) {
  const files = {};
  for (const name of REQUIRED_SOURCES) {
    const path = join(workspace, name);
    files[name] = existsSync(path) ? fileDigestSync(path) : null;
  }
  return files;
}

function authoredEvidence(before, after) {
  const written = [];
  let changed = false;
  for (const name of REQUIRED_SOURCES) {
    if (!after[name]) continue;
    written.push(name);
    if (!before[name] || before[name].sha256 !== after[name].sha256) changed = true;
  }
  return { written, changed, complete: written.length === REQUIRED_SOURCES.length };
}

/**
 * Invoke the fixed Codex profile. Tests may inject `runCommand`.
 * HTTP/UI must not pass argv. This session does not spawn nested agents;
 * the parent runs the production CLI author command.
 */
export function invokeAuthorAgent(input) {
  const staged = stageAuthorWorkspace(input.workspace, input);
  const lastMessagePath = join(staged.sandbox, "last-message.txt");
  const argv = defaultCodexExecArgv({
    workspace: input.workspace,
    schemaPath: staged.schemaDest,
    lastMessagePath
  });
  if (!input.runCommand) {
    try {
      assertCodexBinAvailable(CODEX_BIN);
    } catch (error) {
      return {
        status: "blocked",
        reason: error.message,
        promptPath: staged.promptPath,
        skillDest: staged.skillDest,
        argv,
        parentCommand: parentAuthorCommand(input.productionRoot ?? input.workspace)
      };
    }
  }
  const before = snapshotSources(input.workspace);
  const home = join(staged.sandbox, "home");
  const tmpdir = join(staged.sandbox, "tmp");
  const childEnv = input.childEnv ?? authorChildEnv(input.env ?? process.env, { home, tmpdir });
  const runCommand = input.runCommand ?? ((commandArgv, options) => spawnSync(commandArgv[0], commandArgv.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    timeout: options.timeoutMs ?? 300_000,
    input: options.input
  }));
  const result = runCommand(argv, {
    cwd: input.workspace,
    env: childEnv,
    timeoutMs: input.timeoutMs,
    input: readFileSync(staged.promptPath, "utf8")
  });
  const after = snapshotSources(input.workspace);
  const evidence = authoredEvidence(before, after);
  let status = "incomplete";
  if (result.status === 0 && evidence.complete && evidence.changed) status = "authored";
  else if (result.status === 0 && evidence.complete && !evidence.changed) status = "noop";
  return {
    status,
    promptPath: staged.promptPath,
    skillDest: staged.skillDest,
    argv,
    argv_digest: sha256Bytes(Buffer.from(JSON.stringify(argv))),
    exitStatus: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    written: evidence.written.map((name) => join(input.workspace, name)),
    before,
    after,
    parentCommand: parentAuthorCommand(input.productionRoot ?? input.workspace)
  };
}

export function startAuthorAgentProcess(input) {
  const staged = stageAuthorWorkspace(input.workspace, input);
  const lastMessagePath = join(staged.sandbox, "last-message.txt");
  const argv = defaultCodexExecArgv({
    workspace: input.workspace,
    schemaPath: staged.schemaDest,
    lastMessagePath
  });
  assertCodexBinAvailable(CODEX_BIN);
  const before = snapshotSources(input.workspace);
  const home = join(staged.sandbox, "home");
  const tmpdir = join(staged.sandbox, "tmp");
  const childEnv = input.childEnv ?? authorChildEnv(input.env ?? process.env, { home, tmpdir });
  const logPath = join(staged.sandbox, "author-run.log");
  const log = createWriteStream(logPath);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: input.workspace,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(readFileSync(staged.promptPath));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return {
    pid: child.pid,
    argv,
    argv_digest: sha256Bytes(Buffer.from(JSON.stringify(argv))),
    promptPath: staged.promptPath,
    skillDest: staged.skillDest,
    lastMessagePath,
    logPath,
    before,
    child
  };
}

export { defaultCodexExecArgv, parentAuthorCommand, snapshotSources, authoredEvidence };
