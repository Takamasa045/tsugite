/**
 * Durable Gate decision + phase evidence for live subject recompute.
 * Phase checks recompute expected subjects from these artifacts + GateBundle,
 * never by comparing stored production digests to themselves.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { RunState } from "../orchestrator/stateTypes.js";
import { sha256Canonical } from "./canonical.js";
import { pcError, type ProductionControlError } from "./errors.js";
import {
  parseGenerationCompletionRef,
  type GenerationCompletionRef
} from "./generationBridge.js";
import {
  loadDurableGateBundle,
  buildActiveGate1ProductionBinding,
  buildActiveGate2ProductionBinding,
  buildActiveGate3ProductionBinding,
  cascadeRunStateFromDrift
} from "./activePipeline.js";
import {
  gateDecisionDigest,
  type GateCascade,
  type GateDriftKind,
  type LiveGateSubjects
} from "./gateSubjects.js";
import {
  humanDecisionRefSchema,
  type HumanDecisionRef,
  type ProductionControlMode
} from "./schema.js";
import { parseGateBundle, type GateBundle } from "./gateBundle.js";

export type { LiveGateSubjects };

export type LiveActiveSubjectsPhaseResult =
  | {
      ok: true;
      expected: LiveGateSubjects;
      cascadeKinds: [];
    }
  | {
      ok: false;
      expected: LiveGateSubjects;
      cascadeKinds: GateDriftKind[];
      cascadedState: RunState;
      cascade: GateCascade;
      error: ProductionControlError;
    };

const PC_DIR = "production-control";

function decisionPath(runDir: string, gate: "gate_1" | "gate_2" | "gate_3"): string {
  return join(runDir, PC_DIR, `${gate}-decision.json`);
}

function completionsPath(runDir: string): string {
  return join(runDir, PC_DIR, "selected-completion-refs.json");
}

function gate2EvidencePath(runDir: string): string {
  return join(runDir, PC_DIR, "gate-2-evidence.json");
}

function gate3EvidencePath(runDir: string): string {
  return join(runDir, PC_DIR, "gate-3-evidence.json");
}

function coordinatorPrincipalPath(runDir: string): string {
  return join(runDir, PC_DIR, "coordinator-principal.json");
}

export type DurableGateDecisionRecord = {
  schema_version: 1;
  gate: "gate_1" | "gate_2" | "gate_3";
  decision: HumanDecisionRef;
  decision_digest: string;
  decision_source: "human" | "auto_qc";
  legacy_approved_input_digest?: string;
};

export type DurableGate2Evidence = {
  schema_version: 1;
  kind: "gate-2-evidence";
  gate_bundle_digest: string;
  gate_1_decision_digest: string;
  selected_generation_completion_digests: string[];
  manifest_digest: string;
  technical_qa_digest: string;
  semantic_qa_digest?: string;
  identity_verification_report_digest?: string;
  resolved_composition_plan_digest?: string;
  digest: string;
};

export type DurableGate3Evidence = {
  schema_version: 1;
  kind: "gate-3-evidence";
  gate_2_decision_digest: string;
  gate_2_subject_digest: string;
  final_artifact_sha256: string;
  render_report_digest: string;
  gate_3_qc_digest: string;
  selected_branch_digest: string;
  resolved_composition_plan_digest?: string;
  digest: string;
};

export type DurableCoordinatorPrincipal = {
  schema_version: 1;
  kind: "coordinator-principal";
  actor: "coordinator";
  /** Digest of the verified Gate1 human decision that established coordinator authority. */
  gate_1_decision_digest: string;
  /** Digest of the durable principal body (excludes this field). */
  digest: string;
};

function gate2EvidenceDigest(body: Omit<DurableGate2Evidence, "digest">): string {
  return sha256Canonical(body);
}

function gate3EvidenceDigest(body: Omit<DurableGate3Evidence, "digest">): string {
  return sha256Canonical(body);
}

function coordinatorPrincipalDigest(
  body: Omit<DurableCoordinatorPrincipal, "digest">
): string {
  return sha256Canonical(body);
}

export async function writeDurableGateDecision(
  runDir: string,
  record: Omit<DurableGateDecisionRecord, "schema_version" | "decision_digest"> & {
    decision_digest?: string;
  }
): Promise<string> {
  const decision = humanDecisionRefSchema.parse(record.decision);
  const decision_digest = record.decision_digest ?? gateDecisionDigest(decision);
  const full: DurableGateDecisionRecord = {
    schema_version: 1,
    gate: record.gate,
    decision,
    decision_digest,
    decision_source: record.decision_source,
    ...(record.legacy_approved_input_digest
      ? { legacy_approved_input_digest: record.legacy_approved_input_digest }
      : {})
  };
  const dir = join(runDir, PC_DIR);
  await mkdir(dir, { recursive: true });
  const path = decisionPath(runDir, record.gate);
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return path;
}

export async function loadDurableGateDecision(
  runDir: string,
  gate: "gate_1" | "gate_2" | "gate_3"
): Promise<DurableGateDecisionRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(decisionPath(runDir, gate), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const rec = raw as DurableGateDecisionRecord;
    const decision = humanDecisionRefSchema.parse(rec.decision);
    const decision_digest = gateDecisionDigest(decision);
    if (rec.decision_digest && rec.decision_digest !== decision_digest) {
      throw pcError("PC_GATE_SUBJECT_STALE", `${gate} durable decision digest mismatch`);
    }
    return {
      schema_version: 1,
      gate,
      decision,
      decision_digest,
      decision_source: rec.decision_source === "auto_qc" ? "auto_qc" : "human",
      ...(rec.legacy_approved_input_digest
        ? { legacy_approved_input_digest: rec.legacy_approved_input_digest }
        : {})
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return undefined;
  }
}

export async function writeDurableSelectedCompletions(
  runDir: string,
  refs: readonly GenerationCompletionRef[]
): Promise<string> {
  const parsed = refs.map((ref) => parseGenerationCompletionRef(ref));
  const dir = join(runDir, PC_DIR);
  await mkdir(dir, { recursive: true });
  const path = completionsPath(runDir);
  await writeFile(
    path,
    `${JSON.stringify({ schema_version: 1, completions: parsed }, null, 2)}\n`,
    "utf8"
  );
  return path;
}

export async function loadDurableSelectedCompletions(
  runDir: string
): Promise<GenerationCompletionRef[]> {
  try {
    const raw = JSON.parse(await readFile(completionsPath(runDir), "utf8")) as {
      completions?: unknown[];
    };
    if (!Array.isArray(raw.completions)) return [];
    return raw.completions.map((item) => parseGenerationCompletionRef(item));
  } catch {
    return [];
  }
}

export async function writeDurableGate2Evidence(
  runDir: string,
  evidence: Omit<DurableGate2Evidence, "schema_version" | "kind" | "digest">
): Promise<DurableGate2Evidence> {
  const body = {
    schema_version: 1 as const,
    kind: "gate-2-evidence" as const,
    ...evidence,
    selected_generation_completion_digests: [
      ...evidence.selected_generation_completion_digests
    ]
  };
  const full: DurableGate2Evidence = {
    ...body,
    digest: gate2EvidenceDigest(body)
  };
  const dir = join(runDir, PC_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(gate2EvidencePath(runDir), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return full;
}

export async function loadDurableGate2Evidence(
  runDir: string
): Promise<DurableGate2Evidence | undefined> {
  try {
    const raw = JSON.parse(await readFile(gate2EvidencePath(runDir), "utf8")) as DurableGate2Evidence;
    const body = {
      schema_version: 1 as const,
      kind: "gate-2-evidence" as const,
      gate_bundle_digest: raw.gate_bundle_digest,
      gate_1_decision_digest: raw.gate_1_decision_digest,
      selected_generation_completion_digests: [
        ...raw.selected_generation_completion_digests
      ],
      manifest_digest: raw.manifest_digest,
      technical_qa_digest: raw.technical_qa_digest,
      ...(raw.semantic_qa_digest ? { semantic_qa_digest: raw.semantic_qa_digest } : {}),
      ...(raw.identity_verification_report_digest
        ? { identity_verification_report_digest: raw.identity_verification_report_digest }
        : {}),
      ...(raw.resolved_composition_plan_digest
        ? { resolved_composition_plan_digest: raw.resolved_composition_plan_digest }
        : {})
    };
    const digest = gate2EvidenceDigest(body);
    if (raw.digest !== digest) {
      throw pcError("PC_GATE_SUBJECT_STALE", "Gate 2 durable evidence digest mismatch");
    }
    return { ...body, digest };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return undefined;
  }
}

export async function writeDurableGate3Evidence(
  runDir: string,
  evidence: Omit<DurableGate3Evidence, "schema_version" | "kind" | "digest">
): Promise<DurableGate3Evidence> {
  const body = {
    schema_version: 1 as const,
    kind: "gate-3-evidence" as const,
    ...evidence
  };
  const full: DurableGate3Evidence = {
    ...body,
    digest: gate3EvidenceDigest(body)
  };
  const dir = join(runDir, PC_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(gate3EvidencePath(runDir), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return full;
}

export async function loadDurableGate3Evidence(
  runDir: string
): Promise<DurableGate3Evidence | undefined> {
  try {
    const raw = JSON.parse(await readFile(gate3EvidencePath(runDir), "utf8")) as DurableGate3Evidence;
    const body = {
      schema_version: 1 as const,
      kind: "gate-3-evidence" as const,
      gate_2_decision_digest: raw.gate_2_decision_digest,
      gate_2_subject_digest: raw.gate_2_subject_digest,
      final_artifact_sha256: raw.final_artifact_sha256,
      render_report_digest: raw.render_report_digest,
      gate_3_qc_digest: raw.gate_3_qc_digest,
      selected_branch_digest: raw.selected_branch_digest,
      ...(raw.resolved_composition_plan_digest
        ? { resolved_composition_plan_digest: raw.resolved_composition_plan_digest }
        : {})
    };
    const digest = gate3EvidenceDigest(body);
    if (raw.digest !== digest) {
      throw pcError("PC_GATE_SUBJECT_STALE", "Gate 3 durable evidence digest mismatch");
    }
    return { ...body, digest };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return undefined;
  }
}

export async function writeDurableCoordinatorPrincipal(
  runDir: string,
  input: { gate_1_decision_digest: string }
): Promise<DurableCoordinatorPrincipal> {
  const body = {
    schema_version: 1 as const,
    kind: "coordinator-principal" as const,
    actor: "coordinator" as const,
    gate_1_decision_digest: input.gate_1_decision_digest
  };
  const full: DurableCoordinatorPrincipal = {
    ...body,
    digest: coordinatorPrincipalDigest(body)
  };
  const dir = join(runDir, PC_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    coordinatorPrincipalPath(runDir),
    `${JSON.stringify(full, null, 2)}\n`,
    "utf8"
  );
  return full;
}

export async function loadDurableCoordinatorPrincipal(
  runDir: string
): Promise<DurableCoordinatorPrincipal | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(coordinatorPrincipalPath(runDir), "utf8")
    ) as DurableCoordinatorPrincipal;
    if (raw.actor !== "coordinator" || raw.kind !== "coordinator-principal") {
      return undefined;
    }
    const body = {
      schema_version: 1 as const,
      kind: "coordinator-principal" as const,
      actor: "coordinator" as const,
      gate_1_decision_digest: raw.gate_1_decision_digest
    };
    const digest = coordinatorPrincipalDigest(body);
    if (raw.digest !== digest) {
      throw pcError("PC_AUTHORITY_DENIED", "coordinator principal digest mismatch");
    }
    return { ...body, digest };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return undefined;
  }
}

export async function sha256FileContents(path: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

/**
 * Recompute expected Gate subjects/decisions from durable evidence immediately
 * before run / render / finalize. Does not accept stored production digests as expected.
 */
export async function recomputeExpectedSubjectsFromDurableEvidence(input: {
  phase: "run" | "render" | "finalize";
  runDir: string;
  state: RunState;
  production_id: string;
  /** Live GateBundle when already loaded; otherwise loaded from durable path. */
  gate_bundle?: GateBundle;
}): Promise<LiveGateSubjects> {
  const loaded = input.gate_bundle ?? (await loadDurableGateBundle(input.runDir));
  if (!loaded) {
    throw pcError("PC_GATE_BUNDLE_INVALID", "active phase requires durable GateBundle");
  }
  const bundle = parseGateBundle(loaded);

  const gate1Decision = await loadDurableGateDecision(input.runDir, "gate_1");
  if (!gate1Decision) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 1 durable HumanDecisionRef is missing");
  }
  const legacyG1 =
    gate1Decision.legacy_approved_input_digest
    ?? input.state.gates.gate_1.approved_input_digest;
  if (!legacyG1) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 1 legacy approved_input_digest is missing");
  }

  const g1 = buildActiveGate1ProductionBinding({
    production_id: input.production_id,
    run_id: input.state.run_id,
    gate_bundle: bundle,
    legacy_approved_input_digest: legacyG1,
    decision: {
      decision_id: gate1Decision.decision.decision_id,
      decision: gate1Decision.decision.decision,
      actor: gate1Decision.decision.actor,
      decided_at: gate1Decision.decision.decided_at,
      ...(gate1Decision.decision.reason ? { reason: gate1Decision.decision.reason } : {})
    }
  });
  // Decision digest must match the durable decision artifact exactly.
  if (g1.decision_digest !== gate1Decision.decision_digest) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 1 decision digest does not match durable HumanDecisionRef"
    );
  }

  const expected: LiveGateSubjects = {
    gate_1_subject_digest: g1.subject_digest,
    gate_1_decision_digest: g1.decision_digest
  };

  if (input.phase === "run") return expected;

  const g2Evidence = await loadDurableGate2Evidence(input.runDir);
  const gate2Decision = await loadDurableGateDecision(input.runDir, "gate_2");
  if (!g2Evidence || !gate2Decision) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "Gate 2 durable evidence and HumanDecisionRef are required before render/finalize"
    );
  }
  // Completions: prefer pinned durable refs; evidence digests must match.
  const completions = await loadDurableSelectedCompletions(input.runDir);
  const completionDigests = completions.map((ref) => ref.digest).sort();
  const evidenceCompletions = [...g2Evidence.selected_generation_completion_digests].sort();
  if (JSON.stringify(completionDigests) !== JSON.stringify(evidenceCompletions)) {
    // Empty both is allowed only when no generation completions were selected.
    if (!(completionDigests.length === 0 && evidenceCompletions.length === 0)) {
      throw pcError(
        "PC_GATE_SUBJECT_STALE",
        "Gate 2 selected completion digests drifted from durable CompletionRefs"
      );
    }
  }
  if (g2Evidence.gate_1_decision_digest !== g1.decision_digest) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 2 evidence Gate 1 decision digest mismatch");
  }
  if (g2Evidence.gate_bundle_digest !== bundle.digest) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 2 evidence GateBundle digest mismatch");
  }

  const g2 = buildActiveGate2ProductionBinding({
    gate_1_decision_digest: g2Evidence.gate_1_decision_digest,
    gate_bundle_digest: g2Evidence.gate_bundle_digest,
    selected_generation_completion_digests: g2Evidence.selected_generation_completion_digests,
    manifest_digest: g2Evidence.manifest_digest,
    technical_qa_digest: g2Evidence.technical_qa_digest,
    ...(g2Evidence.semantic_qa_digest
      ? { semantic_qa_digest: g2Evidence.semantic_qa_digest }
      : {}),
    ...(g2Evidence.identity_verification_report_digest
      ? { identity_verification_report_digest: g2Evidence.identity_verification_report_digest }
      : {}),
    ...(g2Evidence.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: g2Evidence.resolved_composition_plan_digest }
      : {}),
    decision: {
      decision_id: gate2Decision.decision.decision_id,
      decision: gate2Decision.decision.decision,
      actor: gate2Decision.decision.actor,
      decided_at: gate2Decision.decision.decided_at,
      ...(gate2Decision.decision.reason ? { reason: gate2Decision.decision.reason } : {})
    },
    decision_source: gate2Decision.decision_source,
    ...(gate2Decision.legacy_approved_input_digest
      ? { legacy_approved_input_digest: gate2Decision.legacy_approved_input_digest }
      : {})
  });
  if (g2.decision_digest !== gate2Decision.decision_digest) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 2 decision digest does not match durable HumanDecisionRef"
    );
  }
  expected.gate_2_subject_digest = g2.subject_digest;
  expected.gate_2_decision_digest = g2.decision_digest;

  if (input.phase === "render") return expected;

  const g3Evidence = await loadDurableGate3Evidence(input.runDir);
  const gate3Decision = await loadDurableGateDecision(input.runDir, "gate_3");
  if (!g3Evidence || !gate3Decision) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "Gate 3 durable evidence and HumanDecisionRef are required before finalize"
    );
  }
  if (g3Evidence.gate_2_decision_digest !== g2.decision_digest) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 3 evidence Gate 2 decision digest mismatch");
  }
  if (g3Evidence.gate_2_subject_digest !== g2.subject_digest) {
    throw pcError("PC_GATE_SUBJECT_STALE", "Gate 3 evidence Gate 2 subject digest mismatch");
  }

  const g3 = buildActiveGate3ProductionBinding({
    gate_2_decision_digest: g3Evidence.gate_2_decision_digest,
    gate_2_subject_digest: g3Evidence.gate_2_subject_digest,
    final_artifact_sha256: g3Evidence.final_artifact_sha256,
    render_report_digest: g3Evidence.render_report_digest,
    gate_3_qc_digest: g3Evidence.gate_3_qc_digest,
    selected_branch_digest: g3Evidence.selected_branch_digest,
    ...(g3Evidence.resolved_composition_plan_digest
      ? { resolved_composition_plan_digest: g3Evidence.resolved_composition_plan_digest }
      : {}),
    decision: {
      decision_id: gate3Decision.decision.decision_id,
      decision: gate3Decision.decision.decision,
      actor: gate3Decision.decision.actor,
      decided_at: gate3Decision.decision.decided_at,
      ...(gate3Decision.decision.reason ? { reason: gate3Decision.decision.reason } : {})
    },
    ...(gate3Decision.legacy_approved_input_digest
      ? { legacy_approved_input_digest: gate3Decision.legacy_approved_input_digest }
      : {})
  });
  if (g3.decision_digest !== gate3Decision.decision_digest) {
    throw pcError(
      "PC_GATE_SUBJECT_STALE",
      "recomputed Gate 3 decision digest does not match durable HumanDecisionRef"
    );
  }
  expected.gate_3_subject_digest = g3.subject_digest;
  expected.gate_3_decision_digest = g3.decision_digest;
  return expected;
}

/**
 * Live phase gate: recompute expected from durable evidence, compare to stored state,
 * cascade on drift. Never passes stored production digests as expected.
 *
 * On drift, returns a structured cascade result (does not discard) so the CLI /
 * Coordinator can persist cascaded RunState atomically under the serial state
 * boundary before reporting the error. Callers that want throw-only may use
 * assertLiveActiveSubjectsBeforePhaseOrThrow.
 */
export async function assertLiveActiveSubjectsBeforePhase(input: {
  mode: ProductionControlMode | undefined;
  phase: "run" | "render" | "finalize";
  runDir: string;
  state: RunState;
  production_id: string;
  gate_bundle?: GateBundle;
}): Promise<LiveActiveSubjectsPhaseResult> {
  if (input.mode !== "active") {
    return { ok: true, expected: {}, cascadeKinds: [] };
  }
  const expected = await recomputeExpectedSubjectsFromDurableEvidence({
    phase: input.phase,
    runDir: input.runDir,
    state: input.state,
    production_id: input.production_id,
    ...(input.gate_bundle ? { gate_bundle: input.gate_bundle } : {})
  });

  const cascadeKinds: GateDriftKind[] = [];
  const g1s = input.state.gates.gate_1.production_subject_digest;
  const g1d = input.state.gates.gate_1.production_decision_digest;
  if (
    !g1s
    || !g1d
    || g1s !== expected.gate_1_subject_digest
    || g1d !== expected.gate_1_decision_digest
  ) {
    cascadeKinds.push("compilation");
  }

  if (input.phase === "render" || input.phase === "finalize") {
    const g2s = input.state.gates.gate_2.production_subject_digest;
    const g2d = input.state.gates.gate_2.production_decision_digest;
    if (
      !g2s
      || !g2d
      || g2s !== expected.gate_2_subject_digest
      || g2d !== expected.gate_2_decision_digest
    ) {
      cascadeKinds.push("selected-completion");
    }
  }

  if (input.phase === "finalize") {
    const g3s = input.state.gates.gate_3.production_subject_digest;
    const g3d = input.state.gates.gate_3.production_decision_digest;
    if (
      !g3s
      || !g3d
      || g3s !== expected.gate_3_subject_digest
      || g3d !== expected.gate_3_decision_digest
    ) {
      cascadeKinds.push("final-artifact");
    }
  }

  if (cascadeKinds.length > 0) {
    const { state: cascadedState, cascade } = cascadeRunStateFromDrift(
      input.state,
      cascadeKinds
    );
    const error = pcError(
      "PC_GATE_SUBJECT_STALE",
      `active ${input.phase} blocked: recomputed Gate subjects do not match stored state`
    );
    return {
      ok: false,
      expected,
      cascadeKinds,
      cascadedState,
      cascade,
      error
    };
  }

  return { ok: true, expected, cascadeKinds: [] };
}

/**
 * Throw-only wrapper for callers that cannot persist cascade themselves.
 * Prefer assertLiveActiveSubjectsBeforePhase + atomic writeState in CLI.
 */
export async function assertLiveActiveSubjectsBeforePhaseOrThrow(input: {
  mode: ProductionControlMode | undefined;
  phase: "run" | "render" | "finalize";
  runDir: string;
  state: RunState;
  production_id: string;
  gate_bundle?: GateBundle;
}): Promise<{ expected: LiveGateSubjects; cascadeKinds: GateDriftKind[] }> {
  const result = await assertLiveActiveSubjectsBeforePhase(input);
  if (!result.ok) throw result.error;
  return { expected: result.expected, cascadeKinds: result.cascadeKinds };
}
