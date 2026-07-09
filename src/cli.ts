import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDryRun, createPlan } from "./orchestrator/plan.js";
import { renderAssembledMedia } from "./orchestrator/render.js";
import { assembleLocalMediaRun } from "./orchestrator/run.js";
import {
  createPlannedState,
  markGateAwaiting,
  readState,
  recordGateDecision,
  writeState,
  type GateDecision,
  type GateId,
  type RunState
} from "./orchestrator/state.js";
import { validateProject } from "./project/validateProject.js";
import type { Project } from "./project/schema.js";
import type { Issue, Result } from "./types.js";

type ParsedArgs = {
  command: string;
  config?: string;
  json: boolean;
  dryRun: boolean;
  actor?: string;
  gate?: string;
  decision?: string;
  stateDir?: string;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args.command) {
    return output(args, 1, { ok: false, issues: [{ code: "cli.command_missing", message: "command is required" }] });
  }

  if (args.command === "doctor") {
    return output(args, 0, {
      ok: true,
      command: "doctor",
      checks: [{ name: "node", ok: true, version: process.version }]
    });
  }

  if (!args.config) {
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: [{ code: "cli.config_missing", message: "--config is required" }]
    });
  }

  const validation = await validateProject(args.config);
  if (args.command === "validate") {
    return output(args, validation.ok ? 0 : 1, {
      ok: validation.ok,
      command: "validate",
      issues: validation.issues
    });
  }

  if (!validation.ok) {
    return output(args, 1, {
      ok: false,
      command: args.command,
      issues: validation.issues
    });
  }

  if (args.command === "plan") {
    return output(args, 0, {
      ok: true,
      command: "plan",
      plan: createPlan(validation.project!, validation.manifest!, validation.adapter)
    });
  }

  if (args.command === "run" && args.dryRun) {
    return output(args, 0, {
      ok: true,
      command: "run",
      dry_run: createDryRun(validation.project!, validation.manifest!, validation.adapter, validation.backend)
    });
  }

  if (args.command === "gate") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "gate", issues: [coordinatorIssue] });

    const gate = parseGate(args.gate);
    const decision = parseDecision(args.decision);
    const issues = [
      ...(gate ? [] : [{ code: "cli.gate_missing", message: "--gate must be gate-1, gate-2, or gate-3" }]),
      ...(decision ? [] : [{ code: "cli.decision_missing", message: "--decision must be approve, revise, or abort" }])
    ];
    if (issues.length > 0) return output(args, 1, { ok: false, command: "gate", issues });

    const gateResult = await recordGate(args, validation.project!, gate!, decision!);
    return output(args, gateResult.ok ? 0 : 1, {
      ok: gateResult.ok,
      command: "gate",
      issues: gateResult.issues,
      state: gateResult.state,
      state_path: gateResult.statePath
    });
  }

  if (args.command === "run") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "run", issues: [coordinatorIssue] });

    const stateResult = await loadState(args, validation.project!, { allowMissing: true });
    if (!stateResult.ok) return output(args, 1, { ok: false, command: "run", issues: stateResult.issues });

    if (!stateResult.state || stateResult.state.gates.gate_1.status !== "approved") {
      return output(args, 1, {
        ok: false,
        command: "run",
        issues: [{ code: "run.requires_gate_1_approval", message: "Gate 1 must be approved before run" }]
      });
    }

    const runResult = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: resolve(dirname(resolve(args.config!)), validation.project!.manifest),
      stateDir: stateResult.stateDir,
      state: stateResult.state
    });
    return output(args, runResult.ok ? 0 : 1, {
      ok: runResult.ok,
      command: "run",
      issues: runResult.issues,
      manifest_path: runResult.manifestPath,
      asset_count: runResult.assetCount,
      already_assembled: runResult.alreadyAssembled,
      state: runResult.state,
      state_path: runResult.statePath
    });
  }

  if (args.command === "render") {
    const coordinatorIssue = requireCoordinator(args);
    if (coordinatorIssue) return output(args, 1, { ok: false, command: "render", issues: [coordinatorIssue] });

    const stateResult = await loadState(args, validation.project!, { allowMissing: true });
    if (!stateResult.ok) return output(args, 1, { ok: false, command: "render", issues: stateResult.issues });

    if (!stateResult.state || stateResult.state.gates.gate_2.status !== "approved") {
      return output(args, 1, {
        ok: false,
        command: "render",
        issues: [{ code: "render.requires_gate_2_approval", message: "Gate 2 must be approved before render" }]
      });
    }

    const renderResult = await renderAssembledMedia(validation.project!, {
      stateDir: stateResult.stateDir,
      state: stateResult.state
    });
    return output(args, renderResult.ok ? 0 : 1, {
      ok: renderResult.ok,
      command: "render",
      issues: renderResult.issues,
      output_path: renderResult.outputPath,
      report_path: renderResult.reportPath,
      already_rendered: renderResult.alreadyRendered,
      state: renderResult.state,
      state_path: renderResult.statePath
    });
  }

  return output(args, 1, {
    ok: false,
    command: args.command,
    issues: [{ code: "cli.command_unknown", message: `unknown command '${args.command}'` }]
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? "",
    json: false,
    dryRun: false
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") parsed.config = argv[++index];
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--actor") parsed.actor = argv[++index];
    else if (arg === "--gate") parsed.gate = argv[++index];
    else if (arg === "--decision") parsed.decision = argv[++index];
    else if (arg === "--state-dir") parsed.stateDir = argv[++index];
  }

  return parsed;
}

function requireCoordinator(args: ParsedArgs): Issue | undefined {
  if (args.actor === "coordinator") return undefined;
  return {
    code: "cli.coordinator_required",
    message: "this command requires --actor coordinator"
  };
}

async function recordGate(
  args: ParsedArgs,
  project: Project,
  gate: GateId,
  decision: GateDecision
): Promise<Result<{ state: RunState; statePath: string }>> {
  const stateLocation = getStateLocation(args, project);
  const existing = await loadState(args, project, { allowMissing: gate === "gate_1" });
  if (!existing.ok) return existing;

  let state = existing.state ?? createPlannedState(project.run_id ?? project.slug);
  if (gate === "gate_1" && (state.gates.gate_1.status === "pending" || state.gates.gate_1.status === "revise")) {
    state = markGateAwaiting(state, "gate_1");
  }

  try {
    const nextState = recordGateDecision(state, gate, decision);
    await writeState(stateLocation.stateDir, nextState);
    return { ok: true, issues: [], state: nextState, statePath: stateLocation.statePath };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "state.gate_invalid", message: error instanceof Error ? error.message : String(error) }],
      state,
      statePath: stateLocation.statePath
    };
  }
}

async function loadState(
  args: ParsedArgs,
  project: Project,
  options: { allowMissing?: boolean } = {}
): Promise<Result<{ state?: RunState; statePath: string; stateDir: string }>> {
  const location = getStateLocation(args, project);

  try {
    const state = await readState(location.statePath);
    const runId = project.run_id ?? project.slug;
    if (state.run_id !== runId) {
      return {
        ok: false,
        issues: [
          {
            code: "state.run_id_mismatch",
            message: `state run_id '${state.run_id}' does not match project run_id '${runId}'`,
            path: location.statePath
          }
        ],
        statePath: location.statePath,
        stateDir: location.stateDir
      };
    }
    return { ok: true, issues: [], state, statePath: location.statePath, stateDir: location.stateDir };
  } catch (error) {
    if (options.allowMissing && isMissingFile(error)) {
      return {
        ok: true,
        issues: [],
        statePath: location.statePath,
        stateDir: location.stateDir
      };
    }

    return {
      ok: false,
      issues: [
        {
          code: isMissingFile(error) ? "state.not_found" : "state.invalid",
          message: error instanceof Error ? error.message : String(error),
          path: location.statePath
        }
      ],
      statePath: location.statePath,
      stateDir: location.stateDir
    };
  }
}

function getStateLocation(args: ParsedArgs, project: Project): { stateDir: string; statePath: string } {
  const stateDir = args.stateDir
    ? resolve(args.stateDir)
    : resolve(dirname(resolve(args.config!)), project.dist_dir);
  const runId = project.run_id ?? project.slug;
  return {
    stateDir,
    statePath: join(stateDir, runId, "state.json")
  };
}

function parseGate(value: string | undefined): GateId | undefined {
  if (value === "gate-1" || value === "gate_1") return "gate_1";
  if (value === "gate-2" || value === "gate_2") return "gate_2";
  if (value === "gate-3" || value === "gate_3") return "gate_3";
  return undefined;
}

function parseDecision(value: string | undefined): GateDecision | undefined {
  if (value === "approve" || value === "approved") return "approved";
  if (value === "revise") return "revise";
  if (value === "abort") return "abort";
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function output(args: ParsedArgs, status: number, payload: unknown): number {
  const text = args.json ? JSON.stringify(payload, null, 2) : formatHuman(payload);
  if (status === 0) console.log(text);
  else console.error(text);
  return status;
}

function formatHuman(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const status = await main();
  process.exit(status);
}
