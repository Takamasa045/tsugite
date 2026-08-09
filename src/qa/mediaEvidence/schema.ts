/**
 * Common media QA evidence schemas (provider / model neutral).
 * Biometric embeddings are forbidden in persisted manifests and layouts.
 */
import { z } from "zod";

export const FRAMES_MANIFEST_SCHEMA_VERSION = "media-evidence-frames-v1" as const;
export const CONTACT_SHEET_LAYOUT_SCHEMA_VERSION = "media-evidence-contact-sheet-v1" as const;

export const MEDIA_EVIDENCE_LIMITS = {
  max_total_frames: 48,
  max_frames_per_shot: 12,
  max_video_bytes: 512 * 1024 * 1024,
  max_duration_ms: 30 * 60 * 1000,
  max_frame_width: 4096,
  max_frame_height: 4096,
  max_parallelism: 4
} as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const safeRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
    "must be a safe relative path"
  );

const toolInvocationSchema = z
  .object({
    tool: z.string().min(1),
    version: z.string().min(1),
    /** Fixed argv array only — never a shell-concatenated string. */
    argv: z.array(z.string()).min(1)
  })
  .strict();

export const mediaFrameRoleSchema = z.enum(["boundary_start", "boundary_end", "uniform"]);
export type MediaFrameRole = z.infer<typeof mediaFrameRoleSchema>;

export const mediaFrameEntrySchema = z
  .object({
    relative_path: safeRelativePathSchema,
    sha256: sha256HexSchema,
    width: z.number().int().positive().max(MEDIA_EVIDENCE_LIMITS.max_frame_width),
    height: z.number().int().positive().max(MEDIA_EVIDENCE_LIMITS.max_frame_height),
    timestamp_ms: z.number().int().nonnegative(),
    role: mediaFrameRoleSchema.optional(),
    shot_id: z.string().min(1).optional()
  })
  .strict();

export type MediaFrameEntry = z.infer<typeof mediaFrameEntrySchema>;

export const framesManifestSchema = z
  .object({
    schema_version: z.literal(FRAMES_MANIFEST_SCHEMA_VERSION),
    source_video_sha256: sha256HexSchema,
    ffprobe_metadata_digest: sha256HexSchema,
    extractor: toolInvocationSchema,
    timebase: z.string().min(1),
    duration_ms: z.number().int().nonnegative().max(MEDIA_EVIDENCE_LIMITS.max_duration_ms),
    frames: z.array(mediaFrameEntrySchema).min(1).max(MEDIA_EVIDENCE_LIMITS.max_total_frames)
  })
  .strict()
  .superRefine((manifest, context) => {
    const forbidden = findForbiddenBiometricKeys(manifest);
    if (forbidden) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `biometric field '${forbidden}' is forbidden in frames manifests`,
        path: ["frames"]
      });
    }
    // Deterministic ordering: non-decreasing timestamps.
    for (let i = 1; i < manifest.frames.length; i += 1) {
      if (manifest.frames[i]!.timestamp_ms < manifest.frames[i - 1]!.timestamp_ms) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "frames must be ordered by non-decreasing timestamp_ms",
          path: ["frames", i, "timestamp_ms"]
        });
      }
    }
  });

export type FramesManifestV1 = z.infer<typeof framesManifestSchema>;

export const contactSheetCellSchema = z
  .object({
    frame_index: z.number().int().nonnegative(),
    order: z.number().int().nonnegative(),
    label: z.string().min(1)
  })
  .strict();

export const contactSheetLayoutSchema = z
  .object({
    schema_version: z.literal(CONTACT_SHEET_LAYOUT_SCHEMA_VERSION),
    layout_version: z.string().min(1),
    rows: z.number().int().positive(),
    columns: z.number().int().positive(),
    cells: z.array(contactSheetCellSchema),
    /** Digests taken from frames manifest order only (no timestamp recomputation). */
    frame_digests_in_order: z.array(sha256HexSchema),
    generator: toolInvocationSchema,
    output: z
      .object({
        relative_path: safeRelativePathSchema,
        sha256: sha256HexSchema
      })
      .strict()
  })
  .strict()
  .superRefine((layout, context) => {
    const forbidden = findForbiddenBiometricKeys(layout);
    if (forbidden) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `biometric field '${forbidden}' is forbidden in contact sheet layouts`,
        path: ["cells"]
      });
    }
  });

export type ContactSheetLayoutV1 = z.infer<typeof contactSheetLayoutSchema>;

export const analyzerWeightsLicenseSchema = z
  .object({
    analyzer_id: z.string().min(1),
    version: z.string().min(1),
    weights_sha256: sha256HexSchema.optional(),
    license: z.string().min(1).optional(),
    commercial_use: z.string().min(1).optional()
  })
  .strict();

export type AnalyzerWeightsLicense = z.infer<typeof analyzerWeightsLicenseSchema>;

/** Licenses accepted for local pluggable analyzers. "unknown" is always rejected. */
export const ACCEPTED_ANALYZER_LICENSES = new Set([
  "fixture",
  "manual",
  "permissive-commercial",
  "approved-commercial",
  "apache-2.0",
  "mit",
  "bsd-3-clause"
]);

const FORBIDDEN_BIOMETRIC_KEYS = new Set([
  "embedding",
  "embeddings",
  "face_embedding",
  "face_embeddings",
  "biometric_embedding",
  "biometric_embeddings",
  "embedding_vector",
  "embedding_vectors",
  "vector",
  "vectors"
]);

export function findForbiddenBiometricKeys(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const hit = findForbiddenBiometricKeys(child, `${path}[${index}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_BIOMETRIC_KEYS.has(key)) return key;
    const hit = findForbiddenBiometricKeys(child, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return undefined;
}

export function parseFramesManifest(
  input: unknown
): { ok: true; manifest: FramesManifestV1 } | { ok: false; message: string } {
  const parsed = framesManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "invalid frames manifest"
    };
  }
  return { ok: true, manifest: parsed.data };
}

export function parseContactSheetLayout(
  input: unknown
): { ok: true; layout: ContactSheetLayoutV1 } | { ok: false; message: string } {
  const parsed = contactSheetLayoutSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "invalid contact sheet layout"
    };
  }
  return { ok: true, layout: parsed.data };
}
