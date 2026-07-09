import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDryRun, createPlan } from "./orchestrator/plan.js";
import { validateProject } from "./project/validateProject.js";

type ParsedArgs = {
  command: string;
  config?: string;
  json: boolean;
  dryRun: boolean;
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
      dry_run: createDryRun(validation.project!, validation.manifest!, validation.adapter)
    });
  }

  if (args.command === "run") {
    return output(args, 1, {
      ok: false,
      command: "run",
      issues: [
        {
          code: "run.requires_explicit_gate",
          message: "non-dry-run execution is intentionally blocked in Phase 0"
        }
      ]
    });
  }

  if (args.command === "render") {
    return output(args, 1, {
      ok: false,
      command: "render",
      issues: [{ code: "render.not_implemented", message: "render is scheduled for Phase 1" }]
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
  }

  return parsed;
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
