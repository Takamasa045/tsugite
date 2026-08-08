/**
 * Execution-ready requires ALL of:
 * model profile AND exact connection capability AND adapter implementation
 * AND runtime preflight AND auth/entitlement AND known price AND matching cost approval.
 *
 * This module only evaluates planning / dry-run readiness for P0–P4.
 * Provider submit is never authorized here.
 * intent=execute is always fail-closed in P0–P4.
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
export const VPD_PRICE_UNKNOWN_CODE = "VPD-E023";
export const VPD_COST_APPROVAL_MISSING_CODE = "VPD-E024";
export const VPD_AUTH_NOT_VERIFIED_CODE = "VPD-E025";
export const VPD_PROFILE_CONNECTION_MISMATCH_CODE = "VPD-E026";

export type PlanningReadinessInput = {
  modelProfile: ModelPromptProfile;
  connectionProfile: ConnectionCapabilityProfile;
  mode: H3Mode;
  /** Semantics requested by the authoring IR (e.g. last-frame-only). */
  semantics?: string[];
  /**
   * True only when adapter_id was verified against registry or explicit implemented set.
   * Caller boolean alone must not set this without resolveAdapterImplementation.
   */
  adapterImplemented: boolean;
  /** Catalog may list the model; never sufficient alone. */
  catalogPresent?: boolean;
  /** Planning/dry-run only for P0–P4 — execute is always rejected. */
  intent: "planning" | "dry-run" | "execute";
  runtimePreflightOk?: boolean;
  authVerified?: boolean;
  entitlementOk?: boolean;
  priceKnown?: boolean;
  costApprovalMatches?: boolean;
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
 * P0–P4: intent=execute always returns runtime-not-ready.
 */
export function evaluatePlanningReadiness(input: PlanningReadinessInput): PlanningReadinessResult {
  // M3: P0–P4 never authorize execute, even when all preflight flags are green.
  if (input.intent === "execute") {
    return {
      ok: false,
      code: VPD_RUNTIME_NOT_READY_CODE,
      message:
        `intent=execute is not authorized in P0–P4 for connection `
        + `'${input.connectionProfile.connection_id}' (planning/dry-run only)`
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
