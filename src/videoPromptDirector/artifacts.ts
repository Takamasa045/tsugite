/**
 * Durable H3 compile artifacts under an existing run directory.
 * Written after pin/verify and before the generation adapter is invoked.
 *
 * Adapter-route prompt files are named from a safe adapter id
 * (`prompt.<adapterId>.txt`) so core never hardcodes a provider segment.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GenerationRequest } from "../project/schema.js";
import type { Result } from "../types.js";
import { toPortablePath } from "../platform/path.js";
import {
  enrichH3Compilation,
  type H3Compilation,
  type H3PromptGuideSource
} from "./compile.js";
import { canonicalJson, sha256Canonical, sha256Text, stablePrettyJson } from "../integrity/canonical.js";
import type { H3Asset, H3CreativeIr } from "./schema.js";

export type H3RequestArtifacts = {
  request_id: string;
  /** Safe adapter id used for the adapter-route prompt filename segment. */
  adapter_id: string;
  /** Portable relative directory under the run dir, e.g. `h3/shot-1`. */
  relative_dir: string;
  absolute_dir: string;
  relative_paths: {
    creative_ir: string;
    prompt_canonical: string;
    prompt_adapter: string;
    validation: string;
    lineage: string;
  };
  absolute_paths: {
    creative_ir: string;
    prompt_canonical: string;
    prompt_adapter: string;
    validation: string;
    lineage: string;
  };
  compilation: H3Compilation;
};

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const STATIC_ARTIFACT_FILES = [
  "creative-ir.json",
  "prompt.canonical.txt",
  "validation.json",
  "lineage.json"
] as const;

type StaticArtifactFileName = (typeof STATIC_ARTIFACT_FILES)[number];
type ArtifactFileName = StaticArtifactFileName | string;

/** Build `prompt.<adapterId>.txt` after validating the segment is path-safe. */
export function h3AdapterPromptFileName(adapterId: string): string {
  if (!SAFE_PATH_SEGMENT.test(adapterId)) {
    throw new Error(`h3 adapter id '${adapterId}' is not a safe path segment`);
  }
  return `prompt.${adapterId}.txt`;
}

function resolveSafeAdapterId(adapterId: string | undefined): Result<{ adapterId: string }> {
  if (!adapterId || !SAFE_PATH_SEGMENT.test(adapterId)) {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: adapterId
          ? `h3 artifact adapter id '${adapterId}' is not a safe path segment`
          : "h3 artifact adapter id is required",
        path: "generation.adapter"
      }]
    };
  }
  return { ok: true, issues: [], adapterId };
}

/**
 * Write per-request H3 artifacts under `runDir/h3/<request-id>/`.
 * Fails closed when request ids escape the run dir, path components are
 * symlinks, or pinned inputs cannot be hashed.
 */
export async function writeH3RunArtifacts(options: {
  runDir: string;
  compilations: H3Compilation[];
  pinnedRequests: GenerationRequest[];
  /** Safe adapter id used as the adapter-route prompt filename segment. */
  adapterId: string;
  promptGuides?: H3PromptGuideSource[];
}): Promise<Result<{ artifacts: H3RequestArtifacts[] }>> {
  if (options.compilations.length === 0) {
    return { ok: true, issues: [], artifacts: [] };
  }

  const adapterResolved = resolveSafeAdapterId(options.adapterId);
  if (!adapterResolved.ok) return adapterResolved;
  const adapterId = adapterResolved.adapterId;
  const adapterPromptName = h3AdapterPromptFileName(adapterId);

  const realRunDir = await realpath(options.runDir);
  const pinnedById = new Map(options.pinnedRequests.map((request) => [request.id, request]));
  const guidesByCatalog = new Map(
    (options.promptGuides ?? []).map((guide) => [guide.catalog_id, guide])
  );
  const artifacts: H3RequestArtifacts[] = [];

  for (const compilation of options.compilations) {
    if (!SAFE_PATH_SEGMENT.test(compilation.request_id)) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact request id '${compilation.request_id}' is not a safe path segment`
      );
    }

    const relativeDir = toPortablePath(join("h3", compilation.request_id));
    const pinned = pinnedById.get(compilation.request_id);
    if (!pinned) {
      return h3PathFail(
        compilation.request_id,
        `pinned request missing for h3 compilation '${compilation.request_id}'`
      );
    }

    const hashed = await hashPinnedH3Assets(compilation.creative_ir, pinned, realRunDir);
    if (!hashed.ok) return hashed;

    const guide = pinned.prompt_guide?.catalog
      ? guidesByCatalog.get(pinned.prompt_guide.catalog)
      : undefined;
    const enriched = enrichH3Compilation(compilation, {
      ...(guide ? { promptGuide: guide } : {}),
      ...(Object.keys(hashed.assetHashes).length > 0 ? { assetHashes: hashed.assetHashes } : {})
    });

    // Create/verify h3 root and request dir before any write; refuse symlink components.
    const requestDir = await ensureSafeH3RequestDir(realRunDir, compilation.request_id);
    if (!requestDir.ok) return requestDir;

    const relativePaths = {
      creative_ir: toPortablePath(join(relativeDir, "creative-ir.json")),
      prompt_canonical: toPortablePath(join(relativeDir, "prompt.canonical.txt")),
      prompt_adapter: toPortablePath(join(relativeDir, adapterPromptName)),
      validation: toPortablePath(join(relativeDir, "validation.json")),
      lineage: toPortablePath(join(relativeDir, "lineage.json"))
    };
    const absolutePaths = {
      creative_ir: resolve(requestDir.realDir, "creative-ir.json"),
      prompt_canonical: resolve(requestDir.realDir, "prompt.canonical.txt"),
      prompt_adapter: resolve(requestDir.realDir, adapterPromptName),
      validation: resolve(requestDir.realDir, "validation.json"),
      lineage: resolve(requestDir.realDir, "lineage.json")
    };

    for (const [name, target] of Object.entries(absolutePaths) as Array<[string, string]>) {
      const prepared = await prepareArtifactWriteTarget(realRunDir, requestDir.realDir, target);
      if (!prepared.ok) {
        return h3PathFail(
          compilation.request_id,
          prepared.issues[0]?.message
            ?? `h3 artifact path for '${compilation.request_id}' is unsafe (${name})`
        );
      }
    }

    await writeFile(absolutePaths.creative_ir, stablePrettyJson(enriched.creative_ir));
    await writeFile(absolutePaths.prompt_canonical, `${enriched.canonical_prompt}\n`);
    await writeFile(absolutePaths.prompt_adapter, `${enriched.adapter_prompt}\n`);
    await writeFile(absolutePaths.validation, stablePrettyJson(enriched.validation));
    await writeFile(absolutePaths.lineage, stablePrettyJson(enriched.lineage));

    artifacts.push({
      request_id: compilation.request_id,
      adapter_id: adapterId,
      relative_dir: relativeDir,
      absolute_dir: requestDir.realDir,
      relative_paths: relativePaths,
      absolute_paths: absolutePaths,
      compilation: enriched
    });
  }

  return { ok: true, issues: [], artifacts };
}

/**
 * Read-only inspection of durable H3 artifacts for resume / Gate 2 evidence.
 * Verifies existence, regular-file/non-symlink containment, creative IR hash,
 * exact prompt text + hashes, validation content, and core lineage hashes.
 * When asset_hashes are present, only the 64-hex shape is checked (no invention).
 */
export async function inspectH3RunArtifacts(options: {
  runDir: string;
  compilations: H3Compilation[];
  /** Safe adapter id used as the adapter-route prompt filename segment. */
  adapterId: string;
}): Promise<Result<{ artifacts: H3RequestArtifacts[] }>> {
  if (options.compilations.length === 0) {
    return { ok: true, issues: [], artifacts: [] };
  }

  const adapterResolved = resolveSafeAdapterId(options.adapterId);
  if (!adapterResolved.ok) return adapterResolved;
  const adapterId = adapterResolved.adapterId;
  const adapterPromptName = h3AdapterPromptFileName(adapterId);

  let realRunDir: string;
  try {
    realRunDir = await realpath(options.runDir);
  } catch {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: "h3 artifact inspection requires an existing run directory",
        path: "h3"
      }]
    };
  }

  const artifacts: H3RequestArtifacts[] = [];

  for (const compilation of options.compilations) {
    if (!SAFE_PATH_SEGMENT.test(compilation.request_id)) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact request id '${compilation.request_id}' is not a safe path segment`
      );
    }

    const relativeDir = toPortablePath(join("h3", compilation.request_id));
    const absoluteDir = resolve(realRunDir, "h3", compilation.request_id);
    if (!isPathWithin(realRunDir, absoluteDir)) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact path for '${compilation.request_id}' escapes the run directory`
      );
    }

    const dirStats = await safeLstat(absoluteDir);
    if (!dirStats) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifacts missing for '${compilation.request_id}'`
      );
    }
    if (dirStats.isSymbolicLink()) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact directory for '${compilation.request_id}' is a symlink`
      );
    }
    if (!dirStats.isDirectory()) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact path for '${compilation.request_id}' is not a directory`
      );
    }

    let realDir: string;
    try {
      realDir = await realpath(absoluteDir);
    } catch {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact directory for '${compilation.request_id}' could not be resolved`
      );
    }
    if (!isPathWithin(realRunDir, realDir)) {
      return h3PathFail(
        compilation.request_id,
        `h3 artifact directory for '${compilation.request_id}' escapes the run directory`
      );
    }

    const relativePaths = {
      creative_ir: toPortablePath(join(relativeDir, "creative-ir.json")),
      prompt_canonical: toPortablePath(join(relativeDir, "prompt.canonical.txt")),
      prompt_adapter: toPortablePath(join(relativeDir, adapterPromptName)),
      validation: toPortablePath(join(relativeDir, "validation.json")),
      lineage: toPortablePath(join(relativeDir, "lineage.json"))
    };
    const absolutePaths = {
      creative_ir: resolve(realDir, "creative-ir.json"),
      prompt_canonical: resolve(realDir, "prompt.canonical.txt"),
      prompt_adapter: resolve(realDir, adapterPromptName),
      validation: resolve(realDir, "validation.json"),
      lineage: resolve(realDir, "lineage.json")
    };

    const files = await readVerifiedArtifactFiles(
      realRunDir,
      realDir,
      absolutePaths,
      adapterPromptName
    );
    if (!files.ok) {
      return h3PathFail(
        compilation.request_id,
        files.issues[0]?.message
          ?? `h3 artifacts for '${compilation.request_id}' failed inspection`
      );
    }

    const contentCheck = inspectArtifactContents(compilation, files.contents, adapterPromptName);
    if (!contentCheck.ok) {
      return {
        ok: false,
        issues: contentCheck.issues.map((issue) => ({
          ...issue,
          path: issue.path ?? `generation.requests.${compilation.request_id}`
        }))
      };
    }

    artifacts.push({
      request_id: compilation.request_id,
      adapter_id: adapterId,
      relative_dir: relativeDir,
      absolute_dir: realDir,
      relative_paths: relativePaths,
      absolute_paths: absolutePaths,
      compilation
    });
  }

  return { ok: true, issues: [], artifacts };
}

async function ensureSafeH3RequestDir(
  realRunDir: string,
  requestId: string
): Promise<Result<{ absoluteDir: string; realDir: string }>> {
  const segments = ["h3", requestId];
  let parentReal = realRunDir;
  let absoluteDir = realRunDir;

  for (const segment of segments) {
    absoluteDir = resolve(parentReal, segment);
    if (!isPathWithin(realRunDir, absoluteDir)) {
      return h3PathFail(requestId, `h3 artifact path for '${requestId}' escapes the run directory`);
    }

    const existing = await safeLstat(absoluteDir);
    if (existing) {
      if (existing.isSymbolicLink()) {
        return h3PathFail(
          requestId,
          `h3 artifact path component '${segment}' is a symlink; refusing to write outside the run directory`
        );
      }
      if (!existing.isDirectory()) {
        return h3PathFail(
          requestId,
          `h3 artifact path component '${segment}' exists and is not a directory`
        );
      }
    } else {
      await mkdir(absoluteDir, { recursive: false });
    }

    let realDir: string;
    try {
      realDir = await realpath(absoluteDir);
    } catch {
      return h3PathFail(
        requestId,
        `h3 artifact path component '${segment}' could not be resolved after create`
      );
    }

    if (!isPathWithin(realRunDir, realDir)) {
      return h3PathFail(requestId, `h3 artifact path for '${requestId}' escapes the run directory`);
    }
    // Expect realpath of the created/existing directory to match the absolute join under the parent realpath.
    const expected = resolve(parentReal, segment);
    if (realDir !== expected) {
      // When parentReal is already real and segment is a real dir, expected === realDir.
      // Mismatch means a symlink or mount redirect — fail closed.
      return h3PathFail(
        requestId,
        `h3 artifact path component '${segment}' resolved outside the expected directory`
      );
    }

    parentReal = realDir;
  }

  return { ok: true, issues: [], absoluteDir, realDir: parentReal };
}

async function prepareArtifactWriteTarget(
  realRunDir: string,
  realParentDir: string,
  target: string
): Promise<Result<{}>> {
  if (!isPathWithin(realRunDir, target) || !isPathWithin(realParentDir, target)) {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: "h3 artifact target escapes the verified request directory"
      }]
    };
  }
  if (resolve(realParentDir) === resolve(target)) {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: "h3 artifact target must be a file under the verified request directory"
      }]
    };
  }

  const existing = await safeLstat(target);
  if (existing?.isSymbolicLink()) {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: "h3 artifact target is a symlink; refusing to write through it"
      }]
    };
  }
  if (existing && !existing.isFile()) {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: "h3 artifact target exists and is not a regular file"
      }]
    };
  }
  return { ok: true, issues: [] };
}

async function readVerifiedArtifactFiles(
  realRunDir: string,
  realDir: string,
  absolutePaths: H3RequestArtifacts["absolute_paths"],
  adapterPromptName: string
): Promise<Result<{ contents: Record<string, string> }>> {
  const contents: Record<string, string> = {};
  const mapping: Array<[ArtifactFileName, string]> = [
    ["creative-ir.json", absolutePaths.creative_ir],
    ["prompt.canonical.txt", absolutePaths.prompt_canonical],
    [adapterPromptName, absolutePaths.prompt_adapter],
    ["validation.json", absolutePaths.validation],
    ["lineage.json", absolutePaths.lineage]
  ];

  for (const [name, target] of mapping) {
    if (!isPathWithin(realRunDir, target) || !isPathWithin(realDir, target)) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' escapes the run directory`
        }]
      };
    }
    const stats = await safeLstat(target);
    if (!stats) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' is missing`
        }]
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' is a symlink`
        }]
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' is not a regular file`
        }]
      };
    }
    let realFile: string;
    try {
      realFile = await realpath(target);
    } catch {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' could not be resolved`
        }]
      };
    }
    if (!isPathWithin(realRunDir, realFile) || !isPathWithin(realDir, realFile)) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 artifact '${name}' escapes the run directory`
        }]
      };
    }
    contents[name] = await readFile(realFile, "utf8");
  }

  return { ok: true, issues: [], contents };
}

function inspectArtifactContents(
  expected: H3Compilation,
  contents: Record<string, string>,
  adapterPromptName: string
): Result<{}> {
  let creativeIr: unknown;
  try {
    creativeIr = JSON.parse(contents["creative-ir.json"]!);
  } catch {
    return h3ContentFail(expected.request_id, "creative-ir.json is not valid JSON");
  }
  const creativeIrHash = sha256Canonical(creativeIr);
  if (creativeIrHash !== expected.lineage.creative_ir_hash) {
    return h3ContentFail(expected.request_id, "creative-ir.json does not match the expected creative IR hash");
  }
  if (canonicalJson(creativeIr) !== canonicalJson(expected.creative_ir)) {
    return h3ContentFail(expected.request_id, "creative-ir.json does not match the expected creative IR");
  }

  const canonicalPrompt = stripExactTrailingNewline(contents["prompt.canonical.txt"]!);
  if (canonicalPrompt === undefined) {
    return h3ContentFail(expected.request_id, "prompt.canonical.txt must end with a single trailing newline");
  }
  if (canonicalPrompt !== expected.canonical_prompt) {
    return h3ContentFail(expected.request_id, "prompt.canonical.txt does not match the expected canonical prompt");
  }
  if (sha256Text(canonicalPrompt) !== expected.lineage.canonical_prompt_hash) {
    return h3ContentFail(expected.request_id, "prompt.canonical.txt hash does not match lineage");
  }

  const adapterPrompt = stripExactTrailingNewline(contents[adapterPromptName]!);
  if (adapterPrompt === undefined) {
    return h3ContentFail(expected.request_id, `${adapterPromptName} must end with a single trailing newline`);
  }
  if (adapterPrompt !== expected.adapter_prompt) {
    return h3ContentFail(expected.request_id, `${adapterPromptName} does not match the expected adapter prompt`);
  }
  if (sha256Text(adapterPrompt) !== expected.lineage.adapter_prompt_hash) {
    return h3ContentFail(expected.request_id, `${adapterPromptName} hash does not match lineage`);
  }

  let validation: unknown;
  try {
    validation = JSON.parse(contents["validation.json"]!);
  } catch {
    return h3ContentFail(expected.request_id, "validation.json is not valid JSON");
  }
  if (canonicalJson(validation) !== canonicalJson(expected.validation)) {
    return h3ContentFail(expected.request_id, "validation.json does not match the expected validation result");
  }

  let lineage: Record<string, unknown>;
  try {
    const parsed = JSON.parse(contents["lineage.json"]!);
    if (!isRecord(parsed)) {
      return h3ContentFail(expected.request_id, "lineage.json must be a JSON object");
    }
    lineage = parsed;
  } catch {
    return h3ContentFail(expected.request_id, "lineage.json is not valid JSON");
  }

  for (const key of [
    "workflow_id",
    "workflow_version",
    "creative_ir_hash",
    "canonical_prompt_hash",
    "adapter_prompt_hash"
  ] as const) {
    if (lineage[key] !== expected.lineage[key]) {
      return h3ContentFail(expected.request_id, `lineage.json ${key} does not match the expected compilation`);
    }
  }

  if (
    expected.lineage.prompt_guide_identity !== undefined
    && lineage.prompt_guide_identity !== expected.lineage.prompt_guide_identity
  ) {
    return h3ContentFail(expected.request_id, "lineage.json prompt_guide_identity does not match");
  }
  if (
    expected.lineage.prompt_guide_hash !== undefined
    && lineage.prompt_guide_hash !== expected.lineage.prompt_guide_hash
  ) {
    return h3ContentFail(expected.request_id, "lineage.json prompt_guide_hash does not match");
  }

  if (expected.lineage.locked_block_hashes !== undefined) {
    if (!isRecord(lineage.locked_block_hashes)) {
      return h3ContentFail(
        expected.request_id,
        "lineage.json locked_block_hashes must be an object when expected"
      );
    }
    const expectedLocks = expected.lineage.locked_block_hashes;
    const actualLocks = lineage.locked_block_hashes as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedLocks).sort();
    const actualKeys = Object.keys(actualLocks).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      return h3ContentFail(
        expected.request_id,
        "lineage.json locked_block_hashes keys do not match the expected compilation"
      );
    }
    for (const key of expectedKeys) {
      const hash = actualLocks[key];
      if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
        return h3ContentFail(
          expected.request_id,
          `lineage.json locked_block_hashes['${key}'] must be a 64-char lowercase hex digest`
        );
      }
      if (hash !== expectedLocks[key]) {
        return h3ContentFail(
          expected.request_id,
          `lineage.json locked_block_hashes['${key}'] does not match the expected compilation`
        );
      }
    }
  }

  if (lineage.asset_hashes !== undefined) {
    if (!isRecord(lineage.asset_hashes)) {
      return h3ContentFail(expected.request_id, "lineage.json asset_hashes must be an object");
    }
    for (const [assetId, hash] of Object.entries(lineage.asset_hashes)) {
      if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
        return h3ContentFail(
          expected.request_id,
          `lineage.json asset_hashes['${assetId}'] must be a 64-char lowercase hex digest`
        );
      }
    }
  }

  return { ok: true, issues: [] };
}

function stripExactTrailingNewline(text: string): string | undefined {
  if (!text.endsWith("\n")) return undefined;
  return text.slice(0, -1);
}

async function hashPinnedH3Assets(
  ir: H3CreativeIr,
  pinned: GenerationRequest,
  realRunDir: string
): Promise<Result<{ assetHashes: Record<string, string> }>> {
  const mappings = mapAssetIdsToPinnedPaths(ir, pinned);
  if (!mappings.ok) return mappings;

  const assetHashes: Record<string, string> = {};
  for (const { assetId, path } of mappings.entries) {
    const resolved = await resolvePinnedAssetFile(path, realRunDir, assetId);
    if (!resolved.ok) return resolved;
    assetHashes[assetId] = await sha256FileStream(resolved.path);
  }
  return { ok: true, issues: [], assetHashes };
}

function mapAssetIdsToPinnedPaths(
  ir: H3CreativeIr,
  pinned: GenerationRequest
): Result<{ entries: Array<{ assetId: string; path: string }> }> {
  const entries: Array<{ assetId: string; path: string }> = [];

  switch (ir.target.mode) {
    case "text-to-video":
      return { ok: true, issues: [], entries };
    case "first-frame": {
      const asset = ir.assets.find((item) => item.role === "first_frame");
      if (!asset) return { ok: true, issues: [], entries };
      if (!pinned.first_frame) {
        return missingPinnedPath(asset, "first_frame");
      }
      entries.push({ assetId: asset.id, path: pinned.first_frame });
      return { ok: true, issues: [], entries };
    }
    case "last-frame": {
      const asset = ir.assets.find((item) => item.role === "last_frame");
      if (!asset) return { ok: true, issues: [], entries };
      if (!pinned.last_frame) {
        return missingPinnedPath(asset, "last_frame");
      }
      entries.push({ assetId: asset.id, path: pinned.last_frame });
      return { ok: true, issues: [], entries };
    }
    case "first-last": {
      const first = ir.assets.find((item) => item.role === "first_frame");
      const last = ir.assets.find((item) => item.role === "last_frame");
      // Provider-neutral pins use first_frame/last_frame; some routes pack them into input_images.
      if (pinned.first_frame || pinned.last_frame) {
        if (first) {
          if (!pinned.first_frame) return missingPinnedPath(first, "first_frame");
          entries.push({ assetId: first.id, path: pinned.first_frame });
        }
        if (last) {
          if (!pinned.last_frame) return missingPinnedPath(last, "last_frame");
          entries.push({ assetId: last.id, path: pinned.last_frame });
        }
        return { ok: true, issues: [], entries };
      }
      const paths = pinned.input_images ?? [];
      if (first) {
        if (!paths[0]) return missingPinnedPath(first, "input_images[0]");
        entries.push({ assetId: first.id, path: paths[0] });
      }
      if (last) {
        if (!paths[1]) return missingPinnedPath(last, "input_images[1]");
        entries.push({ assetId: last.id, path: paths[1] });
      }
      return { ok: true, issues: [], entries };
    }
    case "reference": {
      const images = ir.assets.filter((asset) => asset.type === "image");
      const videos = ir.assets.filter((asset) => asset.type === "video");
      const audios = ir.assets.filter((asset) => asset.type === "audio");
      const imagePaths = pinned.input_images ?? [];
      const videoPaths = pinned.input_videos ?? [];
      const audioPaths = pinned.input_audios ?? [];
      for (const [index, asset] of images.entries()) {
        if (!imagePaths[index]) return missingPinnedPath(asset, `input_images[${index}]`);
        entries.push({ assetId: asset.id, path: imagePaths[index]! });
      }
      for (const [index, asset] of videos.entries()) {
        if (!videoPaths[index]) return missingPinnedPath(asset, `input_videos[${index}]`);
        entries.push({ assetId: asset.id, path: videoPaths[index]! });
      }
      for (const [index, asset] of audios.entries()) {
        if (!audioPaths[index]) return missingPinnedPath(asset, `input_audios[${index}]`);
        entries.push({ assetId: asset.id, path: audioPaths[index]! });
      }
      return { ok: true, issues: [], entries };
    }
  }
}

function missingPinnedPath(asset: H3Asset, field: string): Result<{ entries: never[] }> {
  return {
    ok: false,
    issues: [{
      code: "H3-C000",
      message: `h3 asset '${asset.id}' has no pinned path at ${field}; refusing to invent an asset hash`,
      path: `h3.assets.${asset.id}`
    }]
  };
}

async function resolvePinnedAssetFile(
  candidate: string,
  realRunDir: string,
  assetId: string
): Promise<Result<{ path: string }>> {
  try {
    const absolute = isAbsolute(candidate) ? candidate : resolve(realRunDir, candidate);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 asset '${assetId}' resolves to a symlink; hashing requires a regular file under the run directory`,
          path: `h3.assets.${assetId}`
        }]
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 asset '${assetId}' is not a regular file`,
          path: `h3.assets.${assetId}`
        }]
      };
    }
    const real = await realpath(absolute);
    if (!isPathWithin(realRunDir, real)) {
      return {
        ok: false,
        issues: [{
          code: "H3-C000",
          message: `h3 asset '${assetId}' escapes the run directory`,
          path: `h3.assets.${assetId}`
        }]
      };
    }
    return { ok: true, issues: [], path: real };
  } catch {
    return {
      ok: false,
      issues: [{
        code: "H3-C000",
        message: `h3 asset '${assetId}' could not be resolved for hashing`,
        path: `h3.assets.${assetId}`
      }]
    };
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function h3PathFail(requestId: string, message: string): Result<any> {
  return {
    ok: false,
    issues: [{
      code: "H3-C000",
      message,
      path: `generation.requests.${requestId}`
    }]
  };
}

function h3ContentFail(requestId: string, message: string): Result<any> {
  return {
    ok: false,
    issues: [{
      code: "H3-C000",
      message: `h3 artifacts for '${requestId}' failed inspection: ${message}`,
      path: `generation.requests.${requestId}`
    }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256FileStream(path: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}
