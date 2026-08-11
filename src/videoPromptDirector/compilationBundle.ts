import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { link, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as nativePath from "node:path";
import { z } from "zod";
import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import { ArtifactStore } from "../productionControl/artifactStore.js";
import { programBindingSchema, routeIdentitySchema, type GenerationUnitProgramSourceV1 } from "../productionControl/programBinding.js";
import { digestSchema, safeIdSchema } from "../productionControl/schema.js";
import type { SemanticPromptBlock } from "./semanticBlocks.js";
import type { AdapterLabelMap } from "./adapterDialect.js";
import type { VideoPromptIrV2 } from "./schemaV2.js";
import type { GenerationUnitContractFacts } from "./generationUnitSourceResolver.js";
import { createEffectiveGenerationContract, effectiveGenerationContractSchema, routeFromProfiles, routeIdentityDigest, type EffectiveGenerationContractV1 } from "./effectiveContract.js";
import { isExecutionAuthoritativePinnedPromptBudgetEvidence } from "./promptBudgetEvidence.js";
import { isTrustedH3GrammarProfile } from "./render/h3GrammarV3.js";
import { safeParseVideoPromptIrV2 } from "./schemaV2.js";
import type { ModelPromptProfile } from "./modelProfile.js";
import type { ConnectionCapabilityProfile } from "./connectionCapability.js";
import { modelProfileDigest } from "./modelProfile.js";
import { connectionCapabilityDigest } from "./connectionCapability.js";
import type { TrustedPinnedPromptBudgetEvidence } from "./promptBudgetEvidence.js";

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
  }).strict().optional(),
  asset_contract: z.object({
    contract_id: safeIdSchema,
    revision: z.number().int().nonnegative(),
    digest: digestSchema,
    entry_id: safeIdSchema,
    path: z.string().min(1),
    sha256: digestSchema,
    byte_size: z.number().int().nonnegative(),
    external_send: z.enum(["allowed", "forbidden", "needs-human"])
  }).strict().optional(),
  /** Project-relative immutable run-local pin; never an absolute source path. */
  pin: z.object({
    relative_path: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")),
    sha256: digestSchema,
    byte_size: z.number().int().nonnegative()
  }).strict().optional()
}).strict();

export const compilationBundleSchema = z.object({
  schema_version: z.literal(1),
  workflow: z.literal("video-prompt-v3"),
  request_id: safeIdSchema,
  normalized_ir: z.record(z.string(), z.unknown()),
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
  labels: z.object({
    assets: z.array(z.object({ asset_id: safeIdSchema, type: z.enum(["image", "video", "audio"]), canonical: z.string(), adapter: z.string() }).strict()),
    subjects: z.array(z.object({ subject_id: safeIdSchema, canonical: z.string() }).strict()),
    digest: digestSchema
  }).strict(),
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
    reference_section_order: z.array(z.string().min(1)),
    language_map: z.record(z.string().min(1), z.string().min(2)),
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
    generation_unit_source_canonical_digest: digestSchema.optional(),
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
    }).strict().optional(),
    generation_unit_contract_facts: z.object({
      generation_unit_digest: digestSchema,
      master_duration_ms: z.number().int().positive(),
      clip_duration_ms: z.number().int().positive(),
      audio_policy: z.enum(["reuse-master", "reference-only", "native-generated", "silent"]),
      reference_audio_asset_id: safeIdSchema.optional(),
      reference_audio_asset_digest: digestSchema.optional(),
      asset_contract: z.object({
        contract_id: safeIdSchema,
        revision: z.number().int().nonnegative(),
        digest: digestSchema,
        entry_id: safeIdSchema,
        path: z.string().min(1),
        sha256: digestSchema,
        byte_size: z.number().int().nonnegative(),
        external_send: z.enum(["allowed", "forbidden", "needs-human"])
      }).strict().optional()
    }).strict().optional()
  }).strict(),
  compilation_digest: digestSchema
}).strict().superRefine((bundle, context) => {
  if (bundle.canonical_prompt_digest !== sha256Text(bundle.canonical_prompt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["canonical_prompt_digest"], message: "canonical prompt digest mismatch" });
  if (bundle.adapter_prompt_digest !== sha256Text(bundle.adapter_prompt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["adapter_prompt_digest"], message: "adapter prompt digest mismatch" });
  if (sha256Canonical(bundle.normalized_ir) !== bundle.normalized_ir_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["normalized_ir_digest"], message: "normalized IR digest mismatch" });
  if (sha256Canonical({ assets: bundle.labels.assets, subjects: bundle.labels.subjects }) !== bundle.labels.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["labels", "digest"], message: "label map digest mismatch" });
  if (bundle.block_digests && Object.keys(bundle.block_digests).length !== bundle.semantic_blocks.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["block_digests"], message: "block digest map must cover every semantic block" });
  for (const block of bundle.semantic_blocks) {
    if (bundle.block_digests[block.block_id] !== block.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["block_digests", block.block_id], message: "semantic block digest mismatch" });
  }
  if (routeIdentityDigest(bundle.route) !== bundle.route.route_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["route", "route_digest"], message: "route identity digest mismatch" });
  if (bundle.effective_contract_digest !== bundle.effective_contract.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_contract_digest"], message: "effective contract digest mismatch" });
  if (bundle.execution_capable !== (bundle.effective_contract.execution.status === "execution-capable")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution_capable"], message: "execution capability status mismatch" });
  for (const [index, asset] of bundle.asset_lineage.entries()) {
    if (bundle.execution_capable && (!asset.pin_evidence || !asset.pin)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_lineage", index], message: "execution-capable bundles require verified evidence and an immutable pin for every asset" });
    if (asset.pin_evidence && asset.declared_sha256 && asset.declared_sha256 !== asset.pin_evidence.sha256) context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_lineage", index, "pin_evidence", "sha256"], message: "asset pin evidence does not match declared sha256" });
  }
  if (bundle.lineage.generation_unit_source_digest && !bundle.lineage.generation_unit_contract_facts) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lineage", "generation_unit_contract_facts"], message: "MV lineage must bind complete T04 GenerationUnitContract facts" });
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

/** Immutable PO-4 revision identity; run_id/slug are mutable project labels, not revision truth. */
export function compilationRevisionId(bundle: Pick<CompilationBundleV1, "compilation_digest">): string {
  return `revision-${bundle.compilation_digest.slice(0, 32)}`;
}

declare const executionCompilationBundleBrand: unique symbol;
export type ExecutionCompilationBundle = CompilationBundleV1 & { readonly [executionCompilationBundleBrand]: true };
const adoptedExecutionBundles = new WeakSet<object>();

declare const createOnlyArtifactStoreEnvelopeBrand: unique symbol;
export type CreateOnlyArtifactStoreEnvelope = {
  readonly kind: "create-only-artifact-store-envelope";
  readonly create_only: true;
  readonly artifact_id: string;
  readonly artifact_digest: string;
  readonly raw_bytes_digest?: string;
  readonly compilation_digest?: string;
  readonly request_id?: string;
  readonly revision_id?: string;
  readonly production_id?: string;
  readonly project_id?: string;
  readonly [createOnlyArtifactStoreEnvelopeBrand]: true;
};
const trustedArtifactStoreEnvelopes = new WeakSet<object>();
const artifactStoreEnvelopeSnapshots = new WeakMap<object, string>();

export type RuntimeAssetPinEvidence = {
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

export type AssetPin = {
  asset_id: string;
  relative_path: string;
  sha256: string;
  byte_size: number;
};
const trustedAssetPins = new WeakSet<object>();
const assetPinSnapshots = new WeakMap<object, string>();
const assetPinRuntimeSnapshots = new WeakMap<object, { project_root: string; pin_root: string; pin_path: string; dev: number; ino: number; size: number; mtimeMs: number }>();

export function isTrustedAssetPin(pin: AssetPin | undefined): boolean {
  return Boolean(pin) && trustedAssetPins.has(pin as object) && assetPinSnapshots.get(pin as object) === sha256Canonical(pin!);
}

/**
 * Verify and copy from the same opened source descriptor into a create-only
 * project-local pin. The returned token is the only asset authority accepted
 * by execution-capable bundle construction.
 */
export function createVerifiedAssetPin(input: {
  asset_id: string;
  project_root: string;
  project_relative_path: string;
  expected_sha256?: string;
  expected_size?: number;
  expected_real_path?: string;
  pin_root: string;
}): AssetPin {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.asset_id)) throw new Error("VPD-J002: unsafe asset id");
  const root = realpathSync(input.project_root);
  if (isAbsolute(input.project_relative_path) || !isProjectAssetIdentityContained(root, join(root, input.project_relative_path))) throw new Error("VPD-J002: asset path escapes project root");
  const sourcePath = join(root, input.project_relative_path);
  if (realpathSync(sourcePath) !== sourcePath || !isProjectAssetIdentityContained(root, sourcePath)) throw new Error("VPD-J002: asset path contains a link");
  if (input.expected_real_path !== undefined && resolve(input.expected_real_path) !== sourcePath) throw new Error("VPD-J002: asset identity path does not match the project asset");
  const pathIdentity = lstatSync(sourcePath);
  if (pathIdentity.isSymbolicLink() || !pathIdentity.isFile() || pathIdentity.dev === 0 || pathIdentity.ino === 0) throw new Error("VPD-J002: asset path identity is unavailable");
  const pinRoot = resolvePinRoot(input.pin_root, root);
  const pinRelativePath = `asset-pins/${input.asset_id}.bin`;
  const pinPath = join(pinRoot, pinRelativePath);
  const pinDirectory = join(pinRoot, "asset-pins");
  try {
    const pinDirectoryStat = lstatSync(pinDirectory);
    if (!pinDirectoryStat.isDirectory() || pinDirectoryStat.isSymbolicLink()) throw new Error("VPD-J002: asset pin directory is a link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(pinDirectory, { recursive: false, mode: 0o700 });
  }
  assertStrongDirectoryChain(pinDirectory, root);
  let sourceFd = -1;
  let pinFd = -1;
  try {
    sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.dev === 0 || before.ino === 0 || before.dev !== pathIdentity.dev || before.ino !== pathIdentity.ino || before.size > MAX_PINNED_ASSET_BYTES || (input.expected_size !== undefined && before.size !== input.expected_size)) throw new Error("VPD-J002: asset identity or bound changed");
    pinFd = openSync(pinPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = readSync(sourceFd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (read <= 0) throw new Error("VPD-J002: short asset read");
      hash.update(chunk.subarray(0, read));
      let written = 0;
      while (written < read) {
        written += writeSync(pinFd, chunk, written, read - written);
      }
      offset += read;
    }
    const digest = hash.digest("hex");
    const after = fstatSync(sourceFd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || input.expected_sha256 !== undefined && digest !== input.expected_sha256) throw new Error("VPD-J002: asset changed during pin");
    fsyncSync(pinFd);
    const pinStat = fstatSync(pinFd);
    if (!pinStat.isFile() || pinStat.size !== before.size) throw new Error("VPD-J002: pin is not a complete regular file");
    const pin: AssetPin = Object.freeze({ asset_id: input.asset_id, relative_path: pinRelativePath, sha256: digest, byte_size: before.size });
    trustedAssetPins.add(pin as object);
    assetPinSnapshots.set(pin as object, sha256Canonical(pin));
    assetPinRuntimeSnapshots.set(pin as object, {
      project_root: root,
      pin_root: pinRoot,
      pin_path: pinPath,
      dev: pinStat.dev,
      ino: pinStat.ino,
      size: pinStat.size,
      mtimeMs: pinStat.mtimeMs
    });
    return pin;
  } catch (error) {
    throw error instanceof Error ? error : new Error("VPD-J002: asset pin failed");
  } finally {
    if (sourceFd >= 0) closeSync(sourceFd);
    if (pinFd >= 0) closeSync(pinFd);
  }
}

/** Re-read the already-created pin at the execution boundary; the source IR path is never reopened. */
export function verifyVerifiedAssetPin(
  pin: AssetPin,
  input: { project_root: string; pin_root: string; expected_sha256?: string; expected_size?: number }
): void {
  if (!isTrustedAssetPin(pin)) throw new Error("VPD-J002: asset pin is not an opaque trusted token");
  const runtime = assetPinRuntimeSnapshots.get(pin as object);
  if (!runtime || resolve(input.project_root) !== runtime.project_root || resolve(input.pin_root) !== runtime.pin_root) throw new Error("VPD-J002: asset pin root identity does not match");
  assertStrongDirectoryChain(runtime.pin_root, runtime.project_root);
  const lexical = join(runtime.pin_root, pin.relative_path);
  if (!isProjectAssetIdentityContained(runtime.pin_root, lexical) || resolve(lexical) !== runtime.pin_path) throw new Error("VPD-J002: asset pin path identity does not match");
  const leaf = lstatSync(lexical);
  if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.dev === 0 || leaf.ino === 0) throw new Error("VPD-J002: asset pin leaf identity is unavailable");
  const fd = openSync(lexical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== runtime.dev || before.ino !== runtime.ino || before.size !== runtime.size || before.mtimeMs !== runtime.mtimeMs) throw new Error("VPD-J002: asset pin changed before execution");
    const digest = sha256Fd(fd, before.size);
    if (digest !== pin.sha256 || (input.expected_sha256 !== undefined && digest !== input.expected_sha256) || (input.expected_size !== undefined && before.size !== input.expected_size)) throw new Error("VPD-J002: asset pin bytes do not match expected digest");
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("VPD-J002: asset pin changed during execution verification");
  } finally {
    closeSync(fd);
  }
}

export type CompilationBundleInput = {
  request_id: string;
  ir: VideoPromptIrV2;
  canonical_prompt: string;
  adapter_prompt: string;
  semantic_blocks: readonly SemanticPromptBlock[];
  labels: AdapterLabelMap;
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
  generation_unit_source_facts?: GenerationUnitContractFacts;
  asset_evidence?: Readonly<Record<string, RuntimeAssetPinEvidence>>;
  asset_pins?: Readonly<Record<string, AssetPin>>;
};

export function createCompilationBundle(input: CompilationBundleInput): CompilationBundleV1 {
  // This is a structural serializer only. Even an execution-shaped bundle is
  // not execution authority until the opaque live-evidence adoption boundary.
  const semanticBlocks = input.semantic_blocks.map((block) => ({ ...block, source_paths: [...block.source_paths], exact_text_digests: [...block.exact_text_digests] }));
  const withoutDigest = {
    schema_version: 1 as const,
    workflow: "video-prompt-v3" as const,
    request_id: input.request_id,
    normalized_ir: input.ir,
    normalized_ir_digest: sha256Canonical(input.ir),
    normalized_ir_version: 2 as const,
    canonical_prompt: input.canonical_prompt,
    adapter_prompt: input.adapter_prompt,
    canonical_prompt_digest: sha256Text(input.canonical_prompt),
    adapter_prompt_digest: sha256Text(input.adapter_prompt),
    semantic_blocks: semanticBlocks,
    labels: {
      assets: input.labels.assets.map((label) => ({ ...label })),
      subjects: input.labels.subjects.map((label) => ({ ...label })),
      digest: input.labels.digest
    },
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
      ...(input.generation_unit_source_facts?.asset_contract?.entry_id === asset.id
        ? { asset_contract: input.generation_unit_source_facts.asset_contract }
        : {}),
      ...(input.asset_evidence?.[asset.id] ? {
        pin_evidence: {
          source: input.asset_evidence[asset.id].source,
          sha256: input.asset_evidence[asset.id].sha256,
          byte_size: input.asset_evidence[asset.id].byte_size,
          regular_file: input.asset_evidence[asset.id].regular_file,
          contained_in_project_root: input.asset_evidence[asset.id].contained_in_project_root
        },
        ...(input.asset_evidence[asset.id].asset_contract ? { asset_contract: input.asset_evidence[asset.id].asset_contract } : {})
      } : {}),
      ...(input.asset_pins?.[asset.id] && isTrustedAssetPin(input.asset_pins[asset.id]) ? {
        pin: {
          relative_path: input.asset_pins[asset.id].relative_path,
          sha256: input.asset_pins[asset.id].sha256,
          byte_size: input.asset_pins[asset.id].byte_size
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
        generation_unit_source_digest: input.generation_unit_source.generation_unit_digest,
        generation_unit_source_canonical_digest: sha256Canonical(input.generation_unit_source),
        generation_unit_source_identity: generationUnitSourceIdentity(input.generation_unit_source)
      } : {}),
      ...(input.generation_unit_source_facts ? { generation_unit_contract_facts: input.generation_unit_source_facts } : {})
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

export type ExecutionBundleAuthorityContext = {
  effective_contract: EffectiveGenerationContractV1;
  grammar_profile?: unknown;
  trusted_pinned_budget_evidence?: unknown;
  asset_pins: Readonly<Record<string, AssetPin>>;
  artifact_store_envelope?: unknown;
  revision_id?: string;
  project_root?: string;
  asset_pin_root?: string;
  production_id?: string;
  project_id?: string;
};

/**
 * Resolve the envelope only from a real create-only ArtifactStore read. A
 * structurally identical object supplied by a caller is never execution
 * authority because it cannot carry the private runtime brand.
 */
export async function loadCreateOnlyArtifactStoreEnvelope(input: {
  store: ArtifactStore;
  artifact_id: string;
  artifact_digest: string;
  expected_compilation_digest?: string;
  request_id?: string;
  revision_id?: string;
  production_id?: string;
  project_id?: string;
}): Promise<CreateOnlyArtifactStoreEnvelope> {
  if (!(input.store instanceof ArtifactStore) || !/^[a-f0-9]{64}$/u.test(input.artifact_digest)) {
    throw new Error("VPD-K003: create-only artifact-store resolver is unavailable");
  }
  const bytes = await input.store.readBounded(input.artifact_id, 32 * 1024 * 1024);
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== input.artifact_digest) throw new Error("VPD-K003: create-only artifact-store digest mismatch");
  let compilationDigest: string | undefined;
  if (input.expected_compilation_digest !== undefined) {
    let parsed: CompilationBundleV1;
    try { parsed = verifyCompilationBundle(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("VPD-K003: artifact bytes are not a strict compilation bundle"); }
    if (parsed.compilation_digest !== input.expected_compilation_digest
      || (input.request_id !== undefined && parsed.request_id !== input.request_id)) {
      throw new Error("VPD-K003: stored compilation bundle identity mismatch");
    }
    if (!Buffer.from(JSON.stringify(parsed), "utf8").equals(bytes)) throw new Error("VPD-K003: stored compilation bundle bytes are not canonical");
    compilationDigest = parsed.compilation_digest;
  }
  const envelope = Object.freeze({
    kind: "create-only-artifact-store-envelope" as const,
    create_only: true as const,
    artifact_id: input.artifact_id,
    artifact_digest: actualDigest,
    ...(compilationDigest ? { raw_bytes_digest: actualDigest, compilation_digest: compilationDigest } : {}),
    ...(input.request_id ? { request_id: input.request_id } : {}),
    ...(input.revision_id ? { revision_id: input.revision_id } : {}),
    ...(input.production_id ? { production_id: input.production_id } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {})
  }) as CreateOnlyArtifactStoreEnvelope;
  trustedArtifactStoreEnvelopes.add(envelope as object);
  artifactStoreEnvelopeSnapshots.set(envelope as object, sha256Canonical(envelope));
  return envelope;
}

export async function createExecutionCompilationBundleArtifact(input: {
  store: ArtifactStore;
  bundle: CompilationBundleV1;
  revision_id: string;
  production_id?: string;
  project_id?: string;
}): Promise<CreateOnlyArtifactStoreEnvelope> {
  const bundle = verifyCompilationBundle(input.bundle);
  if (!bundle.execution_capable) throw new Error("VPD-K003: planning-only bundle cannot be persisted as execution authority");
  if (!isSafeRelativeId(input.revision_id)) throw new Error("VPD-K002: revision id is unsafe");
  const bytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const productionId = input.production_id ?? "production";
  const projectId = input.project_id ?? "project";
  if (!isSafeRelativeId(productionId) || !isSafeRelativeId(projectId)) throw new Error("VPD-K002: execution artifact namespace is unsafe");
  const artifactId = `compilation-${productionId}-${projectId}-${input.revision_id}-${bundle.request_id}`;
  const stored = await input.store.create({ artifact_id: artifactId, bytes });
  return loadCreateOnlyArtifactStoreEnvelope({
    store: input.store,
    artifact_id: stored.artifact_id,
    artifact_digest: stored.sha256,
    expected_compilation_digest: bundle.compilation_digest,
    request_id: bundle.request_id,
    revision_id: input.revision_id,
    production_id: productionId,
    project_id: projectId
  });
}

/**
 * The sole PO-4 execution derivation path. It recomputes the effective
 * contract from trusted live profiles/evidence and persists/adopts the exact
 * resulting bytes; callers cannot turn a structural JSON assertion into this
 * authority.
 */
export async function deriveExecutionCompilationBundleFromPlanningArtifact(input: {
  planning_bundle: CompilationBundleV1;
  model_profile: ModelPromptProfile;
  connection_profile: ConnectionCapabilityProfile;
  grammar_profile?: Parameters<typeof isTrustedH3GrammarProfile>[0];
  trusted_pinned_budget_evidence: TrustedPinnedPromptBudgetEvidence;
  asset_pins: Readonly<Record<string, AssetPin>>;
  project_root: string;
  asset_pin_root: string;
  store: ArtifactStore;
  production_id: string;
  project_id: string;
  revision_id: string;
}): Promise<{ bundle: ExecutionCompilationBundle; envelope: CreateOnlyArtifactStoreEnvelope }> {
  const planning = verifyCompilationBundle(input.planning_bundle);
  if (planning.execution_capable) throw new Error("VPD-K003: execution derivation requires a planning artifact");
  if (!isExecutionAuthoritativePinnedPromptBudgetEvidence(input.trusted_pinned_budget_evidence)) throw new Error("VPD-K003: budget evidence is not execution-authoritative");
  if (planning.route.ir_model !== input.model_profile.id
    || planning.route.connection_id !== input.connection_profile.connection_id
    || planning.route.adapter_id !== input.connection_profile.adapter_id
    || planning.model_profile_digest !== modelProfileDigest(input.model_profile)
    || planning.connection_capability_digest !== connectionCapabilityDigest(input.connection_profile)) throw new Error("VPD-K002: planning route/profile does not match trusted live profiles");
  const normalized = safeParseVideoPromptIrV2(planning.normalized_ir);
  if (!normalized.success
    || normalized.data.target.model_profile_id !== planning.route.ir_model
    || normalized.data.target.mode !== planning.route.mode_binding) throw new Error("VPD-K002: planning IR does not match the committed route");
  const selectedRoute = routeFromProfiles({
    model: normalized.data.target.model_profile_id,
    mode: normalized.data.target.mode,
    model_profile: input.model_profile,
    connection_profile: input.connection_profile,
    model_profile_digest: planning.model_profile_digest,
    connection_profile_digest: planning.connection_capability_digest
  });
  if (!selectedRoute.ok || sha256Canonical(selectedRoute.route) !== sha256Canonical(planning.route)) throw new Error("VPD-R002: planning route is not the unique current model/mode route");
  const trustedGrammar = input.grammar_profile && isTrustedH3GrammarProfile(input.grammar_profile as never)
    ? input.grammar_profile
    : undefined;
  if (planning.grammar_profile && (!trustedGrammar || sha256Canonical(planning.grammar_profile) !== sha256Canonical(trustedGrammar))) throw new Error("VPD-C003: planning grammar is not the exact trusted profile");
  const effective = createEffectiveGenerationContract({
    mode: planning.route.mode_binding as never,
    route: planning.route,
    model_profile: input.model_profile,
    model_profile_digest: planning.model_profile_digest,
    connection_profile: input.connection_profile,
    connection_profile_digest: planning.connection_capability_digest,
    trusted_pinned_budget_evidence: input.trusted_pinned_budget_evidence,
    capability_evidence: {
      duration: "hard",
      aspect: "hard",
      resolution: "hard",
      mode: "hard",
      reference: "hard",
      group_speaker: trustedGrammar?.features.group_speaker ? "hard" : "unknown",
      exact_text: trustedGrammar?.features.exact_dialogue ? "hard" : "unknown"
    },
    execution_capable: true
  });
  if (!effective.ok) throw new Error(`VPD-K003: trusted profiles cannot derive an execution contract (${effective.issues.map((item) => item.code).join(",")})`);
  for (const asset of planning.asset_lineage) {
    const pin = input.asset_pins[asset.asset_id];
    if (!asset.pin_evidence || !asset.pin || !pin || !isTrustedAssetPin(pin)
      || pin.relative_path !== asset.pin.relative_path
      || pin.sha256 !== asset.pin.sha256
      || pin.byte_size !== asset.pin.byte_size) throw new Error(`VPD-J002: asset '${asset.asset_id}' is not fully pinned`);
    verifyVerifiedAssetPin(pin, { project_root: input.project_root, pin_root: input.asset_pin_root, expected_sha256: asset.pin.sha256, expected_size: asset.pin.byte_size });
  }
  const { compilation_digest: _planningDigest, ...body } = planning;
  const executionBody = {
    ...body,
    effective_contract: effective.contract,
    effective_contract_digest: effective.contract.digest,
    execution_capable: true as const
  };
  const executionBundle = verifyCompilationBundle({ ...executionBody, compilation_digest: sha256Canonical(executionBody) });
  const envelope = await createExecutionCompilationBundleArtifact({
    store: input.store,
    bundle: executionBundle,
    revision_id: input.revision_id,
    production_id: input.production_id,
    project_id: input.project_id
  });
  const adopted = adoptExecutionCompilationBundle(executionBundle, {
    effective_contract: effective.contract,
    grammar_profile: input.grammar_profile,
    trusted_pinned_budget_evidence: input.trusted_pinned_budget_evidence,
    asset_pins: input.asset_pins,
    artifact_store_envelope: envelope,
    revision_id: input.revision_id,
    production_id: input.production_id,
    project_id: input.project_id,
    project_root: input.project_root,
    asset_pin_root: input.asset_pin_root
  });
  return { bundle: adopted, envelope };
}

function isTrustedCreateOnlyArtifactStoreEnvelope(value: unknown): value is CreateOnlyArtifactStoreEnvelope {
  return Boolean(value && typeof value === "object"
    && trustedArtifactStoreEnvelopes.has(value as object)
    && artifactStoreEnvelopeSnapshots.get(value as object) === sha256Canonical(value));
}

/**
 * Structural JSON verification is deliberately not execution adoption. This
 * second boundary requires live trusted objects and the create-only artifact
 * envelope that callers cannot self-sign into a persisted JSON bundle.
 */
export function adoptExecutionCompilationBundle(
  value: unknown,
  context: ExecutionBundleAuthorityContext
): ExecutionCompilationBundle {
  const bundle = verifyCompilationBundle(value);
  if (!bundle.execution_capable) throw new Error("VPD-K003: planning-only bundle cannot be adopted for execution");
  if (bundle.grammar_profile) {
    if (!isTrustedH3GrammarProfile(context.grammar_profile as never)
      || sha256Canonical(bundle.grammar_profile) !== sha256Canonical(context.grammar_profile)) {
      throw new Error("VPD-C003: execution grammar provenance does not match the committed bundle");
    }
  } else if (context.grammar_profile !== undefined) {
    throw new Error("VPD-C003: plain execution bundle must not carry an H3 grammar profile");
  }
  if (!isTrustedCreateOnlyArtifactStoreEnvelope(context.artifact_store_envelope)) throw new Error("VPD-K003: create-only artifact-store provenance is missing");
  if (!isExecutionAuthoritativePinnedPromptBudgetEvidence(context.trusted_pinned_budget_evidence)) throw new Error("VPD-K003: execution requires authoritative budget evidence");
  const budgetEvidence = bundle.effective_contract.effective.prompt_budget.evidence;
  if (!budgetEvidence || budgetEvidence.digest !== context.trusted_pinned_budget_evidence.digest
    || budgetEvidence.model_profile_digest !== bundle.model_profile_digest
    || budgetEvidence.connection_profile_digest !== bundle.connection_capability_digest
    || budgetEvidence.route_digest !== bundle.route.route_digest) {
    throw new Error("VPD-K003: budget evidence does not match the committed route/profile bundle");
  }
  const liveEffective = effectiveGenerationContractSchema.parse(context.effective_contract);
  if (liveEffective.mode !== bundle.route.mode_binding
    || liveEffective.route.route_digest !== bundle.route.route_digest
    || liveEffective.route.ir_model !== bundle.route.ir_model
    || liveEffective.route.provider_model !== bundle.route.provider_model
    || liveEffective.digests.model_profile !== bundle.model_profile_digest
    || liveEffective.digests.connection_profile !== bundle.connection_capability_digest
    || liveEffective.freshness.status !== "fresh"
    || liveEffective.execution.status !== "execution-capable") {
    throw new Error("VPD-K002: live effective contract route/profile/mode/freshness does not match bundle");
  }
  for (const [name, value] of Object.entries(liveEffective.execution.capability_evidence)) {
    if (value !== "hard") throw new Error(`VPD-K003: execution capability '${name}' is not proven by trusted evidence`);
  }
  const { digest: _effectiveDigest, ...effectiveBody } = context.effective_contract;
  if (sha256Canonical(effectiveBody) !== bundle.effective_contract_digest
    || context.effective_contract.digest !== bundle.effective_contract_digest) throw new Error("VPD-K002: live effective contract does not match bundle");
  const envelope = context.artifact_store_envelope;
  const expectedProductionId = context.production_id ?? envelope.production_id ?? "production";
  const expectedProjectId = context.project_id ?? envelope.project_id ?? "project";
  if (!isSafeRelativeId(expectedProductionId) || !isSafeRelativeId(expectedProjectId)
    || envelope.artifact_id !== `compilation-${expectedProductionId}-${expectedProjectId}-${context.revision_id ?? envelope.revision_id ?? ""}-${bundle.request_id}`
    || envelope.compilation_digest !== bundle.compilation_digest
    || envelope.raw_bytes_digest !== envelope.artifact_digest
    || envelope.request_id !== bundle.request_id
    || (context.revision_id !== undefined && envelope.revision_id !== context.revision_id)) {
    throw new Error("VPD-K003: create-only artifact-store provenance is missing");
  }
  if (!context.project_root || !context.asset_pin_root) throw new Error("VPD-J002: execution requires a bound project-local asset pin root");
  const expectedAssetIds = new Set(bundle.asset_lineage.map((asset) => asset.asset_id));
  if (Object.keys(context.asset_pins).some((assetId) => !expectedAssetIds.has(assetId))) throw new Error("VPD-J002: live asset pin set contains an unbound asset");
  for (const asset of bundle.asset_lineage) {
    const pin = context.asset_pins[asset.asset_id];
    if (!pin || !isTrustedAssetPin(pin) || !asset.pin
      || pin.relative_path !== asset.pin.relative_path
      || pin.sha256 !== asset.pin.sha256
      || pin.byte_size !== asset.pin.byte_size
      || asset.pin_evidence?.sha256 !== pin.sha256
      || asset.pin_evidence.byte_size !== pin.byte_size
      || (asset.asset_contract && (asset.asset_contract.sha256 !== pin.sha256
        || asset.asset_contract.byte_size !== pin.byte_size
        || asset.asset_contract.external_send !== "allowed"))) {
      throw new Error(`VPD-J002: live opaque asset pin does not match '${asset.asset_id}'`);
    }
    verifyVerifiedAssetPin(pin, { project_root: context.project_root, pin_root: context.asset_pin_root, expected_sha256: asset.pin.sha256, expected_size: asset.pin.byte_size });
  }
  adoptedExecutionBundles.add(bundle as object);
  return bundle as ExecutionCompilationBundle;
}

export function isAdoptedExecutionCompilationBundle(value: unknown): value is ExecutionCompilationBundle {
  return Boolean(value && typeof value === "object" && adoptedExecutionBundles.has(value as object));
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
          if (stat.dev === 0 || stat.ino === 0 || after.dev === 0 || after.ino === 0
            || stat.dev !== after.dev || stat.ino !== after.ino
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

function resolvePinRoot(pinRoot: string, projectRoot: string): string {
  if (!isAbsolute(pinRoot) || !isProjectAssetIdentityContained(projectRoot, pinRoot)) {
    throw new Error("VPD-J002: asset pin root must be a project-local regular directory");
  }
  const resolved = resolve(pinRoot);
  assertStrongDirectoryChain(resolved, resolve(projectRoot));
  return resolved;
}

function assertStrongDirectoryChain(candidate: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isProjectAssetIdentityContained(resolvedRoot, resolvedCandidate)) throw new Error("VPD-J002: asset pin directory escapes project root");
  const relativePath = nativePath.relative(resolvedRoot, resolvedCandidate);
  const parts = relativePath ? relativePath.split(nativePath.sep) : [];
  let current = resolvedRoot;
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev === 0 || rootStat.ino === 0) {
    throw new Error("VPD-J002: project root identity is not strong");
  }
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev === 0 || stat.ino === 0) {
      throw new Error("VPD-J002: asset pin ancestor identity is not strong");
    }
  }
}

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

/**
 * Persist a complete bundle under a trusted project root. A no-replace final
 * directory reservation and hard-link publication expose the commit marker
 * only after every bounded staged file has been fsynced. Existing final paths
 * and links are never replaced.
 */
export async function writeCompilationBundleAtomic(
  path: string,
  bundle: CompilationBundleV1,
  options: {
    project_root: string;
    revision_id: string;
    request_id: string;
    allow_existing_same_digest?: boolean;
  }
): Promise<void> {
  const checked = verifyCompilationBundle(bundle);
  if (!options.project_root) throw new Error("VPD-K002: compilation artifact project root is required");
  const projectRoot = resolve(options.project_root);
  if (resolve(path) !== projectRoot) throw new Error("VPD-K002: compilation artifact root must equal the trusted project root");
  await ensureTrustedProjectRoot(projectRoot);
  const target = resolveCompilationTarget(projectRoot, options.revision_id, options.request_id);
  const parent = dirname(target);
  if (!isAbsolute(target) || !isProjectAssetIdentityContained(projectRoot, target)) throw new Error("VPD-K002: compilation artifact path escapes the trusted project root");
  await ensureTrustedDirectoryChain(parent, projectRoot);
  assertStrongDirectoryChain(parent, projectRoot);
  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink() || existing.isFile()) throw new Error("VPD-K002: compilation artifact already exists");
    if (existing.isDirectory() && options.allow_existing_same_digest) {
      try {
        const persisted = readCompilationBundleAtomic(target, { project_root: projectRoot });
        if (persisted.manifest.compilation_digest === checked.compilation_digest
          && persisted.bundle.compilation_digest === checked.compilation_digest) return;
      } catch {
        // A marker-less final directory may be resumed only after the staged
        // bytes are compared leaf-by-leaf by publishNoReplaceDirectory.
      }
    } else if (existing.isDirectory()) {
      throw new Error("VPD-K002: compilation artifact already exists");
    }
    if (!existing.isDirectory()) throw new Error("VPD-K002: compilation artifact already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = join(parent, `.${target.split(nativePath.sep).pop() ?? "bundle"}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await mkdir(temp, { recursive: false, mode: 0o700 });
    const adapterPromptName = `prompt.${checked.route.adapter_id}.txt`;
    const contents: Record<string, string> = {
      "ir.normalized.json": JSON.stringify(checked.normalized_ir),
      "effective-contract.json": JSON.stringify(checked.effective_contract),
      "semantic-blocks.json": JSON.stringify(checked.semantic_blocks),
      "prompt.canonical.txt": checked.canonical_prompt,
      [adapterPromptName]: checked.adapter_prompt,
      "labels.json": JSON.stringify(checked.labels),
      "validation.json": JSON.stringify(checked.validation),
      "route.json": JSON.stringify(checked.route),
      "lineage.json": JSON.stringify(checked.lineage),
      "bundle.json": JSON.stringify(checked),
      // Keep the pre-v3 filenames readable for existing local consumers; the
      // v3 names above remain the authoritative file set.
      "canonical-prompt.txt": checked.canonical_prompt,
      "adapter-prompt.txt": checked.adapter_prompt
    };
    const fileDigests: Record<string, string> = {};
    for (const [file, value] of Object.entries(contents)) {
      await writeCreateOnlyText(join(temp, file), value);
      fileDigests[file] = sha256Text(`${value}\n`);
    }
    const manifest = JSON.stringify({
      schema_version: 1,
      request_id: checked.request_id,
      revision_id: options.revision_id,
      compilation_digest: checked.compilation_digest,
      canonical_prompt_digest: checked.canonical_prompt_digest,
      adapter_prompt_digest: checked.adapter_prompt_digest,
      file_digests: fileDigests,
      committed: true
    });
    await writeCreateOnlyText(join(temp, "compilation-manifest.json"), manifest);
    fsyncDirectory(temp);
    await publishNoReplaceDirectory({
      temp,
      target,
      project_root: projectRoot,
      parent,
      expected_files: contents,
      manifest_name: "compilation-manifest.json",
      manifest_value: manifest,
      allow_existing_same_digest: options.allow_existing_same_digest,
      expected_compilation_digest: checked.compilation_digest
    });
  } catch (error) {
    try { await rm(temp, { recursive: true, force: true }); } catch { /* best-effort cleanup of a private temp sibling */ }
    throw error;
  }
}

export type PersistedCompilationBundle = {
  bundle: CompilationBundleV1;
  manifest: {
    schema_version: 1;
    compilation_digest: string;
    canonical_prompt_digest: string;
    adapter_prompt_digest: string;
    committed: true;
  };
};

export function readCompilationBundleAtomic(
  path: string,
  options: { project_root: string; revision_id?: string; request_id?: string }
): PersistedCompilationBundle {
  if (!options.project_root) throw new Error("VPD-K002: compilation artifact project root is required");
  const projectRoot = resolve(options.project_root);
  const target = options.revision_id !== undefined || options.request_id !== undefined
    ? resolveCompilationTarget(projectRoot, options.revision_id, options.request_id ?? "")
    : resolve(path);
  if (!isProjectAssetIdentityContained(projectRoot, target)) throw new Error("VPD-K002: compilation artifact path escapes the trusted project root");
  assertDirectoryIdentity(projectRoot);
  assertStrongDirectoryChain(target, projectRoot);
  const marker = z.object({
    schema_version: z.literal(1),
    request_id: safeIdSchema,
    revision_id: safeIdSchema,
    compilation_digest: digestSchema,
    canonical_prompt_digest: digestSchema,
    adapter_prompt_digest: digestSchema,
    file_digests: z.record(safeIdSchema.or(z.string().regex(/^prompt\.[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/u)), digestSchema),
    committed: z.literal(true)
  }).strict().parse(JSON.parse(readBoundedFile(join(target, "compilation-manifest.json"))));
  const bundle = verifyCompilationBundle(JSON.parse(readBoundedFile(join(target, "bundle.json"))));
  if (bundle.request_id !== marker.request_id
    || bundle.compilation_digest !== marker.compilation_digest
    || bundle.canonical_prompt_digest !== marker.canonical_prompt_digest
    || bundle.adapter_prompt_digest !== marker.adapter_prompt_digest) {
    throw new Error("VPD-K002: persisted compilation manifest does not match bundle");
  }
  const files = [
    "ir.normalized.json",
    "effective-contract.json",
    "semantic-blocks.json",
    "prompt.canonical.txt",
    `prompt.${bundle.route.adapter_id}.txt`,
    "labels.json",
    "validation.json",
    "route.json",
    "lineage.json",
    "bundle.json",
    "canonical-prompt.txt",
    "adapter-prompt.txt"
  ];
  for (const file of files) {
    if (readBoundedFile(join(target, file)).length === 0) throw new Error("VPD-K002: persisted compilation file is empty");
    if (marker.file_digests[file] !== sha256Text(readBoundedFile(join(target, file)))) throw new Error("VPD-K002: persisted compilation file digest mismatch");
  }
  if (readBoundedFile(join(target, "prompt.canonical.txt")) !== `${bundle.canonical_prompt}\n`
    || readBoundedFile(join(target, `prompt.${bundle.route.adapter_id}.txt`)) !== `${bundle.adapter_prompt}\n`
    || readBoundedFile(join(target, "canonical-prompt.txt")) !== `${bundle.canonical_prompt}\n`
    || readBoundedFile(join(target, "adapter-prompt.txt")) !== `${bundle.adapter_prompt}\n`
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "ir.normalized.json")))) !== bundle.normalized_ir_digest
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "semantic-blocks.json")))) !== sha256Canonical(bundle.semantic_blocks)
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "labels.json")))) !== sha256Canonical(bundle.labels)
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "validation.json")))) !== sha256Canonical(bundle.validation)
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "route.json")))) !== sha256Canonical(bundle.route)
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "effective-contract.json")))) !== sha256Canonical(bundle.effective_contract)
    || sha256Canonical(JSON.parse(readBoundedFile(join(target, "lineage.json")))) !== sha256Canonical(bundle.lineage)) {
    throw new Error("VPD-K002: persisted compilation file set does not match the committed bundle");
  }
  return { bundle, manifest: marker };
}

function resolveCompilationTarget(projectRoot: string, revisionId: string | undefined, requestId: string): string {
  if (!revisionId || !isSafeRelativeId(revisionId) || !isSafeRelativeId(requestId)) throw new Error("VPD-K002: revision and request ids must be safe relative ids");
  return join(projectRoot, revisionId, "video-prompt", requestId);
}

async function ensureTrustedDirectoryChain(candidate: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isProjectAssetIdentityContained(resolvedRoot, resolvedCandidate)) throw new Error("VPD-K002: compilation artifact path escapes the trusted project root");
  assertDirectoryIdentity(resolvedRoot);
  const relativePath = nativePath.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const part of relativePath ? relativePath.split(nativePath.sep) : []) {
    if (!isSafeRelativeId(part)) throw new Error("VPD-K002: compilation artifact path contains an unsafe segment");
    current = join(current, part);
    try {
      assertDirectoryIdentity(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { recursive: false, mode: 0o700 });
      assertDirectoryIdentity(current);
    }
  }
}

async function ensureTrustedProjectRoot(root: string): Promise<void> {
  try {
    assertDirectoryIdentity(root);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(root);
  assertDirectoryIdentity(parent);
  await mkdir(root, { recursive: false, mode: 0o700 });
  assertDirectoryIdentity(root);
}

async function publishNoReplaceDirectory(input: {
  temp: string;
  target: string;
  project_root: string;
  parent: string;
  expected_files: Readonly<Record<string, string>>;
  manifest_name: string;
  manifest_value: string;
  allow_existing_same_digest?: boolean;
  expected_compilation_digest?: string;
}): Promise<void> {
  const expectedNames = [...Object.keys(input.expected_files), input.manifest_name];
  let created = false;
  try {
    // mkdir is the no-replace directory reservation. Unlike rename(temp,target)
    // it cannot replace a concurrent or malicious final directory.
    await mkdir(input.target, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!input.allow_existing_same_digest) throw new Error("VPD-K002: compilation artifact already exists");
  }
  assertStrongDirectoryChain(input.target, input.project_root);
  if (!created && input.expected_compilation_digest) {
    try {
      const persisted = readCompilationBundleAtomic(input.target, { project_root: input.project_root });
      if (persisted.bundle.compilation_digest === input.expected_compilation_digest) return;
      throw new Error("VPD-K002: committed compilation digest differs");
    } catch (error) {
      if (error instanceof Error && error.message.includes("committed compilation digest differs")) throw error;
      // A marker-less directory is resumable only when its existing leaves
      // are a byte-exact subset of this staged publication.
    }
  }
  const entries = await readdir(input.target, { withFileTypes: true });
  for (const entry of entries) {
    if (!expectedNames.includes(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("VPD-K002: compilation artifact destination contains an unexpected leaf");
    }
  }
  const allExpected: Array<[string, string]> = [
    ...Object.entries(input.expected_files),
    [input.manifest_name, input.manifest_value]
  ];
  for (const [name, expectedValue] of allExpected) {
    const destination = join(input.target, name);
    let exists = false;
    try {
      const stat = lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.dev === 0 || stat.ino === 0) throw new Error("VPD-K002: compilation artifact destination leaf identity is unsafe");
      exists = true;
      if (readBoundedFile(destination) !== `${expectedValue}\n`) throw new Error("VPD-K002: compilation artifact destination bytes differ");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!exists) {
      try {
        // Hard-linking the fsynced staged file is atomic and no-replace on the
        // destination leaf; no mutable pathname is copied or reopened.
        await link(join(input.temp, name), destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("VPD-K002: no-replace compilation publication failed");
        if (readBoundedFile(destination) !== `${expectedValue}\n`) throw new Error("VPD-K002: concurrent compilation publication differs");
      }
    }
  }
  assertStrongDirectoryChain(input.target, input.project_root);
  fsyncDirectory(input.target);
  fsyncDirectory(input.parent);
}

function isSafeRelativeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

/** Shadow comparison is intentionally a separate, non-authoritative namespace. */
export async function writeShadowComparisonAtomic(
  root: string,
  comparison: { request_id: string; authoritative: "legacy"; status: string; compilation_digest?: string; issues: unknown[]; revision_id?: string; legacy_canonical_prompt_digest?: string; legacy_adapter_prompt_digest?: string; v2_canonical_prompt_digest?: string; v2_adapter_prompt_digest?: string; diff?: unknown },
  options: { project_root: string; revision_id: string }
): Promise<void> {
  if (!options.project_root) throw new Error("VPD-K002: shadow artifact project root is required");
  const projectRoot = resolve(options.project_root);
  const target = resolveCompilationTarget(projectRoot, options.revision_id, comparison.request_id);
  await ensureTrustedProjectRoot(projectRoot);
  const parent = dirname(target);
  await ensureTrustedDirectoryChain(parent, projectRoot);
  assertStrongDirectoryChain(parent, projectRoot);
  const payload = JSON.stringify({ ...comparison, authoritative: "legacy", gate_binding: null, run_binding: null });
  try {
    assertStrongDirectoryChain(target, projectRoot);
    const existing = readBoundedFile(join(target, "comparison.json"));
    const manifest = z.object({
      schema_version: z.literal(1),
      request_id: safeIdSchema,
      comparison_digest: digestSchema,
      committed: z.literal(true)
    }).strict().parse(JSON.parse(readBoundedFile(join(target, "comparison-manifest.json"))));
    if (existing === `${payload}\n`
      && manifest.request_id === comparison.request_id
      && manifest.comparison_digest === sha256Text(`${payload}\n`)
      && manifest.committed === true) return;
    throw new Error("VPD-C004: shadow comparison artifact changed after commit");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message.startsWith("VPD-C004")) throw error;
      // A missing final directory is the only state eligible for publication.
    }
  }
  const temp = join(parent, `.shadow-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await mkdir(temp, { recursive: false, mode: 0o700 });
    await writeCreateOnlyText(join(temp, "comparison.json"), payload);
    const manifest = JSON.stringify({ schema_version: 1, request_id: comparison.request_id, comparison_digest: sha256Text(`${payload}\n`), committed: true });
    await writeCreateOnlyText(join(temp, "comparison-manifest.json"), manifest);
    fsyncDirectory(temp);
    await publishNoReplaceDirectory({
      temp,
      target,
      project_root: projectRoot,
      parent,
      expected_files: { "comparison.json": payload },
      manifest_name: "comparison-manifest.json",
      manifest_value: manifest,
      allow_existing_same_digest: true
    });
  } catch (error) {
    try { await rm(temp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
  fsyncDirectory(target);
  fsyncDirectory(parent);
}

const MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024;

async function writeCreateOnlyText(path: string, value: string): Promise<void> {
  const bytes = Buffer.from(`${value}\n`, "utf8");
  if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) throw new Error("VPD-K002: compilation artifact exceeds bounded write size");
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readBoundedFile(path: string): string {
  const expected = lstatSync(path);
  if (expected.isSymbolicLink() || !expected.isFile() || expected.dev === 0 || expected.ino === 0 || expected.size > MAX_BUNDLE_FILE_BYTES) {
    throw new Error("VPD-K002: compilation artifact leaf is not a bounded stable regular file");
  }
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev === 0 || opened.ino === 0 || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error("VPD-K002: compilation artifact leaf identity changed");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("VPD-K002: compilation artifact short read");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("VPD-K002: compilation artifact leaf changed during read");
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assertDirectoryIdentity(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev === 0 || stat.ino === 0) {
    throw new Error("VPD-K002: compilation artifact directory identity is not strong");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
