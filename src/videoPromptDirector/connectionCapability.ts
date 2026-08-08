/**
 * Connection capability profile: transport, exact model routes, auth env names,
 * job surface status, and planning-time readiness. Credential values are never stored.
 * Separate schema / digest / loader from model prompt profiles.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { sha256Canonical } from "../integrity/canonical.js";
import type { H3Mode } from "./schema.js";

export const CONNECTION_CAPABILITY_UNKNOWN_CODE = "VPD-E010";
export const CONNECTION_CAPABILITY_STALE_CODE = "VPD-E011";
export const CONNECTION_ROUTE_UNSUPPORTED_CODE = "VPD-E012";
export const CONNECTION_ROUTE_EXACT_MISMATCH_CODE = "VPD-E013";
export const CONNECTION_FAMILY_ONLY_CODE = "VPD-E014";

const safeId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

const exactModelRouteSchema = z
  .object({
    /** Exact model id (must match IR target.model / model profile id). No family fuzzy match. */
    model: z.string().min(1),
    provider_model: z.string().min(1),
    /** Modes confirmed on this exact route. Absent modes are unsupported. */
    modes: z.array(z.string().min(1)).min(1),
    /** Optional family label for diagnostics only — never used for matching. */
    family: z.string().min(1).optional()
  })
  .strict();

export const connectionCapabilityProfileSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("connection-capability-profile"),
    connection_id: safeId,
    transport: z.enum(["cli", "mcp", "api", "local", "manual"]),
    /** Exact model routes only. Family membership is not enough for planning. */
    exact_model_routes: z.array(exactModelRouteSchema).default([]),
    /** Auth environment variable *names* only — never values. */
    auth_env_names: z.array(envName).default([]),
    submit: z.boolean().default(false),
    poll: z.boolean().default(false),
    cancel: z.boolean().default(false),
    download: z.boolean().default(false),
    idempotency: z.enum(["none", "client-token", "provider-native"]).default("none"),
    pricing_status: z.enum(["known", "unknown", "not-applicable"]).default("unknown"),
    /**
     * Runtime readiness advertised by the profile itself.
     * planning-only: dry-run / plan allowed; no provider submit.
     */
    runtime_readiness: z.enum(["planning-only", "preflight-only", "integrated"]).default("planning-only"),
    /** Optional adapter implementation id required for non-planning execution. */
    adapter_id: safeId.optional(),
    source: z
      .object({
        pin: z.string().min(1),
        version: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{64}$/).optional()
      })
      .strict()
  })
  .strict();

export type ConnectionCapabilityProfile = z.infer<typeof connectionCapabilityProfileSchema>;
export type ExactModelRoute = z.infer<typeof exactModelRouteSchema>;

export type ConnectionCapabilityLoadResult =
  | { ok: true; profile: ConnectionCapabilityProfile; digest: string; path: string }
  | { ok: false; code: string; message: string };

const DEFAULT_ROOTS = ["profiles/connection-capabilities"];

export function connectionCapabilityDigest(profile: ConnectionCapabilityProfile): string {
  const { source, ...rest } = profile;
  const { digest: _digest, ...sourceWithoutDigest } = source;
  return sha256Canonical({ ...rest, source: sourceWithoutDigest });
}

export async function loadConnectionCapabilityProfile(
  connectionId: string,
  roots: string[] = DEFAULT_ROOTS
): Promise<ConnectionCapabilityLoadResult> {
  if (!safeId.safeParse(connectionId).success) {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_UNKNOWN_CODE,
      message: `connection capability id '${connectionId}' is not a safe id`
    };
  }

  for (const root of roots) {
    const path = join(root, `${connectionId}.yaml`);
    try {
      await access(path);
    } catch {
      continue;
    }
    const raw = await readYamlFile(path);
    const parsed = connectionCapabilityProfileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_UNKNOWN_CODE,
        message: `connection capability '${connectionId}' failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`
      };
    }
    if (parsed.data.connection_id !== connectionId) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_UNKNOWN_CODE,
        message: `connection capability id mismatch: file declares '${parsed.data.connection_id}', requested '${connectionId}'`
      };
    }
    const digest = connectionCapabilityDigest(parsed.data);
    if (parsed.data.source.digest && parsed.data.source.digest !== digest) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_STALE_CODE,
        message: `connection capability '${connectionId}' source.digest is stale (expected ${digest})`
      };
    }
    return { ok: true, profile: parsed.data, digest, path };
  }

  return {
    ok: false,
    code: CONNECTION_CAPABILITY_UNKNOWN_CODE,
    message: `unknown connection capability profile '${connectionId}'`
  };
}

/**
 * Resolve an exact model route. Family-only matches are rejected.
 * No fuzzy / silent fallback to another model on the same connection.
 */
export function resolveExactModelRoute(
  profile: ConnectionCapabilityProfile,
  modelId: string
): { ok: true; route: ExactModelRoute } | { ok: false; code: string; message: string } {
  const exact = profile.exact_model_routes.filter((route) => route.model === modelId);
  if (exact.length === 1) {
    return { ok: true, route: exact[0]! };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      code: CONNECTION_ROUTE_EXACT_MISMATCH_CODE,
      message: `connection '${profile.connection_id}' has ambiguous exact routes for model '${modelId}'`
    };
  }

  const familyHits = profile.exact_model_routes.filter(
    (route) => route.family !== undefined && route.family === modelId
  );
  if (familyHits.length > 0) {
    return {
      ok: false,
      code: CONNECTION_FAMILY_ONLY_CODE,
      message:
        `connection '${profile.connection_id}' has family-level entries related to '${modelId}' `
        + "but no exact model route; family match is not execution- or planning-ready"
    };
  }

  return {
    ok: false,
    code: CONNECTION_ROUTE_EXACT_MISMATCH_CODE,
    message: `connection '${profile.connection_id}' has no exact model route for '${modelId}'`
  };
}

export function connectionRouteSupportsMode(
  route: ExactModelRoute,
  mode: H3Mode | string
): boolean {
  return route.modes.includes(mode);
}

export function assertConnectionModeSupported(
  profile: ConnectionCapabilityProfile,
  modelId: string,
  mode: H3Mode | string
): { ok: true; route: ExactModelRoute } | { ok: false; code: string; message: string } {
  const resolved = resolveExactModelRoute(profile, modelId);
  if (!resolved.ok) return resolved;
  if (!connectionRouteSupportsMode(resolved.route, mode)) {
    return {
      ok: false,
      code: CONNECTION_ROUTE_UNSUPPORTED_CODE,
      message:
        `connection '${profile.connection_id}' exact route for model '${modelId}' `
        + `does not support mode '${mode}'`
    };
  }
  return { ok: true, route: resolved.route };
}
