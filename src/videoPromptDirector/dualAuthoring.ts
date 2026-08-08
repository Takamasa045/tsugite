/**
 * Dual authoring guard: request.h3 and request.video_prompt are mutually exclusive.
 * Enforced at every programmatic compile entrypoint (not only Zod schema).
 */

import type { GenerationRequest } from "../project/schema.js";
import { issue, type H3Issue } from "./validation/types.js";

/** Same code as schema dual-authoring rejection (VPD-E030). */
export const VIDEO_PROMPT_DUAL_AUTHORING_CODE = "VPD-E030";

/**
 * Fail-closed when a video_prompt request would proceed uncompiled
 * (empty prompt must never reach generation as a silent pass-through).
 */
export const VIDEO_PROMPT_UNCOMPILED_CODE = "VPD-E031";

export function hasVideoPromptField(
  request: GenerationRequest
): boolean {
  return (request as GenerationRequest & { video_prompt?: unknown }).video_prompt !== undefined;
}

export function hasH3Field(request: GenerationRequest): boolean {
  return request.h3 !== undefined;
}

/**
 * Reject simultaneous request.h3 and request.video_prompt authoring.
 * Schema-independent; call from every compile entrypoint.
 */
export function rejectDualAuthoring(request: GenerationRequest): H3Issue[] {
  if (hasH3Field(request) && hasVideoPromptField(request)) {
    return [issue(
      VIDEO_PROMPT_DUAL_AUTHORING_CODE,
      "request.h3 and request.video_prompt cannot be specified together",
      "error",
      ["video_prompt"]
    )];
  }
  return [];
}

/**
 * Fail-closed when video_prompt is present but the request still has an empty
 * author prompt (compiler has not filled execution fields).
 */
export function rejectUncompiledVideoPrompt(request: GenerationRequest): H3Issue[] {
  if (!hasVideoPromptField(request)) return [];
  if (hasH3Field(request)) return []; // dual is handled separately
  if (request.prompt.trim().length > 0) return [];
  return [issue(
    VIDEO_PROMPT_UNCOMPILED_CODE,
    "request.video_prompt must be compiled for planning/dry-run before use; empty prompt is not allowed",
    "error",
    ["video_prompt"]
  )];
}
