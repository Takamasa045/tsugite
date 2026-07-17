import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { generationRequestMode, type GenerationRequest, type Project } from "../project/schema.js";
import { PipelineError } from "../types.js";
import { toPortablePath } from "../platform/path.js";

const promptModeSchema = z.union([z.literal("text-to-video"), z.literal("image-to-video")]);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a real date");
const safeIdSchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const sourceSchema = z.object({
  id: safeIdSchema,
  type: z.union([
    z.literal("official-guide"),
    z.literal("official-api"),
    z.literal("official-model-page")
  ]),
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.string().url().refine((value) => value.startsWith("https://"), "must use https"),
  accessed_at: dateSchema
}).strict();

const ruleSchema = z.object({
  id: safeIdSchema,
  instruction: z.string().min(1),
  evidence: z.union([z.literal("documented"), z.literal("synthesized")]),
  confidence: z.union([z.literal("high"), z.literal("medium"), z.literal("low")]),
  source_ids: z.array(safeIdSchema).min(1)
}).strict();

const negativePromptSchema = z.object({
  strategy: z.string().min(1),
  guidance: z.array(z.string().min(1)).min(1),
  source_ids: z.array(safeIdSchema).min(1)
}).strict();

const modelLimitsSchema = z.object({
  prompt_max_characters: z.number().int().positive().optional(),
  prompt_recommended_max_words: z.number().int().positive().optional(),
  duration_seconds: z
    .object({
      min: z.number().nonnegative(),
      max: z.number().positive(),
      auto_value: z.number().optional()
    })
    .refine((value) => value.max >= value.min, "duration max must be at least min"),
  resolutions: z.array(z.string().min(1)),
  text_to_video_aspect_ratios: z.array(z.string().min(1)),
  image_to_video_aspect_ratios: z.array(z.string().min(1)),
  image_to_video_uses_input_aspect: z.boolean(),
  max_storyboard_shots: z.number().int().positive().optional(),
  unsupported_parameters: z.array(z.string().min(1)).default([]),
  notes: z.array(z.string().min(1)).default([])
}).strict();

const modeRecipeSchema = z.object({
  template: z.string().min(1),
  prompt_order: z.array(z.string().min(1)).min(1),
  checklist: z.array(ruleSchema).min(1),
  avoid: z.array(z.string().min(1)).default([]),
  negative_prompt: negativePromptSchema
}).strict();

const modelSchema = z.object({
  id: safeIdSchema,
  aliases: z.array(z.string().min(1)).min(1),
  verified_at: dateSchema,
  review_after: dateSchema,
  input_modes: z.array(promptModeSchema).min(1),
  limits: modelLimitsSchema,
  mode_checklist: z
    .object({
      "text-to-video": z.array(ruleSchema).optional(),
      "image-to-video": z.array(ruleSchema).optional()
    })
    .strict()
    .optional(),
  notes: z.array(z.string().min(1)).default([]),
  source_ids: z.array(safeIdSchema).min(1)
}).strict();

const promptGuideSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("video-prompt-guide"),
    catalog_id: safeIdSchema,
    display_name: z.string().min(1),
    revision: z.string().min(1),
    sources: z.array(sourceSchema).min(1),
    models: z.array(modelSchema).min(1),
    common: z.object({
      checklist: z.array(ruleSchema).default([])
    }),
    modes: z.object({
      "text-to-video": modeRecipeSchema,
      "image-to-video": modeRecipeSchema
    })
  }).strict()
  .superRefine((guide, context) => {
    const sourceIds = new Set(guide.sources.map((source) => source.id));
    if (sourceIds.size !== guide.sources.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source ids must be unique",
        path: ["sources"]
      });
    }
    const referencedIds = [
      ...guide.common.checklist.flatMap((rule) => rule.source_ids),
      ...Object.values(guide.modes).flatMap((mode) => [
        ...mode.checklist.flatMap((rule) => rule.source_ids),
        ...mode.negative_prompt.source_ids
      ]),
      ...guide.models.flatMap((model) => model.source_ids),
      ...guide.models.flatMap((model) =>
        Object.values(model.mode_checklist ?? {}).flatMap((rules) =>
          (rules ?? []).flatMap((rule) => rule.source_ids)
        )
      )
    ];
    for (const sourceId of referencedIds) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown source id '${sourceId}'`,
          path: ["sources"]
        });
      }
    }

    const aliases = new Set<string>();
    const ruleIds = [
      ...guide.common.checklist,
      ...Object.values(guide.modes).flatMap((mode) => mode.checklist),
      ...guide.models.flatMap((model) =>
        Object.values(model.mode_checklist ?? {}).flatMap((rules) => rules ?? [])
      )
    ].map((rule) => rule.id);
    if (new Set(ruleIds).size !== ruleIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rule ids must be unique",
        path: ["modes"]
      });
    }
    for (const [index, model] of guide.models.entries()) {
      if (model.review_after < model.verified_at) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "review_after must not precede verified_at",
          path: ["models", index, "review_after"]
        });
      }
      for (const alias of [model.id, ...model.aliases].map(normalizeModelName)) {
        if (aliases.has(alias)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate model alias '${alias}'`,
            path: ["models", index, "aliases"]
          });
        }
        aliases.add(alias);
      }
    }
  });

type ParsedPromptGuide = z.infer<typeof promptGuideSchema>;
export type PromptMode = z.infer<typeof promptModeSchema>;
export type PromptGuide = ParsedPromptGuide & { root: string; path: string };
export type PromptGuidance = {
  request_id: string;
  catalog_id: string;
  input_mode: PromptMode | "unspecified";
  model: string;
  model_profile?: string;
  status: "matched" | "catalog-missing" | "model-unmatched" | "input-mode-unset" | "input-mode-unsupported";
  guide_path?: string;
  verified_at?: string;
  review_after?: string;
  freshness?: "current" | "stale";
  available_model_profiles: string[];
  recipe?: {
    template: string;
    prompt_order: string[];
    checklist: z.infer<typeof ruleSchema>[];
    avoid: string[];
    negative_prompt: z.infer<typeof negativePromptSchema>;
  };
  model_notes: string[];
  model_limits?: z.infer<typeof modelLimitsSchema>;
  sources: Array<{ id: string; title: string; url: string }>;
  source_urls: string[];
};

export async function loadPromptGuide(root: string): Promise<PromptGuide | undefined> {
  const path = join(root, "prompt-guide.yaml");
  if (!(await exists(path))) return undefined;

  try {
    const parsed = promptGuideSchema.safeParse(await readYamlFile(path));
    if (!parsed.success) {
      throw schemaError(path, parsed.error.issues[0]?.message ?? "invalid prompt guide");
    }
    if (parsed.data.catalog_id !== basename(root)) {
      throw schemaError(path, "catalog_id must match its directory name");
    }
    return { ...parsed.data, root, path: toPortablePath(path) };
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw schemaError(path, error instanceof Error ? error.message : String(error));
  }
}

export async function loadPromptGuideById(
  catalogId: string,
  guideDirs = ["knowledge/video-models"]
): Promise<PromptGuide | undefined> {
  if (!safeIdSchema.safeParse(catalogId).success) {
    throw new PipelineError({
      code: "prompt_guide.catalog_id",
      message: "catalog id must be a safe id"
    });
  }
  for (const dir of guideDirs) {
    const guide = await loadPromptGuide(join(dir, catalogId));
    if (guide) return guide;
  }
  return undefined;
}

export async function loadPromptGuideCatalog(
  guideDirs = ["knowledge/video-models"]
): Promise<PromptGuide[]> {
  const guides: PromptGuide[] = [];
  for (const dir of guideDirs) {
    for (const child of await childDirectories(dir)) {
      const guide = await loadPromptGuide(join(dir, child));
      if (guide) guides.push(guide);
    }
  }
  guides.sort((left, right) => left.catalog_id.localeCompare(right.catalog_id));
  const duplicate = guides.find((guide, index) => guides.findIndex((item) => item.catalog_id === guide.catalog_id) !== index);
  if (duplicate) throw schemaError(duplicate.path, `duplicate catalog id '${duplicate.catalog_id}'`);
  return guides;
}

export async function loadProjectPromptGuides(
  project: Project,
  guideDirs = ["knowledge/video-models"]
): Promise<PromptGuide[]> {
  if (!project.generation) return [];
  const ids = new Set(
    project.generation.requests.map((request) => request.prompt_guide?.catalog ?? project.generation!.adapter)
  );
  const guides = await Promise.all([...ids].map((id) => loadPromptGuideById(id, guideDirs)));
  return guides.filter((guide): guide is PromptGuide => guide !== undefined);
}

export function resolveProjectPromptGuidance(
  project: Project,
  guides: PromptGuide[],
  asOf = new Date().toISOString().slice(0, 10)
): PromptGuidance[] {
  if (!project.generation) return [];
  return project.generation.requests.flatMap((request) => {
    const catalogId = request.prompt_guide?.catalog ?? project.generation!.adapter;
    const guide = guides.find((candidate) => candidate.catalog_id === catalogId);
    if (guide) return [resolvePromptGuidance(request, guide, asOf)];
    if (!request.prompt_guide) return [];
    return [missingGuidance(request, catalogId)];
  });
}

export function resolvePromptGuidance(
  request: GenerationRequest,
  guide: PromptGuide,
  asOf = new Date().toISOString().slice(0, 10)
): PromptGuidance {
  const inputMode: PromptMode | "unspecified" = generationRequestMode(request) ?? "unspecified";
  const advisoryModel = request.prompt_guide?.model ?? request.model;
  const model = guide.models.find((candidate) =>
    [candidate.id, ...candidate.aliases].some(
      (alias) => normalizeModelName(alias) === normalizeModelName(advisoryModel)
    )
  );
  const base = {
    request_id: request.id,
    catalog_id: guide.catalog_id,
    input_mode: inputMode,
    model: request.model,
    guide_path: guide.path,
    available_model_profiles: guide.models.map((candidate) => candidate.id),
    model_notes: model?.notes ?? [],
    sources: [],
    source_urls: []
  };

  if (!model) {
    return {
      ...base,
      status: "model-unmatched",
      model_profile: undefined,
      recipe: undefined
    };
  }
  const modelSources = guide.sources.filter((source) => model.source_ids.includes(source.id));
  const modelBase = {
    ...base,
    model_profile: model.id,
    model_limits: model.limits,
    verified_at: model.verified_at,
    review_after: model.review_after,
    freshness: asOf > model.review_after ? "stale" as const : "current" as const,
    sources: modelSources.map(sourceSummary),
    source_urls: modelSources.map((source) => source.url)
  };
  if (inputMode === "unspecified") return { ...modelBase, status: "input-mode-unset" };
  if (!model.input_modes.includes(inputMode)) return { ...modelBase, status: "input-mode-unsupported" };

  const mode = guide.modes[inputMode];
  const modelChecklist = model.mode_checklist?.[inputMode] ?? [];
  const sourceIds = new Set([
    ...model.source_ids,
    ...guide.common.checklist.flatMap((rule) => rule.source_ids),
    ...mode.checklist.flatMap((rule) => rule.source_ids),
    ...modelChecklist.flatMap((rule) => rule.source_ids),
    ...mode.negative_prompt.source_ids
  ]);
  const sources = guide.sources.filter((source) => sourceIds.has(source.id));
  return {
    ...modelBase,
    sources: sources.map(sourceSummary),
    source_urls: sources.map((source) => source.url),
    status: "matched",
    recipe: {
      template: mode.template,
      prompt_order: mode.prompt_order,
      checklist: [...guide.common.checklist, ...mode.checklist, ...modelChecklist],
      avoid: mode.avoid,
      negative_prompt: mode.negative_prompt
    }
  };
}

function missingGuidance(request: GenerationRequest, catalogId: string): PromptGuidance {
  return {
    request_id: request.id,
    catalog_id: catalogId,
    input_mode: generationRequestMode(request) ?? "unspecified",
    model: request.model,
    status: "catalog-missing",
    available_model_profiles: [],
    model_notes: [],
    sources: [],
    source_urls: []
  };
}

function sourceSummary(source: ParsedPromptGuide["sources"][number]): { id: string; title: string; url: string } {
  return { id: source.id, title: source.title, url: source.url };
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function schemaError(path: string, message: string): PipelineError {
  return new PipelineError({ code: "prompt_guide.schema", message, path });
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
