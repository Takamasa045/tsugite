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

/**
 * Canonical Gate semantic fingerprint.
 * Explicitly binds GateBundle/decision/approval, Gate2 selected completion, and Gate3 final SHA.
 * Does not change legacy approved_input_digest storage semantics on RunState.
 */
export function gateSemanticFingerprint(state: RunState): string {
  const g1 = state.gates.gate_1;
  const g2 = state.gates.gate_2;
  const g3 = state.gates.gate_3;
  return JSON.stringify({
    run_status: state.status,
    gate_1: {
      status: g1.status,
      // Legacy review subject (unchanged semantics)
      legacy_approved_input_digest: g1.approved_input_digest ?? null,
      // GateBundle subject + human decision + optional person-QA approval binding
      gate_bundle_subject_digest: g1.production_subject_digest ?? null,
      decision_digest: g1.production_decision_digest ?? null,
      approval_binding_digest: g1.person_qa_approval_digest ?? null,
      person_qa_approval_digest: g1.person_qa_approval_digest ?? null,
      decision_source: g1.decision_source ?? null,
      production_subject_digest: g1.production_subject_digest ?? null,
      production_decision_digest: g1.production_decision_digest ?? null
    },
    gate_2: {
      status: g2.status,
      // Selected completion / QC+manifest subject (legacy approved_input_digest for Gate2)
      selected_completion_digest: g2.approved_input_digest ?? null,
      legacy_approved_input_digest: g2.approved_input_digest ?? null,
      production_subject_digest: g2.production_subject_digest ?? null,
      production_decision_digest: g2.production_decision_digest ?? null,
      decision_digest: g2.production_decision_digest ?? null,
      approval_binding_digest: g2.person_qa_approval_digest ?? null,
      person_qa_approval_digest: g2.person_qa_approval_digest ?? null,
      decision_source: g2.decision_source ?? null
    },
    gate_3: {
      status: g3.status,
      // Final output SHA-256 (legacy approved_input_digest for Gate3)
      final_output_sha256: g3.approved_input_digest ?? null,
      legacy_approved_input_digest: g3.approved_input_digest ?? null,
      production_subject_digest: g3.production_subject_digest ?? null,
      production_decision_digest: g3.production_decision_digest ?? null,
      decision_digest: g3.production_decision_digest ?? null,
      approval_binding_digest: g3.person_qa_approval_digest ?? null,
      person_qa_approval_digest: g3.person_qa_approval_digest ?? null,
      decision_source: g3.decision_source ?? null
    }
  });
}

export function gateSemanticsChanged(previous: RunState | undefined, next: RunState): boolean {
  if (!previous) return true;
  return gateSemanticFingerprint(previous) !== gateSemanticFingerprint(next);
}

export async function writeState(
  distDir: string,
  state: RunState,
  options?: {
    /** Optional RC effect policy — gates mutation only when decision fields change. */
    effect_policy?: import("../productionControl/rc/effectCapability.js").EffectPolicy;
    previous?: RunState;
  }
): Promise<string> {
  if (options?.effect_policy) {
    const {
      noteEffectBoundary,
      registerEffectBoundary
    } = await import("../productionControl/rc/effectCapability.js");
    // Real production boundary wrapper registers itself (no fixture bulk-arm).
    registerEffectBoundary(options.effect_policy, "gate_mutation");
    if (gateSemanticsChanged(options.previous, state)) {
      noteEffectBoundary(options.effect_policy, "gate_mutation", "orchestrator.writeState");
    }
  }
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
