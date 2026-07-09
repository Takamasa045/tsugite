import { z } from "zod";

const aspectSchema = z.union([z.literal("16:9"), z.literal("9:16")]);

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
            text: z.string(),
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
