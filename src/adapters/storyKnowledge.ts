import { z } from "zod";
import { readYamlFile } from "../io.js";
import { PipelineError } from "../types.js";

const safeIdSchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const sourceSchema = z.object({
  id: safeIdSchema,
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.string().url().refine((value) => value.startsWith("https://")),
  accessed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).strict();

const frameworkSchema = z.object({
  id: safeIdSchema,
  name: z.string().min(1),
  family: z.string().min(1),
  best_for: z.array(z.string().min(1)).min(1),
  flow: z.array(z.string().min(1)).min(2),
  keywords: z.array(z.string().min(1)).min(1),
  short_form_score: z.number().int(),
  long_form_score: z.number().int(),
  caution: z.string().min(1),
  derived_from: z.string().min(1).optional(),
  source_ids: z.array(safeIdSchema).default([])
}).strict();

const principleSchema = z.object({
  id: safeIdSchema,
  category: z.union([
    z.literal("story"),
    z.literal("shot-design"),
    z.literal("continuity"),
    z.literal("editing"),
    z.literal("sound")
  ]),
  instruction: z.string().min(1),
  rationale: z.string().min(1),
  source_ids: z.array(safeIdSchema).default([])
}).strict();

const durationPresetSchema = z.object({
  id: safeIdSchema,
  max_seconds: z.number().positive(),
  recommended_cuts: z.object({
    min: z.number().int().positive(),
    max: z.number().int().positive()
  }).refine((value) => value.max >= value.min),
  phases: z.array(z.object({
    range: z.string().min(1),
    role: z.string().min(1)
  }).strict()).min(2)
}).strict();

const storyGuideSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("story-framework-guide"),
  catalog_id: safeIdSchema,
  display_name: z.string().min(1),
  revision: z.string().min(1),
  sources: z.array(sourceSchema).min(1),
  frameworks: z.array(frameworkSchema).min(1),
  duration_presets: z.array(durationPresetSchema).min(1),
  principles: z.array(principleSchema).min(1),
  safety_notes: z.array(z.string().min(1)).min(1)
}).strict().superRefine((guide, context) => {
  const sourceIds = new Set(guide.sources.map((source) => source.id));
  const ids = [...guide.frameworks.map((item) => item.id), ...guide.principles.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "framework and principle ids must be unique" });
  }
  for (const [index, item] of [...guide.frameworks, ...guide.principles].entries()) {
    for (const sourceId of item.source_ids) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown source id '${sourceId}'`,
          path: [index < guide.frameworks.length ? "frameworks" : "principles", index, "source_ids"]
        });
      }
    }
  }
});

export type StoryGuide = z.infer<typeof storyGuideSchema>;
type Framework = StoryGuide["frameworks"][number];

export type StoryRecommendation = {
  request: string;
  duration_seconds: number;
  primary: RecommendedFramework;
  secondary: RecommendedFramework[];
  rejected: Array<{ id: string; name: string; reason: string }>;
  duration_preset: StoryGuide["duration_presets"][number];
  applied_principles: StoryGuide["principles"];
  safety_notes: string[];
  sources: StoryGuide["sources"];
};

type RecommendedFramework = Framework & {
  score: number;
  selection_reasons: string[];
};

const DEFAULT_GUIDE_PATH = "knowledge/story-frameworks/catalog.yaml";

export async function loadStoryGuide(path = DEFAULT_GUIDE_PATH): Promise<StoryGuide> {
  try {
    const parsed = storyGuideSchema.safeParse(await readYamlFile(path));
    if (!parsed.success) {
      throw new PipelineError({
        code: "story_guide.schema",
        message: parsed.error.issues[0]?.message ?? "invalid story guide",
        path
      });
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError({
      code: "story_guide.read_failed",
      message: error instanceof Error ? error.message : String(error),
      path
    });
  }
}

export function recommendStoryFrameworks(
  request: string,
  guide: StoryGuide,
  options: { durationSeconds?: number } = {}
): StoryRecommendation {
  const normalized = request.trim().toLowerCase();
  if (!normalized) throw new Error("creative request must not be blank");

  const durationSeconds = options.durationSeconds ?? extractDurationSeconds(normalized) ?? 30;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("duration must be a positive number");
  }

  const ranked = guide.frameworks
    .map((framework, order) => scoreFramework(framework, normalized, durationSeconds, order))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const primary = toRecommended(ranked[0]);
  const secondary = ranked
    .slice(1)
    .filter((item) => item.score > 0)
    .slice(0, 2)
    .map(toRecommended);
  const selectedIds = new Set([primary.id, ...secondary.map((item) => item.id)]);
  const rejected = [...ranked]
    .reverse()
    .filter((item) => !selectedIds.has(item.framework.id))
    .slice(0, 3)
    .map((item) => ({
      id: item.framework.id,
      name: item.framework.name,
      reason: "今回の目的・尺・視聴者の次の行動への寄与が上位候補より弱い。"
    }));
  const durationPreset = guide.duration_presets.find((preset) => durationSeconds <= preset.max_seconds)
    ?? guide.duration_presets.at(-1)!;
  const appliedPrinciples = selectPrinciples(guide, primary.id);
  const sourceIds = new Set([
    ...primary.source_ids,
    ...secondary.flatMap((framework) => framework.source_ids),
    ...appliedPrinciples.flatMap((principle) => principle.source_ids)
  ]);

  return {
    request,
    duration_seconds: durationSeconds,
    primary,
    secondary,
    rejected,
    duration_preset: durationPreset,
    applied_principles: appliedPrinciples,
    safety_notes: guide.safety_notes,
    sources: guide.sources.filter((source) => sourceIds.has(source.id))
  };
}

const COMMON_PRINCIPLES = [
  "one-shot-one-role",
  "start-end-state",
  "visual-hierarchy",
  "motivated-cut",
  "audio-leads-picture",
  "continuity-anchor",
  "transition-handles",
  "camera-motivation",
  "one-motion-per-clip"
];

const PRINCIPLES_BY_FRAMEWORK: Record<string, string[]> = {
  "tension-escalation-reveal": [
    "setup-payoff", "escalation", "cut-on-gaze", "hold-before-after", "silence-as-emphasis", "pace-contrast"
  ],
  "mystery-question-clue-answer": [
    "setup-payoff", "cutaway-bridge", "cut-on-gaze", "graphic-match", "hold-before-after"
  ],
  "documentary-character-quest": [
    "establishing-reestablishing", "cutaway-bridge", "room-tone", "dialogue-ducking", "look-room"
  ],
  "interview-insight-evidence": [
    "screen-direction", "eyeline-match", "shot-reverse-shot", "cutaway-bridge", "room-tone", "dialogue-ducking"
  ],
  "music-performance-motif": [
    "color-motif", "pace-contrast", "graphic-match", "sonic-motif", "shot-size-progression", "depth-layers"
  ],
  "music-narrative-concept": [
    "color-motif", "setup-payoff", "graphic-match", "sonic-motif", "pace-contrast"
  ],
  "comedy-rule-of-three": [
    "setup-payoff", "pace-contrast", "hold-before-after", "shot-size-progression", "silence-as-emphasis"
  ],
  "looped-short": [
    "match-on-action", "graphic-match", "transition-handles", "pace-contrast", "sonic-motif"
  ],
  "montage-association": [
    "graphic-match", "pace-contrast", "color-motif", "sonic-motif", "leading-lines"
  ]
};

function selectPrinciples(guide: StoryGuide, primaryId: string): StoryGuide["principles"] {
  const narrativeDefaults = [
    "setup-payoff",
    "escalation",
    "rule-of-thirds",
    "screen-direction",
    "match-on-action",
    "room-tone"
  ];
  const selected = new Set([
    ...COMMON_PRINCIPLES,
    ...(PRINCIPLES_BY_FRAMEWORK[primaryId] ?? narrativeDefaults)
  ]);
  return guide.principles.filter((principle) => selected.has(principle.id));
}

type ScoredFramework = {
  framework: Framework;
  score: number;
  order: number;
  reasons: string[];
};

function scoreFramework(
  framework: Framework,
  request: string,
  durationSeconds: number,
  order: number
): ScoredFramework {
  const matched = framework.keywords.filter((keyword) => request.includes(keyword.toLowerCase()));
  let score = matched.length * 4;
  const reasons: string[] = [];
  if (matched.length > 0) reasons.push(`依頼の「${matched.slice(0, 3).join("・")}」と適性が一致`);

  if (durationSeconds <= 45) {
    score += framework.short_form_score;
    if (framework.short_form_score >= 3) reasons.push("15〜45秒の短尺で機能を圧縮しやすい");
  } else {
    score += framework.long_form_score;
    if (framework.long_form_score >= 3) reasons.push("60秒以上で変化や展開を段階的に作りやすい");
  }

  return { framework, score, order, reasons };
}

function toRecommended(scored: ScoredFramework): RecommendedFramework {
  return {
    ...scored.framework,
    score: scored.score,
    selection_reasons: scored.reasons.length > 0
      ? scored.reasons
      : ["汎用的な構造として今回の尺に適合"]
  };
}

function extractDurationSeconds(request: string): number | undefined {
  const mixed = request.match(/(\d+(?:\.\d+)?)\s*分\s*(\d+(?:\.\d+)?)\s*秒/);
  if (mixed) return Number(mixed[1]) * 60 + Number(mixed[2]);
  const minutes = request.match(/(\d+(?:\.\d+)?)\s*(?:分|minutes?|mins?)/i);
  if (minutes) return Number(minutes[1]) * 60;
  const seconds = request.match(/(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?)/i);
  return seconds ? Number(seconds[1]) : undefined;
}
