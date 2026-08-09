/**
 * Connection capability profile: transport, exact model routes, auth env names,
 * job surface status, and planning-time readiness. Credential values are never stored.
 * Separate schema / digest / loader from model prompt profiles.
 *
 * Integrity:
 * - source.digest always binds the profile body (excluding digest + pin_digest).
 * - optional source.pin_digest binds a local pin file under allowed repo roots.
 * - matchesProfile || matchesPinFile is forbidden: body mutation must not pass via pin hash.
 */

import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { sha256Canonical } from "../integrity/canonical.js";
import type { H3Mode } from "./schema.js";

export const CONNECTION_CAPABILITY_UNKNOWN_CODE = "VPD-E010";
export const CONNECTION_CAPABILITY_STALE_CODE = "VPD-E011";
export const CONNECTION_ROUTE_UNSUPPORTED_CODE = "VPD-E012";
export const CONNECTION_ROUTE_EXACT_MISMATCH_CODE = "VPD-E013";
export const CONNECTION_FAMILY_ONLY_CODE = "VPD-E014";
export const CONNECTION_CAPABILITY_PIN_CODE = "VPD-E015";
export const CONNECTION_CAPABILITY_READINESS_CODE = "VPD-E016";

const safeId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

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
     * unknown pricing + integrated is rejected at load time (no silent rewrite).
     */
    runtime_readiness: z.enum(["planning-only", "preflight-only", "integrated"]).default("planning-only"),
    /** Optional adapter implementation id required for non-planning execution. */
    adapter_id: safeId.optional(),
    source: z
      .object({
        pin: z.string().min(1),
        version: z.string().min(1),
        /** Canonical profile body digest (excludes digest + pin_digest fields). */
        digest: sha256Hex.optional(),
        /** Optional SHA-256 of the local pin file under allowed roots (e.g. adapters/). */
        pin_digest: sha256Hex.optional()
      })
      .strict()
  })
  .strict();

export type ConnectionCapabilityProfile = z.infer<typeof connectionCapabilityProfileSchema>;
export type ExactModelRoute = z.infer<typeof exactModelRouteSchema>;

export type ConnectionCapabilityLoadResult =
  | { ok: true; profile: ConnectionCapabilityProfile; digest: string; path: string }
  | { ok: false; code: string; message: string };

export type LoadConnectionCapabilityOptions = {
  /** Repository root owning allowed pin roots. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Relative roots (from repoRoot) that may host pin files. Default: ["adapters"]. */
  allowedPinRoots?: readonly string[];
};

const DEFAULT_ROOTS = ["profiles/connection-capabilities"];
const DEFAULT_PIN_ROOTS = ["adapters"] as const;

/** Canonical body digest: strips source.digest and source.pin_digest. */
export function connectionCapabilityDigest(profile: ConnectionCapabilityProfile): string {
  const { source, ...rest } = profile;
  const { digest: _digest, pin_digest: _pinDigest, ...sourceBody } = source;
  return sha256Canonical({ ...rest, source: sourceBody });
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Lexically validate a relative pin path under one of the allowed roots.
 * Does not follow symlinks; call verifyConnectionPinFile for realpath containment.
 * Error messages intentionally omit absolute paths and file contents.
 */
export function resolveConnectionPinPath(
  pinPath: string,
  options: LoadConnectionCapabilityOptions = {}
): { ok: true; absolutePath: string; allowedRoot: string; repoRoot: string }
  | { ok: false; code: string; message: string } {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const allowedPinRoots = options.allowedPinRoots ?? DEFAULT_PIN_ROOTS;

  if (!pinPath || pinPath.trim() === "") {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin is empty"
    };
  }
  if (isAbsolute(pinPath) || pinPath.includes("\0")) {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin must be a relative path under an allowed root"
    };
  }
  // Reject @version / fragment pins for file pin_digest verification.
  if (pinPath.includes("@") || pinPath.includes("#")) {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability pin_digest requires a plain relative file pin"
    };
  }
  // Reject any ".." segment before resolve so traversal cannot be normalized away silently.
  const segments = pinPath.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  if (segments.some((part) => part === "..")) {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin must not contain path traversal"
    };
  }

  const absolutePath = resolve(repoRoot, pinPath);
  for (const rootRel of allowedPinRoots) {
    if (!rootRel || isAbsolute(rootRel) || rootRel.split(/[/\\]/).includes("..")) {
      continue;
    }
    const allowedRoot = resolve(repoRoot, rootRel);
    if (isPathWithinRoot(allowedRoot, absolutePath)) {
      return { ok: true, absolutePath, allowedRoot, repoRoot };
    }
  }

  return {
    ok: false,
    code: CONNECTION_CAPABILITY_PIN_CODE,
    message: "connection capability source.pin is outside allowed pin roots"
  };
}

/**
 * Verify optional pin_digest against a regular file contained under allowed roots.
 * No credential values or absolute path contents are returned in errors.
 */
export async function verifyConnectionPinFile(
  pinPath: string,
  expectedPinDigest: string,
  options: LoadConnectionCapabilityOptions = {}
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const lexical = resolveConnectionPinPath(pinPath, options);
  if (!lexical.ok) return lexical;

  try {
    const leafStat = await lstat(lexical.absolutePath);
    if (leafStat.isSymbolicLink()) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_PIN_CODE,
        message: "connection capability source.pin must not be a symlink"
      };
    }
    if (!leafStat.isFile()) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_PIN_CODE,
        message: "connection capability source.pin is not a regular file"
      };
    }
  } catch {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin is not readable"
    };
  }

  try {
    const [realRoot, realPath] = await Promise.all([
      realpath(lexical.allowedRoot),
      realpath(lexical.absolutePath)
    ]);
    if (!isPathWithinRoot(realRoot, realPath)) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_PIN_CODE,
        message: "connection capability source.pin realpath escaped allowed pin roots"
      };
    }
  } catch {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin is not readable"
    };
  }

  try {
    const bytes = await readFile(lexical.absolutePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedPinDigest) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_PIN_CODE,
        message: "connection capability source.pin_digest is stale"
      };
    }
  } catch {
    return {
      ok: false,
      code: CONNECTION_CAPABILITY_PIN_CODE,
      message: "connection capability source.pin is not readable"
    };
  }

  return { ok: true };
}

export async function loadConnectionCapabilityProfile(
  connectionId: string,
  roots: string[] = DEFAULT_ROOTS,
  options: LoadConnectionCapabilityOptions = {}
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

    // Body digest first — never accept pin-file hash as a substitute for body integrity.
    const digest = connectionCapabilityDigest(parsed.data);
    const declared = parsed.data.source.digest;
    if (declared && declared !== digest) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_STALE_CODE,
        message:
          `connection capability '${connectionId}' source.digest is stale `
          + `(expected profile body digest ${digest})`
      };
    }

    // Optional pin file hash: only when pin_digest is present (no unnecessary file reads).
    if (parsed.data.source.pin_digest) {
      const pinOk = await verifyConnectionPinFile(
        parsed.data.source.pin,
        parsed.data.source.pin_digest,
        options
      );
      if (!pinOk.ok) {
        return {
          ok: false,
          code: pinOk.code,
          message: `connection capability '${connectionId}' ${pinOk.message}`
        };
      }
    }

    // Fail-closed: unknown pricing cannot advertise integrated readiness.
    // No post-digest mutation — reject with loader error instead of silent rewrite.
    if (
      parsed.data.pricing_status === "unknown"
      && parsed.data.runtime_readiness === "integrated"
    ) {
      return {
        ok: false,
        code: CONNECTION_CAPABILITY_READINESS_CODE,
        message:
          `connection capability '${connectionId}' cannot set runtime_readiness=integrated `
          + "while pricing_status=unknown"
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
