/**
 * Adapter implementation presence for planning readiness.
 * Caller booleans alone are never trusted: connection.adapter_id must match
 * an explicit implemented set and/or a real adapter registry entry.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

export const VPD_ADAPTER_REGISTRY_MISSING_CODE = "VPD-E027";

export type AdapterImplementationCheckInput = {
  /** From connection capability profile. */
  adapterId: string | undefined;
  /**
   * Explicit set of adapter ids known to have implementations for this call.
   * Preferred for unit tests and planned allow-lists.
   */
  implementedAdapterIds?: readonly string[];
  /**
   * Optional registry roots (default: adapters/). Presence of adapter.yaml
   * under `<root>/<adapterId>/` counts as registered.
   */
  adapterDirs?: readonly string[];
  /**
   * Caller boolean is advisory only. When true without set/registry match, still reject.
   */
  callerClaimsImplemented?: boolean;
};

export type AdapterImplementationCheckResult =
  | { ok: true; adapterId: string; source: "explicit-set" | "registry" }
  | { ok: false; code: string; message: string };

/**
 * Cross-check connection.adapter_id against explicit set and/or registry.
 * P0–P4 planning may pass only when the adapter id is confirmed present.
 * Execution is never authorized here.
 */
export async function resolveAdapterImplementation(
  input: AdapterImplementationCheckInput
): Promise<AdapterImplementationCheckResult> {
  const adapterId = input.adapterId?.trim();
  if (!adapterId) {
    return {
      ok: false,
      code: VPD_ADAPTER_REGISTRY_MISSING_CODE,
      message:
        "connection capability is missing adapter_id; "
        + "adapterImplemented caller boolean alone is not accepted"
    };
  }

  if (input.implementedAdapterIds && input.implementedAdapterIds.includes(adapterId)) {
    return { ok: true, adapterId, source: "explicit-set" };
  }

  const dirs = input.adapterDirs ?? ["adapters"];
  for (const dir of dirs) {
    const path = join(dir, adapterId, "adapter.yaml");
    try {
      await access(path);
      return { ok: true, adapterId, source: "registry" };
    } catch {
      // try next root
    }
  }

  return {
    ok: false,
    code: VPD_ADAPTER_REGISTRY_MISSING_CODE,
    message:
      `adapter_id '${adapterId}' is not present in the adapter registry or implementedAdapterIds`
      + (input.callerClaimsImplemented
        ? " (caller adapterImplemented=true was ignored without registry match)"
        : "")
  };
}
