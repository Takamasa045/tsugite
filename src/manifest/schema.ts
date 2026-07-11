import { z } from "zod";

const aspectSchema = z.union([z.literal("16:9"), z.literal("9:16")]);

const imageSchema = z
  .object({
    id: z.string().min(1),
    src: z.string().min(1),
    alt: z.string().optional(),
    alpha_required: z.boolean().optional()
  })
  .passthrough();

const speakerSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    side: z.union([z.literal("left"), z.literal("right")]),
    accent: z.string().min(1),
    poses: z.record(z.string().min(1)),
    mouth_frames: z.array(z.string().min(1)).length(3).optional()
  })
  .passthrough();

const presentationSchema = z
  .object({
    preset: z.string().min(1),
    title: z.string().min(1).optional(),
    source_title: z.string().min(1).optional(),
    source_url: z.string().url().optional(),
    draft: z.boolean().default(false)
  })
  .passthrough();

const captionVisualSchema = z
  .object({
    kicker: z.string().optional(),
    headline: z.string().min(1),
    detail: z.string().optional(),
    badges: z.array(z.string().min(1)).max(4).default([])
  })
  .passthrough();

const trackSchema = z
  .object({
    id: z.string().optional(),
    src: z.string().optional(),
    start: z.number().nonnegative().optional(),
    end: z.number().positive().optional(),
    volume: z.number().nonnegative().optional()
  })
  .passthrough();

const clipSchema = z
  .object({
    id: z.string().min(1),
    src: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().positive(),
    duration: z.number().positive(),
    fps: z.number().positive(),
    resolution: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    }),
    audio: z.boolean()
  })
  .passthrough();

export const manifestSchema = z
  .object({
    meta: z
      .object({
        aspect: aspectSchema,
        fps: z.number().positive(),
        target_duration_seconds: z.number().positive(),
        slug: z.string().min(1)
      })
      .passthrough(),
    clips: z.array(clipSchema).min(1),
    images: z.array(imageSchema).default([]),
    speakers: z.array(speakerSchema).default([]),
    presentation: presentationSchema.optional(),
    audio: z
      .object({
        bgm: z.array(trackSchema).default([]),
        narration: z.array(trackSchema).default([]),
        sfx: z.array(trackSchema).default([])
      })
      .passthrough()
      .default({ bgm: [], narration: [], sfx: [] }),
    captions: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            text: z.string(),
            speaker: z.string().min(1).optional(),
            start: z.number().nonnegative(),
            end: z.number().positive(),
            pose: z.string().min(1).optional(),
            emphasis: z.array(z.string().min(1)).default([]),
            visual: captionVisualSchema.optional()
          })
          .passthrough()
      )
      .default([]),
    chapters: z
      .array(
        z
          .object({
            title: z.string().min(1),
            start: z.number().nonnegative(),
            end: z.number().positive()
          })
          .passthrough()
      )
      .default([]),
    provenance: z
      .array(
        z
          .object({
            clip_id: z.string().optional(),
            engine: z.string().optional(),
            model: z.string().optional(),
            params: z.record(z.unknown()).optional(),
            credits: z.number().nonnegative().optional()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export type Manifest = z.infer<typeof manifestSchema>;
