import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPORT_SCHEMA_VERSION = 1;
const QUICKSTART_TEMPLATE = "quickstart-local";
const QUICKSTART_SOURCE = join("examples", QUICKSTART_TEMPLATE);
const QUICKSTART_TARGET = join("projects", "my-first-tsugite");
const QUICKSTART_MARKER = ".tsugite-bootstrap.json";
const REPORT_RELATIVE_PATH = join(".tsugite", "setup-report.json");
const MAX_DIAGNOSTIC_LENGTH = 12_000;

/**
 * @typedef {{
 *   command: string;
 *   args: string[];
 *   cwd: string;
 *   environment?: NodeJS.ProcessEnv;
 *   shell: false;
 *   stdio?: "pipe" | "inherit";
 * }} BootstrapCommand
 */

/**
 * @typedef {{
 *   status: number;
 *   stdout: string;
 *   stderr: string;
 * }} BootstrapCommandResult
 */

/**
 * Parse the dependency-free bootstrap command line.
 *
 * @param {string[]} argv
 */
export function parseBootstrapArgs(argv) {
  let check = false;
  let open = false;
  let json = false;
  let help = false;
  const issues = [];

  for (const argument of argv) {
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--open") {
      open = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    issues.push({
      code: "bootstrap.argument_unknown",
      message: "An unsupported bootstrap argument was provided.",
      path: "arguments"
    });
  }

  if (check && open) {
    issues.push({
      code: "bootstrap.arguments_conflict",
      message: "--check and --open cannot be used together."
    });
  }

  return {
    ok: issues.length === 0,
    mode: check ? "check" : open ? "open" : "setup",
    json,
    help,
    issues
  };
}

/**
 * Run Tsugite's repository-local bootstrap.
 *
 * @param {{
 *   argv?: string[];
 *   cwd?: string;
 *   nodeVersion?: string;
 *   platform?: NodeJS.Platform;
 *   architecture?: string;
 *   environment?: NodeJS.ProcessEnv;
 *   runCommand?: (command: BootstrapCommand) => Promise<BootstrapCommandResult>;
 * }} options
 */
export async function runBootstrap(options = {}) {
  const parsed = parseBootstrapArgs(options.argv ?? []);
  const repoRoot = resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? hostPlatform();
  const architecture = options.architecture ?? hostArch();
  const environment = options.environment ?? process.env;
  const secretValues = collectSecretValues(environment);
  const runCommand = options.runCommand ?? runCommandWithSpawn;
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    ok: false,
    mode: parsed.mode,
    repo_root: repoRoot,
    platform: {
      os: platform,
      architecture,
      shell: shellForPlatform(platform, environment)
    },
    checks: [],
    steps: [],
    project: {
      created: false,
      reused: false,
      relative_path: normalizeRelativePath(QUICKSTART_TARGET),
      path: join(repoRoot, QUICKSTART_TARGET)
    },
    unavailable_capabilities: [
      "動画生成サービスへの接続",
      "生成サービスの認証とクレジット"
    ],
    safety: {
      system_packages_installed: false,
      global_packages_installed: false,
      external_login_performed: false,
      credentials_configured: false,
      paid_generation_performed: false,
      run_render_or_gate_invoked: false
    },
    report_path: join(repoRoot, REPORT_RELATIVE_PATH),
    issues: [...parsed.issues]
  };

  if (!parsed.ok) {
    return report;
  }

  if (parsed.help) {
    return {
      ...report,
      ok: true,
      help: bootstrapHelp()
    };
  }

  const rootCheck = await inspectRepositoryRoot(repoRoot);
  const checks = await inspectPrerequisites({
    repoRoot,
    platform,
    environment,
    nodeVersion: options.nodeVersion ?? process.version,
    runCommand,
    secretValues
  });
  report.checks = [rootCheck, ...checks];

  const failedChecks = report.checks.filter((check) => !check.ok);
  if (failedChecks.length > 0) {
    report.issues.push({
      code: "bootstrap.prerequisite_missing",
      message: "Required setup checks did not pass.",
      checks: failedChecks.map((check) => check.id)
    });
    return report;
  }

  if (parsed.mode === "check") {
    report.ok = true;
    return report;
  }

  const projectInspection = await inspectQuickstartTarget(repoRoot);
  if (projectInspection.status === "conflict") {
    report.issues.push({
      code: "bootstrap.project_conflict",
      message: "The quickstart destination is unsafe or already contains data not owned by this bootstrap.",
      path: projectInspection.path
    });
    return report;
  }
  const reportTargetInspection = await inspectReportTarget(repoRoot);
  if (!reportTargetInspection.ok) {
    report.issues.push({
      code: "bootstrap.report_path_unsafe",
      message: reportTargetInspection.message,
      path: reportTargetInspection.path
    });
    return report;
  }

  const previousReport = await readPreviousReport(report.report_path);
  const rootLockHash = await sha256File(join(repoRoot, "package-lock.json"));
  const viewerLockHash = await sha256File(
    join(repoRoot, "apps", "workflow-viewer", "package-lock.json")
  );

  const rootDependenciesReusable = await isReusableInstallStep({
    previousReport,
    stepId: "root_dependencies",
    inputHash: rootLockHash,
    markerPath: join(repoRoot, "node_modules", ".package-lock.json")
  });
  if (rootDependenciesReusable) {
    report.steps.push(skippedStep(
      "root_dependencies",
      "Root dependencies already match package-lock.json.",
      rootLockHash
    ));
  } else {
    const result = await executeStep({
      id: "root_dependencies",
      command: {
        command: npmExecutable(platform),
        args: ["ci"],
        cwd: repoRoot,
        environment,
        shell: false
      },
      runCommand,
      secretValues,
      inputHash: rootLockHash
    });
    report.steps.push(result);
    await persistReport(report);
    if (result.status === "failed") {
      addCommandFailure(report, result);
      await persistReport(report);
      return report;
    }
  }

  const viewerDependenciesReusable = await isReusableInstallStep({
    previousReport,
    stepId: "viewer_dependencies",
    inputHash: viewerLockHash,
    markerPath: join(repoRoot, "apps", "workflow-viewer", "node_modules", ".package-lock.json")
  });
  if (viewerDependenciesReusable) {
    report.steps.push(skippedStep(
      "viewer_dependencies",
      "Viewer dependencies already match package-lock.json.",
      viewerLockHash
    ));
  } else {
    const result = await executeStep({
      id: "viewer_dependencies",
      command: {
        command: npmExecutable(platform),
        args: ["--prefix", "apps/workflow-viewer", "ci"],
        cwd: repoRoot,
        environment,
        shell: false
      },
      runCommand,
      secretValues,
      inputHash: viewerLockHash
    });
    report.steps.push(result);
    await persistReport(report);
    if (result.status === "failed") {
      addCommandFailure(report, result);
      await persistReport(report);
      return report;
    }
  }

  if (projectInspection.status === "reusable") {
    report.project = {
      ...report.project,
      created: false,
      reused: true
    };
    report.steps.push(skippedStep(
      "quickstart_project",
      "Existing bootstrap-owned project was preserved."
    ));
  } else {
    try {
      await mkdir(dirname(projectInspection.path), { recursive: true });
      await cp(join(repoRoot, QUICKSTART_SOURCE), projectInspection.path, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
    } catch (error) {
      const failedStep = {
        id: "quickstart_project",
        status: "failed",
        detail: trimDiagnostic(redactText(
          error instanceof Error ? error.message : String(error),
          secretValues
        )),
        exit_code: 1
      };
      report.steps.push(failedStep);
      report.issues.push({
        code: "bootstrap.project_copy_failed",
        message: "The bundled quickstart project could not be copied.",
        step: "quickstart_project"
      });
      await persistReport(report);
      return report;
    }
    report.project = {
      ...report.project,
      created: true,
      reused: false
    };
    report.steps.push({
      id: "quickstart_project",
      status: "completed",
      detail: "Copied the bundled zero-credit quickstart project.",
      exit_code: 0
    });
    await persistReport(report);
  }

  const configPath = join(projectInspection.path, "project.yaml");
  for (const pipelineCommand of ["doctor", "validate", "plan"]) {
    const result = await executeStep({
      id: pipelineCommand,
      command: {
        command: process.execPath,
        args: [
          "bin/pipeline",
          pipelineCommand,
          "--config",
          configPath,
          "--json"
        ],
        cwd: repoRoot,
        environment,
        shell: false
      },
      runCommand,
      secretValues
    });
    report.steps.push(result);
    await persistReport(report);
    if (result.status === "failed") {
      addCommandFailure(report, result);
      await persistReport(report);
      return report;
    }
  }

  report.ok = true;
  await persistReport(report);

  if (parsed.mode === "open") {
    const result = await executeStep({
      id: "viewer_launcher",
      command: {
        command: process.execPath,
        args: ["bin/pipeline", "viewer-launcher", "--open", "--json"],
        cwd: repoRoot,
        environment,
        shell: false,
        stdio: parsed.json ? "pipe" : "inherit"
      },
      runCommand,
      secretValues
    });
    report.steps.push(result);
    if (result.status === "failed") {
      report.ok = false;
      addCommandFailure(report, result);
    }
    await persistReport(report);
  }

  return report;
}

/**
 * @param {ReturnType<typeof runBootstrap> extends Promise<infer T> ? T : never} report
 */
export function formatHumanReport(report) {
  if (report.help) return report.help;
  const title = report.mode === "check"
    ? "継手の初回セットアップ確認"
    : "継手の初回セットアップ結果";
  const lines = [title, ""];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "✓" : "✗"} ${check.label}${check.version ? ` ${check.version}` : ""}`);
    if (!check.ok && check.remediation) {
      lines.push(`  対応: ${check.remediation}`);
    }
  }
  for (const step of report.steps) {
    const marker = step.status === "failed" ? "✗" : step.status === "skipped" ? "−" : "✓";
    lines.push(`${marker} ${humanStepName(step.id)}`);
    if (step.status === "failed") {
      lines.push(`  対応: ${step.detail || step.stderr || "この工程の診断を確認してから再実行してください。"}`);
    }
  }
  if (report.unavailable_capabilities.length > 0) {
    lines.push("", "未設定：");
    for (const capability of report.unavailable_capabilities) {
      lines.push(`・${capability}`);
    }
  }
  lines.push(
    "",
    report.ok
      ? "継手の基本機能とローカル確認機能は利用できます。"
      : "セットアップは完了していません。上の不足または失敗を解消して再実行してください。",
    "課金や認証は実行していません。"
  );
  if (report.mode !== "check" && report.steps.length > 0) {
    lines.push(`結果: ${report.report_path}`);
  }
  return lines.join("\n");
}

export function bootstrapHelp() {
  return [
    "Tsugite safe bootstrap",
    "",
    "Usage:",
    "  node scripts/bootstrap.mjs --check [--json]",
    "  node scripts/bootstrap.mjs [--json]",
    "  node scripts/bootstrap.mjs --open [--json]",
    "",
    "--check  Read-only prerequisite checks",
    "--open   Run setup, then open the loopback-only launcher",
    "--json   Print the final report as JSON"
  ].join("\n");
}

async function inspectRepositoryRoot(repoRoot) {
  const required = [
    "package.json",
    "package-lock.json",
    join("apps", "workflow-viewer", "package.json"),
    join("apps", "workflow-viewer", "package-lock.json"),
    join("bin", "pipeline"),
    "AGENTS.md",
    join(".agents", "skills", "tsugite", "SKILL.md"),
    join(QUICKSTART_SOURCE, "project.yaml"),
    join(QUICKSTART_SOURCE, "manifest.json"),
    join(QUICKSTART_SOURCE, QUICKSTART_MARKER)
  ];
  const missing = [];
  for (const path of required) {
    if (!(await pathExists(join(repoRoot, path)))) missing.push(normalizeRelativePath(path));
  }
  let packageName;
  try {
    packageName = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).name;
  } catch {
    packageName = undefined;
  }
  if (packageName !== "tsugite") missing.push("package.json#name=tsugite");
  return {
    id: "repository",
    label: "Tsugiteリポジトリ",
    ok: missing.length === 0,
    status: missing.length === 0 ? "ready" : "missing",
    detail: missing.length === 0
      ? repoRoot
      : `Missing repository markers: ${missing.join(", ")}`,
    remediation: "公式Tsugiteリポジトリのルートで再実行してください。"
  };
}

async function inspectPrerequisites({
  repoRoot,
  platform,
  environment,
  nodeVersion,
  runCommand,
  secretValues
}) {
  const nodeOk = isSupportedNodeVersion(nodeVersion);
  const checks = [{
    id: "node",
    label: "Node.js",
    ok: nodeOk,
    status: nodeOk ? "ready" : "missing",
    version: nodeVersion,
    remediation: nodeRemediation(platform)
  }];

  const probes = [
    {
      id: "git",
      label: "Git",
      command: gitExecutable(platform),
      args: ["--version"],
      version: parseGitVersion,
      supported: () => true,
      remediation: "Gitが必要です。自動ではインストールしません。公式installerまたはOSのpackage managerで導入する内容を確認・承認してから、setup:checkを再実行してください。"
    },
    {
      id: "repository_origin",
      label: "公式GitHubリポジトリ",
      command: gitExecutable(platform),
      args: ["remote", "get-url", "origin"],
      version: firstNonEmptyLine,
      supported: isOfficialRepositoryOrigin,
      remediation: "空のフォルダへ公式のhttps://github.com/Takamasa045/tsugiteをcloneし、そのcheckoutで再実行してください。"
    },
    {
      id: "npm",
      label: "npm",
      command: npmExecutable(platform),
      args: ["--version"],
      version: firstNonEmptyLine,
      supported: (version) => leadingMajor(version) >= 10,
      remediation: "npm 10以上が必要です。自動ではインストールしません。Node.js 22と合わせて導入する内容を確認・承認してから、setup:checkを再実行してください。"
    },
    {
      id: "ffmpeg",
      label: "FFmpeg",
      command: "ffmpeg",
      args: ["-version"],
      version: parseMediaVersion,
      supported: () => true,
      remediation: ffmpegRemediation(platform)
    },
    {
      id: "ffprobe",
      label: "ffprobe",
      command: "ffprobe",
      args: ["-version"],
      version: parseMediaVersion,
      supported: () => true,
      remediation: ffmpegRemediation(platform)
    }
  ];

  for (const probe of probes) {
    const result = await safeRunCommand(runCommand, {
      command: probe.command,
      args: probe.args,
      cwd: repoRoot,
      environment,
      shell: false
    });
    const output = redactText([result.stdout, result.stderr].filter(Boolean).join("\n"), secretValues);
    const version = result.status === 0 ? probe.version(output) : undefined;
    const ok = result.status === 0 && Boolean(version) && probe.supported(version);
    checks.push({
      id: probe.id,
      label: probe.label,
      ok,
      status: ok ? "ready" : "missing",
      ...(version ? { version } : {}),
      detail: ok ? undefined : trimDiagnostic(output || `Executable '${probe.command}' is unavailable.`),
      remediation: probe.remediation
    });
  }

  return checks;
}

async function inspectQuickstartTarget(repoRoot) {
  const projectsRoot = join(repoRoot, "projects");
  const path = join(repoRoot, QUICKSTART_TARGET);
  if (await pathExists(projectsRoot)) {
    const projectsRootStat = await lstat(projectsRoot);
    if (projectsRootStat.isSymbolicLink() || !projectsRootStat.isDirectory()) {
      return { status: "conflict", path: projectsRoot };
    }
  }
  if (!(await pathExists(path))) return { status: "missing", path };
  const targetStat = await lstat(path);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return { status: "conflict", path };
  }
  let marker;
  try {
    const requiredFiles = [QUICKSTART_MARKER, "project.yaml", "manifest.json"];
    for (const requiredFile of requiredFiles) {
      const fileStat = await lstat(join(path, requiredFile));
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        return { status: "conflict", path };
      }
    }
    marker = JSON.parse(await readFile(join(path, QUICKSTART_MARKER), "utf8"));
  } catch {
    return { status: "conflict", path };
  }
  const reusable = marker?.schema_version === REPORT_SCHEMA_VERSION
    && marker?.template === QUICKSTART_TEMPLATE
    && await pathExists(join(path, "project.yaml"))
    && await pathExists(join(path, "manifest.json"));
  return { status: reusable ? "reusable" : "conflict", path };
}

async function inspectReportTarget(repoRoot) {
  const reportDirectory = join(repoRoot, ".tsugite");
  const reportPath = join(repoRoot, REPORT_RELATIVE_PATH);
  try {
    const directoryStat = await lstat(reportDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return {
        ok: false,
        path: reportDirectory,
        message: ".tsugite must be a normal directory inside the repository."
      };
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      return {
        ok: false,
        path: reportDirectory,
        message: ".tsugite could not be inspected safely."
      };
    }
  }
  try {
    const reportStat = await lstat(reportPath);
    if (reportStat.isSymbolicLink() || !reportStat.isFile()) {
      return {
        ok: false,
        path: reportPath,
        message: "The setup report path must be a normal file."
      };
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      return {
        ok: false,
        path: reportPath,
        message: "The setup report path could not be inspected safely."
      };
    }
  }
  return { ok: true, path: reportPath };
}

async function executeStep({
  id,
  command,
  runCommand,
  secretValues,
  inputHash
}) {
  const startedAt = new Date().toISOString();
  const result = await safeRunCommand(runCommand, command);
  const stdout = trimDiagnostic(redactText(result.stdout, secretValues));
  const stderr = trimDiagnostic(redactText(result.stderr, secretValues));
  return {
    id,
    status: result.status === 0 ? "completed" : "failed",
    command: displayCommand(command),
    exit_code: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ...(inputHash ? { input_hash: inputHash } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {})
  };
}

async function safeRunCommand(runCommand, command) {
  try {
    const result = await runCommand(command);
    return {
      status: Number.isInteger(result?.status) ? result.status : 1,
      stdout: String(result?.stdout ?? ""),
      stderr: String(result?.stderr ?? "")
    };
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

function addCommandFailure(report, step) {
  report.ok = false;
  report.issues.push({
    code: "bootstrap.command_failed",
    message: `Setup step '${step.id}' failed.`,
    step: step.id,
    exit_code: step.exit_code
  });
}

function skippedStep(id, detail, inputHash) {
  return {
    id,
    status: "skipped",
    detail,
    exit_code: 0,
    ...(inputHash ? { input_hash: inputHash } : {})
  };
}

async function isReusableInstallStep({ previousReport, stepId, inputHash, markerPath }) {
  if (
    !previousReport
    || !Array.isArray(previousReport.steps)
    || !inputHash
    || !(await pathExists(markerPath))
  ) {
    return false;
  }
  return previousReport.steps.some((step) =>
    step.id === stepId
    && ["completed", "skipped"].includes(step.status)
    && step.input_hash === inputHash
  );
}

async function readPreviousReport(reportPath) {
  try {
    return JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function persistReport(report) {
  const reportPath = report.report_path;
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, reportPath);
}

async function runCommandWithSpawn(command) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.environment,
      shell: false,
      stdio: command.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      resolvePromise({ status: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.once("close", (status) => {
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });
}

function collectSecretValues(environment) {
  const sensitiveName = /(api.?key|token|secret|password|cookie|authorization|credential)/i;
  return Object.entries(environment)
    .filter(([name, value]) => sensitiveName.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function redactText(value, secretValues) {
  let redacted = String(value ?? "");
  for (const secret of secretValues) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(token|api[_-]?key|cookie|password|secret|authorization)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]"
    );
}

function trimDiagnostic(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length <= MAX_DIAGNOSTIC_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n[truncated]`;
}

function displayCommand(command) {
  const executable = command.command === process.execPath ? "node" : command.command;
  return [executable, ...command.args].map(quoteForDisplay).join(" ");
}

function quoteForDisplay(value) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 22 && Number(match[2]) >= 12;
}

function leadingMajor(version) {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}

function firstNonEmptyLine(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function parseGitVersion(output) {
  return firstNonEmptyLine(output)?.replace(/^git version\s+/i, "");
}

function parseMediaVersion(output) {
  return firstNonEmptyLine(output)?.replace(/^(ffmpeg|ffprobe) version\s+/i, "").split(/\s+/)[0];
}

function isOfficialRepositoryOrigin(value) {
  const origin = String(value ?? "").trim();
  return [
    /^https:\/\/github\.com\/Takamasa045\/tsugite(?:\.git)?\/?$/i,
    /^git@github\.com:Takamasa045\/tsugite(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/Takamasa045\/tsugite(?:\.git)?\/?$/i
  ].some((pattern) => pattern.test(origin));
}

function shellForPlatform(platform, environment) {
  if (platform === "win32") {
    return environment.ComSpec || environment.COMSPEC || "PowerShell or cmd.exe";
  }
  return environment.SHELL || "unknown";
}

function npmExecutable(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function gitExecutable(platform) {
  return platform === "win32" ? "git.exe" : "git";
}

function nodeRemediation(platform) {
  if (platform === "win32") {
    return "Node.js 22.12以上23未満が必要です。自動ではインストールしません。公式installerでの導入内容を確認・承認し、terminalを開き直してからsetup:checkを再実行してください。";
  }
  return "Node.js 22.12以上23未満が必要です。自動ではインストールしません。導入内容を確認・承認してからsetup:checkを再実行してください。";
}

function ffmpegRemediation(platform) {
  if (platform === "darwin") {
    return "FFmpegとffprobeが必要です。自動ではインストールしません。`brew install ffmpeg`の変更範囲を確認・承認してからsetup:checkを再実行してください。";
  }
  if (platform === "win32") {
    return "FFmpegとffprobeが必要です。自動ではインストールしません。`winget install --id Gyan.FFmpeg -e`の変更範囲を確認・承認し、terminalを開き直してからsetup:checkを再実行してください。";
  }
  return "FFmpegとffprobeが必要です。自動ではインストールしません。OSのpackage managerでの導入内容を確認・承認してからsetup:checkを再実行してください。";
}

function humanStepName(id) {
  return {
    root_dependencies: "継手の依存関係",
    viewer_dependencies: "Workflow Viewer",
    quickstart_project: "サンプル案件",
    doctor: "doctor",
    validate: "validate",
    plan: "plan",
    viewer_launcher: "ランチャー"
  }[id] ?? id;
}

function normalizeRelativePath(path) {
  return path.split("\\").join("/");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingPathError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function sha256File(path) {
  try {
    const content = await readFile(path);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}
