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

const generationModeSchema = z.union([z.literal("text-to-video"), z.literal("image-to-video")]);
const audioBgmModeSchema = z.union([z.literal("generate"), z.literal("retrieve")]);

const audioTimingSchema = z
  .object({
    id: safeIdSchema,
    prompt: z.string().min(1),
    start: z.number().nonnegative().default(0),
    end: z.number().positive().optional(),
    volume: z.number().min(0).max(1).optional()
  })
  .superRefine((track, context) => {
    if (track.end !== undefined && track.end <= track.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "end must be greater than start",
        path: ["end"]
      });
    }
  });

const audioBgmRequestSchema = audioTimingSchema.safeExtend({
  mode: audioBgmModeSchema.default("generate"),
  query: z.string().min(1).optional()
});

const audioRequestSchema = z
  .object({
    connection: safeIdSchema.optional(),
    adapter: safeIdSchema.optional(),
    fallback: z.literal("fail").default("fail"),
    bgm: audioBgmRequestSchema.optional(),
    sfx: z.array(audioTimingSchema).superRefine(rejectDuplicateRequestIds).default([]),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .superRefine((audio, context) => {
    if (!audio.bgm && audio.sfx.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audio requires a BGM or SFX request"
      });
    }
    if (audio.bgm && audio.sfx.some((request) => request.id === audio.bgm?.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audio track ids must be unique"
      });
    }
  });

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
    mode: generationModeSchema.optional(),
    input_mode: generationModeSchema.optional(),
    first_frame: z.string().min(1).optional(),
    reference_images: z.array(z.string().min(1)).min(1).optional(),
    prompt_guide: z
      .object({
        catalog: safeIdSchema,
        model: safeIdSchema.optional()
      })
      .optional(),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough()
  .superRefine((request, context) => {
    if (request.mode && request.input_mode && request.mode !== request.input_mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mode and input_mode must match when both are declared",
        path: ["mode"]
      });
    }
  });

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
        connection: safeIdSchema.optional(),
        adapter: safeIdSchema.optional(),
        requests: z.array(generationRequestSchema).superRefine(rejectDuplicateRequestIds).default([])
      })
      .optional(),
    audio: audioRequestSchema.optional(),
    analysis: z
      .object({
        mode: z.enum(["local", "hybrid", "cloud"]).default("local"),
        adapter: safeIdSchema,
        confidence_threshold: z.number().min(0).max(1).default(0.7),
        requests: z.array(analysisRequestSchema).min(1).superRefine(rejectDuplicateRequestIds)
      })
      .optional()
  })
  .passthrough()
  .superRefine((project, context) => {
    for (const [index, request] of project.generation?.requests.entries() ?? []) {
      const secretPath = findSecretKeyPath(request);
      if (secretPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "generation credentials must use adapter-declared environment variables",
          path: ["generation", "requests", index, ...secretPath]
        });
      }
    }
    if (project.audio) {
      const secretPath = findSecretKeyPath(project.audio);
      if (secretPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "audio credentials must use adapter-declared environment variables",
          path: ["audio", ...secretPath]
        });
      }
    }
    for (const [index, request] of project.analysis?.requests.entries() ?? []) {
      const secretPath = findSecretKeyPath(request);
      if (secretPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "analysis credentials must use adapter-declared environment variables",
          path: ["analysis", "requests", index, ...secretPath]
        });
      }
    }
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
export type AudioRequest = NonNullable<Project["audio"]>;
export type AnalysisRequest = NonNullable<Project["analysis"]>["requests"][number];

export function generationRequestMode(
  request: GenerationRequest
): "text-to-video" | "image-to-video" | undefined {
  return request.mode ?? request.input_mode;
}

export function toExecutionGenerationRequest(
  request: GenerationRequest
): GenerationRequest {
  const {
    prompt_guide: _promptGuide,
    mode,
    input_mode: inputMode,
    ...executionRequest
  } = request;
  const normalizedInputMode = mode ?? inputMode;
  return {
    ...executionRequest,
    ...(normalizedInputMode ? { input_mode: normalizedInputMode } : {})
  } as GenerationRequest;
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

function findSecretKeyPath(value: unknown, path: Array<string | number> = []): Array<string | number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretKeyPath(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
    if (normalizedKey === "auth" && item && typeof item === "object") {
      for (const [authKey, authValue] of Object.entries(item)) {
        const tokens = authKey
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toLocaleLowerCase("en-US")
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const environmentReference = (
          tokens.includes("environment") && tokens.includes("variable")
        ) || (
          tokens.includes("env")
          && (tokens.includes("var") || tokens.includes("variable") || tokens.at(-1) === "env")
        );
        if (
          !environmentReference
          || typeof authValue !== "string"
          || !/^[A-Z][A-Z0-9_]*$/.test(authValue)
        ) {
          return [...path, key, authKey];
        }
      }
      continue;
    }
    if (isSecretParameterKey(key, normalizedKey, item)) {
      return [...path, key];
    }
    const found = findSecretKeyPath(item, [...path, key]);
    if (found) return found;
  }
  return undefined;
}

const SECRET_PARAMETER_KEYS = new Set([
  "apikey",
  "token",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "refreshtoken",
  "auth",
  "authorization",
  "cookie",
  "cookies",
  "sessioncookie",
  "secret",
  "secretkey",
  "clientsecret",
  "privatekey",
  "password",
  "credential",
  "credentials"
]);

function isSecretParameterKey(key: string, normalizedKey: string, value: unknown): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const environmentReference = (
    tokens.includes("environment") && tokens.includes("variable")
  ) || (
    tokens.includes("env")
    && (tokens.includes("var") || tokens.includes("variable") || tokens.at(-1) === "env")
  );
  if (environmentReference) {
    return typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value);
  }
  if (SECRET_PARAMETER_KEYS.has(normalizedKey)) return true;
  const directSecretTokens = new Set([
    "secret",
    "token",
    "password",
    "credential",
    "credentials",
    "cookie",
    "cookies",
    "authorization"
  ]);
  if (tokens.some((token) => directSecretTokens.has(token))) return true;
  if (tokens.includes("auth") && tokens.length > 1) return true;
  const keyQualifiers = new Set(["api", "access", "private", "signing", "client", "secret"]);
  if (tokens.includes("key") && tokens.some((token) => keyQualifiers.has(token))) return true;
  return [
    "apikey",
    "apitoken",
    "apisecret",
    "accesstoken",
    "accesskey",
    "authtoken",
    "bearertoken",
    "clienttoken",
    "idtoken",
    "refreshtoken",
    "signingkey",
    "sessiontoken",
    "sessioncookie",
    "secretkey",
    "clientsecret",
    "privatekey"
  ].some((suffix) => normalizedKey.endsWith(suffix))
    || normalizedKey.includes("authorization")
    || normalizedKey.endsWith("cookie")
    || normalizedKey.endsWith("password")
    || normalizedKey.endsWith("credential")
    || normalizedKey.endsWith("credentials");
}
