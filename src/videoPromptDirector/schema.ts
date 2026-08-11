import { z } from "zod";
import { win32 } from "node:path";

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

function hasWindowsPathRoot(value: string): boolean {
  return win32.parse(value).root.length > 0;
}

const safeRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/")
      && !hasWindowsPathRoot(value)
      && !value.includes("..")
      && !value.includes("\\"),
    "must be a safe relative path"
  );

export const h3ModeSchema = z.enum([
  "text-to-video",
  "first-frame",
  "first-last",
  "last-frame",
  "reference"
]);

/** Product-facing labels for H3 modes (schema values stay stable machine ids). */
export const H3_MODE_UI_LABELS = {
  "text-to-video": "text-to-video",
  "first-frame": "first-frame",
  "first-last": "first-last",
  "last-frame": "last-frame-only",
  reference: "reference"
} as const satisfies Record<z.infer<typeof h3ModeSchema>, string>;

export function h3ModeUiLabel(mode: z.infer<typeof h3ModeSchema>): string {
  return H3_MODE_UI_LABELS[mode];
}

/**
 * Canonical H3 Creative IR model id (v1+).
 * No aliases and no unknown-model fallback: only this exact value is accepted on request.h3.
 * Provider-facing model ids are mapped only by adapter / connection capability profiles.
 */
export const H3_CANONICAL_MODEL = "minimax-h3" as const;
export const h3ModelSchema = z.literal(H3_CANONICAL_MODEL);

/**
 * Provider-neutral model id for video_prompt authoring.
 * Exact support is declared by a model prompt profile; unknown models fail closed later.
 */
export const videoModelIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe model id");

/**
 * Model-general quality target (H3 Creative IR accepts free-form quality strings).
 * Adapter execution routes may narrow this via constraints.yaml `h3_execution_route`.
 */
export const h3QualitySchema = z.string().min(1);

/**
 * Model-general H3 aspect targets from published model knowledge.
 * Adapter-route validation (PV-E008) is injected from the selected adapter profile.
 */
export const H3_MODEL_ASPECTS = [
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16"
] as const;
export const h3AspectSchema = z.enum(H3_MODEL_ASPECTS);
export const h3AssetTypeSchema = z.enum(["image", "video", "audio"]);
export const h3AssetRoleSchema = z.enum([
  "subject_reference",
  "first_frame",
  "last_frame",
  "motion_reference",
  "voice_reference",
  "environment_reference",
  "style_reference",
  "other"
]);

export const h3CameraTypeSchema = z.enum([
  "push_in",
  "push_out",
  "zoom_in",
  "zoom_out",
  "pan",
  "truck",
  "arc",
  "track",
  "static",
  "hold"
]);

export const h3AmplitudeSchema = z.enum(["small", "medium", "large"]);
export const h3SpeedSchema = z.enum(["slow", "medium", "fast"]);

const videoTargetSchema = z
  .object({
    model: videoModelIdSchema,
    mode: h3ModeSchema,
    duration: z.number().positive(),
    quality: h3QualitySchema,
    aspect: h3AspectSchema,
    audio: z.boolean()
  })
  .strict();

const h3TargetSchema = z
  .object({
    model: h3ModelSchema,
    mode: h3ModeSchema,
    duration: z.number().positive(),
    quality: h3QualitySchema,
    aspect: h3AspectSchema,
    audio: z.boolean()
  })
  .strict();

const h3CreativeSchema = z
  .object({
    intent: z.string().min(1).optional(),
    style: z
      .object({
        medium: z.string().min(1).optional(),
        tone: z.string().min(1).optional(),
        lighting: z.string().min(1).optional(),
        palette: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    must_include: z.array(z.string().min(1)).optional(),
    avoid: z.array(z.string().min(1)).optional()
  })
  .strict()
  .optional();

const lockedBlockFieldSchema = z
  .object({
    text: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "must be lowercase sha256 hex")
  })
  .strict();

const lockedBlocksSchema = z
  .object({
    voice: lockedBlockFieldSchema.optional(),
    appearance: lockedBlockFieldSchema.optional(),
    manner: lockedBlockFieldSchema.optional()
  })
  .strict();

const h3SubjectSchema = z
  .object({
    id: safeIdSchema,
    description: z.string().min(1),
    source_asset: safeIdSchema.optional(),
    speaker_id: z
      .string()
      .regex(/^S\d+$/, "speaker_id must look like S1")
      .optional(),
    voice: z
      .object({
        source_asset: safeIdSchema.optional(),
        description: z.string().min(1).optional(),
        relationship: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    /**
     * Verbatim identity text blocks (voice / appearance / manner).
     * Optional; when present, validate checks sha256 and compile injects text without paraphrase.
     */
    locked_blocks: lockedBlocksSchema.optional(),
    preservation: z
      .object({
        identity: z.enum(["strict", "loose"]).optional(),
        clothing: z.enum(["strict", "loose"]).optional(),
        hairstyle: z.enum(["strict", "loose"]).optional()
      })
      .strict()
      .optional(),
    /** Optional person-consistency QA participation (Phase B). Off by default. */
    consistency: z
      .object({
        enabled: z.boolean(),
        reference_region: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().min(0).max(1),
            height: z.number().min(0).max(1)
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict();

const h3AssetSchema = z
  .object({
    id: safeIdSchema,
    type: h3AssetTypeSchema,
    path: safeRelativePathSchema,
    role: h3AssetRoleSchema.default("other")
  })
  .strict();

const h3CameraSchema = z
  .object({
    type: h3CameraTypeSchema,
    amplitude: h3AmplitudeSchema.optional(),
    speed: h3SpeedSchema.optional(),
    direction: z.string().min(1).optional(),
    sentence: z.string().min(1).optional()
  })
  .strict();

const h3DialogueSchema = z
  .object({
    speaker: safeIdSchema.optional(),
    speaker_id: z
      .string()
      .regex(/^S\d+$/, "speaker_id must look like S1")
      .optional(),
    language: z.string().min(1),
    text: z.string().min(1),
    lock_text: z.boolean().default(true),
    voiceover: z.boolean().default(false),
    speaker_description: z.string().min(1).optional()
  })
  .strict()
  .superRefine((dialogue, context) => {
    if (!dialogue.speaker && !dialogue.speaker_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dialogue requires speaker or speaker_id",
        path: ["speaker_id"]
      });
    }
  });

const h3SceneSchema = z
  .object({
    id: safeIdSchema,
    /** Anchor-based spatial description; compile injects verbatim into LOCATION MAP. */
    location_map: z.string().min(1),
    /** World palette / lighting prose; compile injects into LIGHTING when set. */
    palette: z.string().min(1).optional(),
    /** Subjects allowed in this scene. Empty = undeclared_subject check off. */
    active_subjects: z.array(safeIdSchema).default([])
  })
  .strict();

const h3ShotSchema = z
  .object({
    id: safeIdSchema,
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    transition: z.enum(["cut", "none"]).optional(),
    /** Optional scene id; when set, compile prepends scene location_map / palette. */
    scene: safeIdSchema.optional(),
    composition: z
      .object({
        framing: z.string().min(1).optional(),
        subject_position: z.string().min(1).optional(),
        environment: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    visual: z.string().min(1),
    camera: h3CameraSchema.optional(),
    dialogue: h3DialogueSchema.optional(),
    on_screen_text: z.string().min(1).optional(),
    lyrics: z.string().min(1).optional(),
    /** Optional per-shot subject visibility for person-consistency QA (Phase B). */
    subject_expectations: z
      .array(
        z
          .object({
            subject_id: safeIdSchema,
            visibility: z.enum(["visible", "partial", "occluded", "offscreen"]),
            face_visibility: z.enum(["required", "optional", "not_expected"])
          })
          .strict()
      )
      .optional()
  })
  .strict()
  .superRefine((shot, context) => {
    if (shot.end_ms <= shot.start_ms) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "end_ms must be greater than start_ms",
        path: ["end_ms"]
      });
    }
  });

const h3SoundSchema = z
  .object({
    soundscape: z.string().min(1),
    music: z
      .object({
        enabled: z.boolean(),
        description: z.string().min(1).optional()
      })
      .strict()
      .superRefine((music, context) => {
        if (music.enabled && !music.description) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "enabled music requires description",
            path: ["description"]
          });
        }
      })
  })
  .strict();

const creativeIrObjectSchema = (targetSchema: typeof videoTargetSchema | typeof h3TargetSchema) =>
  z
  .object({
    version: z.literal(1),
    target: targetSchema,
    creative: h3CreativeSchema,
    subjects: z.array(h3SubjectSchema).default([]),
    assets: z.array(h3AssetSchema).default([]),
    /** Optional scene layer for shared location/palette inject across shots. */
    scenes: z.array(h3SceneSchema).optional(),
    shots: z.array(h3ShotSchema).min(1),
    sound: h3SoundSchema
  })
  .strict()
  .superRefine((ir, context) => {
    const assetIds = new Set<string>();
    for (const [index, asset] of ir.assets.entries()) {
      if (assetIds.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "asset ids must be unique",
          path: ["assets", index, "id"]
        });
      }
      assetIds.add(asset.id);
    }

    const subjectIds = new Set<string>();
    for (const [index, subject] of ir.subjects.entries()) {
      if (subjectIds.has(subject.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subject ids must be unique",
          path: ["subjects", index, "id"]
        });
      }
      subjectIds.add(subject.id);
      if (subject.source_asset && !assetIds.has(subject.source_asset)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subject source_asset '${subject.source_asset}' is undefined`,
          path: ["subjects", index, "source_asset"]
        });
      }
      if (subject.voice?.source_asset && !assetIds.has(subject.voice.source_asset)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subject voice.source_asset '${subject.voice.source_asset}' is undefined`,
          path: ["subjects", index, "voice", "source_asset"]
        });
      }
    }

    const sceneIds = new Set<string>();
    for (const [index, scene] of (ir.scenes ?? []).entries()) {
      if (sceneIds.has(scene.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "scene ids must be unique",
          path: ["scenes", index, "id"]
        });
      }
      sceneIds.add(scene.id);
      for (const [subIndex, subjectId] of scene.active_subjects.entries()) {
        if (!subjectIds.has(subjectId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `scene active_subjects '${subjectId}' is undefined`,
            path: ["scenes", index, "active_subjects", subIndex]
          });
        }
      }
    }

    const shotIds = new Set<string>();
    for (const [index, shot] of ir.shots.entries()) {
      if (shotIds.has(shot.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "shot ids must be unique",
          path: ["shots", index, "id"]
        });
      }
      shotIds.add(shot.id);
      if (shot.scene && !sceneIds.has(shot.scene)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `shot scene '${shot.scene}' is undefined`,
          path: ["shots", index, "scene"]
        });
      }
      if (shot.dialogue?.speaker && !subjectIds.has(shot.dialogue.speaker)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dialogue speaker '${shot.dialogue.speaker}' is undefined`,
          path: ["shots", index, "dialogue", "speaker"]
        });
      }
    }

    if (ir.target.mode === "first-frame") {
      const first = ir.assets.filter((asset) => asset.role === "first_frame");
      if (first.length !== 1 || first[0]?.type !== "image") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "first-frame mode requires exactly one first_frame image asset",
          path: ["assets"]
        });
      }
    }
    if (ir.target.mode === "first-last") {
      const first = ir.assets.filter((asset) => asset.role === "first_frame");
      const last = ir.assets.filter((asset) => asset.role === "last_frame");
      if (
        first.length !== 1
        || last.length !== 1
        || first[0]?.type !== "image"
        || last[0]?.type !== "image"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "first-last mode requires first_frame and last_frame image assets",
          path: ["assets"]
        });
      }
    }
    if (ir.target.mode === "last-frame") {
      const last = ir.assets.filter((asset) => asset.role === "last_frame");
      const unexpected = ir.assets.filter((asset) => asset.role !== "last_frame");
      if (
        last.length !== 1
        || last[0]?.type !== "image"
        || unexpected.length > 0
        || ir.assets.some((asset) => asset.type === "video" || asset.type === "audio")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "last-frame mode requires exactly one last_frame image and no first_frame, reference, video, or audio assets",
          path: ["assets"]
        });
      }
    }
  });

/** Provider-neutral Creative IR (video_prompt authoring). */
export const videoCreativeIrSchema = creativeIrObjectSchema(videoTargetSchema);
/** H3 compatibility IR: model locked to minimax-h3. */
export const h3CreativeIrSchema = creativeIrObjectSchema(h3TargetSchema);

export type H3Mode = z.infer<typeof h3ModeSchema>;
export type H3Model = z.infer<typeof h3ModelSchema>;
export type H3Quality = z.infer<typeof h3QualitySchema>;
export type H3Aspect = z.infer<typeof h3AspectSchema>;
export type H3ModelAspect = (typeof H3_MODEL_ASPECTS)[number];
export type H3CreativeIr = z.infer<typeof h3CreativeIrSchema>;
export type VideoCreativeIr = z.infer<typeof videoCreativeIrSchema>;
export type H3Asset = H3CreativeIr["assets"][number];
export type H3Subject = H3CreativeIr["subjects"][number];
export type H3Scene = NonNullable<H3CreativeIr["scenes"]>[number];
export type H3Shot = H3CreativeIr["shots"][number];
export type H3Dialogue = NonNullable<H3Shot["dialogue"]>;
export type H3Camera = NonNullable<H3Shot["camera"]>;

export function parseH3CreativeIr(input: unknown): H3CreativeIr {
  return h3CreativeIrSchema.parse(input);
}

export function safeParseH3CreativeIr(input: unknown) {
  return h3CreativeIrSchema.safeParse(input);
}

export function parseVideoCreativeIr(input: unknown): VideoCreativeIr {
  return videoCreativeIrSchema.parse(input);
}

export function safeParseVideoCreativeIr(input: unknown) {
  return videoCreativeIrSchema.safeParse(input);
}
