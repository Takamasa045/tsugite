import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { PipelineError } from "../types.js";
import { setupCheckSchema } from "../setupChecks.js";
import { analysisOutputSchema } from "../project/schema.js";

const unsafeForwardedEnvironment = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELLOPTS"
]);

const credentialVariableSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be an uppercase environment variable name")
  .refine((value) => !unsafeForwardedEnvironment.has(value), "must not be a runtime injection variable");

const adapterSchema = z.object({
  name: z.string().min(1),
  kind: z.union([z.literal("cli"), z.literal("mcp-agent"), z.literal("mcp-client")]),
  class: z.union([z.literal("generation"), z.literal("analysis"), z.literal("audio")]).default("generation"),
  connection_requirement: z.enum(["required", "local-only"]).default("required"),
  offline: z.boolean().optional(),
  outputs: z
    .array(analysisOutputSchema)
    .min(1)
    .optional(),
  network: z
    .object({
      input_scope: z.enum([
        "low-confidence-segments",
        "source-media",
        "source-media-and-dependencies",
        "request-metadata"
      ]),
      timeout_ms: z.number().int().min(1_000).max(3_600_000).default(900_000),
      credential_env: z.array(credentialVariableSchema).max(16).default([]),
      optional_credential_env: z.array(credentialVariableSchema).max(16).default([])
    })
    .optional(),
  dry_run_estimate: z.boolean(),
  batch: z.boolean(),
  credit_estimate: z
    .object({
      per_request: z.number().nonnegative().default(0),
      per_second: z.number().nonnegative().default(0)
    })
    .default({ per_request: 0, per_second: 0 }),
  retry: z.object({
    max_attempts: z.number().int().nonnegative(),
    retryable_exit_codes: z.array(z.number().int())
  }),
  exit_code_map: z.record(z.string(), z.string().min(1)),
  input_modes: z
    .object({
      "text-to-video": z
        .object({
          required_params: z
            .record(
              z.string(),
              z.union([z.literal("non-empty-string"), z.literal("boolean"), z.literal("finite-number")])
            )
            .default({}),
          forbidden_params: z.array(z.string().min(1)).default([]),
          required_fields: z.array(z.string().min(1)).default([]),
          forbidden_fields: z.array(z.string().min(1)).default([])
        })
        .optional(),
      "image-to-video": z
        .object({
          required_params: z
            .record(
              z.string(),
              z.union([z.literal("non-empty-string"), z.literal("boolean"), z.literal("finite-number")])
            )
            .default({}),
          forbidden_params: z.array(z.string().min(1)).default([]),
          required_fields: z.array(z.string().min(1)).default([]),
          forbidden_fields: z.array(z.string().min(1)).default([])
        })
        .optional()
    })
    .optional(),
  audio_capabilities: z
    .object({
      bgm_modes: z.array(z.enum(["generate", "retrieve"])).min(1).default(["generate"]),
      sfx: z.boolean().default(false)
    })
    .optional(),
  checks: z
    .object({
      setup: z.array(setupCheckSchema).default([])
    })
    .default({ setup: [] }),
  command: z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string().min(1)).default([]),
      input: z.literal("stdin-json").default("stdin-json")
    })
    .optional()
}).superRefine((adapter, context) => {
  if (adapter.class === "audio" && !adapter.audio_capabilities) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "audio adapters must declare audio_capabilities",
      path: ["audio_capabilities"]
    });
  }
  if (adapter.class !== "audio" && adapter.audio_capabilities) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "audio_capabilities are valid only for audio adapters",
      path: ["audio_capabilities"]
    });
  }
  if (adapter.class === "audio" && adapter.network && adapter.network.input_scope !== "request-metadata") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "online audio adapters must limit network input_scope to request-metadata",
      path: ["network", "input_scope"]
    });
  }
  if (adapter.class !== "audio" && adapter.network?.input_scope === "request-metadata") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "request-metadata network scope is valid only for audio adapters",
      path: ["network", "input_scope"]
    });
  }
  if (adapter.class !== "audio" && (adapter.network?.optional_credential_env.length ?? 0) > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "optional network credentials are valid only for audio adapters",
      path: ["network", "optional_credential_env"]
    });
  }
  const duplicateCredential = adapter.network?.credential_env.find((variable) =>
    adapter.network?.optional_credential_env.includes(variable)
  );
  if (duplicateCredential) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `credential '${duplicateCredential}' cannot be both required and optional`,
      path: ["network", "optional_credential_env"]
    });
  }
  if (adapter.offline === false && !adapter.network) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "online adapters must declare a network contract",
      path: ["network"]
    });
  }
  if (adapter.offline === false && adapter.retry.max_attempts > 2) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "online adapters may retry at most twice",
      path: ["retry", "max_attempts"]
    });
  }
  if (adapter.offline === true && adapter.network) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "offline adapters cannot declare a network contract",
      path: ["network"]
    });
  }
});

export type AdapterDefinition = z.infer<typeof adapterSchema> & {
  root: string;
};

export async function loadAdapterDefinition(
  name: string,
  adapterDirs = ["adapters"]
): Promise<AdapterDefinition> {
  for (const dir of adapterDirs) {
    const root = join(dir, name);
    if (await exists(join(root, "adapter.yaml"))) {
      await requireFile(join(root, "constraints.md"), "adapter.constraints_md_missing");
      const parsed = adapterSchema.safeParse(await readYamlFile(join(root, "adapter.yaml")));
      if (!parsed.success) {
        throw new PipelineError({
          code: "adapter.schema",
          message: parsed.error.issues[0]?.message ?? "invalid adapter definition",
          path: join(root, "adapter.yaml")
        });
      }
      if (parsed.data.kind === "mcp-agent") {
        await requireFile(join(root, "SKILL.md"), "adapter.skill_md_missing");
      }
      return { ...parsed.data, root };
    }
  }

  throw new PipelineError({
    code: "adapter.not_found",
    message: `adapter '${name}' was not found`
  });
}

async function requireFile(path: string, code: string): Promise<void> {
  if (await exists(path)) return;
  throw new PipelineError({
    code,
    message: `${path} is required`
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
