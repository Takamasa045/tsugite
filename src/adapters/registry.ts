import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { PipelineError } from "../types.js";
import { setupCheckSchema } from "../setupChecks.js";

const adapterSchema = z.object({
  name: z.string().min(1),
  kind: z.union([z.literal("cli"), z.literal("mcp-agent"), z.literal("mcp-client")]),
  class: z.union([z.literal("generation"), z.literal("analysis")]).default("generation"),
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
          forbidden_params: z.array(z.string().min(1)).default([])
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
          forbidden_params: z.array(z.string().min(1)).default([])
        })
        .optional()
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
