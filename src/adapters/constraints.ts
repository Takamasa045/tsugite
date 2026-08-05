import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import {
  generationOperationSchema,
  generationRequestMode,
  type GenerationRequest,
  type Project
} from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import type { H3ExecutionRouteProfile } from "../h3/validate/adapterRoute.js";
import { loadAdapterDefinition } from "./registry.js";

/**
 * Machine-readable H3 route block inside adapter constraints.yaml.
 * Unknown fields are rejected (strict) so typos cannot silently disable checks.
 */
const h3ExecutionRouteYamlSchema = z
  .object({
    /** Required non-empty; Stage 2 matches this against each IR target.model (H3-C006). */
    model: z.string().min(1),
    durations: z.array(z.number().positive()).min(1),
    qualities: z.array(z.string().min(1)).min(1),
    aspects: z.array(z.string().min(1)).min(1),
    max_images: z.number().int().nonnegative(),
    max_videos: z.number().int().nonnegative(),
    max_audios: z.number().int().nonnegative(),
    audio_requires_image_or_video: z.boolean(),
    forbid_first_last_reference_mix: z.boolean()
  })
  .strict();

const constraintSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        scope: z.union([z.literal("generation"), z.literal("analysis")]),
        field: z.string().min(1),
        operations: z.array(generationOperationSchema).min(1).optional(),
        operator: z.union([z.literal("in"), z.literal("min"), z.literal("max")]),
        values: z.array(z.union([z.string(), z.number()])).optional(),
        value: z.union([z.string(), z.number()]).optional(),
        optional: z.boolean().default(false),
        message: z.string().min(1)
      })
    )
    .default([]),
  h3_execution_route: h3ExecutionRouteYamlSchema.optional()
});

type ConstraintFile = z.infer<typeof constraintSchema>;
type Comparable = string | number | undefined;

export type { H3ExecutionRouteProfile };

export async function validateGenerationConstraints(
  project: Project,
  adapterDirs = ["adapters"]
): Promise<Result<{}>> {
  if (!project.generation?.adapter) {
    return { ok: true, issues: [] };
  }

  const adapter = await loadAdapterDefinition(project.generation.adapter, adapterDirs);
  const constraints = await loadConstraints(adapter.root);
  const issues = project.generation.requests.flatMap((request, index) =>
    [
      ...constraints.checks.flatMap((check) => {
        if (check.scope !== "generation") return [];
        if (check.operations && !check.operations.includes(request.operation ?? "video")) return [];

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

/**
 * Load the provider-neutral H3 execution route profile from an adapter root.
 * Reads only `<adapterRoot>/constraints.yaml` — never arbitrary paths.
 * Returns undefined when the adapter does not declare `h3_execution_route`.
 */
export async function loadH3ExecutionRouteProfile(
  adapterRoot: string
): Promise<H3ExecutionRouteProfile | undefined> {
  const constraints = await loadConstraints(adapterRoot);
  if (!constraints.h3_execution_route) return undefined;
  return mapH3ExecutionRouteProfile(constraints.h3_execution_route);
}

function mapH3ExecutionRouteProfile(
  route: NonNullable<ConstraintFile["h3_execution_route"]>
): H3ExecutionRouteProfile {
  return {
    model: route.model,
    durations: route.durations,
    qualities: route.qualities,
    aspects: route.aspects,
    maxImages: route.max_images,
    maxVideos: route.max_videos,
    maxAudios: route.max_audios,
    audioRequiresImageOrVideo: route.audio_requires_image_or_video,
    forbidFirstLastReferenceMix: route.forbid_first_last_reference_mix
  };
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
  const missingAnyGroups = contract.required_any.filter(
    (paths) => !paths.some((path) => hasRequestPath(request, path))
  );
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
    })),
    ...missingAnyGroups.map((paths) => ({
      code: "adapter.input_mode.required_any",
      message: `input mode requires one of: ${paths.join(", ")}`,
      path: `generation.requests.${index}`
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
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Resolve a provider-neutral request path for input-mode contracts.
 * Supports top-level fields and a single `params.<key>` segment only.
 * `params.*` alternatives count only as non-empty strings so typed media paths
 * (legacy `params.image`) cannot be satisfied by booleans or empty values.
 */
function hasRequestPath(request: GenerationRequest, path: string): boolean {
  if (path.startsWith("params.")) {
    const key = path.slice("params.".length);
    if (!key || key.includes(".")) return false;
    return matchesParamType(request.params?.[key], "non-empty-string");
  }
  if (!path || path.includes(".")) return false;
  return hasField(request, path);
}

async function loadConstraints(root: string): Promise<ConstraintFile> {
  // Only the adapter's own constraints.yaml is readable from this loader.
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
