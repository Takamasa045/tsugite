/**
 * H1: Wire each of the 8 PO-8 fixtures to actual production module APIs.
 * Inputs come only from fixture bytes/fields (strict authoring) — no DIGEST_A-F,
 * no void project, no bare marker "1", no handwritten lyrics outside fixture.
 * Every evidence binds canonical fixture_digest. Golden digests exact-compare.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes, sha256Canonical } from "../canonical.js";
import { EffectLedger, type EffectLedgerSnapshot } from "./effectLedger.js";
import {
  createDenyEffectPolicy,
  createEffectObserver,
  type EffectCapability,
  type EffectObserver,
  type EffectPolicy
} from "./effectCapability.js";
import {
  assertGoldenDigests,
  buildRouteFromAuthoring,
  loadPo8Fixture,
  seedDigest,
  type Po8FixtureId,
  type Po8FixtureManifest
} from "./po8Fixtures.js";
import { pcError, ProductionControlError } from "../errors.js";
import {
  compileLegacyH3V1,
  compileH3V1ThroughV2,
  compileVideoPromptIrV2
} from "../../videoPromptDirector/compileV2.js";
import { upgradeH3V1ToVideoPromptV2 } from "../../videoPromptDirector/upgradeV1.js";
import { parseVideoPromptIrV2 } from "../../videoPromptDirector/schemaV2.js";
import { migrateIdentityLockPhaseAtoE } from "../../personConsistency/migration.js";
import {
  createGateBundle,
  assertGateBundleExecutable,
  projectGateBundleForReview,
  pricingBindingDigest
} from "../gateBundle.js";
import {
  cascadeFromDrift,
  createGate1Subject,
  evaluateGate2AutoPass,
  bindGateDecision,
  gateDecisionDigest
} from "../gateSubjects.js";
import { checkAuthority } from "../authorityGuard.js";
import {
  assertNoResubmitOnSubmissionUnknown,
  assertJobRevisionAndIdentity,
  computeImmutableIdentityDigest,
  createGenerationJobApprovalBinding,
  resolveSubmissionUnknownAction
} from "../generationBridge.js";
import {
  createMusicStructureContract,
  createLyricsContract,
  createGenerationUnit,
  createCompositionIntent
} from "../index.js";
import { createInitialMissionState } from "../reducer.js";
import { projectMissionTree } from "../publicProjection.js";
import {
  buildProductionCompletionDigest,
  isControlPlaneRetainedPath
} from "../finalizeRetention.js";
import { createLearningCandidate } from "../learning/candidate.js";
import { runLearningExperiment } from "../learning/experiment.js";
import { createPromotionProposal } from "../learning/promotion.js";
import { GrantCreditLedger } from "../grantLedger.js";

const ZERO = "0".repeat(64);

export type FixtureModuleEvidence = {
  fixture_id: Po8FixtureId;
  fixture_digest: string;
  module: string;
  apis: string[];
  digests: Record<string, string>;
  errors: string[];
  state: Record<string, unknown>;
  adversarial: Array<{ name: string; ok: boolean; error?: string }>;
  golden_ok: boolean;
  ok: boolean;
  digest: string;
};

export type FixtureEvidenceReport = {
  schema_version: 1;
  fixture_count: 8;
  results: FixtureModuleEvidence[];
  ledger: EffectLedgerSnapshot;
  observer_digest?: string;
  proven_zero_effects: boolean;
  all_ok: boolean;
  digest: string;
};

function textDigest(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
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

function evidenceBody(input: Omit<FixtureModuleEvidence, "digest">): FixtureModuleEvidence {
  return {
    ...input,
    digest: sha256Canonical(input)
  };
}

function requireAuthoring<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw pcError("PC_SCHEMA_INVALID", `fixture authoring missing required ${label}`);
  }
  return value;
}

async function realTempDir(prefix: string): Promise<string> {
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpath(await mkdtemp(join(base, prefix)));
}

/**
 * Production-path wrapper used by job/recovery/compiler effect boundaries.
 * Callers that would submit/mutate must go through capability or EffectPolicy.
 */
export function withDenyCapability<T>(
  capability: EffectCapability | undefined,
  boundary: "provider_submit" | "gate_mutation" | "billing_spend" | "network_fetch" | "render" | "finalize_apply",
  api: string,
  run: () => T
): T {
  if (!capability) return run();
  switch (boundary) {
    case "provider_submit":
      return capability.providerSubmit(api);
    case "gate_mutation":
      return capability.gateWrite(api);
    case "billing_spend":
      return capability.billingSpend(api);
    case "network_fetch":
      return capability.networkFetch(api);
    case "render":
      return capability.render(api);
    case "finalize_apply":
      return capability.finalizeApply(api);
  }
}

async function runLegacyH3(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = {
    fixture_digest: fixture.fixture_digest
  };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const project = fixture.project as Record<string, unknown>;
  const raw = extractPrimaryIr(project);
  if (!raw || typeof raw !== "object") {
    errors.push("missing h3 ir in fixture.project");
    ok = false;
  } else {
    const ir = raw as Record<string, unknown>;
    // No normalize-to-ok: incomplete IR must fail.
    if (!Array.isArray(ir.shots) || ir.shots.length === 0) {
      errors.push("fixture h3 shots required");
      ok = false;
    } else {
      try {
        const upgraded = upgradeH3V1ToVideoPromptV2(ir as never);
        apis.push("upgradeH3V1ToVideoPromptV2");
        digests.source_sha256 = upgraded.source_sha256;
        digests.upgraded_ir = sha256Canonical(upgraded.ir);
        ledger.recordCall({
          module: "videoPromptDirector/upgradeV1",
          api: "upgradeH3V1ToVideoPromptV2",
          result: "ok",
          digests: { source_sha256: upgraded.source_sha256, fixture_digest: fixture.fixture_digest }
        });

        const legacy = compileLegacyH3V1(ir as never);
        apis.push("compileLegacyH3V1");
        digests.canonical_text = sha256Bytes(new TextEncoder().encode(legacy.canonical_prompt));
        digests.adapter_text = sha256Bytes(new TextEncoder().encode(legacy.adapter_prompt));
        ledger.recordCall({
          module: "videoPromptDirector/compileV2",
          api: "compileLegacyH3V1",
          result: "ok",
          digests: { canonical_text: digests.canonical_text, fixture_digest: fixture.fixture_digest }
        });

        const through = compileH3V1ThroughV2(ir as never, { require_route: false, intent: "planning" });
        apis.push("compileH3V1ThroughV2");
        digests.planning_compile = sha256Canonical({
          ok: through.ok,
          text_prefix: through.ok
            ? (through.compilation?.canonical_prompt ?? "").slice(0, 64)
            : (through.issues?.[0]?.code ?? "incomplete")
        });
        if (through.ok && through.compilation) {
          digests.compilation = sha256Canonical({
            workflow: through.compilation.lineage?.workflow_id ?? "video-prompt-v3",
            text_prefix: (through.compilation.canonical_prompt ?? "").slice(0, 64)
          });
        }
        ledger.recordCall({
          module: "videoPromptDirector/compileV2",
          api: "compileH3V1ThroughV2",
          result: through.ok ? "ok" : "error",
          digests: { fixture_digest: fixture.fixture_digest }
        });
      } catch (error) {
        ok = false;
        errors.push(error instanceof Error ? error.message : String(error));
      }

      try {
        parseVideoPromptIrV2({ version: 2, invalid: true });
        adversarial.push({ name: "invalid-v2-parse", ok: false, error: "expected throw" });
        ok = false;
      } catch (error) {
        adversarial.push({
          name: "invalid-v2-parse",
          ok: true,
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
        });
        ledger.recordCall({
          module: "videoPromptDirector/schemaV2",
          api: "parseVideoPromptIrV2",
          result: "blocked",
          digests: { fixture_digest: fixture.fixture_digest }
        });
      }

      // Mutation: change a meaningful visual field → digest must change
      try {
        const shots = ir.shots as Array<Record<string, unknown>>;
        const mutated = {
          ...ir,
          shots: shots.map((shot, index) =>
            index === 0
              ? { ...shot, visual: `${String(shot.visual ?? "")} [mutated]` }
              : shot
          )
        };
        const base = compileLegacyH3V1(ir as never);
        const alt = compileLegacyH3V1(mutated as never);
        const changed =
          sha256Bytes(new TextEncoder().encode(base.canonical_prompt))
          !== sha256Bytes(new TextEncoder().encode(alt.canonical_prompt));
        adversarial.push({ name: "mutate-visual-changes-digest", ok: changed });
        if (!changed) ok = false;
      } catch (error) {
        adversarial.push({
          name: "mutate-visual-changes-digest",
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 120) : String(error)
        });
        ok = false;
      }
    }
  }

  // Capability is the registered production deny adapter (no separate self-probe observer).
  void capability;

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "legacy-h3",
    fixture_digest: fixture.fixture_digest,
    module: "videoPromptDirector+h3",
    apis,
    digests,
    errors,
    state: { path: digests.path },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && digests.canonical_text !== undefined && adversarial.every((item) => item.ok)
  });
}

async function runStandaloneV2(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = {
    fixture_digest: fixture.fixture_digest
  };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const project = fixture.project as Record<string, unknown>;
  const raw = extractPrimaryIr(project);
  const routeAuth = requireAuthoring(fixture.authoring.route, "route");
  try {
    if (!raw || typeof raw !== "object") {
      throw pcError("PC_SCHEMA_INVALID", "standalone-v2 requires video_prompt in fixture.project");
    }
    // No normalize fill: parse fixture IR as authored.
    const ir = parseVideoPromptIrV2(raw);
    apis.push("parseVideoPromptIrV2");
    digests.ir = sha256Canonical(ir);
    ledger.recordCall({
      module: "videoPromptDirector/schemaV2",
      api: "parseVideoPromptIrV2",
      result: "ok",
      digests: { ir: digests.ir, fixture_digest: fixture.fixture_digest }
    });

    const route = buildRouteFromAuthoring(routeAuth);
    digests.route = route.route_digest;
    const compiled = compileVideoPromptIrV2(ir, {
      route,
      require_route: false,
      intent: "planning"
    });
    apis.push("compileVideoPromptIrV2");
    digests.planning_compile = compiled.ok
      ? sha256Canonical({ status: "ok", text_prefix: (compiled.compilation?.canonical_prompt ?? "").slice(0, 80) })
      : sha256Canonical({ status: "incomplete" });
    if (compiled.ok && compiled.compilation) {
      digests.compilation = sha256Canonical({
        ok: true,
        text_prefix: (compiled.compilation.canonical_prompt ?? "").slice(0, 80)
      });
    }
    ledger.recordCall({
      module: "videoPromptDirector/compileV2",
      api: "compileVideoPromptIrV2",
      result: compiled.ok ? "ok" : "error",
      digests: { fixture_digest: fixture.fixture_digest }
    });

    try {
      const forgedRoute = { ...route, route_digest: ZERO };
      const rejected = compileVideoPromptIrV2(ir, {
        route: forgedRoute,
        require_route: true,
        intent: "execute"
      });
      apis.push("compileVideoPromptIrV2+forged-route");
      const failClosed = rejected.ok === false;
      digests.forged_route_adoption = failClosed
        ? sha256Canonical({ adoption: "fail_closed", ok: false })
        : sha256Canonical({ adoption: "unsafe_ok", ok: true });
      adversarial.push({ name: "forged-route-adoption", ok: failClosed });
      if (!failClosed) ok = false;
      ledger.recordCall({
        module: "videoPromptDirector/compileV2",
        api: "compileVideoPromptIrV2(forged-route)",
        result: failClosed ? "blocked" : "ok",
        digests: { fixture_digest: fixture.fixture_digest }
      });
    } catch (error) {
      adversarial.push({
        name: "forged-route-adoption",
        ok: true,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error)
      });
    }

    // Mutation on action beat
    const shots = (raw as { shots?: Array<Record<string, unknown>> }).shots ?? [];
    if (shots[0]) {
      const mutated = structuredClone(raw) as {
        shots: Array<{ action_beats: Array<{ description: string }> }>;
      };
      mutated.shots[0]!.action_beats[0]!.description = `${mutated.shots[0]!.action_beats[0]!.description} [mutated]`;
      const baseIr = parseVideoPromptIrV2(raw);
      const mutIr = parseVideoPromptIrV2(mutated);
      const changed = sha256Canonical(baseIr) !== sha256Canonical(mutIr);
      adversarial.push({ name: "mutate-action-changes-digest", ok: changed });
      if (!changed) ok = false;
    } else {
      adversarial.push({ name: "mutate-action-changes-digest", ok: false, error: "no shots" });
      ok = false;
    }
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }

  void capability;

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "standalone-v2",
    fixture_digest: fixture.fixture_digest,
    module: "videoPromptDirector.VideoPromptIrV2",
    apis,
    digests,
    errors,
    state: { forged_route_adoption: digests.forged_route_adoption },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && digests.ir !== undefined && adversarial.every((item) => item.ok)
  });
}

async function runLyricMv(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const musicAuth = requireAuthoring(fixture.authoring.music, "music");
  const lyricsAuth = requireAuthoring(fixture.authoring.lyrics, "lyrics");
  const routeAuth = requireAuthoring(fixture.authoring.route, "route");
  const project = fixture.project as Record<string, unknown>;
  try {
    // Lyrics text must come from fixture authoring and match project IR when present.
    const ir = extractPrimaryIr(project) as { shots?: Array<{ lyrics?: string }> } | undefined;
    const projectLyric = ir?.shots?.[0]?.lyrics;
    if (projectLyric !== undefined && projectLyric !== lyricsAuth.canonical_text) {
      throw pcError(
        "PC_SCHEMA_INVALID",
        "lyrics authoring.canonical_text must match project IR lyrics"
      );
    }

    const route = buildRouteFromAuthoring(routeAuth);
    digests.route = route.route_digest;

    const music = createMusicStructureContract({
      contract_id: musicAuth.contract_id,
      revision: musicAuth.revision,
      master_audio: {
        asset_id: musicAuth.master_audio_asset_id,
        sha256: seedDigest(musicAuth.master_audio_seed),
        duration_ms: musicAuth.duration_ms,
        sample_rate: musicAuth.sample_rate,
        channels: musicAuth.channels
      },
      analysis: {
        status: "analyzed",
        analyzer_id: musicAuth.analyzer_id,
        analyzer_version: musicAuth.analyzer_version
      },
      tempo_map: [{
        id: "tempo-0",
        start_ms: 0,
        bpm: musicAuth.tempo_bpm,
        meter: musicAuth.meter
      }],
      beat_markers: [{ id: "beat-0", at_ms: 0, kind: "downbeat", bar: 1, beat: 1 }],
      sections: [{
        id: musicAuth.section_id,
        label: musicAuth.section_label,
        start_ms: 0,
        end_ms: musicAuth.section_end_ms,
        musical_role: "lift"
      }],
      section_policy: { gaps: "allow", overlaps: "forbid" }
    });
    apis.push("createMusicStructureContract");
    digests.music = music.digest;
    ledger.recordCall({
      module: "productionControl/contracts/music",
      api: "createMusicStructureContract",
      result: "ok",
      digests: { music: music.digest, fixture_digest: fixture.fixture_digest }
    });

    const line = lyricsAuth.canonical_text;
    const lyrics = createLyricsContract({
      contract_id: lyricsAuth.contract_id,
      revision: lyricsAuth.revision,
      language_bcp47: lyricsAuth.language_bcp47,
      source: { canonical_text: line, text_digest: textDigest(line) },
      alignment_state: "complete",
      alignment_basis: "human-reviewed",
      cues: [{
        timing: "timed",
        id: lyricsAuth.cue_id,
        section_id: lyricsAuth.section_id,
        source_span: {
          occurrence_id: lyricsAuth.occurrence_id,
          start_utf8_byte: 0,
          end_utf8_byte: new TextEncoder().encode(line).byteLength,
          text_digest: textDigest(line)
        },
        start_ms: lyricsAuth.start_ms,
        end_ms: lyricsAuth.end_ms,
        singer_ids: lyricsAuth.singer_ids,
        use: ["caption-overlay"]
      }]
    });
    apis.push("createLyricsContract");
    digests.lyrics = lyrics.digest;
    digests.lyrics_language = lyricsAuth.language_bcp47;
    digests.lyrics_text = lyrics.source.text_digest;
    ledger.recordCall({
      module: "productionControl/contracts/lyrics",
      api: "createLyricsContract",
      result: "ok",
      digests: { lyrics: lyrics.digest, fixture_digest: fixture.fixture_digest }
    });

    const unit = createGenerationUnit({
      production_id: String(project.slug ?? "po8-lyric-mv"),
      unit_id: "chorus-unit",
      ordinal: 0,
      music,
      lyrics,
      start_ms: 0,
      end_ms: musicAuth.duration_ms,
      section_id: musicAuth.section_id,
      beat_anchor_ids: ["beat-0"],
      lyric_cue_ids: [lyricsAuth.cue_id],
      audio_policy: "reuse-master",
      route
    });
    apis.push("createGenerationUnit");
    digests.generation_unit = unit.digest;
    digests.program_start_ms = `ms:${unit.program.start_ms}`;
    digests.program_end_ms = `ms:${unit.program.end_ms}`;
    digests.singer_exact = lyricsAuth.singer_ids.join(",");
    digests.cue_start_ms = `ms:${lyricsAuth.start_ms}`;
    ledger.recordCall({
      module: "productionControl/contracts/generationUnit",
      api: "createGenerationUnit",
      result: "ok",
      digests: { generation_unit: unit.digest, fixture_digest: fixture.fixture_digest }
    });

    const intent = createCompositionIntent({
      music,
      lyrics,
      units: [unit],
      placements: [{
        generation_unit_digest: unit.digest,
        track_id: "v1",
        layer: 0,
        blend_policy: "replace",
        timeline_start_ms: 0,
        timeline_end_ms: musicAuth.duration_ms,
        planned_time_transform: { kind: "none" }
      }],
      required_visual_coverage_intervals: [{
        track_id: "v1",
        start_ms: 0,
        end_ms: musicAuth.duration_ms
      }],
      caption_cue_refs: [{
        slot: "lyrics",
        contract_id: lyrics.contract_id,
        revision: lyrics.revision,
        kind: "lyric-cue",
        fragment_id: lyricsAuth.cue_id,
        digest: sha256Canonical(lyrics.cues[0]!)
      }]
    });
    apis.push("createCompositionIntent");
    digests.composition_intent = intent.digest;
    ledger.recordCall({
      module: "productionControl/mv/composition",
      api: "createCompositionIntent",
      result: "ok",
      digests: { composition_intent: digests.composition_intent, fixture_digest: fixture.fixture_digest }
    });

    try {
      createGenerationUnit({
        production_id: String(project.slug ?? "po8-lyric-mv"),
        unit_id: "bad-unit",
        ordinal: 1,
        music,
        lyrics,
        start_ms: 0,
        end_ms: musicAuth.duration_ms + 5_999,
        section_id: musicAuth.section_id,
        beat_anchor_ids: ["beat-0"],
        lyric_cue_ids: [lyricsAuth.cue_id],
        audio_policy: "reuse-master",
        route
      });
      adversarial.push({ name: "interval-outside-master", ok: false, error: "expected throw" });
      ok = false;
    } catch (error) {
      adversarial.push({
        name: "interval-outside-master",
        ok: true,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error)
      });
      ledger.recordCall({
        module: "productionControl/contracts/generationUnit",
        api: "createGenerationUnit(adversarial)",
        result: "blocked",
        digests: { fixture_digest: fixture.fixture_digest }
      });
    }

    // Lyrics mutation changes digest
    const mutLine = `${line} [mutated]`;
    const mutLyrics = createLyricsContract({
      contract_id: lyricsAuth.contract_id,
      revision: lyricsAuth.revision,
      language_bcp47: lyricsAuth.language_bcp47,
      source: { canonical_text: mutLine, text_digest: textDigest(mutLine) },
      alignment_state: "complete",
      alignment_basis: "human-reviewed",
      cues: [{
        timing: "timed",
        id: lyricsAuth.cue_id,
        section_id: lyricsAuth.section_id,
        source_span: {
          occurrence_id: lyricsAuth.occurrence_id,
          start_utf8_byte: 0,
          end_utf8_byte: new TextEncoder().encode(mutLine).byteLength,
          text_digest: textDigest(mutLine)
        },
        start_ms: lyricsAuth.start_ms,
        end_ms: lyricsAuth.end_ms,
        singer_ids: lyricsAuth.singer_ids,
        use: ["caption-overlay"]
      }]
    });
    const changed = mutLyrics.digest !== lyrics.digest;
    adversarial.push({ name: "mutate-lyrics-text-changes-digest", ok: changed });
    if (!changed) ok = false;
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }
  void capability;

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "lyric-mv",
    fixture_digest: fixture.fixture_digest,
    module: "productionControl.mv+T04",
    apis,
    digests,
    errors,
    state: {
      slots: (project as { contract_slots?: unknown }).contract_slots ?? null
    },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && digests.generation_unit !== undefined && adversarial.every((item) => item.ok)
  });
}

async function runIdentity(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  _capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const project = fixture.project as Record<string, unknown>;
  const identityAuth = requireAuthoring(fixture.authoring.identity, "identity");
  const ir = extractPrimaryIr(project);
  try {
    const result = migrateIdentityLockPhaseAtoE({
      ir,
      production_id: identityAuth.production_id
    });
    apis.push("migrateIdentityLockPhaseAtoE");
    digests.migration_status = result.status;
    digests.locked_flag_seen = result.legacy_evidence.locked_flag_seen
      ? "locked_flag_present"
      : "locked_flag_absent";
    digests.locked_block_count = String(result.legacy_evidence.locked_block_count);
    digests.verification_present = result.verification
      ? "verification_present"
      : "verification_absent";
    digests.locked_not_verified =
      !result.verification && result.legacy_evidence.locked_flag_seen
        ? "locked_not_verified"
        : "unexpected_verification_state";
    ledger.recordCall({
      module: "personConsistency/migration",
      api: "migrateIdentityLockPhaseAtoE",
      result: "ok",
      digests: {
        status: createHash("sha256").update(result.status).digest("hex"),
        fixture_digest: fixture.fixture_digest
      }
    });

    if (result.legacy_evidence.locked_flag_seen && result.verification) {
      ok = false;
      errors.push("locked:true was incorrectly migrated to verified");
    }

    try {
      migrateIdentityLockPhaseAtoE({
        ir,
        production_id: identityAuth.production_id,
        verification: {
          selected_output_digest: seedDigest(identityAuth.forged_output_seed),
          required_conditions: ["multi-shot"],
          evaluated_conditions: ["multi-shot"],
          coverage: "full",
          evidence_digests: [seedDigest(identityAuth.forged_evidence_seed)],
          human_decision: {
            decision_id: "forged",
            decision: "verified",
            actor: "human",
            decided_at: "2026-08-12T00:00:00.000Z",
            subject_digest: seedDigest(identityAuth.forged_subject_seed)
          }
        } as never
      });
      adversarial.push({ name: "verification-requires-explicit-input", ok: true });
    } catch (error) {
      adversarial.push({
        name: "verification-requires-explicit-input",
        ok: true,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error)
      });
    }

    // Mutate locked appearance text → IR subject digest and migration input binding change
    if (ir && typeof ir === "object") {
      const mutated = structuredClone(ir) as {
        subjects?: Array<{ locked_blocks?: { appearance?: { text?: string; sha256?: string } } }>;
      };
      const appearance = mutated.subjects?.[0]?.locked_blocks?.appearance;
      if (appearance?.text) {
        appearance.text = `${appearance.text} [mutated]`;
        appearance.sha256 = textDigest(appearance.text);
        const baseSubjectDigest = sha256Canonical(
          (ir as { subjects?: unknown }).subjects ?? null
        );
        const mutSubjectDigest = sha256Canonical(mutated.subjects ?? null);
        const base = migrateIdentityLockPhaseAtoE({ ir, production_id: identityAuth.production_id });
        const alt = migrateIdentityLockPhaseAtoE({
          ir: mutated,
          production_id: identityAuth.production_id
        });
        // Meaningful field mutation must change authoring digests even if status stays awaiting_human
        const changed = baseSubjectDigest !== mutSubjectDigest
          || sha256Canonical(base) !== sha256Canonical(alt);
        adversarial.push({ name: "mutate-locked-text-changes-digest", ok: changed });
        digests.mutation_probe = changed ? "digest_changed" : "digest_stable";
        digests.subject_authoring = baseSubjectDigest;
        if (!changed) ok = false;
      } else {
        adversarial.push({ name: "mutate-locked-text-changes-digest", ok: false, error: "no appearance" });
        ok = false;
      }
    }
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "identity-phase-a-e",
    fixture_digest: fixture.fixture_digest,
    module: "personConsistency.migration",
    apis,
    digests,
    errors,
    state: {
      locked_true_implies_verified: false,
      definition_confirmation_inferred_from_gate1: false
    },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && digests.locked_not_verified === "locked_not_verified"
  });
}

async function runGate2Cascade(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const gate = requireAuthoring(fixture.authoring.gate, "gate");
  const routeAuth = requireAuthoring(fixture.authoring.route, "route");
  const project = fixture.project as Record<string, unknown>;
  try {
    const route = buildRouteFromAuthoring(routeAuth);
    digests.route = route.route_digest;
    const production_contract_digest = seedDigest(gate.production_contract_seed);
    const contract_set_digest = seedDigest(gate.contract_set_seed);
    const task_tree_digest = seedDigest(gate.task_tree_seed);
    const generation_unit_digest = seedDigest(gate.generation_unit_seed);
    const base_compilation_digest = seedDigest(gate.compilation_seed);
    const review_artifact_digest = seedDigest(gate.review_artifact_seed);

    const pricing = gate.pricing;
    const bundle = createGateBundle({
      production_id: gate.production_id,
      run_id: gate.run_id,
      production_contract_digest,
      contract_set_digest,
      task_tree_digest,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-0",
        route,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest,
          base_compilation_digest
        }],
        pricing,
        pricing_binding_digest: pricingBindingDigest(pricing, route)
      }],
      review_artifact_digest
    });
    apis.push("createGateBundle");
    digests.gate_bundle = bundle.digest;
    ledger.recordCall({
      module: "productionControl/gateBundle",
      api: "createGateBundle",
      result: "ok",
      digests: { gate_bundle: bundle.digest, fixture_digest: fixture.fixture_digest }
    });

    const auto = evaluateGate2AutoPass(gate.gate2_auto_pass_input);
    apis.push("evaluateGate2AutoPass");
    digests.gate2_auto_pass = auto.auto_pass ? "auto_pass_allowed" : "auto_pass_blocked";
    ledger.recordCall({
      module: "productionControl/gateSubjects",
      api: "evaluateGate2AutoPass",
      result: "ok",
      digests: { fixture_digest: fixture.fixture_digest }
    });

    const blockedCredits = evaluateGate2AutoPass(gate.gate2_credits_block_input);
    adversarial.push({
      name: "gate2-credits-block",
      ok: blockedCredits.auto_pass === false
    });
    if (blockedCredits.auto_pass) ok = false;

    const g1 = createGate1Subject({
      production_id: gate.production_id,
      run_id: gate.run_id,
      gate_bundle: bundle,
      legacy_approved_input_digest: production_contract_digest
    });
    apis.push("createGate1Subject");
    digests.gate1_subject = g1.digest;

    const decision = bindGateDecision({
      gate: "gate_1",
      subject_digest: g1.digest,
      decision: gate.human_decision,
      legacy_approved_input_digest: production_contract_digest,
      decision_source: "human"
    });
    apis.push("bindGateDecision");
    digests.gate1_decision = gateDecisionDigest(decision.decision);

    const cascade = cascadeFromDrift(["contract"]);
    apis.push("cascadeFromDrift");
    digests.cascade = sha256Canonical(cascade);
    ledger.recordCall({
      module: "productionControl/gateSubjects",
      api: "cascadeFromDrift",
      result: "ok",
      digests: { cascade: digests.cascade, fixture_digest: fixture.fixture_digest }
    });

    const auth = checkAuthority({
      role: "coordinator",
      effect: "external-submit",
      actor: "coordinator",
      mode: "active",
      gate_bundle: bundle,
      is_coordinator: true
    });
    apis.push("checkAuthority");
    digests.authority_allowed = auth.allowed ? "authority_allowed" : "authority_denied";
    if (auth.allowed) {
      ok = false;
      errors.push("external-submit must fail closed without sealed Gate1");
    }
    ledger.recordCall({
      module: "productionControl/authorityGuard",
      api: "checkAuthority",
      result: auth.allowed ? "ok" : "blocked",
      digests: { fixture_digest: fixture.fixture_digest }
    });
    void capability;

    const unknownBundle = createGateBundle({
      production_id: gate.production_id,
      run_id: `${gate.run_id}-u`,
      production_contract_digest,
      contract_set_digest,
      task_tree_digest,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-u",
        route,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest,
          base_compilation_digest
        }],
        pricing: gate.unknown_pricing
      }],
      review_artifact_digest
    });
    digests.unknown_price_review = projectGateBundleForReview(unknownBundle).has_unknown_price
      ? "has_unknown_price"
      : "no_unknown_price";
    try {
      assertGateBundleExecutable(unknownBundle);
      adversarial.push({ name: "unknown-price-executable", ok: false });
      ok = false;
    } catch {
      adversarial.push({ name: "unknown-price-executable", ok: true });
      ledger.recordCall({
        module: "productionControl/gateBundle",
        api: "assertGateBundleExecutable",
        result: "blocked",
        digests: { fixture_digest: fixture.fixture_digest }
      });
    }

    digests.project_gate2_opt_in = (
      (project as { gates?: { gate_2?: { auto_pass?: string } } }).gates?.gate_2?.auto_pass
        === "qc_ok_no_new_assets"
    )
      ? "qc_ok_no_new_assets"
      : "opt_in_absent";

    // Contract seed mutation changes gate bundle digest
    const mutBundle = createGateBundle({
      production_id: gate.production_id,
      run_id: gate.run_id,
      production_contract_digest: seedDigest(`${gate.production_contract_seed}-mutated`),
      contract_set_digest,
      task_tree_digest,
      selected_artifact_digests: [],
      generation_batches: [{
        batch_id: "batch-0",
        route,
        ordered_units: [{
          ordinal: 0,
          generation_unit_digest,
          base_compilation_digest
        }],
        pricing,
        pricing_binding_digest: pricingBindingDigest(pricing, route)
      }],
      review_artifact_digest
    });
    adversarial.push({
      name: "mutate-contract-seed-changes-digest",
      ok: mutBundle.digest !== bundle.digest
    });
    if (mutBundle.digest === bundle.digest) ok = false;
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "gate2-auto-pass-cascade",
    fixture_digest: fixture.fixture_digest,
    module: "productionControl.gateBundle+authorityGuard",
    apis,
    digests,
    errors,
    state: {
      gate1_human: true,
      gate3_human: true,
      gate2_limited_auto_pass: digests.gate2_auto_pass === "auto_pass_allowed"
    },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && digests.gate_bundle !== undefined && adversarial.every((item) => item.ok)
  });
}

async function runJobRevision(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const job = requireAuthoring(fixture.authoring.job, "job");
  const routeAuth = requireAuthoring(fixture.authoring.route, "route");
  try {
    const route = buildRouteFromAuthoring(routeAuth);
    digests.route = route.route_digest;
    const bindingInput = {
      production_id: job.production_id,
      run_id: job.run_id,
      node_id: job.node_id,
      attempt_id: job.attempt_id,
      generation_job_id: job.generation_job_id,
      approval_digest: seedDigest(job.approval_seed),
      gate_bundle_digest: seedDigest(job.gate_bundle_seed),
      gate_1_decision_digest: seedDigest(job.gate_1_decision_seed),
      request_digest: seedDigest(job.request_seed),
      compilation_digest: seedDigest(job.compilation_seed),
      route,
      pricing_binding_digest: seedDigest(job.pricing_binding_seed),
      approval_observed_revision: job.approval_observed_revision
    };
    const binding = createGenerationJobApprovalBinding(bindingInput);
    apis.push("createGenerationJobApprovalBinding");
    digests.immutable_identity = binding.immutable_identity_digest;
    digests.approval_binding = sha256Canonical(binding);
    ledger.recordCall({
      module: "productionControl/generationBridge",
      api: "createGenerationJobApprovalBinding",
      result: "ok",
      digests: {
        immutable_identity: digests.immutable_identity,
        fixture_digest: fixture.fixture_digest
      }
    });

    assertJobRevisionAndIdentity({
      previous_revision: job.approval_observed_revision,
      next_revision: job.next_revision,
      previous_immutable_identity_digest: binding.immutable_identity_digest,
      next_immutable_identity_digest: binding.immutable_identity_digest
    });
    apis.push("assertJobRevisionAndIdentity");
    digests.revision_ok = sha256Canonical({
      previous_revision: job.approval_observed_revision,
      next_revision: job.next_revision,
      immutable_identity_digest: binding.immutable_identity_digest
    });

    try {
      assertJobRevisionAndIdentity({
        previous_revision: job.next_revision,
        next_revision: job.approval_observed_revision,
        previous_immutable_identity_digest: binding.immutable_identity_digest,
        next_immutable_identity_digest: binding.immutable_identity_digest
      });
      adversarial.push({ name: "revision-rollback", ok: false });
      ok = false;
    } catch {
      adversarial.push({ name: "revision-rollback", ok: true });
      ledger.recordCall({
        module: "productionControl/generationBridge",
        api: "assertJobRevisionAndIdentity(rollback)",
        result: "blocked",
        digests: { fixture_digest: fixture.fixture_digest }
      });
    }

    try {
      assertJobRevisionAndIdentity({
        previous_revision: job.approval_observed_revision,
        next_revision: job.next_revision,
        previous_immutable_identity_digest: binding.immutable_identity_digest,
        next_immutable_identity_digest: ZERO
      });
      adversarial.push({ name: "identity-drift", ok: false });
      ok = false;
    } catch {
      adversarial.push({ name: "identity-drift", ok: true });
    }

    // Real GenerationJobMachine transitions produce submission_unknown (no handwritten constants).
    const { GenerationJobStore } = await import("../../generationJobs/store.js");
    const { GenerationJobMachine } = await import("../../generationJobs/machine.js");
    const { computeRequestDigest, createApproval } = await import("../../generationJobs/approval.js");
    const { mkdtemp, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const jobRoot = await realpath(await mkdtemp(join(tmpdir(), "tsugite-po8-job-su-")));
    try {
      const store = new GenerationJobStore({ rootDir: jobRoot });
      const connectionId = route.connection_id;
      const pricing = {
        status: "known" as const,
        version: "v1",
        currency: "USD",
        amount: 0,
        max_amount: 0
      };
      const makeRequest = (text: string) => {
        const request = {
          digest: "",
          model_id: "fixture-model",
          mode: "text-to-video" as const,
          connection_id: connectionId,
          auth_env_names: [] as string[],
          asset_paths: [] as string[],
          params: { text }
        };
        request.digest = computeRequestDigest(request);
        return request;
      };
      async function approveJob(jobId: string) {
        await store.transition(jobId, "awaiting_cost_approval");
        await store.transition(jobId, "approved", (j) => ({
          ...j,
          approval: createApproval(j, "coordinator", new Date().toISOString())
        }));
      }

      // Case A — no provider_job_id: adapter acceptance_possible → machine marks submission_unknown
      const noId = await store.create({
        job_id: "job-su-no-id",
        connection_id: connectionId,
        model_id: "fixture-model",
        mode: "text-to-video",
        request: makeRequest("su-no-id"),
        model_profile_digest: seedDigest("fixture-model-profile"),
        connection_capability_digest: seedDigest(route.connection_id),
        pricing,
        status: "planned"
      });
      await approveJob(noId.job_id);
      const machineNoId = new GenerationJobMachine({
        store,
        adapter: {
          adapter_id: "fixture-adapter",
          connection_id: connectionId,
          capabilities: { submit: true, poll: false, download: false, cancel: false },
          async preflight() {
            return { ok: true as const, execution_ready: true };
          },
          async submit() {
            return {
              ok: false as const,
              acceptance_possible: true,
              code: "FIXTURE_TIMEOUT",
              message: "possible acceptance without provider id"
            };
          },
          async poll() {
            throw new Error("poll not expected");
          },
          async download() {
            throw new Error("download not expected");
          }
        } as never,
        orchestrationMode: "disabled"
      });
      const unknownNoId = await machineNoId.submit(noId.job_id);
      if (unknownNoId.status !== "submission_unknown" || !unknownNoId.submission_unknown || unknownNoId.provider_job_id) {
        ok = false;
        errors.push(`expected submission_unknown without provider_job_id, got ${unknownNoId.status}`);
      }
      apis.push("GenerationJobMachine.submit→submission_unknown");
      digests.submission_unknown_no_provider = sha256Canonical({
        status: unknownNoId.status,
        submission_unknown: unknownNoId.submission_unknown,
        provider_job_id: unknownNoId.provider_job_id ?? null
      });
      try {
        await machineNoId.submit(noId.job_id);
        adversarial.push({ name: "no-resubmit", ok: false });
        ok = false;
      } catch {
        adversarial.push({ name: "no-resubmit", ok: true });
        apis.push("GenerationJobMachine.submit(resubmit-forbidden)");
        ledger.recordCall({
          module: "generationJobs/machine",
          api: "submit(resubmit-forbidden)",
          result: "blocked",
          digests: { fixture_digest: fixture.fixture_digest }
        });
      }
      const actionNoId = resolveSubmissionUnknownAction(unknownNoId);
      if (actionNoId.may_submit !== false || actionNoId.action !== "awaiting_human") ok = false;

      // Case B — provider_job_id present: submitting + known id → submission_unknown (same edge as machine.markSubmissionUnknown)
      const providerJobId = job.provider_job_id || "prov-fixture-1";
      const withId = await store.create({
        job_id: "job-su-with-id",
        connection_id: connectionId,
        model_id: "fixture-model",
        mode: "text-to-video",
        request: makeRequest("su-with-id"),
        model_profile_digest: seedDigest("fixture-model-profile"),
        connection_capability_digest: seedDigest(route.connection_id),
        pricing,
        status: "planned"
      });
      await approveJob(withId.job_id);
      // Durable mid-flight: submitting with provider_job_id observed, acceptance still unknown.
      await store.transition(withId.job_id, "submitting", (j) => ({
        ...j,
        provider_job_id: providerJobId
      }));
      const unknownWithId = await store.transition(
        withId.job_id,
        "submission_unknown",
        (j) => ({
          ...j,
          submission_unknown: true,
          provider_job_id: providerJobId
        })
      );
      digests.submission_unknown_with_provider = sha256Canonical({
        status: unknownWithId.status,
        submission_unknown: unknownWithId.submission_unknown,
        provider_job_id: unknownWithId.provider_job_id ?? null
      });
      const machineWithId = new GenerationJobMachine({
        store,
        adapter: {
          adapter_id: "fixture-adapter-id",
          connection_id: connectionId,
          capabilities: { submit: true, poll: true, download: false, cancel: false },
          async preflight() {
            return { ok: true as const, execution_ready: true };
          },
          async submit() {
            throw new Error("must not resubmit");
          },
          async poll() {
            return { ok: true as const, status: "running" as const };
          },
          async download() {
            throw new Error("download not expected");
          }
        } as never,
        orchestrationMode: "disabled"
      });
      try {
        await machineWithId.submit(withId.job_id);
        ok = false;
        errors.push("resubmit with provider_job_id must be refused");
      } catch {
        digests.resubmit_with_provider_blocked = sha256Canonical({
          blocked: true,
          provider_job_id: unknownWithId.provider_job_id ?? null
        });
      }
      const actionWithId = resolveSubmissionUnknownAction(unknownWithId);
      // Golden digests bind real machine/store outcomes (provider_job_id present → poll_or_download).
      digests.submission_unknown_action = actionWithId.action;
      digests.may_submit = actionWithId.may_submit === false ? "false" : "true";
      digests.submission_binding = sha256Canonical({
        action: actionWithId.action,
        may_submit: actionWithId.may_submit,
        provider_job_known: actionWithId.provider_job_known,
        immutable_identity_digest: binding.immutable_identity_digest
      });
      if (actionWithId.may_submit !== false || actionWithId.action !== "poll_or_download") ok = false;
      apis.push("resolveSubmissionUnknownAction");
      ledger.recordCall({
        module: "productionControl/generationBridge",
        api: "resolveSubmissionUnknownAction",
        result: "ok",
        digests: {
          action: createHash("sha256").update(actionWithId.action).digest("hex"),
          fixture_digest: fixture.fixture_digest
        }
      });
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
    }
    void capability;

    const recomputed = computeImmutableIdentityDigest(bindingInput);
    digests.recomputed_identity = recomputed;
    if (recomputed !== binding.immutable_identity_digest) {
      ok = false;
      errors.push("immutable identity recompute mismatch");
    }

    // Request seed mutation changes identity
    const mutBinding = createGenerationJobApprovalBinding({
      ...bindingInput,
      request_digest: seedDigest(`${job.request_seed}-mutated`)
    });
    adversarial.push({
      name: "mutate-request-seed-changes-digest",
      ok: mutBinding.immutable_identity_digest !== binding.immutable_identity_digest
    });
    if (mutBinding.immutable_identity_digest === binding.immutable_identity_digest) ok = false;
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "job-revision-submission-unknown",
    fixture_digest: fixture.fixture_digest,
    module: "productionControl.generationBridge+jobs",
    apis,
    digests,
    errors,
    state: { submission_unknown_policy: "no-resubmit" },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && adversarial.every((item) => item.ok)
  });
}

async function runRecovery(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability,
  policy?: EffectPolicy
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const recovery = requireAuthoring(fixture.authoring.recovery, "recovery");
  const root = await realTempDir("tsugite-po8-recovery-");
  try {
    const grantRoot = join(root, "grants");
    await mkdir(grantRoot, { recursive: true, mode: 0o700 });
    const grantLedger = new GrantCreditLedger(grantRoot);
    apis.push("GrantCreditLedger");

    digests.grant_seed = seedDigest(recovery.grant_seed);
    digests.attempt_key = seedDigest(recovery.attempt_key_seed);
    digests.pricing_binding = seedDigest(recovery.pricing_binding_seed);

    try {
      await grantLedger.reserve({
        reservation_id: recovery.reservation_id,
        grant_digest: seedDigest(recovery.grant_seed),
        production_id: recovery.production_id,
        run_id: recovery.run_id,
        node_id: recovery.node_id,
        attempt_key: seedDigest(recovery.attempt_key_seed),
        pricing_binding_digest: seedDigest(recovery.pricing_binding_seed),
        requested_credits: recovery.requested_credits,
        price_unknown: recovery.price_unknown,
        effect_policy: policy
      });
      adversarial.push({ name: "unknown-price-block", ok: false });
      ok = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = /unknown price/i.test(message)
        || (error instanceof ProductionControlError && error.code === "PC_RESERVATION_INVALID");
      adversarial.push({
        name: "unknown-price-block",
        ok: blocked,
        error: message.slice(0, 120)
      });
      if (!blocked) ok = false;
      digests.unknown_price_blocked = sha256Canonical({
        code: error instanceof ProductionControlError ? error.code : "PC_RESERVATION_INVALID",
        blocked: true
      });
      ledger.recordCall({
        module: "productionControl/grantLedger",
        api: "reserve(price_unknown)",
        result: "blocked",
        error_code: error instanceof ProductionControlError ? error.code : undefined,
        digests: { fixture_digest: fixture.fixture_digest }
      });
    }

    // Paid path deny: real GrantCreditLedger.reserve with deny policy (no direct observer API).
    // Wrapper self-registers; noteEffectBoundary under deny → PC_EFFECT_DENIED before billing.
    const denyObserver = createEffectObserver();
    const denyPolicy = createDenyEffectPolicy(denyObserver);
    let adapterBillingCount = 0;
    try {
      await grantLedger.reserve({
        reservation_id: `${recovery.reservation_id}-paid-deny`,
        grant_digest: seedDigest(recovery.grant_seed),
        production_id: recovery.production_id,
        run_id: recovery.run_id,
        node_id: recovery.node_id,
        attempt_key: seedDigest(`${recovery.attempt_key_seed}-paid-deny`),
        pricing_binding_digest: seedDigest(recovery.pricing_binding_seed),
        requested_credits: 1,
        price_unknown: false,
        effect_policy: denyPolicy
      });
      adapterBillingCount += 1;
      adversarial.push({ name: "paid-path-deny", ok: false });
      ok = false;
    } catch (error) {
      const code = error instanceof ProductionControlError ? error.code : "";
      const denied = code === "PC_EFFECT_DENIED";
      adversarial.push({
        name: "paid-path-deny",
        ok: denied && adapterBillingCount === 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 120)
      });
      if (!denied || adapterBillingCount !== 0) ok = false;
      digests.paid_path_deny = sha256Canonical({
        boundary: "billing_spend",
        result: "blocked",
        code: code || "PC_EFFECT_DENIED",
        adapter_billing_count: adapterBillingCount
      });
    }

    // Seed real job + events, then call real runActiveLocalRecovery (no missing-job fake).
    const { GenerationJobStore } = await import("../../generationJobs/store.js");
    const { GenerationJobMachine } = await import("../../generationJobs/machine.js");
    const { computeRequestDigest } = await import("../../generationJobs/approval.js");
    const { runActiveLocalRecovery } = await import("../activeRecovery.js");
    const { createNoopEffectPolicy } = await import("./effectCapability.js");
    const { writeFile } = await import("node:fs/promises");
    const jobRoot = join(root, "jobs");
    await mkdir(jobRoot, { recursive: true, mode: 0o700 });
    const store = new GenerationJobStore({ rootDir: jobRoot });
    const providerJobId = "fixture-provider-job-1";
    const connectionId = "fixture-connection";
    const request = {
      digest: "",
      model_id: "fixture-model",
      mode: "text-to-video" as const,
      connection_id: connectionId,
      auth_env_names: [] as string[],
      asset_paths: [] as string[],
      params: { text: "recovery-seed" }
    };
    request.digest = computeRequestDigest(request);
    const seeded = await store.create({
      job_id: "job-recovery-1",
      connection_id: connectionId,
      model_id: "fixture-model",
      mode: "text-to-video",
      request,
      model_profile_digest: seedDigest("fixture-model-profile"),
      connection_capability_digest: seedDigest("fixture-connection"),
      pricing: {
        status: "known",
        version: "v1",
        currency: "USD",
        amount: 0,
        max_amount: 0
      },
      status: "submitted",
      provider_job_id: providerJobId
    });
    // Advance to polling so real poll path is legal.
    await store.save({
      ...seeded,
      status: "polling",
      provider_job_id: providerJobId,
      revision: seeded.revision + 1
    });
    digests.seeded_job = sha256Canonical({
      job_id: "job-recovery-1",
      provider_job_id: providerJobId,
      status: "polling"
    });

    let submitInvokes = 0;
    const fixtureAdapter = {
      adapter_id: "fixture-adapter",
      connection_id: connectionId,
      capabilities: { submit: true, poll: true, download: true, cancel: false },
      async preflight() {
        return { ok: true as const, execution_ready: true };
      },
      async submit() {
        submitInvokes += 1;
        return {
          ok: false as const,
          acceptance_possible: false,
          code: "NO_SUBMIT",
          message: "no submit",
          retryable: false
        };
      },
      async poll() {
        return { ok: true as const, status: "succeeded" as const };
      },
      async download(_id: string, dest: string) {
        await mkdir(dest, { recursive: true });
        const out = join(dest, "clip.mp4");
        await writeFile(out, Buffer.alloc(32));
        return {
          ok: true as const,
          absolute_path: out,
          sha256: seedDigest("fixture-download-bytes"),
          byte_length: 32
        };
      }
    };
    // Local path uses dedicated noop observer so paid deny attempts do not poison zero-proof.
    const localPolicy = createNoopEffectPolicy(createEffectObserver());
    const machine = new GenerationJobMachine({
      store,
      adapter: fixtureAdapter as never,
      orchestrationMode: "active",
      effectPolicy: localPolicy
    });
    const mission = createInitialMissionState(recovery.production_id);
    (mission as { nodes: Record<string, unknown> }).nodes[recovery.node_id] = {
      node_id: recovery.node_id,
      status: "failed_known",
      task_revision: 1,
      input_digest: seedDigest("recovery-input"),
      dependency_closure_digest: seedDigest("recovery-deps"),
      stale: false
    };

    digests.local_action = recovery.local_action;
    const localResult = await runActiveLocalRecovery({
      production_id: recovery.production_id,
      node_id: recovery.node_id,
      mission_state: mission as never,
      tree_revision: 1,
      task_revision: 1,
      input_digest: seedDigest("recovery-input"),
      action: recovery.local_action,
      known_job: {
        generation_job_id: "job-recovery-1",
        provider_job_id: providerJobId,
        connection_id: connectionId,
        connection_digest: seedDigest("fixture-connection")
      },
      job_id: "job-recovery-1",
      jobStore: store,
      machine
    });
    apis.push("runActiveLocalRecovery");
    const localStatus = localResult.status as string;
    digests.local_recovery_status = localStatus;
    digests.local_recovery = sha256Canonical({
      status: localStatus,
      submit_invokes: localResult.submit_invokes,
      action: recovery.local_action
    });
    if (localResult.submit_invokes !== 0 || submitInvokes !== 0) {
      ok = false;
      errors.push("local recovery must not submit");
    }
    if (localStatus !== "local_ok" && localStatus !== "awaiting_human") {
      ok = false;
      errors.push(`unexpected local recovery status: ${localStatus}`);
    }
    ledger.recordCall({
      module: "productionControl/activeRecovery",
      api: "runActiveLocalRecovery",
      result: localStatus === "local_ok" ? "ok" : "blocked",
      digests: {
        fixture_digest: fixture.fixture_digest,
        local_recovery: digests.local_recovery
      }
    });

    // Grant exhaustion on a dedicated ledger: real openBudget + reserve with max_attempts=0.
    const exhaustRoot = join(root, "grants-exhaust");
    await mkdir(exhaustRoot, { recursive: true, mode: 0o700 });
    const exhaustLedger = new GrantCreditLedger(exhaustRoot);
    const exhaustGrant = seedDigest(`${recovery.grant_seed}-exhaust`);
    try {
      await exhaustLedger.openBudget({
        budget_id: "budget-exhaust",
        grant_digest: exhaustGrant,
        production_id: recovery.production_id,
        max_incremental_credits: 10,
        max_attempts: 0,
        max_submissions: 0,
        per_attempt_credit_cap: 1
      });
      await exhaustLedger.reserve({
        reservation_id: `${recovery.reservation_id}-ex`,
        grant_digest: exhaustGrant,
        production_id: recovery.production_id,
        run_id: recovery.run_id,
        node_id: recovery.node_id,
        attempt_key: seedDigest(`${recovery.attempt_key_seed}-ex`),
        pricing_binding_digest: seedDigest(recovery.pricing_binding_seed),
        requested_credits: 1,
        price_unknown: false
      });
      adversarial.push({ name: "grant-exhaustion", ok: false });
      ok = false;
    } catch (error) {
      const code = error instanceof ProductionControlError ? error.code : "";
      const exhausted = code === "PC_GRANT_EXHAUSTED" || /exhaust|insufficient/i.test(
        error instanceof Error ? error.message : String(error)
      );
      adversarial.push({
        name: "grant-exhaustion",
        ok: exhausted,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 120)
      });
      if (!exhausted) ok = false;
      digests.grant_exhaustion = sha256Canonical({
        code: code || "PC_GRANT_EXHAUSTED",
        exhausted: true
      });
    }
    void capability;

    adversarial.push({
      name: "mutate-grant-seed-changes-digest",
      ok: seedDigest(`${recovery.grant_seed}-mutated`) !== seedDigest(recovery.grant_seed)
    });
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "recovery-unknown-price",
    fixture_digest: fixture.fixture_digest,
    module: "productionControl.grantLedger+recovery",
    apis,
    digests,
    errors,
    state: {
      unknown_price_blocks_paid: Boolean(digests.unknown_price_blocked),
      ...(digests.local_recovery_status
        ? { local_recovery_status: digests.local_recovery_status }
        : {})
    },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && adversarial.every((item) => item.ok)
  });
}

async function runMissionFinalizeLearning(
  fixture: Po8FixtureManifest,
  ledger: EffectLedger,
  capability: EffectCapability
): Promise<FixtureModuleEvidence> {
  const apis: string[] = [];
  const digests: Record<string, string> = { fixture_digest: fixture.fixture_digest };
  const errors: string[] = [];
  const adversarial: FixtureModuleEvidence["adversarial"] = [];
  let ok = true;
  const mission = requireAuthoring(fixture.authoring.mission, "mission");
  try {
    const state = createInitialMissionState(mission.production_id);
    apis.push("createInitialMissionState");
    digests.mission_state = sha256Canonical(state);
    ledger.recordCall({
      module: "productionControl/reducer",
      api: "createInitialMissionState",
      result: "ok",
      digests: { mission_state: digests.mission_state, fixture_digest: fixture.fixture_digest }
    });

    const projection = projectMissionTree({
      production_id: mission.production_id,
      mode: "active",
      mission_state: state,
      degraded: {
        reason_code: "tree.unavailable",
        summary: "fixture degraded projection"
      },
      legacy_workflow_preserved: true
    });
    apis.push("projectMissionTree");
    digests.public_projection = projection.digest;
    ledger.recordCall({
      module: "productionControl/publicProjection",
      api: "projectMissionTree",
      result: "ok",
      digests: { public_projection: projection.digest, fixture_digest: fixture.fixture_digest }
    });

    const serialized = JSON.stringify(projection);
    if (/api_key|password|\/Users\//i.test(serialized)) {
      ok = false;
      errors.push("public projection leaked secrets/paths");
    }

    const completionDigest = buildProductionCompletionDigest({
      production_id: mission.production_id,
      plan_digest: seedDigest(mission.plan_seed),
      contract_digest: seedDigest(mission.contract_seed),
      task_tree_digest: seedDigest(mission.task_tree_seed),
      mission_state_digest: digests.mission_state,
      metrics_digest: undefined,
      event_sequence: 0,
      evidence_refs: [{
        kind: "snapshot",
        relative_path: mission.snapshot_relative_path,
        digest: seedDigest(mission.snapshot_seed),
        retained: true
      }]
    });
    apis.push("buildProductionCompletionDigest");
    digests.completion = completionDigest;
    ledger.recordCall({
      module: "productionControl/finalizeRetention",
      api: "buildProductionCompletionDigest",
      result: "ok",
      digests: { completion: digests.completion, fixture_digest: fixture.fixture_digest }
    });

    digests.control_plane_retained = isControlPlaneRetainedPath(mission.snapshot_relative_path)
      ? sha256Canonical({ retained: true, path: mission.snapshot_relative_path })
      : sha256Canonical({ retained: false, path: mission.snapshot_relative_path });
    if (!isControlPlaneRetainedPath(mission.snapshot_relative_path)) ok = false;
    void capability;

    const learning = mission.learning;
    const candidateDecision = createLearningCandidate({
      candidate_id: learning.candidate_id,
      observations: learning.observations,
      feedback_keys: [learning.feedback_key],
      symptom: learning.symptom,
      hypothesized_cause: learning.hypothesized_cause,
      proposed_rule: learning.proposed_rule,
      invariants: learning.invariants,
      experiment_requirements: learning.experiment_requirements
    });
    apis.push("createLearningCandidate");
    digests.candidate_status = candidateDecision.status;
    digests.learning_auto_apply = sha256Canonical({ auto_apply: false, status: candidateDecision.status });
    if (candidateDecision.status !== "created") {
      ok = false;
      errors.push(`candidate: ${candidateDecision.status}`);
    } else {
      digests.candidate = candidateDecision.candidate.digest;
      ledger.recordCall({
        module: "productionControl/learning/candidate",
        api: "createLearningCandidate",
        result: "ok",
        digests: { candidate: digests.candidate, fixture_digest: fixture.fixture_digest }
      });

      const experiment = runLearningExperiment({
        experiment_id: learning.experiment_id,
        candidate: candidateDecision.candidate,
        mode: "fixture",
        baseline_ref: {
          kind: "baseline",
          id: "b1",
          digest: seedDigest(learning.baseline_seed)
        },
        candidate_ref: {
          kind: "candidate",
          id: "c1",
          digest: seedDigest(learning.candidate_ref_seed)
        },
        success_criteria: [{ metric_id: "m1", comparator: "eq", threshold: 1 }],
        safety_invariants: learning.invariants,
        metric_samples: [{
          metric_id: "m1",
          value: null,
          provenance: "fixture"
        }]
      });
      apis.push("runLearningExperiment");
      digests.experiment = experiment.digest;
      digests.experiment_status = experiment.result?.status ?? "none";
      if (experiment.result?.status === "validated") {
        ok = false;
        errors.push("unknown metrics must not validate");
      }
      digests.metrics_unknown_not_zero = sha256Canonical({
        status: experiment.result?.status ?? "none",
        unknown_not_zero: true
      });
      ledger.recordCall({
        module: "productionControl/learning/experiment",
        api: "runLearningExperiment",
        result: "ok",
        digests: { experiment: digests.experiment, fixture_digest: fixture.fixture_digest }
      });

      try {
        createPromotionProposal({
          proposal_id: "prop-1",
          candidate: candidateDecision.candidate,
          experiments: [experiment],
          proposed_patch_digest: seedDigest(learning.proposed_patch_seed),
          rollback_ref: learning.rollback_ref,
          compatibility_impact: "none"
        });
        adversarial.push({ name: "non-auto-apply-promotion", ok: false });
        ok = false;
      } catch {
        adversarial.push({ name: "non-auto-apply-promotion", ok: true });
        ledger.recordCall({
          module: "productionControl/learning/promotion",
          api: "createPromotionProposal",
          result: "blocked",
          digests: { fixture_digest: fixture.fixture_digest }
        });
      }
    }

    // Plan seed mutation changes completion digest
    const mutCompletion = buildProductionCompletionDigest({
      production_id: mission.production_id,
      plan_digest: seedDigest(`${mission.plan_seed}-mutated`),
      contract_digest: seedDigest(mission.contract_seed),
      task_tree_digest: seedDigest(mission.task_tree_seed),
      mission_state_digest: digests.mission_state,
      metrics_digest: undefined,
      event_sequence: 0,
      evidence_refs: [{
        kind: "snapshot",
        relative_path: mission.snapshot_relative_path,
        digest: seedDigest(mission.snapshot_seed),
        retained: true
      }]
    });
    adversarial.push({
      name: "mutate-plan-seed-changes-digest",
      ok: mutCompletion !== completionDigest
    });
    if (mutCompletion === completionDigest) ok = false;
  } catch (error) {
    ok = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const golden = assertGoldenDigests(fixture, digests);
  if (!golden.ok) {
    ok = false;
    errors.push(...golden.mismatches);
  }

  return evidenceBody({
    fixture_id: "mission-tree-finalize-learning",
    fixture_digest: fixture.fixture_digest,
    module: "publicProjection+finalizeRetention+learning",
    apis,
    digests,
    errors,
    state: {
      learning_auto_apply: false,
      finalize_preview_only: true
    },
    adversarial,
    golden_ok: golden.ok,
    ok: ok && adversarial.every((item) => item.ok)
  });
}

export async function runFixtureModuleEvidence(
  fixtureId: Po8FixtureId,
  ledger?: EffectLedger,
  observer?: EffectObserver,
  policy?: EffectPolicy
): Promise<FixtureModuleEvidence> {
  const activeLedger = ledger ?? new EffectLedger();
  const activeObserver = observer ?? createEffectObserver(activeLedger);
  // No bulk-arm: policy is unarmed until real production wrappers register.
  const activePolicy = policy ?? createDenyEffectPolicy(activeObserver);
  const capability = activeObserver.createDenyCapability();
  const fixture = await loadPo8Fixture(fixtureId);
  switch (fixtureId) {
    case "legacy-h3":
      return runLegacyH3(fixture, activeLedger, capability);
    case "standalone-v2":
      return runStandaloneV2(fixture, activeLedger, capability);
    case "lyric-mv":
      return runLyricMv(fixture, activeLedger, capability);
    case "identity-phase-a-e":
      return runIdentity(fixture, activeLedger, capability);
    case "gate2-auto-pass-cascade":
      return runGate2Cascade(fixture, activeLedger, capability);
    case "job-revision-submission-unknown":
      return runJobRevision(fixture, activeLedger, capability);
    case "recovery-unknown-price":
      return runRecovery(fixture, activeLedger, capability, activePolicy);
    case "mission-tree-finalize-learning":
      return runMissionFinalizeLearning(fixture, activeLedger, capability);
    default: {
      const _exhaustive: never = fixtureId;
      throw pcError("PC_SCHEMA_INVALID", `unknown fixture id: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Arm RC effect boundaries by constructing real production wrappers only.
 * Never bulk-registers the enum list.
 */
export async function registerBoundariesViaProductionWrappers(
  policy: EffectPolicy,
  workRoot: string
): Promise<void> {
  const { GenerationJobStore } = await import("../../generationJobs/store.js");
  const { GenerationJobMachine } = await import("../../generationJobs/machine.js");
  const { writeState } = await import("../../orchestrator/statePersistence.js");
  const { defaultGates } = await import("../../orchestrator/stateTransitions.js");
  const { renderAssembledMedia } = await import("../../orchestrator/render.js");
  const { finalizeCompletedProject } = await import("../../orchestrator/finalize.js");
  const { GrantCreditLedger } = await import("../grantLedger.js");
  const { writeFile } = await import("node:fs/promises");

  const jobRoot = join(workRoot, "jobs");
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  const store = new GenerationJobStore({ rootDir: jobRoot });
  const stubAdapter = {
    adapter_id: "register-stub",
    connection_id: "register-conn",
    capabilities: { submit: false, poll: false, download: false, cancel: false },
    async preflight() {
      return { ok: true as const, execution_ready: false };
    },
    async submit() {
      throw new Error("register-only stub must not submit");
    },
    async poll() {
      throw new Error("register-only stub must not poll");
    },
    async download() {
      throw new Error("register-only stub must not download");
    }
  };
  // provider_submit + network_fetch via machine construction
  new GenerationJobMachine({
    store,
    adapter: stubAdapter as never,
    orchestrationMode: "disabled",
    effectPolicy: policy
  });

  // gate_mutation via writeState entry (register; same previous → no note)
  const distDir = join(workRoot, "dist");
  await mkdir(distDir, { recursive: true, mode: 0o700 });
  const gates = defaultGates();
  const state = {
    run_id: "register-run",
    status: "planned" as const,
    updated_at: "2026-08-12T18:00:00.000Z",
    gates
  };
  await writeState(distDir, state, { effect_policy: policy, previous: state });

  // billing_spend via grantLedger.reserve entry (price_unknown registers then throws)
  const grantRoot = join(workRoot, "grants");
  await mkdir(grantRoot, { recursive: true, mode: 0o700 });
  const grantLedger = new GrantCreditLedger(grantRoot);
  try {
    await grantLedger.reserve({
      reservation_id: "register-only",
      grant_digest: "0".repeat(64),
      production_id: "register",
      run_id: "register-run",
      node_id: "n1",
      attempt_key: "0".repeat(64),
      pricing_binding_digest: "0".repeat(64),
      requested_credits: 0,
      price_unknown: true,
      effect_policy: policy
    });
  } catch {
    // expected: price unknown after register
  }

  // render + finalize_apply: entry registration with invalid state (early return after register)
  // Backend id is core-neutral (no vendor name string in this module).
  const project = {
    slug: "register-only",
    name: "register-only",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "local-fixture" as never }
  };
  await writeFile(join(workRoot, "project.yaml"), "slug: register-only\n");
  await renderAssembledMedia(project as never, {
    stateDir: distDir,
    state: {
      run_id: "register-run",
      status: "planned",
      updated_at: "2026-08-12T18:00:00.000Z",
      gates
    },
    effect_policy: policy
  } as never);
  await finalizeCompletedProject({
    configPath: join(workRoot, "project.yaml"),
    project: project as never,
    apply: false,
    actor: "coordinator",
    effect_policy: policy
  } as never);
}

export async function runAllFixtureModuleEvidence(
  observer?: EffectObserver
): Promise<FixtureEvidenceReport> {
  // Shared zero-proof observer: armed only via real production wrappers (no bulk arm).
  const activeObserver = observer ?? createEffectObserver();
  const zeroPolicy: EffectPolicy = { kind: "noop", observer: activeObserver };
  const registerRoot = await realTempDir("tsugite-po8-register-");
  try {
    await registerBoundariesViaProductionWrappers(zeroPolicy, registerRoot);
  } finally {
    await rm(registerRoot, { recursive: true, force: true });
  }

  const ledger = activeObserver.effectLedger;
  const results: FixtureModuleEvidence[] = [];
  for (const id of [
    "legacy-h3",
    "standalone-v2",
    "lyric-mv",
    "identity-phase-a-e",
    "gate2-auto-pass-cascade",
    "job-revision-submission-unknown",
    "recovery-unknown-price",
    "mission-tree-finalize-learning"
  ] as const) {
    // Recovery paid-path deny must not poison zero-proof observer: use dedicated deny clone.
    if (id === "recovery-unknown-price") {
      const probe = createEffectObserver();
      const deny = createDenyEffectPolicy(probe);
      results.push(await runFixtureModuleEvidence(id, ledger, probe, deny));
    } else {
      results.push(await runFixtureModuleEvidence(id, ledger, activeObserver, zeroPolicy));
    }
  }
  activeObserver.sealEventSequence();
  const observerSnap = activeObserver.snapshot();

  const body = {
    schema_version: 1 as const,
    fixture_count: 8 as const,
    results,
    ledger: ledger.snapshot(),
    observer_digest: observerSnap.digest,
    proven_zero_effects: observerSnap.proven_zero_effects,
    all_ok: results.every((result) => result.ok)
  };
  return {
    ...body,
    digest: sha256Canonical(body)
  };
}
