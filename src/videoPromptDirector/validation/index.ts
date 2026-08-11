import type { H3CreativeIr } from "../schema.js";
import { validateLockedBlocks } from "../lockedBlocks.js";
import { validateH3Format } from "./h3Format.js";
import {
  validateH3AdapterRoute,
  type H3ExecutionRouteProfile
} from "./adapterRoute.js";
import { validateH3Warnings } from "./warnings.js";
import { finalizeValidation, type H3Issue, type H3ValidationResult } from "./types.js";

export { validateH3Format } from "./h3Format.js";
export {
  validateH3AdapterRoute,
  H3_ROUTE_MODEL_MISMATCH_CODE,
  H3_ROUTE_UNSUPPORTED_MODE_CODE,
  H3_ASSET_BINDING_MISMATCH_CODE,
  H3_PROVIDER_MODEL_MAPPING_MISSING_CODE,
  type H3ExecutionRouteProfile,
  type H3RouteModeBinding
} from "./adapterRoute.js";
export { validateH3Warnings } from "./warnings.js";
export type { H3Issue, H3IssueSeverity, H3ValidationResult } from "./types.js";
export {
  validateLockedBlocks,
  LOCK_HASH_MISMATCH_CODE
} from "../lockedBlocks.js";

export type H3ValidateOptions = {
  /** When provided, also check rendered section headers, shot stamps, dialogue tags, and labels. */
  renderedText?: string;
  /**
   * When provided, include adapter execution-route checks
   * (H3-C006 model match + PV-E001..E008) against this profile.
   * Omit for format-only validation.
   */
  routeProfile?: H3ExecutionRouteProfile;
  /** Include feasible warnings. Default true. */
  includeWarnings?: boolean;
};

/**
 * Compose H3 format validation with optional route checks and warnings.
 * Format rules and adapter route rules remain separate code paths.
 * Route limits are never invented in core — callers inject a profile.
 * locked_blocks hash checks are renderer-independent and always run.
 */
export function validateH3CreativeIr(
  ir: H3CreativeIr,
  options: H3ValidateOptions = {}
): H3ValidationResult {
  const issues: H3Issue[] = [];
  // Always: hash integrity of locked identity blocks (plain + H3).
  issues.push(...validateLockedBlocks(ir));
  issues.push(...validateH3Format(ir, options.renderedText).issues);
  if (options.routeProfile) {
    issues.push(...validateH3AdapterRoute(ir, options.routeProfile).issues);
  }
  if (options.includeWarnings ?? true) {
    issues.push(...validateH3Warnings(ir).issues);
  }
  return finalizeValidation(issues);
}
