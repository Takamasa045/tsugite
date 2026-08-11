/**
 * Model prompt profile: declarative model semantics (modes, durations, renderer).
 * Separate schema, digest, and loader from connection capability profiles.
 * Catalog presence alone is never treated as execution-ready.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import { verifyModelProfileAgainstKnowledge } from "./knowledgeBounds.js";
import type { H3Mode } from "./schema.js";

export const MODEL_PROFILE_STALE_CODE = "VPD-E001";
export const MODEL_PROFILE_UNKNOWN_CODE = "VPD-E002";
export const MODEL_PROFILE_UNSUPPORTED_MODE_CODE = "VPD-E003";
export const MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE = "VPD-E004";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const modeSupportSchema = z
  .object({
    supported: z.boolean(),
    /** Neutral input_mode emitted for planning when supported. */
    input_mode: z.string().min(1).optional(),
    asset_roles: z.array(z.string().min(1)).default([]),
    notes: z.array(z.string().min(1)).default([]),
    /**
     * Provider-neutral semantics required for this mode on this profile.
     * Omit or [] so non-H3 models never inherit H3 terms from mode alone.
     * Optional (no default) keeps digests stable when the field is absent.
     */
    required_semantics: z.array(z.string().min(1)).optional()
  })
  .strict();

export const modelPromptProfileSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("model-prompt-profile"),
    id: safeId,
    display_name: z.string().min(1),
    /**
     * Optional aliases for this profile id (e.g. knowledge aliases).
     * IR target.model and connection exact routes use `id`, not aliases, unless explicitly mapped.
     * Omit when unused so profile digests stay stable.
     */
    aliases: z.array(z.string().min(1)).optional(),
    /**
     * Canonical knowledge model id when it differs from profile id
     * (e.g. profile id `o1` → knowledge `video-o1`).
     */
    knowledge_model_id: z.string().min(1).optional(),
    source: z
      .object({
        pin: z.string().min(1),
        version: z.string().min(1),
        /** Expected content digest of this profile body (excluding digest field). */
        digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        review_after: z.string().min(1).optional()
      })
      .strict(),
    modes: z
      .object({
        "text-to-video": modeSupportSchema.optional(),
        "first-frame": modeSupportSchema.optional(),
        "first-last": modeSupportSchema.optional(),
        "last-frame": modeSupportSchema.optional(),
        reference: modeSupportSchema.optional()
      })
      .strict(),
    durations: z.array(z.number().positive()).min(1),
    aspects: z.array(z.string().min(1)).min(1),
    resolutions: z.array(z.string().min(1)).min(1),
    /** Renderer id: h3-grammar keeps H3 Picture/FL2VA/L2VA; plain-prompt is generic. */
    renderer: z.enum(["h3-grammar", "plain-prompt"]),
    /** H3-only label dialect. Other models must not declare picture. */
    label_dialect: z.enum(["picture", "none"]).default("none"),
    /**
     * Optional prompt skeleton opt-in (Phase D).
     * When set, plain-prompt compile may emit skeleton-ordered sections.
     * H3 grammar ignores this and keeps BASE/REFERENCE section order.
     */
    prompt_skeleton: z
      .object({
        id: z.string().min(1),
        /** Optional explicit block order; otherwise catalog default for id is used. */
        blocks: z.array(z.string().min(1)).min(1).optional()
      })
      .strict()
      .optional(),
    /** Explicitly unsupported modes (fail-closed, no silent remap). */
    unsupported: z.array(z.string().min(1)).default([]),
    /** Semantics that must not leak to other models (e.g. last-frame-only). */
    exclusive_semantics: z.array(z.string().min(1)).default([])
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.renderer === "h3-grammar" && profile.label_dialect !== "picture") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "h3-grammar renderer requires label_dialect=picture",
        path: ["label_dialect"]
      });
    }
    if (profile.renderer !== "h3-grammar" && profile.label_dialect === "picture") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "picture label dialect is reserved for h3-grammar",
        path: ["label_dialect"]
      });
    }
  });

export type ModelPromptProfile = z.infer<typeof modelPromptProfileSchema>;

export type ModelProfileLoadResult =
  | { ok: true; profile: ModelPromptProfile; digest: string; path: string }
  | { ok: false; code: string; message: string };

const DEFAULT_ROOTS = ["profiles/model-prompts"];

/** Canonical digest of profile content with source.digest stripped. */
export function modelProfileDigest(profile: ModelPromptProfile): string {
  const { source, ...rest } = profile;
  const { digest: _digest, ...sourceWithoutDigest } = source;
  return sha256Canonical({ ...rest, source: sourceWithoutDigest });
}

export async function loadModelPromptProfile(
  modelId: string,
  roots: string[] = DEFAULT_ROOTS
): Promise<ModelProfileLoadResult> {
  if (!safeId.safeParse(modelId).success) {
    return {
      ok: false,
      code: MODEL_PROFILE_UNKNOWN_CODE,
      message: `model profile id '${modelId}' is not a safe id`
    };
  }

  for (const root of roots) {
    const path = join(root, `${modelId}.yaml`);
    try {
      await access(path);
    } catch {
      continue;
    }
    const raw = await readYamlFile(path);
    const parsed = modelPromptProfileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: MODEL_PROFILE_UNKNOWN_CODE,
        message: `model profile '${modelId}' failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`
      };
    }
    if (parsed.data.id !== modelId) {
      return {
        ok: false,
        code: MODEL_PROFILE_UNKNOWN_CODE,
        message: `model profile id mismatch: file declares '${parsed.data.id}', requested '${modelId}'`
      };
    }
    const digest = modelProfileDigest(parsed.data);
    if (parsed.data.source.digest && parsed.data.source.digest !== digest) {
      return {
        ok: false,
        code: MODEL_PROFILE_STALE_CODE,
        message: `model profile '${modelId}' source.digest is stale (expected ${digest})`
      };
    }
    // Knowledge-pinned profiles must stay within primary knowledge bounds even when
    // source.digest matches the inflated body (digest alone is not a capability claim).
    if (parsed.data.source.pin.startsWith("knowledge/")) {
      const bounds = await verifyModelProfileAgainstKnowledge(parsed.data);
      if (!bounds.ok) {
        return {
          ok: false,
          code: bounds.code,
          message: bounds.message
        };
      }
    }
    return { ok: true, profile: parsed.data, digest, path };
  }

  return {
    ok: false,
    code: MODEL_PROFILE_UNKNOWN_CODE,
    message: `unknown model prompt profile '${modelId}'`
  };
}

export function modelProfileSupportsMode(
  profile: ModelPromptProfile,
  mode: H3Mode
): boolean {
  if (profile.unsupported.includes(mode)) return false;
  const entry = profile.modes[mode];
  return Boolean(entry?.supported);
}

export function assertModelModeSupported(
  profile: ModelPromptProfile,
  mode: H3Mode
): { ok: true } | { ok: false; code: string; message: string } {
  if (modelProfileSupportsMode(profile, mode)) return { ok: true };
  return {
    ok: false,
    code: MODEL_PROFILE_UNSUPPORTED_MODE_CODE,
    message: `model profile '${profile.id}' does not support mode '${mode}'`
  };
}

/** Reject H3-exclusive semantics (e.g. last-frame-only) when the profile does not declare them. */
export function assertSemanticsAllowed(
  profile: ModelPromptProfile,
  semantics: string[]
): { ok: true } | { ok: false; code: string; message: string } {
  for (const item of semantics) {
    if (!profile.exclusive_semantics.includes(item)) {
      return {
        ok: false,
        code: MODEL_PROFILE_UNSUPPORTED_SEMANTICS_CODE,
        message: `model profile '${profile.id}' does not allow exclusive semantics '${item}'`
      };
    }
  }
  return { ok: true };
}

/**
 * Provider-neutral required semantics declared on a mode entry.
 * Generic compile/readiness must use this (not exclusiveSemanticsForMode).
 */
export function requiredSemanticsForMode(
  profile: ModelPromptProfile,
  mode: H3Mode
): string[] {
  return profile.modes[mode]?.required_semantics ?? [];
}

/** Hash raw profile file bytes for pin evidence (optional helper). */
export async function hashModelProfileFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  return sha256Text(text);
}
