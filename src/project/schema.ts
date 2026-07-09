import { z } from "zod";

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const safeRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
    "must be a safe relative path"
  );

const manifestPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      if (value.startsWith("/") || value.includes("\\")) return false;
      const parts = value.split("/");
      const parentRefs = parts.filter((part) => part === "..");
      return parentRefs.length === 0 || (parentRefs.length === 1 && parts[0] === "..");
    },
    "must be a safe manifest path"
  );

const generationRequestSchema = z
  .object({
    id: safeIdSchema,
    prompt: z.string().min(1),
    model: z.string().min(1),
    duration: z.number().positive(),
    aspect: z.union([z.literal("16:9"), z.literal("9:16")]),
    seed: z.number().int().optional(),
    input_mode: z.union([z.literal("text-to-video"), z.literal("image-to-video")]).optional(),
    prompt_guide: z
      .object({
        catalog: safeIdSchema
      })
      .optional(),
    params: z.record(z.unknown()).default({})
  })
  .passthrough();

const analysisRequestSchema = z
  .object({
    id: safeIdSchema,
    output: z.union([z.literal("captions"), z.literal("chapters"), z.literal("cut_points")]),
    params: z.record(z.unknown()).default({})
  })
  .passthrough();

export const projectSchema = z
  .object({
    slug: safeIdSchema,
    run_id: safeIdSchema.optional(),
    manifest: manifestPathSchema,
    dist_dir: safeRelativePathSchema.default("dist"),
    edit: z.object({
      backend: safeIdSchema
    }),
    generation: z
      .object({
        adapter: safeIdSchema,
        requests: z.array(generationRequestSchema).superRefine(rejectDuplicateRequestIds).default([])
      })
      .optional(),
    analysis: z
      .object({
        adapter: safeIdSchema,
        requests: z.array(analysisRequestSchema).min(1).superRefine(rejectDuplicateRequestIds)
      })
      .optional()
  })
  .passthrough();

export type Project = z.infer<typeof projectSchema>;
export type GenerationRequest = NonNullable<Project["generation"]>["requests"][number];
export type AnalysisRequest = NonNullable<Project["analysis"]>["requests"][number];

export function toExecutionGenerationRequest(
  request: GenerationRequest
): GenerationRequest {
  const { prompt_guide: _promptGuide, ...executionRequest } = request;
  return executionRequest as GenerationRequest;
}

export function toExecutionProject(project: Project): Project {
  if (!project.generation) return project;
  return {
    ...project,
    generation: {
      ...project.generation,
      requests: project.generation.requests.map(toExecutionGenerationRequest)
    }
  };
}

function rejectDuplicateRequestIds(requests: Array<{ id: string }>, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, request] of requests.entries()) {
    if (seen.has(request.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "request ids must be unique",
        path: [index, "id"]
      });
    }
    seen.add(request.id);
  }
}
