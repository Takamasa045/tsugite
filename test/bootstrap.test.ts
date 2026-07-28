import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatHumanReport,
  parseBootstrapArgs,
  runBootstrap,
  type BootstrapCommand,
  type BootstrapCommandResult
} from "../src/bootstrap/index.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Tsugite bootstrap", () => {
  it("checks prerequisites without writing files", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: ["--check"],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: { SHELL: "/bin/zsh" },
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("check");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "git", ok: true }),
      expect.objectContaining({ id: "node", ok: true, version: "v22.12.0" }),
      expect.objectContaining({ id: "npm", ok: true, version: "10.9.8" }),
      expect.objectContaining({ id: "ffmpeg", ok: true }),
      expect.objectContaining({ id: "ffprobe", ok: true })
    ]));
    expect(commands.map(commandLine)).toEqual([
      "git --version",
      "git remote get-url origin",
      "npm --version",
      "ffmpeg -version",
      "ffprobe -version"
    ]);
    await expect(stat(join(root, ".tsugite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "projects", "my-first-tsugite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs only the declared local setup commands and creates the quickstart project", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.22.3",
      platform: "darwin",
      environment: { SHELL: "/bin/zsh" },
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("setup");
    expect(report.project).toMatchObject({
      created: true,
      reused: false,
      relative_path: "projects/my-first-tsugite"
    });
    expect(report.steps.map((step) => [step.id, step.status])).toEqual([
      ["root_dependencies", "completed"],
      ["viewer_dependencies", "completed"],
      ["quickstart_project", "completed"],
      ["doctor", "completed"],
      ["validate", "completed"],
      ["plan", "completed"]
    ]);
    const setupCommands = commands
      .map(commandLine)
      .filter((command) => ![
        "git --version",
        "git remote get-url origin",
        "npm --version",
        "ffmpeg -version",
        "ffprobe -version"
      ].includes(command));
    expect(setupCommands).toEqual([
      "npm ci",
      "npm --prefix apps/workflow-viewer ci",
      expect.stringMatching(/node bin\/pipeline doctor --config .*projects[/\\]my-first-tsugite[/\\]project\.yaml --json/),
      expect.stringMatching(/node bin\/pipeline validate --config .*projects[/\\]my-first-tsugite[/\\]project\.yaml --json/),
      expect.stringMatching(/node bin\/pipeline plan --config .*projects[/\\]my-first-tsugite[/\\]project\.yaml --json/)
    ]);
    expect(commands.flatMap((command) => command.args)).not.toEqual(
      expect.arrayContaining(["run", "render", "gate"])
    );
    expect(await readFile(join(root, "projects", "my-first-tsugite", "project.yaml"), "utf8"))
      .toContain("name: はじめての継手");
    expect(JSON.parse(await readFile(join(root, ".tsugite", "setup-report.json"), "utf8")))
      .toMatchObject({ ok: true, mode: "setup" });
  });

  it.each([
    { nodeVersion: "v22.11.0", npmVersion: "10.9.8", failedId: "node" },
    { nodeVersion: "v23.0.0", npmVersion: "10.9.8", failedId: "node" },
    { nodeVersion: "v22.12.0", npmVersion: "9.9.0", failedId: "npm" }
  ])("stops before changes when a required version is unsupported", async ({
    nodeVersion,
    npmVersion,
    failedId
  }) => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion,
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands, { npmVersion })
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: failedId, ok: false }));
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
    await expect(stat(join(root, ".tsugite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["ffmpeg", "ffprobe"])("stops before changes when %s is unavailable", async (missingCommand) => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];
    const runner = createSuccessfulRunner(commands, { missingCommand });

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "linux",
      environment: { SHELL: "/bin/bash" },
      runCommand: runner
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: missingCommand, ok: false }));
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
    expect(formatHumanReport(report)).toContain("自動ではインストールしません");
  });

  it("records a root dependency failure and does not continue after a network error", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];
    const runner = createSuccessfulRunner(commands, { failCommand: "npm ci" });

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: runner
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "bootstrap.command_failed" }));
    expect(report.steps).toEqual([
      expect.objectContaining({ id: "root_dependencies", status: "failed", exit_code: 1 })
    ]);
    expect(commands.some((command) => command.args.includes("doctor"))).toBe(false);
    expect(JSON.parse(await readFile(join(root, ".tsugite", "setup-report.json"), "utf8")))
      .toMatchObject({ ok: false });
  });

  it("stops when Viewer dependency installation fails", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "win32",
      environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      runCommand: createSuccessfulRunner(commands, {
        failCommand: "npm --prefix apps/workflow-viewer ci"
      })
    });

    expect(report.ok).toBe(false);
    expect(report.platform).toMatchObject({ os: "win32", shell: "C:\\Windows\\System32\\cmd.exe" });
    expect(report.steps.at(-1)).toMatchObject({ id: "viewer_dependencies", status: "failed" });
    expect(commands.some((command) => command.args.includes("doctor"))).toBe(false);
  });

  it("detects a non-empty project collision before installing dependencies", async () => {
    const root = await createRepositoryFixture();
    const target = join(root, "projects", "my-first-tsugite");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "do-not-overwrite.txt"), "user data");
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "bootstrap.project_conflict",
      path: target
    }));
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
    expect(await readFile(join(target, "do-not-overwrite.txt"), "utf8")).toBe("user data");
  });

  it("rejects a report directory symlink before installing dependencies", async () => {
    const root = await createRepositoryFixture();
    const outside = await mkdtemp(join(tmpdir(), "tsugite outside "));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, ".tsugite"), "dir");
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "bootstrap.report_path_unsafe",
      path: join(root, ".tsugite")
    }));
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
    await expect(stat(join(outside, "setup-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent and never overwrites an existing bootstrap-owned project", async () => {
    const root = await createRepositoryFixture();
    const firstCommands: BootstrapCommand[] = [];
    const first = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(firstCommands)
    });
    expect(first.ok).toBe(true);
    const sentinel = join(root, "projects", "my-first-tsugite", "notes.md");
    await writeFile(sentinel, "keep my changes");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "apps", "workflow-viewer", "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", ".package-lock.json"), "{}");
    await writeFile(join(root, "apps", "workflow-viewer", "node_modules", ".package-lock.json"), "{}");
    const secondCommands: BootstrapCommand[] = [];

    const second = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(secondCommands)
    });

    expect(second.ok).toBe(true);
    expect(second.project).toMatchObject({ created: false, reused: true });
    expect(second.steps.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "root_dependencies", status: "skipped" }),
      expect.objectContaining({ id: "viewer_dependencies", status: "skipped" })
    ]);
    expect(second.steps).toContainEqual(expect.objectContaining({
      id: "quickstart_project",
      status: "skipped"
    }));
    expect(await readFile(sentinel, "utf8")).toBe("keep my changes");
    expect(secondCommands.some((command) => command.command === "npm" && command.args.includes("ci")))
      .toBe(false);
  });

  it("ignores a malformed previous report and reruns safe install steps", async () => {
    const root = await createRepositoryFixture();
    await mkdir(join(root, ".tsugite"), { recursive: true });
    await writeFile(join(root, ".tsugite", "setup-report.json"), JSON.stringify({ steps: "invalid" }));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", ".package-lock.json"), "{}");
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(true);
    expect(report.steps[0]).toMatchObject({ id: "root_dependencies", status: "completed" });
    expect(commands.some((command) => commandLine(command) === "npm ci")).toBe(true);
  });

  it("rejects a projects directory symlink instead of copying outside the repository", async () => {
    const root = await createRepositoryFixture();
    const outside = await mkdtemp(join(tmpdir(), "tsugite projects outside "));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, "projects"), "dir");
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "bootstrap.project_conflict",
      path: join(root, "projects")
    }));
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
    await expect(stat(join(outside, "my-first-tsugite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops after doctor fails and does not invoke validate or plan", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands, {
        failCommand: "node bin/pipeline doctor"
      })
    });

    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ id: "doctor", status: "failed" });
    expect(commands.some((command) => command.args.includes("validate"))).toBe(false);
    expect(commands.some((command) => command.args.includes("plan"))).toBe(false);
    expect(formatHumanReport(report)).toContain("セットアップは完了していません");
  });

  it("opens the launcher only after setup and reports launcher failure", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: ["--open"],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands, {
        failCommand: "node bin/pipeline viewer-launcher"
      })
    });

    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({
      id: "viewer_launcher",
      status: "failed",
      command: "node bin/pipeline viewer-launcher --open --json"
    });
    expect(commands.at(-1)).toMatchObject({ stdio: "inherit", shell: false });
  });

  it("returns help without probing or writing", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: ["-h"],
      cwd: root,
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(true);
    expect(report.help).toContain("node scripts/bootstrap.mjs --check");
    expect(formatHumanReport(report)).toBe(report.help);
    expect(commands).toEqual([]);
    await expect(stat(join(root, ".tsugite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when repository markers are invalid", async () => {
    const root = await createRepositoryFixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "not-tsugite" }));

    const report = await runBootstrap({
      argv: ["--check"],
      cwd: root,
      nodeVersion: "not-a-version",
      platform: "linux",
      environment: {},
      runCommand: createSuccessfulRunner([])
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "repository",
      ok: false,
      detail: expect.stringContaining("package.json#name=tsugite")
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "node", ok: false }));
  });

  it("requires the official GitHub origin without exposing remote credentials", async () => {
    const root = await createRepositoryFixture();
    const leakedCredential = "ghp_should_not_be_logged";
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner(commands, {
        originUrl: `https://${leakedCredential}@github.com/attacker/tsugite.git`
      })
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "repository_origin",
      ok: false
    }));
    expect(JSON.stringify(report)).not.toContain(leakedCredential);
    expect(commands.some((command) => command.command === "npm" && command.args[0] === "ci")).toBe(false);
  });

  it("uses argument arrays for paths containing spaces and Japanese characters", async () => {
    const root = await createRepositoryFixture("継手 セットアップ ");
    const commands: BootstrapCommand[] = [];

    const report = await runBootstrap({
      argv: [],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "win32",
      environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      runCommand: createSuccessfulRunner(commands)
    });

    expect(report.ok).toBe(true);
    const doctor = commands.find((command) => command.args.includes("doctor"));
    expect(doctor?.shell).toBe(false);
    expect(doctor?.args).toContain(join(root, "projects", "my-first-tsugite", "project.yaml"));
  });

  it("redacts secret environment values from reports and command diagnostics", async () => {
    const root = await createRepositoryFixture();
    const commands: BootstrapCommand[] = [];
    const secret = "super-secret-cookie-value";
    const baseRunner = createSuccessfulRunner(commands);
    const runner = async (command: BootstrapCommand): Promise<BootstrapCommandResult> => {
      const result = await baseRunner(command);
      if (command.command === "npm" && command.args[0] === "ci") {
        return { status: 1, stdout: `TOKEN=${secret}`, stderr: `Cookie: ${secret}` };
      }
      return result;
    };

    const report = await runBootstrap({
      argv: ["--json"],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {
        TSUGITE_TEST_TOKEN: secret,
        COOKIE_VALUE: secret,
        NORMAL_SETTING: "visible"
      },
      runCommand: runner
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain("[REDACTED]");
    expect(await readFile(join(root, ".tsugite", "setup-report.json"), "utf8")).not.toContain(secret);
  });

  it("parses supported flags and rejects contradictory modes", () => {
    expect(parseBootstrapArgs(["--open", "--json"])).toMatchObject({
      ok: true,
      mode: "open",
      json: true
    });
    expect(parseBootstrapArgs(["--check", "--open"])).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "bootstrap.arguments_conflict" })]
    });
    expect(parseBootstrapArgs(["--unknown"])).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "bootstrap.argument_unknown" })]
    });
    const secret = "do-not-print-this-secret";
    expect(JSON.stringify(parseBootstrapArgs([`--api-key=${secret}`]))).not.toContain(secret);
  });

  it("formats a concise Japanese summary with unavailable provider capabilities", async () => {
    const root = await createRepositoryFixture();
    const report = await runBootstrap({
      argv: ["--check"],
      cwd: root,
      nodeVersion: "v22.12.0",
      platform: "darwin",
      environment: {},
      runCommand: createSuccessfulRunner([])
    });

    expect(formatHumanReport(report)).toContain("継手の初回セットアップ確認");
    expect(formatHumanReport(report)).toContain("動画生成サービスへの接続");
    expect(formatHumanReport(report)).toContain("課金や認証は実行していません");
  });
});

async function createRepositoryFixture(prefix = "tsugite bootstrap "): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "workflow-viewer"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "tsugite"), { recursive: true });
  await mkdir(join(root, "examples", "quickstart-local", "media"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tsugite", version: "0.6.0" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "apps", "workflow-viewer", "package.json"), "{}");
  await writeFile(join(root, "apps", "workflow-viewer", "package-lock.json"), "{}");
  await writeFile(join(root, "bin", "pipeline"), "#!/usr/bin/env node");
  await writeFile(join(root, "AGENTS.md"), "# fixture");
  await writeFile(join(root, ".agents", "skills", "tsugite", "SKILL.md"), "# fixture");
  await writeFile(
    join(root, "examples", "quickstart-local", "project.yaml"),
    "slug: quickstart-local\nname: はじめての継手\nrun_id: quickstart-local-run\nmanifest: manifest.json\ndist_dir: dist\nedit:\n  backend: remotion\n"
  );
  await writeFile(
    join(root, "examples", "quickstart-local", "manifest.json"),
    JSON.stringify({
      meta: {
        aspect: "16:9",
        fps: 30,
        target_duration_seconds: 2,
        slug: "quickstart-local"
      },
      clips: [],
      audio: { bgm: [], narration: [], sfx: [] },
      captions: [],
      provenance: []
    })
  );
  await writeFile(
    join(root, "examples", "quickstart-local", ".tsugite-bootstrap.json"),
    JSON.stringify({ schema_version: 1, template: "quickstart-local" })
  );
  await writeFile(join(root, "examples", "quickstart-local", "media", "clip.mp4"), "fixture");
  return root;
}

function createSuccessfulRunner(
  commands: BootstrapCommand[],
  options: {
    npmVersion?: string;
    missingCommand?: string;
    failCommand?: string;
    originUrl?: string;
  } = {}
) {
  return async (command: BootstrapCommand): Promise<BootstrapCommandResult> => {
    commands.push({
      ...command,
      args: [...command.args]
    });
    const line = commandLine(command);
    if (command.command === options.missingCommand) {
      return { status: 127, stdout: "", stderr: "command not found" };
    }
    if (options.failCommand && line.startsWith(options.failCommand)) {
      return { status: 1, stdout: "", stderr: "simulated failure" };
    }
    if (line === "git --version") {
      return { status: 0, stdout: "git version 2.50.0", stderr: "" };
    }
    if (line === "git remote get-url origin") {
      return {
        status: 0,
        stdout: options.originUrl ?? "https://github.com/Takamasa045/tsugite.git",
        stderr: ""
      };
    }
    if (line === "npm --version") {
      return { status: 0, stdout: options.npmVersion ?? "10.9.8", stderr: "" };
    }
    if (line === "ffmpeg -version") {
      return { status: 0, stdout: "ffmpeg version 7.1", stderr: "" };
    }
    if (line === "ffprobe -version") {
      return { status: 0, stdout: "ffprobe version 7.1", stderr: "" };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
  };
}

function commandLine(command: BootstrapCommand): string {
  const executable = command.command === process.execPath
    ? "node"
    : command.command.replace(/\.(cmd|exe)$/i, "");
  return [executable, ...command.args].join(" ");
}
