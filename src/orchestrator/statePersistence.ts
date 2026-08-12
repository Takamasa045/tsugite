/**
 * Run state read/write/parse persistence.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultGates, gateInvariantError } from "./stateTransitions.js";
import type { RunState } from "./stateTypes.js";

export const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const gateStateSchema = z.object({
  status: z.union([
    z.literal("pending"),
    z.literal("awaiting_approval"),
    z.literal("approved"),
    z.literal("revise"),
    z.literal("abort")
  ]),
  updated_at: z.string().optional(),
  approved_input_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Optional for backward parsing of state written before person-QA binding digests.
  person_qa_approval_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  decision_source: z.union([z.literal("human"), z.literal("auto_qc")]).optional(),
  // Additive PO-5 production-control subject/decision digests (legacy fields unchanged).
  production_subject_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  production_decision_digest: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

const runStateSchema = z.object({
  run_id: safeIdSchema,
  status: z.union([
    z.literal("planned"),
    z.literal("awaiting_gate_1"),
    z.literal("dry_run"),
    z.literal("running"),
    z.literal("awaiting_gate_2"),
    z.literal("rendering"),
    z.literal("awaiting_gate_3"),
    z.literal("completed"),
    z.literal("aborted")
  ]),
  updated_at: z.string().min(1),
  gates: z
    .object({
      gate_1: gateStateSchema,
      gate_2: gateStateSchema,
      gate_3: gateStateSchema
    })
    .default(defaultGates)
});

export async function writeState(distDir: string, state: RunState): Promise<string> {
  const parsedState = parseRunState(state);
  const runDir = join(distDir, parsedState.run_id);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "state.json");
  const temporaryPath = join(runDir, `.state.json.${process.pid}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(parsedState, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      const directoryHandle = await open(runDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    return path;
  } finally {
    try {
      await handle?.close();
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function readState(path: string): Promise<RunState> {
  return parseRunState(JSON.parse(await readFile(path, "utf8")));
}

export function parseRunState(input: unknown): RunState {
  const state = runStateSchema.parse(input);
  const invariantError = gateInvariantError(state);
  if (invariantError) {
    throw new Error(`invalid run state: ${invariantError}`);
  }
  return state;
}
