/**
 * Planning / dry-run readiness for video prompt compile (P0–P4).
 *
 * Contract:
 * - intent=planning | dry-run: allow provider-non-sending planning when model +
 *   connection route + adapter evidence align. Unknown price / unverified auth are
 *   allowed here; they do not block planning.
 * - intent=execute: always fail-closed with VPD-E022, even if every external
 *   preflight flag would be green. Phase C billing/submit authorization lives in
 *   generationJobs — this module never authorizes provider submit.
 *
 * Runtime/auth/price/cost inputs are intentionally not part of this API so a green
 * boolean cannot be mistaken for execute authorization.
 */

import type { ConnectionCapabilityProfile, ExactModelRoute } from "./connectionCapability.js";
import {
  assertConnectionModeSupported,
  CONNECTION_ROUTE_UNSUPPORTED_CODE
} from "./connectionCapability.js";
import type { ModelPromptProfile } from "./modelProfile.js";
import {
  assertModelModeSupported,
  assertSemanticsAllowed,
  MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
  MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE
} from "./modelProfile.js";
import type { H3Mode } from "./schema.js";

export const VPD_ADAPTER_MISSING_CODE = "VPD-E020";
export const VPD_CATALOG_NOT_ADAPTER_CODE = "VPD-E021";
export const VPD_RUNTIME_NOT_READY_CODE = "VPD-E022";
/** Reserved for generationJobs / future execute-path price checks — not used by planning. */
export const VPD_PRICE_UNKNOWN_CODE = "VPD-E023";
/** Reserved for generationJobs / future execute-path cost approval — not used by planning. */
export const VPD_COST_APPROVAL_MISSING_CODE = "VPD-E024";
/** Reserved for generationJobs / future execute-path auth checks — not used by planning. */
export const VPD_AUTH_NOT_VERIFIED_CODE = "VPD-E025";
export const VPD_PROFILE_CONNECTION_MISMATCH_CODE = "VPD-E026";

export type PlanningReadinessInput = {
  modelProfile: ModelPromptProfile;
  connectionProfile: ConnectionCapabilityProfile;
  mode: H3Mode;
  /** Semantics requested by the authoring path (from profile modes.*.required_semantics). */
  semantics?: string[];
  /**
   * True only when adapter_id was verified against registry or explicit implemented set.
   * Caller boolean alone must not set this without resolveAdapterImplementation.
   */
  adapterImplemented: boolean;
  /** Catalog may list the model; never sufficient alone. */
  catalogPresent?: boolean;
  /**
   * planning / dry-run only for P0–P4.
   * execute is always rejected with VPD-E022 (generationJobs owns paid submit).
   */
  intent: "planning" | "dry-run" | "execute";
};

export type PlanningReadinessResult =
  | {
      ok: true;
      route: ExactModelRoute;
      planning_only: true;
      model_profile_digest_required: true;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

/**
 * Fail-closed readiness for video prompt planning / dry-run.
 * Silent fallback across models, connections, or modes is forbidden.
 * P0–P4: intent=execute always returns VPD-E022 (runtime-not-ready).
 * Auth / price / cost are not consulted and cannot authorize execute.
 */
export function evaluatePlanningReadiness(input: PlanningReadinessInput): PlanningReadinessResult {
  // Execute is never authorized here — even with integrated readiness / known price elsewhere.
  if (input.intent === "execute") {
    return {
      ok: false,
      code: VPD_RUNTIME_NOT_READY_CODE,
      message:
        `intent=execute is not authorized in P0–P4 for connection `
        + `'${input.connectionProfile.connection_id}' (planning/dry-run only; `
        + "paid submit is owned by generationJobs)"
    };
  }

  const modeOk = assertModelModeSupported(input.modelProfile, input.mode);
  if (!modeOk.ok) return modeOk;

  if (input.semantics && input.semantics.length > 0) {
    const semanticsOk = assertSemanticsAllowed(input.modelProfile, input.semantics);
    if (!semanticsOk.ok) return semanticsOk;
  }

  const connectionOk = assertConnectionModeSupported(
    input.connectionProfile,
    input.modelProfile.id,
    input.mode
  );
  if (!connectionOk.ok) {
    // Profile supports mode but connection does not → still reject (no silent route change).
    if (connectionOk.code === CONNECTION_ROUTE_UNSUPPORTED_CODE) {
      return {
        ok: false,
        code: VPD_PROFILE_CONNECTION_MISMATCH_CODE,
        message:
          `model profile '${input.modelProfile.id}' supports mode '${input.mode}', `
          + `but connection '${input.connectionProfile.connection_id}' does not`
      };
    }
    return connectionOk;
  }

  if (!input.adapterImplemented) {
    if (input.catalogPresent) {
      return {
        ok: false,
        code: VPD_CATALOG_NOT_ADAPTER_CODE,
        message:
          `model '${input.modelProfile.id}' appears in a catalog but connection `
          + `'${input.connectionProfile.connection_id}' has no adapter implementation`
      };
    }
    return {
      ok: false,
      code: VPD_ADAPTER_MISSING_CODE,
      message:
        `connection '${input.connectionProfile.connection_id}' has no adapter implementation `
        + `for model '${input.modelProfile.id}'`
    };
  }

  // Planning / dry-run path: adapter + profiles enough; never calls providers.
  // Unknown price / unverified auth do not block planning here.
  return {
    ok: true,
    route: connectionOk.route,
    planning_only: true,
    model_profile_digest_required: true
  };
}

// Re-export codes used by tests for mode-support rejects.
export {
  MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
  MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE,
  CONNECTION_ROUTE_UNSUPPORTED_CODE
};
