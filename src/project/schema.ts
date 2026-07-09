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
    id: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1),
    duration: z.number().positive(),
    aspect: z.union([z.literal("16:9"), z.literal("9:16")]),
    seed: z.number().int().optional(),
    params: z.record(z.unknown()).default({})
  })
  .passthrough();

const analysisRequestSchema = z
  .object({
    id: z.string().min(1),
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
        adapter: z.string().min(1),
        requests: z.array(generationRequestSchema).default([])
      })
      .optional(),
    analysis: z
      .object({
        adapter: z.string().min(1),
        requests: z.array(analysisRequestSchema).min(1)
      })
      .optional()
  })
  .passthrough();

export type Project = z.infer<typeof projectSchema>;
export type GenerationRequest = NonNullable<Project["generation"]>["requests"][number];
export type AnalysisRequest = NonNullable<Project["analysis"]>["requests"][number];
