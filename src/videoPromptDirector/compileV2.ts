import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  assertHomogeneousRouteIdentity,
  assertRouteIdentity,
  assertEffectiveGenerationContract,
  createEffectiveGenerationContract,
  type EffectiveGenerationContractV1,
  type PromptBudget
} from "./effectiveContract.js";
import type { TrustedPinnedPromptBudgetEvidence } from "./promptBudgetEvidence.js";
import {
  compileAdapterDialect,
  resolveRendererDialectCapability,
  validateAdapterDialect,
  type AdapterDialectCapability,
  type AdapterDialectResult
} from "./adapterDialect.js";
import {
  createCompilationBundle,
  createVerifiedAssetPin,
  isProjectAssetIdentityContained,
  type CompilationBundleV1
} from "./compilationBundle.js";
import {
  buildSemanticBlocks,
  semanticBlockDigestMap,
  type SemanticPromptBlock
} from "./semanticBlocks.js";
import {
  parseVideoPromptIrV2,
  programBindingSchema,
  type ProgramBindingForV2,
  type VideoPromptIrV2
} from "./schemaV2.js";
import { upgradeH3V1ToVideoPromptV2 } from "./upgradeV1.js";
import type { H3CreativeIr } from "./schema.js";
import {
  H3_GRAMMAR_V3_VERSION,
  renderH3GrammarV3,
  renderProviderNeutralPrompt,
  type H3GrammarProfileV3,
  type H3GrammarV3Options,
  DEFAULT_H3_GRAMMAR_PROFILE_V3
} from "./render/h3GrammarV3.js";
import { isTrustedH3GrammarProfile } from "./render/h3GrammarV3.js";
import { renderH3Prompt } from "./render/h3Grammar.js";
import { issue, type H3Issue, type H3ValidationResult } from "./validation/types.js";
import type { RouteIdentityV1 } from "../productionControl/programBinding.js";
import { connectionCapabilityDigest, type ConnectionCapabilityProfile } from "./connectionCapability.js";
import { modelProfileDigest, type ModelPromptProfile } from "./modelProfile.js";
import { identityDefinitionSchema, type IdentityDefinitionContractV1 } from "../personConsistency/schema.js";
import {
  assertProgramBindingMatchesSource,
  generationUnitProgramSourceSchema,
  type GenerationUnitProgramSourceV1
} from "../productionControl/programBinding.js";
import { generationUnitContractFacts, isAuthoritativeGenerationUnitSource } from "./generationUnitSourceResolver.js";
import { consumeGenerationUnitLyricsForSource, type TrustedGenerationUnitLyricsToken } from "./generationUnitSourceResolver.js";

export const VIDEO_PROMPT_V2_WORKFLOW_ID = "video-prompt-v3" as const;
export const VIDEO_PROMPT_V2_WORKFLOW_VERSION = H3_GRAMMAR_V3_VERSION;

export type GenerationUnitDurationBinding = GenerationUnitProgramSourceV1;

export type CompileVideoPromptV2Options = {
  request_id?: string;
  request_index?: number;
  route?: RouteIdentityV1;
  batch_routes?: readonly RouteIdentityV1[];
  model_profile_digest?: string;
  connection_capability_digest?: string;
  effective_contract?: EffectiveGenerationContractV1;
  budget?: PromptBudget;
  trusted_pinned_budget_evidence?: TrustedPinnedPromptBudgetEvidence;
  /** Public callers cannot provide raw lyric authority; MV lyrics come from this opaque T04 token. */
  generation_unit_lyrics_token?: TrustedGenerationUnitLyricsToken;
  require_exact_sync?: boolean;
  grammar_profile?: H3GrammarProfileV3;
  require_pinned_grammar?: boolean;
  contract_bindings?: string[];
  source?: {
    authoring_schema: "VideoPromptIrV2" | "V1" | "H3-V1";
    upgrader_version: string;
    source_digest?: string;
  };
  generation_unit_source?: GenerationUnitProgramSourceV1;
  require_route?: boolean;
  intent?: "planning" | "execute";
  model_profile?: ModelPromptProfile;
  connection_profile?: ConnectionCapabilityProfile;
  adapter_dialect_capability?: AdapterDialectCapability;
  project_root?: string;
  asset_evidence?: Readonly<Record<string, AssetPinEvidence>>;
  asset_pin_root?: string;
};

export type AssetPinEvidence = {
  source: "project-bytes" | "asset-contract";
  real_path: string;
  sha256: string;
  byte_size: number;
  regular_file: true;
  contained_in_project_root: true;
  asset_contract?: {
    contract_id: string;
    revision: number;
    digest: string;
    entry_id: string;
    path: string;
    sha256: string;
    byte_size: number;
    external_send: "allowed" | "forbidden" | "needs-human";
  };
};

export type VideoPromptV2Compilation = {
  request_id: string;
  normalized_ir: VideoPromptIrV2;
  normalized_ir_digest: string;
  effective_contract: EffectiveGenerationContractV1;
  semantic_blocks: SemanticPromptBlock[];
  canonical_prompt: string;
  adapter_prompt: string;
  dialect: AdapterDialectResult;
  validation: H3ValidationResult;
  route: RouteIdentityV1;
  bundle: CompilationBundleV1;
  lineage: {
    workflow_id: typeof VIDEO_PROMPT_V2_WORKFLOW_ID;
    workflow_version: typeof VIDEO_PROMPT_V2_WORKFLOW_VERSION;
    normalized_ir_digest: string;
    block_digests: Record<string, string>;
    canonical_prompt_digest: string;
    adapter_prompt_digest: string;
    model_profile_digest: string;
    connection_capability_digest: string;
    adapter_capability_digest: string;
    program_binding_digest?: string;
    generation_unit_source_digest?: string;
    generation_unit_source_canonical_digest?: string;
  };
};

export type CompileVideoPromptV2Result =
  | { ok: true; compilation: VideoPromptV2Compilation; issues: [] }
  | { ok: false; compilation?: Omit<VideoPromptV2Compilation, "bundle"> & { bundle?: undefined }; issues: H3Issue[] };

export type LegacyH3CompatibilityCompilation = {
  compatibility_mode: "legacy-h3-v2-golden";
  upgraded_ir?: VideoPromptIrV2;
  source_sha256?: string;
  upgrade_error?: string;
  canonical_prompt: string;
  adapter_prompt: string;
};

export function compileVideoPromptIrV2(
  input: unknown,
  options: CompileVideoPromptV2Options = {}
): CompileVideoPromptV2Result {
  const parsed = parseV2(input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const ir = parsed.ir;
  const issues: H3Issue[] = [];
  const requestId = options.request_id ?? "video-prompt-v2";
  const route = options.route;
  const requireRoute = options.require_route ?? true;
  const intent = options.intent ?? "planning";
  if (!route) {
    if (requireRoute) {
      issues.push(issue("VPD-R001", "VideoPromptIrV2 compilation requires a pinned RouteIdentity", "error", ["route"]));
    }
  } else {
    issues.push(...assertRouteIdentity(route, {
      model: ir.target.model_profile_id,
      mode: ir.target.mode,
      model_profile_digest: options.model_profile_digest,
      connection_digest: options.connection_capability_digest
    }));
  }
  if (options.batch_routes) issues.push(...assertHomogeneousRouteIdentity(options.batch_routes));
  if (route) {
    const rendererDialect = resolveRendererDialectCapability({
      route,
      ...(options.model_profile ? { model_profile: options.model_profile } : {}),
      ...(options.connection_profile ? { connection_profile: options.connection_profile } : {}),
      ...(options.adapter_dialect_capability ? { adapter_dialect_capability: options.adapter_dialect_capability } : {})
    });
    if (!rendererDialect) {
      issues.push(issue("VPD-R002", "route has no digest-bound adapter renderer/dialect capability", "error", ["route", "adapter_id"]));
    } else if (options.model_profile && (
      rendererDialect.renderer !== options.model_profile.renderer
      || rendererDialect.label_dialect !== options.model_profile.label_dialect
    )) {
      issues.push(issue("VPD-R002", "route adapter renderer/dialect does not match the pinned model profile", "error", ["route", "adapter_id"]));
    }
    if (options.connection_profile && options.connection_profile.adapter_id !== route.adapter_id) {
      issues.push(issue("VPD-R002", "route adapter does not match the pinned connection profile adapter", "error", ["route", "adapter_id"]));
    }
  }
  if (ir.program_kind === "mv") {
    if (!options.generation_unit_source) {
      issues.push(issue("VPD-U001", "MV compilation requires the authoritative T04 GenerationUnitProgramSource", "error", ["generation_unit_source"]));
    } else if (!isAuthoritativeGenerationUnitSource(options.generation_unit_source)) {
      issues.push(issue("VPD-U001", "MV source must be derived by the authoritative T04 artifact resolver", "error", ["generation_unit_source"]));
    } else {
      if (!generationUnitContractFacts(options.generation_unit_source)) {
        issues.push(issue("VPD-U001", "MV source is missing the complete T04 GenerationUnitContract snapshot", "error", ["generation_unit_source"]));
      }
      issues.push(...validateMvBinding(
        ir.program_binding,
        ir.target.duration_ms,
        options.generation_unit_source,
        route,
        options.request_id,
        options.request_index
      ));
    }
  }
  if (ir.program_kind === "standalone" && "program_binding" in ir && ir.program_binding !== undefined) {
    issues.push(issue("VPD-U001", "standalone VideoPromptIrV2 must not contain program_binding", "error", ["program_binding"]));
  }
  issues.push(...validateIdentityContract(ir));
  if (options.model_profile) {
    if (options.model_profile.id !== ir.target.model_profile_id) issues.push(issue("VPD-K002", "model profile id does not match the IR target", "error", ["model_profile", "id"]));
    if (options.model_profile_digest && modelProfileDigest(options.model_profile) !== options.model_profile_digest) issues.push(issue("VPD-K002", "model profile digest is stale", "error", ["model_profile", "digest"]));
  }
  if (options.connection_profile) {
    if (options.connection_capability_digest && connectionCapabilityDigest(options.connection_profile) !== options.connection_capability_digest) issues.push(issue("VPD-K002", "connection capability digest is stale", "error", ["connection_profile", "digest"]));
    const exactRoutes = options.connection_profile.exact_model_routes.filter((candidate) => candidate.model === ir.target.model_profile_id && candidate.modes.includes(ir.target.mode));
    const exactRoute = exactRoutes.length === 1 ? exactRoutes[0] : undefined;
    if (!exactRoute || !route || exactRoute.provider_model !== route.provider_model) {
      issues.push(issue("VPD-R002", "connection capability and RouteIdentity do not prove the requested model/mode", "error", ["connection_profile", "exact_model_routes"]));
    }
  }
  if (options.effective_contract && Boolean(options.model_profile) !== Boolean(options.connection_profile)) {
    issues.push(issue("VPD-K003", "effective contract verification requires both pinned model and connection profiles", "error", ["effective_contract"]));
  }
  if (intent === "execute" && (!options.model_profile || !options.connection_profile)) {
    issues.push(issue("VPD-K003", "execution requires current model and connection capability profiles", "error", ["effective_contract", "execution"]));
  }

  const suppliedGrammarProfile = options.grammar_profile;
  const grammarProfile = options.model_profile?.renderer === "plain-prompt"
    ? undefined
    : (suppliedGrammarProfile ?? (options.require_pinned_grammar ? undefined : DEFAULT_H3_GRAMMAR_PROFILE_V3));
  const lyricsSource = options.generation_unit_lyrics_token && options.generation_unit_source
    ? consumeGenerationUnitLyricsForSource(options.generation_unit_source, options.generation_unit_lyrics_token)
    : undefined;
  if (ir.program_kind === "mv" && ir.shots.some((shot) => shot.vocal_events.some((event) => event.content.source === "lyrics-cue")) && !lyricsSource) {
    issues.push(issue("VPD-L002", "MV lyrics must be materialized from the authoritative T04 source token", "error", ["generation_unit_lyrics_token"]));
  }
  const semantic = buildSemanticBlocks(ir, {
    ...(lyricsSource ? { lyrics_source: lyricsSource } : {}),
    ...(grammarProfile ? { allowed_language_map: grammarProfile.language_map } : {}),
    require_exact_sync: options.require_exact_sync
  });
  issues.push(...semantic.issues);
  const plainRenderer = options.model_profile?.renderer === "plain-prompt";
  if (!plainRenderer && options.require_pinned_grammar && !grammarProfile) {
    issues.push(issue("VPD-C003", "H3 compilation requires the repo-local pinned grammar profile", "error", ["grammar_profile"]));
  } else if (suppliedGrammarProfile && !isTrustedH3GrammarProfile(suppliedGrammarProfile)) {
    issues.push(issue("VPD-C003", "H3 grammar profile was not loaded by the trusted pinned-profile loader", "error", ["grammar_profile"]));
  }
  const grammarOptions: H3GrammarV3Options = {
    ...(lyricsSource ? { lyrics_source: lyricsSource } : {}),
    ...(grammarProfile ? { allowed_language_map: grammarProfile.language_map } : {}),
    ...(options.require_exact_sync !== undefined ? { require_exact_sync: options.require_exact_sync } : {}),
    ...(grammarProfile ? { grammar_profile: grammarProfile } : {})
  };
  const rendered = options.model_profile?.renderer === "plain-prompt"
    ? renderProviderNeutralPrompt(semantic.ast)
    : renderH3GrammarV3(semantic.ast, grammarOptions);
  issues.push(...rendered.issues);
  const audioAssets = ir.assets.filter((asset) => asset.type === "audio");
  const requestedReferenceIds = [...ir.audio.reference_asset_ids];
  if (ir.audio.policy === "reference-only") {
    const audioIds = audioAssets.map((asset) => asset.id).sort();
    const referenceIds = [...requestedReferenceIds].sort();
    if (audioIds.length !== 1 || referenceIds.length !== 1 || audioIds[0] !== referenceIds[0]
      || !["voice_reference", "other"].includes(audioAssets[0]?.role ?? "")) {
      issues.push(issue("VPD-J002", "reference-only audio must bind exactly one authoritative audio_reference asset", "error", ["audio"]));
    }
  } else if (audioAssets.length > 0 || requestedReferenceIds.length > 0) {
    issues.push(issue("VPD-J002", `${ir.audio.policy} cannot send unauthorized audio assets or reference ids`, "error", ["audio"]));
  }
  if (!plainRenderer && ir.shots.some((shot) => shot.vocal_events.some((event) => event.speaker_ids.length > 1))
    && grammarProfile && !grammarProfile.features.group_speaker) {
    issues.push(issue("VPD-V001", "selected grammar profile cannot serialize all group speakers", "error", ["shots", "vocal_events", "speaker_ids"]));
  }
  const assetPins: Record<string, import("./compilationBundle.js").AssetPin> = {};
  for (const [assetIndex, asset] of ir.assets.entries()) {
    if (intent === "execute") {
      const evidence = options.asset_evidence?.[asset.id];
      if (!evidence || !verifyAssetPinEvidence(asset.path, asset.sha256, evidence, options.project_root)) {
        issues.push(issue("VPD-J002", "execution-capable compilation requires verified asset bytes and containment evidence", "error", ["assets", assetIndex]));
      } else if (!options.asset_pin_root || !options.project_root) {
        issues.push(issue("VPD-J002", "execution-capable compilation requires a project-local immutable asset pin root", "error", ["assets", assetIndex]));
      } else {
        try {
          assetPins[asset.id] = createVerifiedAssetPin({
            asset_id: asset.id,
            project_root: options.project_root,
            project_relative_path: asset.path,
            expected_sha256: asset.sha256,
            expected_size: evidence.byte_size,
            expected_real_path: evidence.real_path,
            pin_root: options.asset_pin_root
          });
        } catch {
          issues.push(issue("VPD-J002", "execution-capable compilation could not create an immutable asset pin", "error", ["assets", assetIndex]));
        }
      }
    }
  }
  const rendererDialect = route
    ? resolveRendererDialectCapability({
        route,
        ...(options.model_profile ? { model_profile: options.model_profile } : {}),
        ...(options.connection_profile ? { connection_profile: options.connection_profile } : {}),
        ...(options.adapter_dialect_capability ? { adapter_dialect_capability: options.adapter_dialect_capability } : {})
      })
    : undefined;
  const dialect = compileAdapterDialect(ir, rendered.text, rendererDialect);
  issues.push(...dialect.issues);

  const effectiveResult = options.effective_contract
    ? route
      ? assertEffectiveGenerationContract(options.effective_contract, {
          route,
          mode: ir.target.mode,
          model_profile_digest: options.model_profile_digest,
          connection_digest: options.connection_capability_digest,
          intent,
          ...(options.model_profile && options.connection_profile ? {
            truth: {
              model_profile: options.model_profile,
              connection_profile: options.connection_profile,
              model_profile_digest: options.model_profile_digest ?? modelProfileDigest(options.model_profile),
              connection_profile_digest: options.connection_capability_digest ?? connectionCapabilityDigest(options.connection_profile),
              ...(options.trusted_pinned_budget_evidence ? { trusted_pinned_budget_evidence: options.trusted_pinned_budget_evidence } : {}),
              capability_evidence: effectiveCapabilityEvidence(ir, grammarProfile),
              execution_capable: intent === "execute"
            }
          } : {})
        })
      : { ok: false as const, issues: [issue("VPD-K002", "injected effective contract requires a requested route", "error", ["effective_contract", "route"])] }
    : route
      ? createEffectiveGenerationContract({
          mode: ir.target.mode,
          route,
          model_profile_digest: options.model_profile_digest ?? route.model_profile_digest,
          connection_profile_digest: options.connection_capability_digest ?? route.connection_digest,
          ...(options.model_profile ? { model_profile: options.model_profile } : {}),
          ...(options.connection_profile ? { connection_profile: options.connection_profile } : {}),
          execution_capable: intent === "execute",
          capability_evidence: effectiveCapabilityEvidence(ir, grammarProfile),
          ...(options.budget ? { budget: options.budget } : {}),
          ...(options.trusted_pinned_budget_evidence ? { trusted_pinned_budget_evidence: options.trusted_pinned_budget_evidence } : {})
        })
      : { ok: false as const, issues: [issue("VPD-K002", "effective contract cannot be created without a route", "error", ["route"]) ] };
  issues.push(...effectiveResult.issues);
  if (effectiveResult.ok) {
    if (effectiveResult.contract.effective.durations_ms !== "unknown" && !effectiveResult.contract.effective.durations_ms.includes(ir.target.duration_ms)) {
      issues.push(issue("VPD-K002", "requested duration is not proven by the effective capability contract", "error", ["target", "duration_ms"]));
    }
    if (effectiveResult.contract.effective.aspects !== "unknown" && !effectiveResult.contract.effective.aspects.includes(ir.target.aspect)) {
      issues.push(issue("VPD-K002", "requested aspect is not proven by the effective capability contract", "error", ["target", "aspect"]));
    }
    if (effectiveResult.contract.effective.resolutions !== "unknown" && !effectiveResult.contract.effective.resolutions.includes(ir.target.quality)) {
      issues.push(issue("VPD-K002", "requested quality is not proven by the effective capability contract", "error", ["target", "quality"]));
    }
    if (intent === "execute") {
      if (effectiveResult.contract.freshness.status !== "fresh") issues.push(issue("VPD-K003", "execution requires fresh effective contract evidence", "error", ["effective_contract", "freshness"]));
      if (effectiveResult.contract.execution.status !== "execution-capable") issues.push(issue("VPD-K003", "effective contract is planning-only", "error", ["effective_contract", "execution", "status"]));
      for (const [name, evidence] of Object.entries(effectiveResult.contract.execution.capability_evidence)) {
        if (evidence !== "hard") issues.push(issue("VPD-K003", `execution capability '${name}' is unknown`, "error", ["effective_contract", "execution", "capability_evidence", name]));
      }
      if (effectiveResult.contract.effective.prompt_budget.unknown || (!effectiveResult.contract.effective.prompt_budget.hard && !effectiveResult.contract.effective.prompt_budget.soft)) {
        issues.push(issue("VPD-K003", "execution requires a known prompt budget", "error", ["effective_contract", "effective", "prompt_budget"]));
      }
    }
    const promptBudget = effectiveResult.contract.effective.prompt_budget;
    const budgetUnit = promptBudget.hard?.unit ?? promptBudget.soft?.unit;
    const promptLength = budgetUnit === "utf8-bytes"
      ? Buffer.byteLength(dialect.canonical_prompt, "utf8")
      : budgetUnit === "tokens"
        ? undefined
        : [...dialect.canonical_prompt].length;
    if (promptLength === undefined) {
      issues.push(issue("VPD-B003", "token prompt budget cannot be measured without a digest-bound tokenizer", "error", ["budget"]));
    } else if (promptBudget.hard && promptLength > promptBudget.hard.limit) {
      issues.push(issue("VPD-B001", "canonical prompt exceeds hard budget", "error", ["canonical_prompt"]));
    } else if (promptBudget.soft && promptLength > promptBudget.soft.limit) {
      issues.push(issue("VPD-B002", "canonical prompt exceeds soft budget", "warning", ["canonical_prompt"]));
    }
  }
  issues.push(...validateAdapterDialect(rendered.text, dialect.adapter_prompt, dialect.labels, rendererDialect));

  const validation = toValidation(dedupeIssues(issues));
  const normalizedDigest = sha256Canonical(ir);
  const routeForResult = route ?? placeholderRoute(ir.target.model_profile_id, ir.target.mode);
  const effective = effectiveResult.ok ? effectiveResult.contract : placeholderEffectiveContract(routeForResult, ir.target.mode);
  const partial = {
    request_id: requestId,
    normalized_ir: ir,
    normalized_ir_digest: normalizedDigest,
    effective_contract: effective,
    semantic_blocks: semantic.blocks,
    canonical_prompt: rendered.text,
    adapter_prompt: dialect.adapter_prompt,
    dialect,
    validation,
    route: routeForResult,
    lineage: {
      workflow_id: VIDEO_PROMPT_V2_WORKFLOW_ID,
      workflow_version: VIDEO_PROMPT_V2_WORKFLOW_VERSION,
      normalized_ir_digest: normalizedDigest,
      block_digests: semanticBlockDigestMap(semantic.blocks),
      canonical_prompt_digest: sha256Text(rendered.text),
      adapter_prompt_digest: sha256Text(dialect.adapter_prompt),
      model_profile_digest: effective.digests.model_profile,
      connection_capability_digest: effective.digests.connection_profile,
      adapter_capability_digest: rendererDialect?.source_digest ?? "0".repeat(64),
      ...(ir.program_kind === "mv" ? { program_binding_digest: sha256Canonical(ir.program_binding) } : {}),
      ...(options.generation_unit_source ? {
        generation_unit_source_digest: options.generation_unit_source.generation_unit_digest,
        generation_unit_source_canonical_digest: sha256Canonical(options.generation_unit_source)
      } : {})
    }
  };
  if (issues.some((item) => item.severity === "error") || !route) {
    return { ok: false, compilation: partial, issues: validation.errors };
  }

  const bundle = createCompilationBundle({
    request_id: requestId,
    ir,
    canonical_prompt: rendered.text,
    adapter_prompt: dialect.adapter_prompt,
    semantic_blocks: semantic.blocks,
    labels: dialect.labels,
    model_profile_digest: effective.digests.model_profile,
    connection_capability_digest: effective.digests.connection_profile,
    adapter_capability_digest: rendererDialect?.source_digest ?? "0".repeat(64),
    route,
    ...(ir.program_kind === "mv" ? { program_binding: ir.program_binding } : {}),
    ...(rendered.grammar_profile ? {
      grammar_profile: {
        ...rendered.grammar_profile,
        section_order: [...rendered.grammar_profile.section_order],
        reference_section_order: [...rendered.grammar_profile.reference_section_order]
      }
    } : {}),
    labels_digest: dialect.labels.digest,
    validation,
    ...(options.source?.authoring_schema ? { authoring_schema: options.source.authoring_schema } : {}),
    contract_bindings: [
      ...(options.contract_bindings ?? []),
      ...(options.generation_unit_source ? [
        options.generation_unit_source.generation_unit_digest,
        options.generation_unit_source.music.contract_digest,
        ...(options.generation_unit_source.lyrics ? [options.generation_unit_source.lyrics.contract_digest] : [])
      ] : []),
      ...((ir as VideoPromptIrV2 & { identity_definition?: IdentityDefinitionContractV1 }).identity_definition
        ? [(ir as VideoPromptIrV2 & { identity_definition: IdentityDefinitionContractV1 }).identity_definition.digest]
        : [])
    ],
    exact_text_digests: semantic.blocks.flatMap((block) => block.exact_text_digests),
    ...(options.source ? { upgrader_version: options.source.upgrader_version, ...(options.source.source_digest ? { source_digest: options.source.source_digest } : {}) } : {}),
    effective_contract: effective,
    execution_capable: intent === "execute",
    asset_evidence: options.asset_evidence,
    ...(Object.keys(assetPins).length > 0 ? { asset_pins: assetPins } : {}),
    ...(options.generation_unit_source ? {
      generation_unit_source: options.generation_unit_source,
      ...(generationUnitContractFacts(options.generation_unit_source)
        ? { generation_unit_source_facts: generationUnitContractFacts(options.generation_unit_source) }
        : {})
    } : {})
  });
  return { ok: true, compilation: { ...partial, bundle }, issues: [] };
}

/** Normalize legacy H3 authoring in memory before entering the V2 compiler. */
export function compileH3V1ThroughV2(
  input: H3CreativeIr,
  options: Omit<CompileVideoPromptV2Options, "source"> = {}
): CompileVideoPromptV2Result {
  const upgraded = upgradeH3V1ToVideoPromptV2(input);
  return compileVideoPromptIrV2(upgraded.ir, {
    ...options,
    source: {
      authoring_schema: "H3-V1",
      upgrader_version: "h3-v1-to-v2@1",
      source_digest: upgraded.source_sha256
    }
  });
}

/** Pure legacy serializer used only to preserve workflow-v2 golden bytes. */
export function compileLegacyH3V1(input: H3CreativeIr): LegacyH3CompatibilityCompilation {
  const rendered = renderH3Prompt(input);
  try {
    const upgraded = upgradeH3V1ToVideoPromptV2(input);
    // The legacy bytes are deliberately emitted by this compatibility writer,
    // but the input is first read and semantically checked by the single V2
    // boundary. No source/project mutation is performed.
    compileVideoPromptIrV2(upgraded.ir, { require_route: false, intent: "planning" });
    return {
      compatibility_mode: "legacy-h3-v2-golden",
      upgraded_ir: upgraded.ir,
      source_sha256: upgraded.source_sha256,
      canonical_prompt: rendered.text,
      adapter_prompt: rendered.text
    };
  } catch (error) {
    return {
      compatibility_mode: "legacy-h3-v2-golden",
      upgrade_error: error instanceof Error ? error.message : String(error),
      canonical_prompt: rendered.text,
      adapter_prompt: rendered.text
    };
  }
}

export function validateMvBinding(
  binding: ProgramBindingForV2,
  targetDurationMs: number,
  source?: GenerationUnitProgramSourceV1,
  route?: RouteIdentityV1,
  requestId?: string,
  requestIndex?: number
): H3Issue[] {
  const issues: H3Issue[] = [];
  try {
    programBindingSchema.parse(binding);
  } catch {
    return [issue("VPD-U001", "MV program_binding is not a strict T03 ProgramBinding", "error", ["program_binding"])];
  }
  if (!source) {
    issues.push(issue("VPD-U001", "MV compilation requires the T03 GenerationUnitProgramSource", "error", ["generation_unit_source"]));
    return issues;
  }
  try {
    const parsedSource = generationUnitProgramSourceSchema.parse(source);
    const { generation_unit_digest: declaredGenerationUnitDigest, ...sourceBody } = parsedSource;
    // T04 owns this digest. A reduced T03 source must never self-promote its
    // own body hash into the GenerationUnit authority slot.
    if (sha256Canonical(sourceBody) === declaredGenerationUnitDigest) {
      issues.push(issue("VPD-U001", "MV source is a self-hashed reduced source, not a T04 GenerationUnitContract digest", "error", ["generation_unit_source", "generation_unit_digest"]));
    }
    if (requestId !== undefined && parsedSource.unit_id !== requestId) {
      issues.push(issue("VPD-U001", "MV source unit_id must exactly match the request id", "error", ["generation_unit_source", "unit_id"]));
    }
    if (requestIndex !== undefined && parsedSource.ordinal !== requestIndex) {
      issues.push(issue("VPD-U001", "MV source ordinal must exactly match the request index", "error", ["generation_unit_source", "ordinal"]));
    }
    const sourceRouteIssues = assertRouteIdentity(parsedSource.route, { model: parsedSource.route.ir_model, mode: parsedSource.route.mode_binding });
    if (sourceRouteIssues.some((item) => item.severity === "error")) {
      issues.push(issue("VPD-U001", "MV GenerationUnitProgramSource route digest is stale", "error", ["generation_unit_source", "route"]));
    }
    assertProgramBindingMatchesSource(binding, parsedSource);
    if (route && sha256Canonical(route) !== sha256Canonical(parsedSource.route)) {
      issues.push(issue("VPD-R001", "MV program source route does not match the requested RouteIdentity", "error", ["generation_unit_source", "route"]));
    }
  } catch {
    issues.push(issue("VPD-U001", "MV program_binding does not match the complete T03 GenerationUnitProgramSource", "error", ["generation_unit_source"]));
  }
  const duration = binding.program_end_ms - binding.program_start_ms;
  if (duration !== targetDurationMs) issues.push(issue("VPD-U001", "program_end-start must equal target.duration_ms", "error", ["program_binding", "program_end_ms"]));
  return issues;
}

function parseV2(input: unknown): { ok: true; ir: VideoPromptIrV2 } | { ok: false; issues: H3Issue[] } {
  try {
    return { ok: true, ir: parseVideoPromptIrV2(input) };
  } catch (error) {
    const zodIssues = (error as { issues?: Array<{ message: string; path: Array<string | number>; params?: { code?: string } }> }).issues ?? [];
    return { ok: false, issues: zodIssues.length > 0 ? zodIssues.map((item) => issue(item.params?.code ?? "VPD-S001", item.message, "error", item.path)) : [issue("VPD-S001", "VideoPromptIrV2 schema validation failed", "error")] };
  }
}

function toValidation(issues: H3Issue[]): H3ValidationResult {
  const errors = issues.filter((item) => item.severity === "error");
  const warnings = issues.filter((item) => item.severity === "warning");
  return { ok: errors.length === 0, issues, errors, warnings };
}

function dedupeIssues(issues: readonly H3Issue[]): H3Issue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = JSON.stringify([item.code, item.message, item.severity, item.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function placeholderRoute(model: string, mode: VideoPromptIrV2["target"]["mode"]): RouteIdentityV1 {
  return {
    ir_model: model,
    provider_model: "unknown",
    model_profile_digest: "0".repeat(64),
    connection_id: "unknown",
    connection_digest: "0".repeat(64),
    adapter_id: "unknown",
    transport: "unknown",
    mode_binding: mode,
    route_digest: "0".repeat(64)
  };
}

function placeholderEffectiveContract(route: RouteIdentityV1, mode: VideoPromptIrV2["target"]["mode"]): EffectiveGenerationContractV1 {
  return {
    schema_version: 1,
    route,
    mode,
    effective: { durations_ms: "unknown", aspects: "unknown", resolutions: "unknown", reference_caps: "unknown", prompt_budget: { hard: null, soft: null, unknown: true } },
    advisory_warnings: [],
    digests: { model_profile: route.model_profile_digest, connection_profile: route.connection_digest, adapter_route: route.route_digest },
    freshness: { status: "unknown" },
    overrides: [],
    execution: {
      status: "planning-only",
      capability_evidence: {
        duration: "unknown", aspect: "unknown", resolution: "unknown", mode: "unknown",
        reference: "unknown", group_speaker: "unknown", exact_text: "unknown"
      }
    },
    digest: sha256Canonical({ route, mode })
  };
}

function effectiveCapabilityEvidence(
  ir: VideoPromptIrV2,
  grammarProfile?: H3GrammarProfileV3
): Partial<EffectiveGenerationContractV1["execution"]["capability_evidence"]> {
  const trusted = isTrustedH3GrammarProfile(grammarProfile);
  return {
    group_speaker: ir.shots.some((shot) => shot.vocal_events.some((event) => event.speaker_ids.length > 1))
      ? (trusted && grammarProfile?.features.group_speaker ? "hard" : "unknown")
      : (trusted ? "hard" : "unknown"),
    exact_text: ir.shots.some((shot) => shot.vocal_events.some((event) => event.content.source !== "legacy-unaligned"))
      ? (trusted && grammarProfile?.features.exact_dialogue ? "hard" : "unknown")
      : (trusted ? "hard" : "unknown")
  };
}

function validateIdentityContract(ir: VideoPromptIrV2): H3Issue[] {
  const lockedSubjects = ir.subjects.filter((subject) => subject.locked_blocks && Object.keys(subject.locked_blocks).length > 0);
  if (lockedSubjects.length === 0) return [];
  const definition = (ir as VideoPromptIrV2 & { identity_definition?: IdentityDefinitionContractV1 }).identity_definition;
  if (!definition) return [issue("VPD-I001", "locked identity requires a typed IdentityDefinitionContract", "error", ["identity_definition"])] ;
  try {
    const parsed = identityDefinitionSchema.parse(definition);
    if (parsed.definition_status !== "confirmed") {
      return [issue("VPD-I002", "prompt compilation requires a confirmed IdentityDefinitionContract", "error", ["identity_definition", "definition_status"])] ;
    }
    const issues: H3Issue[] = [];
    for (const subject of lockedSubjects) {
      const contractSubject = parsed.subjects.find((candidate) => candidate.id === subject.id);
      if (!contractSubject) {
        issues.push(issue("VPD-I003", `identity subject '${subject.id}' is not defined by the typed contract`, "error", ["identity_definition", "subjects"]));
        continue;
      }
      for (const field of ["voice", "appearance", "manner"] as const) {
        const locked = subject.locked_blocks?.[field];
        const bound = contractSubject.locked_blocks[field];
        if (locked && (!bound || bound.sha256 !== locked.sha256 || bound.text !== locked.text)) {
          issues.push(issue("VPD-I003", `locked identity '${subject.id}.${field}' does not match the typed contract`, "error", ["subjects", subject.id, "locked_blocks", field]));
        }
      }
    }
    return issues;
  } catch {
    return [issue("VPD-I002", "identity definition contract is not strict or has a stale digest", "error", ["identity_definition"])] ;
  }
}

function verifyAssetPinEvidence(
  projectRelativePath: string,
  declaredSha256: string | undefined,
  evidence: AssetPinEvidence,
  projectRoot?: string
): boolean {
  if (evidence.source !== "project-bytes" && evidence.source !== "asset-contract") return false;
  if (evidence.regular_file !== true || evidence.contained_in_project_root !== true) return false;
  if (!isAbsolute(evidence.real_path)) return false;
  if (!/^[a-f0-9]{64}$/.test(evidence.sha256) || (declaredSha256 !== undefined && declaredSha256 !== evidence.sha256)) return false;
  if (!Number.isSafeInteger(evidence.byte_size) || evidence.byte_size < 0) return false;
  if (evidence.asset_contract && (evidence.asset_contract.path !== projectRelativePath
    || evidence.asset_contract.sha256 !== evidence.sha256
    || evidence.asset_contract.byte_size !== evidence.byte_size)) return false;
  if (!projectRoot) return false;
  try {
    const root = realpathSync(resolve(projectRoot));
    const absolute = resolve(root, projectRelativePath);
    if (isAbsolute(projectRelativePath) || !isProjectAssetIdentityContained(root, absolute)) return false;
    if (lstatSync(absolute).isSymbolicLink()) return false;
    const actualPath = realpathSync(absolute);
    if (absolute !== actualPath || !isProjectAssetIdentityContained(root, actualPath)) return false;
    if (resolve(evidence.real_path) !== actualPath) return false;
    const fd = openSync(actualPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev === 0 || before.ino === 0 || before.size !== evidence.byte_size || before.size > MAX_PINNED_ASSET_BYTES) return false;
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (read <= 0) return false;
        hash.update(chunk.subarray(0, read));
        offset += read;
      }
      const after = fstatSync(fd);
      const sameIdentity = before.dev !== 0 && before.ino !== 0
        && after.dev !== 0 && after.ino !== 0
        && before.dev === after.dev && before.ino === after.ino
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs;
      return sameIdentity && hash.digest("hex") === evidence.sha256;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const MAX_PINNED_ASSET_BYTES = 512 * 1024 * 1024;
