import { TextDecoder, TextEncoder } from "node:util";
import { z } from "zod";
import { sha256Bytes, sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema } from "../schema.js";

const nonNegativeInt = z.number().finite().int().nonnegative();
const positiveInt = z.number().finite().int().positive();

export const lyricsUseSchema = z.enum(["caption-overlay", "story-cue", "generated-singing", "audio-reference"]);
export type LyricsUseV1 = z.infer<typeof lyricsUseSchema>;

export const lyricsSourceSpanSchema = z.object({
  occurrence_id: safeIdSchema,
  start_utf8_byte: nonNegativeInt,
  end_utf8_byte: positiveInt,
  text_digest: digestSchema
}).strict().superRefine((value, context) => {
  if (value.end_utf8_byte <= value.start_utf8_byte) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_utf8_byte"], message: "source span must be non-empty" });
});
export type LyricsSourceSpanV1 = z.infer<typeof lyricsSourceSpanSchema>;

function validateSourceSpan(
  span: LyricsSourceSpanV1,
  bytes: Uint8Array,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (span.end_utf8_byte > bytes.byteLength) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "lyrics source span exceeds UTF-8 source" });
    return;
  }
  const raw = bytes.slice(span.start_utf8_byte, span.end_utf8_byte);
  if (sha256Bytes(raw) !== span.text_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "text_digest"], message: "lyrics source span text digest mismatch" });
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "lyrics source span must align to UTF-8 boundaries" });
  }
}

const lyricUseArray = z.array(lyricsUseSchema).min(1).max(4).superRefine((value, context) => {
  if (new Set(value).size !== value.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "lyrics uses must be unique" });
});

const commonCue = {
  id: safeIdSchema,
  section_id: safeIdSchema.optional(),
  source_span: lyricsSourceSpanSchema,
  singer_ids: z.array(safeIdSchema).max(64),
  use: lyricUseArray
};

export const untimedLyricsCueSchema = z.object({
  timing: z.literal("untimed"),
  ...commonCue
}).strict();

const wordTimingSchema = z.object({
  source_span: lyricsSourceSpanSchema,
  start_ms: nonNegativeInt,
  end_ms: positiveInt
}).strict().superRefine((value, context) => {
  if (value.end_ms <= value.start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_ms"], message: "word timing must be non-empty" });
});

export const timedLyricsCueSchema = z.object({
  timing: z.literal("timed"),
  ...commonCue,
  start_ms: nonNegativeInt,
  end_ms: positiveInt,
  confidence: z.number().finite().min(0).max(1).optional(),
  word_timings: z.array(wordTimingSchema).max(10_000).optional()
}).strict().superRefine((value, context) => {
  if (value.end_ms <= value.start_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_ms"], message: "cue timing must be non-empty" });
  for (const [index, word] of value.word_timings?.entries() ?? []) {
    if (word.start_ms < value.start_ms || word.end_ms > value.end_ms) context.addIssue({ code: z.ZodIssueCode.custom, path: ["word_timings", index], message: "word timing must be inside cue timing" });
  }
});

export const lyricsCueSchema = z.discriminatedUnion("timing", [untimedLyricsCueSchema, timedLyricsCueSchema]);
export type UntimedLyricsCueV1 = z.infer<typeof untimedLyricsCueSchema>;
export type TimedLyricsCueV1 = z.infer<typeof timedLyricsCueSchema>;
export type LyricsCueV1 = z.infer<typeof lyricsCueSchema>;

const lyricsSourceSchema = z.object({
  asset_id: safeIdSchema.optional(),
  canonical_text: z.string(),
  text_digest: digestSchema
}).strict();

const lyricsContractBaseSchema = z.object({
  schema_version: z.literal(1),
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  language_bcp47: z.string().min(2).max(35),
  source: lyricsSourceSchema,
  alignment_state: z.enum(["unaligned", "partial", "complete"]),
  alignment_basis: z.enum(["not-aligned", "machine", "human-reviewed", "imported"]),
  cues: z.array(lyricsCueSchema).min(1).max(100_000),
  timing_digest: z.union([digestSchema, z.null()]),
  digest: digestSchema
}).strict();

export const lyricsContractSchema = lyricsContractBaseSchema.superRefine((value, context) => {
  const bytes = new TextEncoder().encode(value.source.canonical_text);
  if (sha256Bytes(bytes) !== value.source.text_digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "text_digest"], message: "lyrics source text digest mismatch" });
  const cueIds = value.cues.map((cue) => cue.id);
  const occurrenceIds = value.cues.map((cue) => cue.source_span.occurrence_id);
  if (new Set(cueIds).size !== cueIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cues"], message: "lyrics cue ids must be unique" });
  if (new Set(occurrenceIds).size !== occurrenceIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cues"], message: "lyrics occurrence ids must be unique" });
  for (const [index, cue] of value.cues.entries()) {
    const span = cue.source_span;
    validateSourceSpan(span, bytes, context, ["cues", index, "source_span"]);
    if (cue.timing === "timed" && cue.word_timings) {
      for (const [wordIndex, word] of cue.word_timings.entries()) {
        const wordPath = ["cues", index, "word_timings", wordIndex, "source_span"];
        validateSourceSpan(word.source_span, bytes, context, wordPath);
        if (word.source_span.start_utf8_byte < span.start_utf8_byte || word.source_span.end_utf8_byte > span.end_utf8_byte) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: wordPath, message: "word timing source span must be inside cue source span" });
        }
        for (const [previousIndex, previousWord] of cue.word_timings.entries()) {
          if (previousIndex >= wordIndex) break;
          if (word.source_span.start_utf8_byte < previousWord.source_span.end_utf8_byte && previousWord.source_span.start_utf8_byte < word.source_span.end_utf8_byte) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: wordPath, message: "word timing source spans must not overlap" });
            break;
          }
        }
      }
    }
  }
  const sortedSpans = value.cues.map((cue, index) => ({ cue, index })).sort((left, right) => left.cue.source_span.start_utf8_byte - right.cue.source_span.start_utf8_byte);
  for (let index = 1; index < sortedSpans.length; index += 1) {
    const previous = sortedSpans[index - 1]!;
    const current = sortedSpans[index]!;
    if (current.cue.source_span.start_utf8_byte < previous.cue.source_span.end_utf8_byte) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cues", current.index, "source_span"], message: "lyrics source spans must not overlap" });
    }
  }
  const timedCount = value.cues.filter((cue) => cue.timing === "timed").length;
  if (value.alignment_state === "unaligned" && (value.alignment_basis !== "not-aligned" || timedCount !== 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["alignment_state"], message: "unaligned lyrics require not-aligned basis and all untimed cues" });
  if (value.alignment_state === "partial" && (value.alignment_basis === "not-aligned" || timedCount === 0 || timedCount === value.cues.length)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["alignment_state"], message: "partial lyrics require timed and untimed cues with a real basis" });
  if (value.alignment_state === "complete" && (value.alignment_basis === "not-aligned" || timedCount !== value.cues.length)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["alignment_state"], message: "complete lyrics require every cue to be timed with a real basis" });
  const expectedTiming = value.alignment_state === "unaligned" ? null : lyricsTimingDigest(value.cues);
  if (value.timing_digest !== expectedTiming) context.addIssue({ code: z.ZodIssueCode.custom, path: ["timing_digest"], message: "lyrics timing digest mismatch" });
  if (sha256Canonical(withoutField(value, "digest")) !== value.digest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "lyrics contract digest mismatch" });
});
export type LyricsContractV1 = z.infer<typeof lyricsContractSchema>;
export type LyricsContract = LyricsContractV1;

export type LyricsContractInput = Omit<LyricsContractV1, "schema_version" | "timing_digest" | "digest">;

export function lyricsTimingDigest(cues: readonly LyricsCueV1[]): string {
  return sha256Canonical(cues.map((cue) => cue.timing === "timed"
    ? {
        id: cue.id,
        timing: cue.timing,
        ...(cue.section_id ? { section_id: cue.section_id } : {}),
        source_span: cue.source_span,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        ...(cue.confidence === undefined ? {} : { confidence: cue.confidence }),
        ...(cue.word_timings === undefined ? {} : { word_timings: cue.word_timings }),
        singer_ids: cue.singer_ids,
        use: cue.use
      }
    : {
        id: cue.id,
        timing: cue.timing,
        ...(cue.section_id ? { section_id: cue.section_id } : {}),
        source_span: cue.source_span,
        singer_ids: cue.singer_ids,
        use: cue.use
      }));
}

export function createLyricsContract(input: LyricsContractInput): LyricsContractV1 {
  const { schema_version: _schemaVersion, timing_digest: _timingDigest, digest: _digest, ...raw } = input as LyricsContractInput & { schema_version?: unknown; timing_digest?: unknown; digest?: unknown };
  const base = lyricsContractBaseSchema.omit({ timing_digest: true, digest: true }).parse({ schema_version: 1, ...raw });
  const timing_digest = base.alignment_state === "unaligned" ? null : lyricsTimingDigest(base.cues);
  const withoutDigest = { ...base, timing_digest };
  return lyricsContractSchema.parse({ ...withoutDigest, digest: sha256Canonical(withoutDigest) });
}

export function lyricsContractDigest(value: LyricsContractV1): string {
  return lyricsContractSchema.parse(value).digest;
}

export function resolveLyricsCueText(contract: LyricsContractV1, cueId: string): string {
  const parsed = lyricsContractSchema.parse(contract);
  const cue = parsed.cues.find((candidate) => candidate.id === cueId);
  if (!cue) throw new Error(`unknown lyrics cue: ${cueId}`);
  const bytes = new TextEncoder().encode(parsed.source.canonical_text);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(cue.source_span.start_utf8_byte, cue.source_span.end_utf8_byte));
}

export function cuesForLyricsUse(contract: LyricsContractV1, use: LyricsUseV1): LyricsCueV1[] {
  return lyricsContractSchema.parse(contract).cues.filter((cue) => cue.use.includes(use));
}

export const sourceSpanSchema = lyricsSourceSpanSchema;
