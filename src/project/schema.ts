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

export const analysisOutputSchema = z.union([
  z.literal("captions"),
  z.literal("chapters"),
  z.literal("cut_points"),
  z.literal("transcript"),
  z.literal("summary"),
  z.literal("subtitle_track")
]);

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
    params: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough();

const analysisRequestSchema = z
  .object({
    id: safeIdSchema,
    output: analysisOutputSchema,
    adapter: safeIdSchema.optional(),
    source_clip_id: z.string().min(1).optional(),
    depends_on: z.array(safeIdSchema).default([]),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough();

const editorialTrackSchema = z.object({
  request_id: safeIdSchema
});

const editorialPolicySchema = z
  .object({
    remove_kinds: z.array(safeIdSchema).max(32).default([]),
    remove_ids: z.array(safeIdSchema).max(10_000).default([]),
    exclude_ids: z.array(safeIdSchema).max(10_000).default([]),
    captions: editorialTrackSchema.optional(),
    chapters: editorialTrackSchema.optional()
  })
  .superRefine((policy, context) => {
    const excluded = new Set(policy.exclude_ids);
    for (const [index, id] of policy.remove_ids.entries()) {
      if (excluded.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an editorial candidate cannot be both removed and excluded",
          path: ["remove_ids", index]
        });
      }
    }
  });

export const projectSchema = z
  .object({
    slug: safeIdSchema,
    run_id: safeIdSchema.optional(),
    manifest: manifestPathSchema,
    dist_dir: safeRelativePathSchema.default("dist"),
    edit: z.object({
      backend: safeIdSchema,
      editorial: editorialPolicySchema.optional()
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
  .passthrough()
  .superRefine((project, context) => {
    if (project.edit.editorial && !project.analysis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edit.editorial requires analysis requests",
        path: ["analysis"]
      });
      return;
    }
    if (project.edit.editorial && project.generation?.requests.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edit.editorial cannot be combined with generation requests",
        path: ["generation"]
      });
    }
    const policy = project.edit.editorial;
    if (!policy || !project.analysis) return;
    const requests = new Map(project.analysis.requests.map((request) => [request.id, request]));
    const captionRequest = policy.captions ? requests.get(policy.captions.request_id) : undefined;
    if (policy.captions && (!captionRequest || !["transcript", "subtitle_track"].includes(captionRequest.output))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "editorial captions must reference a transcript or subtitle_track request",
        path: ["edit", "editorial", "captions", "request_id"]
      });
    }
    const chapterRequest = policy.chapters ? requests.get(policy.chapters.request_id) : undefined;
    if (policy.chapters && (!chapterRequest || chapterRequest.output !== "chapters")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "editorial chapters must reference a chapters request",
        path: ["edit", "editorial", "chapters", "request_id"]
      });
    }
  });

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
