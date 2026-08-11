/**
 * Lineage helpers for video prompt compilations (H3 workflow identity preserved).
 */

import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import type { GenerationRequest } from "../project/schema.js";
import { collectPromptBlockDigests } from "./blockDigests.js";
import { collectLockedBlockHashes } from "./lockedBlocks.js";
import type { H3CreativeIr } from "./schema.js";

/** Stable workflow identity for compiled H3 prompts (compatibility). */
export const H3_WORKFLOW_ID = "h3-prompt-director";
/**
 * Versioned IR/compiler contract identity (not an implementation phase name).
 * v2: last-frame mode, provider-neutral first-last/last-frame intents, official FL2VA/L2VA alignment.
 */
export const H3_WORKFLOW_VERSION = "2";

/** Neutral workflow id for non-H3 video_prompt compilations. */
export const VIDEO_PROMPT_WORKFLOW_ID = "video-prompt-director";
export const VIDEO_PROMPT_WORKFLOW_VERSION = "1";

export type H3Lineage = {
  workflow_id: string;
  workflow_version: string;
  creative_ir_hash: string;
  canonical_prompt_hash: string;
  adapter_prompt_hash: string;
  prompt_guide_identity?: string;
  prompt_guide_hash?: string;
  asset_hashes?: Record<string, string>;
  model_profile_digest?: string;
  connection_capability_digest?: string;
  /** Declared sha256 of subject locked_blocks fields ("subjectId.field" → hex). */
  locked_block_hashes?: Record<string, string>;
  /** IR field digests for iteration multi-block comparison (Phase E). */
  block_digests?: Record<string, string>;
};

export type H3PromptGuideSource = {
  catalog_id: string;
  root?: string;
  path?: string;
  [key: string]: unknown;
};

export function buildLineage(
  ir: H3CreativeIr,
  canonicalPrompt: string,
  adapterPrompt: string,
  request: GenerationRequest,
  options: {
    workflow_id?: string;
    workflow_version?: string;
    model_profile_digest?: string;
    connection_capability_digest?: string;
  } = {}
): H3Lineage {
  const lineage: H3Lineage = {
    workflow_id: options.workflow_id ?? H3_WORKFLOW_ID,
    workflow_version: options.workflow_version ?? H3_WORKFLOW_VERSION,
    creative_ir_hash: sha256Canonical(ir),
    canonical_prompt_hash: sha256Text(canonicalPrompt),
    adapter_prompt_hash: sha256Text(adapterPrompt)
  };

  const guideIdentity = promptGuideIdentity(request);
  if (guideIdentity) {
    lineage.prompt_guide_identity = guideIdentity;
  }
  if (options.model_profile_digest) {
    lineage.model_profile_digest = options.model_profile_digest;
  }
  if (options.connection_capability_digest) {
    lineage.connection_capability_digest = options.connection_capability_digest;
  }

  const lockedBlockHashes = collectLockedBlockHashes(ir);
  if (lockedBlockHashes) {
    lineage.locked_block_hashes = lockedBlockHashes;
  }

  lineage.block_digests = collectPromptBlockDigests(ir);

  return lineage;
}

export function promptGuideIdentity(request: GenerationRequest): string | undefined {
  const guide = request.prompt_guide;
  if (!guide) return undefined;
  return guide.model ? `${guide.catalog}/${guide.model}` : guide.catalog;
}

export function hashPromptGuideContent(guide: H3PromptGuideSource): string {
  const { root: _root, path: _path, ...content } = guide;
  return sha256Canonical(content);
}
