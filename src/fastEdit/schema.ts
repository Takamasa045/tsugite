import { z } from "zod";

// Editing intent only. Renderer names, executable code and remote assets are forbidden.
export const CARDS = [
  "keyword",
  "quote",
  "stat",
  "question",
  "list",
  "steps",
  "comparison",
  "definition",
  "highlight",
  "warning",
  "tip",
  "checklist",
  "timeline",
  "counter",
  "title",
  "lower_third",
  "callout",
  "cta",
] as const;
export const GLOBAL_OPTIONS = {
  style: ["energetic", "minimal", "editorial"],
  color: ["source", "warm", "cool", "mono"],
  caption_style: ["bold", "outlined", "clean"],
  energy: ["high", "medium", "low"],
  progress_bar: ["bottom", "top", "none"],
} as const;
export const EDIT_OPTIONS = {
  visual_needed: ["yes", "no"],
  card: CARDS,
  text_effect: ["none", "pop", "rise", "typewriter"],
  transition: ["cut", "fade", "zoom", "wipe"],
  face_zoom: ["none", "medium", "close"],
  sfx: ["none", "whoosh", "pop", "chime"],
} as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const wordSchema = z
  .object({
    id,
    text: z.string().min(1).max(200),
    start: z.number().nonnegative(),
    end: z.number().positive(),
  })
  .strict();
export const editSchema = z
  .object({
    visual_needed: z.boolean(),
    card: z.enum(CARDS),
    text_effect: z.enum(EDIT_OPTIONS.text_effect),
    transition: z.enum(EDIT_OPTIONS.transition),
    face_zoom: z.enum(EDIT_OPTIONS.face_zoom),
    sfx: z.enum(EDIT_OPTIONS.sfx),
    emphasis_word_id: id.nullable(),
  })
  .strict();
export const fastEditSchema = z
  .object({
    version: z.literal(1),
    global: z
      .object({
        style: z.enum(GLOBAL_OPTIONS.style),
        color: z.enum(GLOBAL_OPTIONS.color),
        caption_style: z.enum(GLOBAL_OPTIONS.caption_style),
        energy: z.enum(GLOBAL_OPTIONS.energy),
        progress_bar: z.enum(GLOBAL_OPTIONS.progress_bar),
      })
      .strict(),
    words: z.array(wordSchema).min(1).max(10000),
    beats: z
      .array(
        z
          .object({
            id,
            start: z.number().nonnegative(),
            end: z.number().positive(),
            word_ids: z.array(id).max(200),
            edit: editSchema,
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set<string>();
    let lastEnd = 0;
    for (const word of value.words) {
      if (
        ids.has(word.id) ||
        word.end <= word.start ||
        word.start < lastEnd - 0.001
      )
        fail(
          "words must have unique IDs and ordered non-overlapping timestamps",
        );
      ids.add(word.id);
      lastEnd = word.end;
    }
    const beats = new Set<string>();
    const assigned = new Set<string>();
    let cursor = 0;
    for (const beat of value.beats) {
      if (
        beats.has(beat.id) ||
        Math.abs(beat.start - cursor) > 0.001 ||
        beat.end <= beat.start
      )
        fail(
          "beats must have unique IDs and contiguous ordered timestamps starting at zero",
        );
      beats.add(beat.id);
      cursor = beat.end;
      for (const wid of beat.word_ids) {
        const word = value.words.find((w) => w.id === wid);
        if (
          !word ||
          assigned.has(wid) ||
          word.start < beat.start - 0.001 ||
          word.end > beat.end + 0.001
        )
          fail(
            "beat word IDs must bind each timed word exactly once within its beat",
          );
        assigned.add(wid);
      }
      if (
        beat.edit.emphasis_word_id !== null &&
        !beat.word_ids.includes(beat.edit.emphasis_word_id)
      )
        fail("emphasis word must belong to its beat");
    }
    if (assigned.size !== ids.size)
      fail("all words must be assigned to a beat");
  });
export type FastEdit = z.infer<typeof fastEditSchema>;
export type Word = z.infer<typeof wordSchema>;
export const fastEditConfigSchema = z
  .object({
    enabled: z.boolean(),
    beat_seconds: z.number().min(0.5).max(12).default(2.5),
  })
  .strict();
export const FAST_EDIT_CAPABILITIES = [
  "supported",
  "source_video",
  "cards",
  "captions",
  "word_emphasis",
  "text_effects",
  "transitions",
  "zoom",
  "sfx",
  "progress",
  "global_style",
  "color_treatment",
  "energy_pacing",
  "vertical",
  "horizontal",
  "audio",
  "final_mp4",
] as const;
export const fastEditCapabilitiesSchema = z.object(
  Object.fromEntries(
    FAST_EDIT_CAPABILITIES.map((k) => [k, z.boolean()]),
  ) as Record<(typeof FAST_EDIT_CAPABILITIES)[number], z.ZodBoolean>,
);
