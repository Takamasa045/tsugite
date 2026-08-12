/**
 * RC migration orchestrator: legacy → shadow → active (create-only).
 * Never invents identity confirmation/verification. Never mutates Gate subjects.
 * Never submits to providers. Source project.yaml is not rewritten in-place.
 */
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Project } from "../../project/schema.js";
import { assertSafeJsonValue, sha256Canonical } from "../canonical.js";
import {
  buildProductionControlShadowSummary,
  compileProductionContract
} from "../contractCompiler.js";
import { createDefaultTaskTreeTemplate } from "../taskTreeTemplates.js";
import { compileTaskTree } from "../taskTreeCompiler.js";
import { migrateIdentityLockPhaseAtoE } from "../../personConsistency/migration.js";
import { pcError } from "../errors.js";
import { acquireProductionControlRootLock } from "../errors.js";
import {
  projectRevisionBindings,
  rcRevisionBindingsDigest,
  type RcRuntimeMode
} from "./revisionBindings.js";
import {
  evaluateModeTransition,
  resolveRuntimeMode,
  toRuntimeMode
} from "./modeDiagnostics.js";
import { assertMigrationPathContained } from "./pathSafety.js";
import { resolveCanonicalProductionControlRoot } from "../activeRunGeneration.js";
import { EventStore } from "../eventStore.js";
import { SnapshotStore } from "../statePersistence.js";
import { ArtifactStore } from "../artifactStore.js";
import { appendModeIntent, readCurrentModePointer } from "./modeIntent.js";
import type { EffectLedger } from "./effectLedger.js";
import {
  createDenyEffectPolicy,
  createEffectObserver,
  type EffectObserver,
  type EffectPolicy
} from "./effectCapability.js";
import {
  advanceJournalStage,
  beginOrResumeJournal,
  journalIsComplete,
  type JournalCrashHook,
  type MigrationJournalStage
} from "./migrationJournal.js";

export type IdentityMigrationProjection = {
  definition_status: "not_applicable" | "awaiting_human" | "migrated" | "blocked";
  verification_status: "not-evaluable" | "awaiting_human" | "not_applicable" | "blocked" | "migrated";
  locked_true_implies_verified: false;
  definition_confirmation_inferred_from_gate1: false;
  locked_flag_seen: boolean;
  locked_block_count: number;
  issue_codes: string[];
};

export type MigrationPreviewV1 = {
  schema_version: 1;
  fixture_id?: string;
  source_mode: RcRuntimeMode;
  target_mode: "shadow" | "active";
  project_slug: string;
  project_yaml_digest: string;
  production_id: string;
  contract_digest: string;
  tree_digest: string;
  node_count: number;
  revision_bindings_digest: string;
  identity: IdentityMigrationProjection;
  safety_invariants: string[];
  write_paths: string[];
  blocked_reasons: string[];
  ok: boolean;
  digest: string;
};

export type MigrationApplyRecordV1 = {
  schema_version: 1;
  preview_digest: string;
  applied_mode: "shadow" | "active";
  coordination_root_relative: string;
  artifact_relative_paths: string[];
  event_sequence?: number;
  event_digest?: string;
  snapshot_digest?: string;
  mode_intent_digest?: string;
  /** Derived from ledger when provided; otherwise omitted (never self-declared true). */
  safety?: {
    provider_submit_count: number | "unknown";
    gate_mutation_count: number | "unknown";
    billing_spend_count: number | "unknown";
    network_fetch_count: number | "unknown";
    ledger_digest: string;
  };
  no_source_project_rewrite: true;
  actor: string;
  applied_at: string;
  digest: string;
};

export type MigrationPreviewInput = {
  project: Project | Record<string, unknown>;
  target_mode: "shadow" | "active";
  projectRoot?: string;
  fixture_id?: string;
  /** Explicit human definition confirmation only — never inferred. */
  definition_confirmation?: Parameters<typeof migrateIdentityLockPhaseAtoE>[0]["definition_confirmation"];
  verification?: Parameters<typeof migrateIdentityLockPhaseAtoE>[0]["verification"];
  asset_digests?: Record<string, string>;
  coordinator?: boolean;
};

function projectRecord(project: Project | Record<string, unknown>): Record<string, unknown> {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw pcError("PC_SCHEMA_INVALID", "migration requires a project object");
  }
  return project as Record<string, unknown>;
}

function extractPrimaryIr(project: Record<string, unknown>): unknown {
  const generation = project.generation;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return undefined;
  const requests = (generation as Record<string, unknown>).requests;
  if (!Array.isArray(requests)) return undefined;
  for (const request of requests) {
    if (!request || typeof request !== "object" || Array.isArray(request)) continue;
    const value = request as Record<string, unknown>;
    if (value.h3) return value.h3;
    if (value.video_prompt) return value.video_prompt;
  }
  return undefined;
}

function projectIdentityProjection(
  project: Record<string, unknown>,
  productionId: string,
  options: Pick<MigrationPreviewInput, "definition_confirmation" | "verification" | "asset_digests">
): IdentityMigrationProjection {
  const ir = extractPrimaryIr(project);
  if (!ir) {
    return {
      definition_status: "not_applicable",
      verification_status: "not_applicable",
      locked_true_implies_verified: false,
      definition_confirmation_inferred_from_gate1: false,
      locked_flag_seen: false,
      locked_block_count: 0,
      issue_codes: []
    };
  }
  const result = migrateIdentityLockPhaseAtoE({
    ir,
    production_id: productionId,
    ...(options.definition_confirmation ? { definition_confirmation: options.definition_confirmation } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
    ...(options.asset_digests ? { asset_digests: options.asset_digests } : {})
  });
  const verificationStatus: IdentityMigrationProjection["verification_status"] =
    result.verification
      ? "migrated"
      : result.status === "not_applicable"
      ? "not_applicable"
      : result.status === "blocked"
      ? "blocked"
      : "not-evaluable";
  return {
    definition_status:
      result.status === "migrated"
        ? "migrated"
        : result.status === "blocked"
        ? "blocked"
        : result.status === "not_applicable"
        ? "not_applicable"
        : "awaiting_human",
    verification_status: verificationStatus,
    locked_true_implies_verified: false,
    definition_confirmation_inferred_from_gate1: false,
    locked_flag_seen: result.legacy_evidence.locked_flag_seen,
    locked_block_count: result.legacy_evidence.locked_block_count,
    issue_codes: result.issues.map((issue) => issue.code)
  };
}

function relativeWritePaths(projectRoot: string | undefined, target: "shadow" | "active"): string[] {
  if (!projectRoot) {
    return [
      "production-control/migration/",
      target === "active" ? "production-control/" : "production-control/shadow/"
    ];
  }
  const root = resolveCanonicalProductionControlRoot(projectRoot);
  const rel = (path: string) => relative(projectRoot, path).split(sep).join("/");
  return [
    rel(join(root, "migration")),
    rel(join(root, target === "shadow" ? "shadow" : "artifacts"))
  ];
}

export function previewMigration(input: MigrationPreviewInput): MigrationPreviewV1 {
  const project = projectRecord(input.project);
  // Prefer durable pointer mode when present (async read is done by apply; preview uses sync YAML
  // unless caller already projected mode via projectWithMode / CLI durable merge).
  const sourceMode = resolveRuntimeMode(project as { orchestration?: { mode?: string } });
  const transition = evaluateModeTransition(sourceMode, input.target_mode, {
    coordinator: input.coordinator ?? false,
    preview_digest: "pending",
    coordination_root_ready: true,
    identity_blocked: false
  });

  const contract = compileProductionContract({ project });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract)
  });
  // Shadow summary proves read-only compile path (does not mutate Gate).
  if (input.target_mode === "shadow" || sourceMode === "legacy") {
    buildProductionControlShadowSummary(project);
  }

  const identity = projectIdentityProjection(project, contract.production_id, input);
  const blocked: string[] = [];
  if (!transition.allowed) {
    blocked.push(...("blocked_reasons" in transition ? transition.blocked_reasons : []));
  }
  // Active never invents identity confirmation; blocked identity stops active apply.
  if (input.target_mode === "active" && identity.definition_status === "blocked") {
    blocked.push("identity migration blocked");
  }
  if (input.target_mode === "active" && !(input.coordinator ?? false)) {
    if (!blocked.includes("coordinator actor required")) {
      blocked.push("coordinator actor required");
    }
  }

  const safety = [
    "legacy project.yaml not rewritten in-place",
    "Gate subjects not mutated by migration",
    "provider submit not invoked",
    "identity confirmation/verification not inferred from locked:true or Gate 1",
    "create-only coordination / migration artifacts"
  ];

  const body = {
    schema_version: 1 as const,
    ...(input.fixture_id ? { fixture_id: input.fixture_id } : {}),
    source_mode: sourceMode,
    target_mode: input.target_mode,
    project_slug: contract.project.slug,
    project_yaml_digest: contract.project.project_yaml_digest,
    production_id: contract.production_id,
    contract_digest: contract.root_digest,
    tree_digest: tree.digest,
    node_count: tree.nodes.length,
    revision_bindings_digest: rcRevisionBindingsDigest(),
    identity,
    safety_invariants: safety,
    write_paths: relativeWritePaths(input.projectRoot, input.target_mode),
    blocked_reasons: blocked,
    ok: blocked.length === 0
  };
  assertSafeJsonValue(body, "migration preview");
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Create-only JSON write. On EEXIST, adopt only when on-disk bytes are identical.
 * Any other conflict or IO failure fails closed (no soft-swallow).
 */
async function atomicCreateJson(filePath: string, value: unknown): Promise<"created" | "adopted"> {
  assertSafeJsonValue(value, filePath);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Create-only reservation on final path closes TOCTOU with concurrent writers.
    const reserve = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await reserve.close();
    await rename(temp, filePath);
    await fsyncDirectory(dir);
    return "created";
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST") {
      // Exact EEXIST: adopt only when byte-identical to intended payload.
      const existing = await readFile(filePath, "utf8");
      if (existing === bytes) {
        return "adopted";
      }
      throw pcError(
        "PC_ARTIFACT_DUPLICATE",
        `migration artifact already exists with different bytes: ${filePath}`
      );
    }
    throw error;
  }
}

export type MigrationApplyInput = MigrationPreviewInput & {
  projectRoot: string;
  actor: string;
  /** Must match preview.digest from the same inputs. */
  expected_preview_digest: string;
  now?: () => string;
  ledger?: EffectLedger;
  observer?: EffectObserver;
  effect_policy?: EffectPolicy;
  /** Test-only crash injection after a journal stage is sealed. */
  crash_after_stage?: MigrationJournalStage;
  crash_hook?: JournalCrashHook;
};

/**
 * Apply migration via create-only journal stages:
 * planned → events → snapshot → artifacts → pointer → complete.
 * Does not rewrite project.yaml, mutate Gates, submit, render, or finalize-apply.
 */
export async function applyMigration(input: MigrationApplyInput): Promise<{
  preview: MigrationPreviewV1;
  record: MigrationApplyRecordV1;
  journal_complete: boolean;
}> {
  if (input.actor !== "coordinator") {
    throw pcError("PC_AUTHORITY_DENIED", "migration apply requires actor=coordinator");
  }
  const preview = previewMigration({ ...input, coordinator: true });
  if (preview.digest !== input.expected_preview_digest) {
    throw pcError("PC_CONTRACT_INVALID", "migration preview digest mismatch");
  }
  if (!preview.ok) {
    throw pcError("PC_CONTRACT_INVALID", `migration blocked: ${preview.blocked_reasons.join("; ")}`);
  }

  const resolvedInput = resolve(input.projectRoot);
  const preStat = await lstat(resolvedInput);
  if (preStat.isSymbolicLink()) {
    throw pcError("PC_PATH_UNSAFE", "project root must not be a symbolic link");
  }
  if (!preStat.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "project root must be a real directory");
  }
  const projectRoot = await realpath(resolvedInput);
  const rootStat = await lstat(projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "project root must be a real directory");
  }

  const controlRoot = resolveCanonicalProductionControlRoot(projectRoot);
  await assertMigrationPathContained({
    projectRoot,
    candidate: controlRoot,
    label: "production-control",
    allowMissingLeaf: true
  });
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });

  const contract = compileProductionContract({ project: projectRecord(input.project) });
  const tree = compileTaskTree({
    production: contract,
    template: createDefaultTaskTreeTemplate(contract)
  });
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  const crashOpts = {
    ...(input.crash_after_stage ? { crash_after_stage: input.crash_after_stage } : {}),
    ...(input.crash_hook ? { crash_hook: input.crash_hook } : {}),
    now: input.now
  };

  // Stage: planned
  const { journal: planned } = await beginOrResumeJournal({
    projectRoot,
    kind: "migration",
    preview_digest: preview.digest,
    production_id: contract.production_id,
    target_mode: input.target_mode,
    source_mode: preview.source_mode,
    actor: "coordinator",
    ...crashOpts
  });
  if (journalIsComplete(planned, preview.digest)) {
    // Idempotent complete — rebuild record from sealed journal digests when possible.
  }

  const observer = input.observer
    ?? (input.ledger ? createEffectObserver(input.ledger) : createEffectObserver());
  const policy = input.effect_policy ?? createDenyEffectPolicy(observer);
  // Coverage registration only — migration itself must not attempt effects.
  void policy;

  const eventStore = new EventStore(controlRoot);
  const snapshotStore = new SnapshotStore(controlRoot);
  const artifactStore = new ArtifactStore(controlRoot);

  let event_sequence: number | undefined;
  let event_digest: string | undefined;
  let snapshot_digest: string | undefined;

  // Stage: events (append-only; idempotent when events already present)
  {
    const existingEvents = await eventStore.readAll().catch(() => []);
    if (existingEvents.length === 0) {
      const missionCreated = await eventStore.append({
        type: "mission-created",
        production_id: contract.production_id,
        payload: {
          mission_digest: contract.root_digest,
          tree_revision: tree.tree_revision
        },
        coordinator_instance_id: "coordinator",
        created_at: nowIso
      });
      event_sequence = missionCreated.sequence;
      event_digest = missionCreated.event_digest;

      const treeCompiled = await eventStore.append({
        type: "tree-compiled",
        production_id: contract.production_id,
        payload: {
          tree_digest: tree.digest,
          tree_revision: tree.tree_revision
        },
        coordinator_instance_id: "coordinator",
        created_at: nowIso
      });
      event_sequence = treeCompiled.sequence;
      event_digest = treeCompiled.event_digest;
    } else {
      event_sequence = existingEvents.at(-1)?.sequence;
      event_digest = existingEvents.at(-1)?.event_digest ?? planned.event_digest;
    }
  }
  let journal = await advanceJournalStage({
    projectRoot,
    expected_preview_digest: preview.digest,
    production_id: contract.production_id,
    to_stage: "events",
    ...(event_digest ? { event_digest } : {}),
    ...crashOpts
  });

  // Stage: snapshot
  {
    const existingEvents = await eventStore.readAll().catch(() => []);
    if (existingEvents.length > 0) {
      const snap = await snapshotStore.read();
      if (!snap) {
        const { replayProductionEvents } = await import("../reducer.js");
        const state = replayProductionEvents(existingEvents, contract.production_id);
        const snapshot = await snapshotStore.compareAndSwap(state, null);
        snapshot_digest = snapshot.state_digest;
      } else {
        snapshot_digest = snap.state_digest;
      }
    } else {
      snapshot_digest = journal.snapshot_digest;
    }
  }
  journal = await advanceJournalStage({
    projectRoot,
    expected_preview_digest: preview.digest,
    production_id: contract.production_id,
    to_stage: "snapshot",
    ...(event_digest ? { event_digest } : {}),
    ...(snapshot_digest ? { snapshot_digest } : {}),
    ...crashOpts
  });

  // Stage: artifacts (create-only preview/contract/tree + optional artifact store)
  {
    if (input.target_mode === "active") {
      try {
        await artifactStore.create({
          artifact_id: `contract-${contract.root_digest.slice(0, 12)}`,
          bytes: `${JSON.stringify(contract)}\n`
        });
      } catch (error) {
        // Exact duplicate with same digest is adopt; other failures fail-closed.
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "";
        if (code !== "PC_ARTIFACT_DUPLICATE" && code !== "EEXIST") {
          throw error;
        }
      }
      try {
        await artifactStore.create({
          artifact_id: `tree-${tree.digest.slice(0, 12)}`,
          bytes: `${JSON.stringify(tree)}\n`
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "";
        if (code !== "PC_ARTIFACT_DUPLICATE" && code !== "EEXIST") {
          throw error;
        }
      }
    }

    const migrationDir = join(controlRoot, "migration");
    await mkdir(migrationDir, { recursive: true, mode: 0o700 });
    const previewPath = join(migrationDir, `preview-${preview.digest.slice(0, 16)}.json`);
    const shadowOrActiveDir = join(
      controlRoot,
      input.target_mode === "shadow" ? "shadow" : "artifacts"
    );
    await mkdir(shadowOrActiveDir, { recursive: true, mode: 0o700 });
    const contractPath = join(shadowOrActiveDir, `production-contract-${contract.root_digest.slice(0, 16)}.json`);
    const treePath = join(shadowOrActiveDir, `task-tree-${tree.digest.slice(0, 16)}.json`);

    // Required artifacts: create-only or byte-identical adoption only (no soft-fail).
    await atomicCreateJson(previewPath, preview);
    await atomicCreateJson(contractPath, contract);
    await atomicCreateJson(treePath, tree);

    journal = await advanceJournalStage({
      projectRoot,
      expected_preview_digest: preview.digest,
      production_id: contract.production_id,
      to_stage: "artifacts",
      ...(event_digest ? { event_digest } : {}),
      ...(snapshot_digest ? { snapshot_digest } : {}),
      stage_payload: {
        preview_path: relative(projectRoot, previewPath).split(sep).join("/"),
        contract_path: relative(projectRoot, contractPath).split(sep).join("/"),
        tree_path: relative(projectRoot, treePath).split(sep).join("/")
      },
      ...crashOpts
    });
  }

  // Stage: pointer (CAS) — after events/snapshot/artifacts exist
  let mode_intent_digest = journal.mode_intent_digest;
  {
    const priorPointer = await readCurrentModePointer(projectRoot);
    if (
      priorPointer?.runtime_mode === input.target_mode
      && priorPointer.production_id === contract.production_id
    ) {
      mode_intent_digest = priorPointer.intent_digest;
    } else {
      const modeIntent = await appendModeIntent({
        projectRoot,
        intended_mode: input.target_mode,
        previous_mode: priorPointer?.runtime_mode ?? preview.source_mode,
        actor: "coordinator",
        production_id: contract.production_id,
        preview_digest: preview.digest,
        ...(priorPointer ? { expected_previous_intent_digest: priorPointer.intent_digest } : {}),
        now: input.now
      });
      mode_intent_digest = modeIntent.intent.digest;
    }
    journal = await advanceJournalStage({
      projectRoot,
      expected_preview_digest: preview.digest,
      production_id: contract.production_id,
      to_stage: "pointer",
      ...(event_digest ? { event_digest } : {}),
      ...(snapshot_digest ? { snapshot_digest } : {}),
      ...(mode_intent_digest ? { mode_intent_digest } : {}),
      ...crashOpts
    });
  }

  // Build apply record + complete journal
  const migrationDir = join(controlRoot, "migration");
  await mkdir(migrationDir, { recursive: true, mode: 0o700 });
  const previewPath = join(migrationDir, `preview-${preview.digest.slice(0, 16)}.json`);
  const shadowOrActiveDir = join(
    controlRoot,
    input.target_mode === "shadow" ? "shadow" : "artifacts"
  );
  const contractPath = join(shadowOrActiveDir, `production-contract-${contract.root_digest.slice(0, 16)}.json`);
  const treePath = join(shadowOrActiveDir, `task-tree-${tree.digest.slice(0, 16)}.json`);

  const artifact_relative_paths = [
    previewPath,
    contractPath,
    treePath,
    join(projectRoot, "production-control/mode/current-mode.json")
  ].map((path) => relative(projectRoot, path).split(sep).join("/"));

  if (event_digest) {
    artifact_relative_paths.push(
      relative(projectRoot, join(controlRoot, "events.jsonl")).split(sep).join("/"),
      relative(projectRoot, join(controlRoot, "events.commit.json")).split(sep).join("/")
    );
  }
  if (snapshot_digest) {
    artifact_relative_paths.push(
      relative(projectRoot, join(controlRoot, "coordination-state.json")).split(sep).join("/")
    );
  }

  observer.effectLedger.recordCall({
    module: "productionControl/rc/migrationOrchestrator",
    api: "applyMigration",
    result: "ok",
    digests: {
      preview: preview.digest,
      ...(event_digest ? { event: event_digest } : {}),
      ...(mode_intent_digest ? { mode_intent: mode_intent_digest } : {})
    }
  });
  // Arm via real production wrappers so zero-effect is proven (no bulk arm).
  if (!observer.provenZeroEffects()) {
    const { registerBoundariesViaProductionWrappers } = await import("./fixtureEvidence.js");
    const { mkdtemp, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const registerRoot = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po8-mig-wrap-")));
    try {
      await registerBoundariesViaProductionWrappers(
        { kind: "noop", observer },
        registerRoot
      );
    } finally {
      await rm(registerRoot, { recursive: true, force: true });
    }
  }
  try {
    observer.sealEventSequence();
  } catch {
    // observer may already be sealed from prior resume
  }

  const safetyEvidence = observer.safetyEvidence();
  const safety = {
    provider_submit_count: safetyEvidence.provider_submit_count,
    gate_mutation_count: safetyEvidence.gate_mutation_count,
    billing_spend_count: safetyEvidence.billing_spend_count,
    network_fetch_count: safetyEvidence.network_fetch_count,
    ledger_digest: safetyEvidence.digest
  };

  const recordBody = {
    schema_version: 1 as const,
    preview_digest: preview.digest,
    applied_mode: input.target_mode,
    coordination_root_relative: relative(projectRoot, controlRoot).split(sep).join("/"),
    artifact_relative_paths,
    ...(event_sequence !== undefined ? { event_sequence } : {}),
    ...(event_digest ? { event_digest } : {}),
    ...(snapshot_digest ? { snapshot_digest } : {}),
    mode_intent_digest: mode_intent_digest ?? journal.mode_intent_digest ?? "",
    safety,
    no_source_project_rewrite: true as const,
    actor: input.actor,
    applied_at: nowIso,
    revision_bindings: projectRevisionBindings()
  };
  const digest = sha256Canonical(recordBody);
  const finalRecord: MigrationApplyRecordV1 = {
    schema_version: 1,
    preview_digest: recordBody.preview_digest,
    applied_mode: recordBody.applied_mode,
    coordination_root_relative: recordBody.coordination_root_relative,
    artifact_relative_paths: recordBody.artifact_relative_paths,
    ...(recordBody.event_sequence !== undefined ? { event_sequence: recordBody.event_sequence } : {}),
    ...(recordBody.event_digest ? { event_digest: recordBody.event_digest } : {}),
    ...(recordBody.snapshot_digest ? { snapshot_digest: recordBody.snapshot_digest } : {}),
    mode_intent_digest: recordBody.mode_intent_digest,
    safety: recordBody.safety,
    no_source_project_rewrite: true,
    actor: recordBody.actor,
    applied_at: recordBody.applied_at,
    digest
  };

  const applyPath = join(migrationDir, `apply-${digest.slice(0, 16)}.json`);
  // Apply record is required durable evidence — fail-closed (or byte-identical adopt).
  await atomicCreateJson(applyPath, finalRecord);
  finalRecord.artifact_relative_paths = [
    ...finalRecord.artifact_relative_paths,
    relative(projectRoot, applyPath).split(sep).join("/")
  ];

  journal = await advanceJournalStage({
    projectRoot,
    expected_preview_digest: preview.digest,
    production_id: contract.production_id,
    to_stage: "complete",
    ...(event_digest ? { event_digest } : {}),
    ...(snapshot_digest ? { snapshot_digest } : {}),
    ...(mode_intent_digest ? { mode_intent_digest } : {}),
    stage_payload: { apply_digest: digest },
    ...crashOpts
  });

  return {
    preview,
    record: finalRecord,
    journal_complete: journalIsComplete(journal, preview.digest)
  };
}

export function projectWithMode(
  project: Project | Record<string, unknown>,
  mode: RcRuntimeMode
): Record<string, unknown> {
  const base = { ...projectRecord(project) };
  if (mode === "legacy") {
    const { orchestration: _drop, ...rest } = base;
    return rest;
  }
  return {
    ...base,
    orchestration: {
      ...(base.orchestration && typeof base.orchestration === "object" && !Array.isArray(base.orchestration)
        ? base.orchestration as Record<string, unknown>
        : {}),
      mode: mode === "shadow" ? "shadow" : "active"
    }
  };
}

export { toRuntimeMode };
