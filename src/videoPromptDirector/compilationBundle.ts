import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as nativePath from "node:path";
import { z } from "zod";
import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import { programBindingSchema, routeIdentitySchema, type GenerationUnitProgramSourceV1 } from "../productionControl/programBinding.js";
import { digestSchema, safeIdSchema } from "../productionControl/schema.js";
import type { SemanticPromptBlock } from "./semanticBlocks.js";
import type { VideoPromptIrV2 } from "./schemaV2.js";
import { effectiveGenerationContractSchema, routeIdentityDigest, type EffectiveGenerationContractV1 } from "./effectiveContract.js";

const issueSchema = z.object({
  code: safeIdSchema,
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  path: z.array(z.union([z.string(), z.number()])).optional()
}).strict();

const assetLineageSchema = z.object({
  asset_id: safeIdSchema,
  path: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "asset path must be project-relative"),
  declared_sha256: digestSchema.optional(),
  pin_evidence: z.object({
    source: z.enum(["project-bytes", "asset-contract"]),
    sha256: digestSchema,
    byte_size: z.number().int().nonnegative(),
    regular_file: z.literal(true),
    contained_in_project_root: z.literal(true)
  }).strict().optional()
}).strict();

export const compilationBundleSchema = z.object({
  schema_version: z.literal(1),
  workflow: z.literal("video-prompt-v3"),
  request_id: safeIdSchema,
  normalized_ir_digest: digestSchema,
  normalized_ir_version: z.literal(2),
  canonical_prompt: z.string(),
  adapter_prompt: z.string(),
  canonical_prompt_digest: digestSchema,
  adapter_prompt_digest: digestSchema,
  semantic_blocks: z.array(z.object({
    block_id: safeIdSchema,
    kind: z.string().min(1),
    source_paths: z.array(z.string().min(1)),
    text: z.string(),
    digest: digestSchema,
    exact_text_digests: z.array(digestSchema)
  }).strict()).min(1),
  block_digests: z.record(safeIdSchema, digestSchema),
  model_profile_digest: digestSchema,
  connection_capability_digest: digestSchema,
  adapter_capability_digest: digestSchema,
  effective_contract: effectiveGenerationContractSchema,
  effective_contract_digest: digestSchema,
  execution_capable: z.boolean(),
  route: routeIdentitySchema,
  program_binding: programBindingSchema.optional(),
  asset_lineage: z.array(assetLineageSchema).max(256),
  grammar_profile: z.object({
    profile_id: safeIdSchema,
    source_commit: z.string().min(1),
    source_digest: digestSchema,
    section_order: z.array(z.string().min(1)),
    features: z.object({
      scenetrans: z.boolean(),
      cutoff: z.boolean(),
      group_speaker: z.boolean(),
      exact_dialogue: z.boolean()
    }).strict(),
    serialization_rules_digest: digestSchema,
    digest: digestSchema
  }).strict().optional(),
  labels_digest: digestSchema,
  validation: z.object({
    ok: z.boolean(),
    issues: z.array(issueSchema),
    errors: z.array(issueSchema),
    warnings: z.array(issueSchema)
  }).strict(),
  lineage: z.object({
    authoring_schema: z.string().min(1),
    upgrader_version: z.string().min(1),
    contract_bindings: z.array(digestSchema),
    exact_text_digests: z.array(digestSchema),
    source_digest: digestSchema.optional(),
    generation_unit_source_digest: digestSchema.optional(),
    generation_unit_source_identity: z.object({
      production_id: safeIdSchema,
      unit_id: safeIdSchema,
      ordinal: z.number().int().nonnegative(),
      generation_unit_digest: digestSchema,
      program_start_ms: z.number().int().nonnegative(),
      program_end_ms: z.number().int().positive(),
      section_id: safeIdSchema.optional(),
      music_contract_digest: digestSchema,
      lyrics_contract_digest: digestSchema.optional(),
      beat_anchor_ids: z.array(safeIdSchema).max(256),
      lyric_cue_ids: z.array(safeIdSchema).max(256),
      route_digest: digestSchema
    }).strict().optional()
  }).strict(),
  compilation_digest: digestSchema
}).strict().superRefine((bundle, context) => {
  if (bundle.canonical_prompt_digest !== sha256Text(bundle.canonical_prompt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["canonical_prompt_digest"], message: "canonical prompt digest mismatch" });
  if (bundle.adapter_prompt_digest !== sha256Text(bundle.adapter_prompt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["adapter_prompt_digest"], message: "adapter prompt digest mismatch" });
  if (bundle.block_digests && Object.keys(bundle.block_digests).length !== bundle.semantic_blocks.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["block_digests"], message: "block digest map must cover every semantic block" });
  for (const block of bundle.semantic_blocks) {
    if (bundle.block_digests[block.block_id] !== block.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["block_digests", block.block_id], message: "semantic block digest mismatch" });
  }
  if (routeIdentityDigest(bundle.route) !== bundle.route.route_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["route", "route_digest"], message: "route identity digest mismatch" });
  if (bundle.effective_contract_digest !== bundle.effective_contract.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_contract_digest"], message: "effective contract digest mismatch" });
  if (bundle.execution_capable !== (bundle.effective_contract.execution.status === "execution-capable")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution_capable"], message: "execution capability status mismatch" });
  for (const [index, asset] of bundle.asset_lineage.entries()) {
    if (bundle.execution_capable && !asset.pin_evidence) context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_lineage", index, "pin_evidence"], message: "execution-capable bundles require pin evidence for every asset" });
    if (asset.pin_evidence && asset.declared_sha256 && asset.declared_sha256 !== asset.pin_evidence.sha256) context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_lineage", index, "pin_evidence", "sha256"], message: "asset pin evidence does not match declared sha256" });
  }
  if (!bundle.validation.ok) context.addIssue({ code: z.ZodIssueCode.custom, path: ["validation", "ok"], message: "compilation bundle cannot commit a failed validation" });
  if (bundle.grammar_profile) {
    const { digest: _grammarDigest, ...grammarWithoutDigest } = bundle.grammar_profile;
    if (sha256Canonical(grammarWithoutDigest) !== bundle.grammar_profile.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["grammar_profile", "digest"], message: "grammar profile digest mismatch" });
  }
  const withoutDigest = { ...bundle } as Record<string, unknown>;
  delete withoutDigest.compilation_digest;
  if (sha256Canonical(withoutDigest) !== bundle.compilation_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["compilation_digest"], message: "compilation digest mismatch" });
});

export type CompilationBundleV1 = z.infer<typeof compilationBundleSchema>;
export type CompilationBundle = CompilationBundleV1;

export type RuntimeAssetPinEvidence = {
  source: "project-bytes" | "asset-contract";
  real_path: string;
  sha256: string;
  byte_size: number;
  regular_file: true;
  contained_in_project_root: true;
};

export type CompilationBundleInput = {
  request_id: string;
  ir: VideoPromptIrV2;
  canonical_prompt: string;
  adapter_prompt: string;
  semantic_blocks: readonly SemanticPromptBlock[];
  model_profile_digest: string;
  connection_capability_digest: string;
  adapter_capability_digest: string;
  effective_contract: EffectiveGenerationContractV1;
  execution_capable: boolean;
  route: CompilationBundleV1["route"];
  program_binding?: CompilationBundleV1["program_binding"];
  grammar_profile?: CompilationBundleV1["grammar_profile"];
  labels_digest: string;
  validation: CompilationBundleV1["validation"];
  authoring_schema?: "VideoPromptIrV2" | "V1" | "H3-V1";
  contract_bindings?: string[];
  exact_text_digests?: string[];
  upgrader_version?: string;
  source_digest?: string;
  generation_unit_source?: GenerationUnitProgramSourceV1;
  asset_evidence?: Readonly<Record<string, RuntimeAssetPinEvidence>>;
};

export function createCompilationBundle(input: CompilationBundleInput): CompilationBundleV1 {
  const semanticBlocks = input.semantic_blocks.map((block) => ({ ...block, source_paths: [...block.source_paths], exact_text_digests: [...block.exact_text_digests] }));
  const withoutDigest = {
    schema_version: 1 as const,
    workflow: "video-prompt-v3" as const,
    request_id: input.request_id,
    normalized_ir_digest: sha256Canonical(input.ir),
    normalized_ir_version: 2 as const,
    canonical_prompt: input.canonical_prompt,
    adapter_prompt: input.adapter_prompt,
    canonical_prompt_digest: sha256Text(input.canonical_prompt),
    adapter_prompt_digest: sha256Text(input.adapter_prompt),
    semantic_blocks: semanticBlocks,
    block_digests: Object.fromEntries(semanticBlocks.map((block) => [block.block_id, block.digest])),
    model_profile_digest: input.model_profile_digest,
    connection_capability_digest: input.connection_capability_digest,
    adapter_capability_digest: input.adapter_capability_digest,
    effective_contract: input.effective_contract,
    effective_contract_digest: input.effective_contract.digest,
    execution_capable: input.execution_capable,
    route: input.route,
    ...(input.program_binding ? { program_binding: input.program_binding } : {}),
    asset_lineage: input.ir.assets.map((asset) => ({
      asset_id: asset.id,
      path: asset.path,
      ...(asset.sha256 ? { declared_sha256: asset.sha256 } : {}),
      ...(input.asset_evidence?.[asset.id] ? {
        pin_evidence: {
          source: input.asset_evidence[asset.id].source,
          sha256: input.asset_evidence[asset.id].sha256,
          byte_size: input.asset_evidence[asset.id].byte_size,
          regular_file: input.asset_evidence[asset.id].regular_file,
          contained_in_project_root: input.asset_evidence[asset.id].contained_in_project_root
        }
      } : {})
    })),
    ...(input.grammar_profile ? { grammar_profile: input.grammar_profile } : {}),
    labels_digest: input.labels_digest,
    validation: input.validation,
    lineage: {
      authoring_schema: input.authoring_schema ?? "VideoPromptIrV2",
      upgrader_version: input.upgrader_version ?? "native-v2",
      contract_bindings: [...(input.contract_bindings ?? [])],
      exact_text_digests: [...(input.exact_text_digests ?? [])],
      ...(input.source_digest ? { source_digest: input.source_digest } : {}),
      ...(input.generation_unit_source ? {
        generation_unit_source_digest: sha256Canonical(input.generation_unit_source),
        generation_unit_source_identity: generationUnitSourceIdentity(input.generation_unit_source)
      } : {})
    }
  };
  return deepFreeze(compilationBundleSchema.parse({
    ...withoutDigest,
    compilation_digest: sha256Canonical(withoutDigest)
  }));
}

export function verifyCompilationBundle(bundle: unknown): CompilationBundleV1 {
  return deepFreeze(compilationBundleSchema.parse(bundle));
}

export function assertCompilationBundleAssets(
  bundle: CompilationBundleV1,
  currentAssets: Readonly<Record<string, { path: string; sha256?: string }>>,
  runtimeAssets: Readonly<Record<string, { real_path: string; project_root: string }>> = {}
): void {
  for (const expected of bundle.asset_lineage) {
    const current = currentAssets[expected.asset_id];
    if (!current || current.path !== expected.path || (expected.declared_sha256 && current.sha256 !== expected.declared_sha256) || (expected.pin_evidence && current.sha256 !== expected.pin_evidence.sha256)) {
      throw new Error(`VPD-J002: compilation bundle asset lineage changed for '${expected.asset_id}'`);
    }
    if (expected.pin_evidence) {
      const runtime = runtimeAssets[expected.asset_id];
      if (!runtime || !isAbsolute(runtime.real_path) || !isAbsolute(runtime.project_root)) {
        throw new Error(`VPD-J002: runtime asset evidence is required for '${expected.asset_id}'`);
      }
      try {
        const projectRoot = realpathSync(runtime.project_root);
        const lexicalExpectedPath = join(projectRoot, expected.path);
        if (realpathSync(lexicalExpectedPath) !== lexicalExpectedPath) throw new Error("asset path contains a link");
        const expectedPath = realpathSync(lexicalExpectedPath);
        const runtimePath = realpathSync(runtime.real_path);
        if (!isProjectAssetIdentityContained(projectRoot, expectedPath) || expectedPath !== runtimePath) {
          throw new Error("asset identity changed");
        }
        const fd = openSync(expectedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== expected.pin_evidence.byte_size || sha256Fd(fd, stat.size) !== expected.pin_evidence.sha256) {
            throw new Error("asset bytes changed");
          }
          const after = fstatSync(fd);
          if ((stat.dev !== 0 && stat.ino !== 0 && (stat.dev !== after.dev || stat.ino !== after.ino))
            || stat.size !== after.size
            || stat.mtimeMs !== after.mtimeMs) throw new Error("asset identity changed");
        } finally {
          closeSync(fd);
        }
      } catch {
        throw new Error(`VPD-J002: compilation bundle asset bytes changed for '${expected.asset_id}'`);
      }
    }
  }
}

/** Separator-aware containment; different Windows drives and UNC roots fail closed. */
type AssetPathApi = {
  resolve(path: string, ...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
};

export function isProjectAssetIdentityContained(root: string, candidate: string, pathApi: AssetPathApi = nativePath): boolean {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCandidate = pathApi.resolve(candidate);
  const descendant = pathApi.relative(resolvedRoot, resolvedCandidate);
  return descendant === ""
    || (!pathApi.isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${pathApi.sep}`));
}

const MAX_PINNED_ASSET_BYTES = 512 * 1024 * 1024;

function sha256Fd(fd: number, byteSize: number): string {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_PINNED_ASSET_BYTES) {
    throw new Error("asset exceeds the bounded pinning limit");
  }
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < byteSize) {
    const read = readSync(fd, chunk, 0, Math.min(chunk.length, byteSize - offset), offset);
    if (read <= 0) throw new Error("short asset read");
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function generationUnitSourceIdentity(source: GenerationUnitProgramSourceV1) {
  return {
    production_id: source.production_id,
    unit_id: source.unit_id,
    ordinal: source.ordinal,
    generation_unit_digest: source.generation_unit_digest,
    program_start_ms: source.program_start_ms,
    program_end_ms: source.program_end_ms,
    ...(source.section_id ? { section_id: source.section_id } : {}),
    music_contract_digest: source.music.contract_digest,
    ...(source.lyrics ? { lyrics_contract_digest: source.lyrics.contract_digest } : {}),
    beat_anchor_ids: source.beat_anchor_refs.map((ref) => ref.fragment_id),
    lyric_cue_ids: source.lyric_cue_refs.map((ref) => ref.fragment_id),
    route_digest: source.route.route_digest
  };
}

/** Write a complete bundle through a sibling temp file; the final file is the commit marker. */
export async function writeCompilationBundleAtomic(
  path: string,
  bundle: CompilationBundleV1
): Promise<void> {
  const checked = verifyCompilationBundle(bundle);
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${path.split("/").pop() ?? "bundle"}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    try { await unlink(temp); } catch { /* best-effort cleanup of a private temp sibling */ }
    throw error;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
