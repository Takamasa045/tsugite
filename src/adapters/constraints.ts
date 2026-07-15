import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { generationRequestMode, type GenerationRequest, type Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { loadAdapterDefinition } from "./registry.js";

const constraintSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        scope: z.union([z.literal("generation"), z.literal("analysis")]),
        field: z.string().min(1),
        operator: z.union([z.literal("in"), z.literal("min"), z.literal("max")]),
        values: z.array(z.union([z.string(), z.number()])).optional(),
        value: z.union([z.string(), z.number()]).optional(),
        optional: z.boolean().default(false),
        message: z.string().min(1)
      })
    )
    .default([])
});

type ConstraintFile = z.infer<typeof constraintSchema>;
type Comparable = string | number | undefined;

export async function validateGenerationConstraints(
  project: Project,
  adapterDirs = ["adapters"]
): Promise<Result<{}>> {
  if (!project.generation) {
    return { ok: true, issues: [] };
  }

  const adapter = await loadAdapterDefinition(project.generation.adapter, adapterDirs);
  const constraints = await loadConstraints(adapter.root);
  const issues = project.generation.requests.flatMap((request, index) =>
    [
      ...constraints.checks.flatMap((check) => {
        if (check.scope !== "generation") return [];

        const actual = request[check.field as keyof typeof request] as Comparable;
        const valid = matchesConstraint(actual, check);
        return valid
          ? []
          : [
              {
                code: `adapter.constraint.${check.id}`,
                message: check.message,
                path: `generation.requests.${index}.${check.field}`
              }
            ];
      }),
      ...validateInputMode(request, index, adapter.input_modes)
    ]
  );

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

function validateInputMode(
  request: GenerationRequest,
  index: number,
  contracts: Awaited<ReturnType<typeof loadAdapterDefinition>>["input_modes"]
): Issue[] {
  const inputMode = generationRequestMode(request);
  if (!inputMode || !contracts) return [];
  const contract = contracts[inputMode];
  if (!contract) {
    return [
      {
        code: "adapter.input_mode.unsupported",
        message: `selected adapter does not support ${inputMode}`,
        path: `generation.requests.${index}.${request.mode ? "mode" : "input_mode"}`
      }
    ];
  }

  const required = Object.entries(contract.required_params);
  const missing = required.filter(([key]) => !hasParam(request.params, key));
  const invalidTypes = required.filter(
    ([key, type]) => hasParam(request.params, key) && !matchesParamType(request.params[key], type)
  );
  const forbidden = contract.forbidden_params.filter((key) => hasParam(request.params, key));
  const missingFields = contract.required_fields.filter((key) => !hasField(request, key));
  const forbiddenFields = contract.forbidden_fields.filter((key) => hasField(request, key));
  return [
    ...missing.map(([key]) => ({
      code: "adapter.input_mode.required_param",
      message: `input mode requires params.${key}`,
      path: `generation.requests.${index}.params.${key}`
    })),
    ...invalidTypes.map(([key, type]) => ({
      code: "adapter.input_mode.param_type",
      message: `params.${key} must be ${type}`,
      path: `generation.requests.${index}.params.${key}`
    })),
    ...forbidden.map((key) => ({
      code: "adapter.input_mode.forbidden_param",
      message: `input mode does not allow params.${key}`,
      path: `generation.requests.${index}.params.${key}`
    })),
    ...missingFields.map((key) => ({
      code: "adapter.input_mode.required_field",
      message: `input mode requires ${key}`,
      path: `generation.requests.${index}.${key}`
    })),
    ...forbiddenFields.map((key) => ({
      code: "adapter.input_mode.forbidden_field",
      message: `input mode does not allow ${key}`,
      path: `generation.requests.${index}.${key}`
    }))
  ];
}

function matchesParamType(
  value: unknown,
  type: "non-empty-string" | "boolean" | "finite-number"
): boolean {
  if (type === "non-empty-string") return typeof value === "string" && value.trim().length > 0;
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value);
}

function hasParam(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  return value !== undefined && value !== null && value !== "";
}

function hasField(request: GenerationRequest, key: string): boolean {
  const value = request[key as keyof GenerationRequest];
  return value !== undefined && value !== null && value !== "";
}

async function loadConstraints(root: string): Promise<ConstraintFile> {
  const path = join(root, "constraints.yaml");
  if (!(await exists(path))) {
    return { checks: [] };
  }

  return constraintSchema.parse(await readYamlFile(path));
}

function matchesConstraint(
  actual: Comparable,
  check: ConstraintFile["checks"][number]
): boolean {
  if (actual === undefined) return check.optional;
  if (check.operator === "in") return Boolean(check.values?.includes(actual));
  if (typeof actual !== "number" || typeof check.value !== "number") return false;
  if (check.operator === "min") return actual >= check.value;
  return actual <= check.value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
