import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import {
  assertHomogeneousRouteIdentity,
  assertRouteIdentity,
  assertEffectiveGenerationContract,
  createEffectiveGenerationContract,
  type EffectiveGenerationContractV1,
  type PromptBudget
} from "./effectiveContract.js";
import {
  compileAdapterDialect,
  validateAdapterDialect,
  type AdapterDialectResult
} from "./adapterDialect.js";
import {
  createCompilationBundle,
  type CompilationBundleV1
} from "./compilationBundle.js";
import {
  buildSemanticBlocks,
  semanticBlockDigestMap,
  type LyricsSource,
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
  type H3GrammarProfileV3,
  type H3GrammarV3Options,
  DEFAULT_H3_GRAMMAR_PROFILE_V3
} from "./render/h3GrammarV3.js";
import { renderH3Prompt } from "./render/h3Grammar.js";
import { issue, type H3Issue, type H3ValidationResult } from "./validation/types.js";
import type { RouteIdentityV1 } from "../productionControl/programBinding.js";
import {
  assertProgramBindingMatchesSource,
  generationUnitProgramSourceSchema,
  type GenerationUnitProgramSourceV1
} from "../productionControl/programBinding.js";

export const VIDEO_PROMPT_V2_WORKFLOW_ID = "video-prompt-v3" as const;
export const VIDEO_PROMPT_V2_WORKFLOW_VERSION = H3_GRAMMAR_V3_VERSION;

export type GenerationUnitDurationBinding = GenerationUnitProgramSourceV1;

export type CompileVideoPromptV2Options = {
  request_id?: string;
  route?: RouteIdentityV1;
  batch_routes?: readonly RouteIdentityV1[];
  model_profile_digest?: string;
  connection_capability_digest?: string;
  effective_contract?: EffectiveGenerationContractV1;
  budget?: PromptBudget;
  lyrics_source?: LyricsSource;
  require_exact_sync?: boolean;
  grammar_profile?: H3GrammarProfileV3;
  contract_bindings?: string[];
  source?: {
    authoring_schema: "VideoPromptIrV2" | "V1" | "H3-V1";
    upgrader_version: string;
    source_digest?: string;
  };
  generation_unit_source?: GenerationUnitProgramSourceV1;
  require_route?: boolean;
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
    program_binding_digest?: string;
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
  if (!route) {
    issues.push(issue("VPD-R001", "VideoPromptIrV2 compilation requires a pinned RouteIdentity", "error", ["route"]));
  } else {
    issues.push(...assertRouteIdentity(route, {
      model: ir.target.model_profile_id,
      mode: ir.target.mode,
      model_profile_digest: options.model_profile_digest,
      connection_digest: options.connection_capability_digest
    }));
  }
  if (options.batch_routes) issues.push(...assertHomogeneousRouteIdentity(options.batch_routes));
  if (!requireRoute && !route) issues.splice(0, issues.length);
  if (ir.program_kind === "mv") issues.push(...validateMvBinding(ir.program_binding, ir.target.duration_ms, options.generation_unit_source, route));
  if (ir.program_kind === "standalone" && "program_binding" in ir && ir.program_binding !== undefined) {
    issues.push(issue("VPD-U001", "standalone VideoPromptIrV2 must not contain program_binding", "error", ["program_binding"]));
  }

  const semantic = buildSemanticBlocks(ir, {
    lyrics_source: options.lyrics_source,
    require_exact_sync: options.require_exact_sync,
    grammar_reserved_tokens: options.grammar_profile ? undefined : undefined
  });
  issues.push(...semantic.issues);
  const grammarOptions: H3GrammarV3Options = {
    ...(options.lyrics_source ? { lyrics_source: options.lyrics_source } : {}),
    ...(options.require_exact_sync !== undefined ? { require_exact_sync: options.require_exact_sync } : {}),
    grammar_profile: options.grammar_profile ?? DEFAULT_H3_GRAMMAR_PROFILE_V3
  };
  const rendered = renderH3GrammarV3(ir, grammarOptions);
  issues.push(...rendered.issues);
  for (const [assetIndex, asset] of ir.assets.entries()) {
    if (!asset.sha256) issues.push(issue("VPD-J001", "execution-capable compilation requires a sha256 pin for every asset", "error", ["assets", assetIndex, "sha256"]));
  }
  const dialect = compileAdapterDialect(ir, rendered.text);
  issues.push(...dialect.issues);

  const effectiveResult = options.effective_contract
    ? route
      ? assertEffectiveGenerationContract(options.effective_contract, {
          route,
          mode: ir.target.mode,
          model_profile_digest: options.model_profile_digest,
          connection_digest: options.connection_capability_digest
        })
      : { ok: false as const, issues: [issue("VPD-K002", "injected effective contract requires a requested route", "error", ["effective_contract", "route"])] }
    : route
      ? createEffectiveGenerationContract({
          mode: ir.target.mode,
          route,
          model_profile_digest: options.model_profile_digest ?? route.model_profile_digest,
          connection_profile_digest: options.connection_capability_digest ?? route.connection_digest,
          ...(options.budget ? { budget: options.budget } : {})
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
    const promptBudget = effectiveResult.contract.effective.prompt_budget;
    const budgetUnit = promptBudget.hard?.unit ?? promptBudget.soft?.unit;
    const promptLength = budgetUnit === "utf8-bytes" ? Buffer.byteLength(dialect.canonical_prompt, "utf8") : [...dialect.canonical_prompt].length;
    if (promptBudget.hard && promptLength > promptBudget.hard.limit) issues.push(issue("VPD-B001", "canonical prompt exceeds hard budget", "error", ["canonical_prompt"]));
    else if (promptBudget.soft && promptLength > promptBudget.soft.limit) issues.push(issue("VPD-B002", "canonical prompt exceeds soft budget", "warning", ["canonical_prompt"]));
  }
  issues.push(...validateAdapterDialect(rendered.text, dialect.adapter_prompt, dialect.labels));

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
      ...(ir.program_kind === "mv" ? { program_binding_digest: sha256Canonical(ir.program_binding) } : {})
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
    model_profile_digest: effective.digests.model_profile,
    connection_capability_digest: effective.digests.connection_profile,
    route,
    ...(ir.program_kind === "mv" ? { program_binding: ir.program_binding } : {}),
    grammar_profile: { ...rendered.grammar_profile, section_order: [...rendered.grammar_profile.section_order] },
    labels_digest: dialect.labels.digest,
    validation,
    ...(options.source?.authoring_schema ? { authoring_schema: options.source.authoring_schema } : {}),
    contract_bindings: options.contract_bindings,
    exact_text_digests: semantic.blocks.flatMap((block) => block.exact_text_digests),
    ...(options.source ? { upgrader_version: options.source.upgrader_version, ...(options.source.source_digest ? { source_digest: options.source.source_digest } : {}) } : {})
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
  route?: RouteIdentityV1
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
    digest: sha256Canonical({ route, mode })
  };
}
