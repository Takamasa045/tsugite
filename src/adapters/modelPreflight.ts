import { z } from "zod";
import { spawnCommandSync } from "../platform/process.js";
import { toAdapterGenerationRequest, type GenerationRequest } from "../project/schema.js";
import type { Issue } from "../types.js";
import type { AdapterDefinition } from "./registry.js";

const safeIdSchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const issueSchema = z.object({
  code: safeIdSchema,
  message: z.string().min(1),
  path: z.string().min(1).optional()
});
const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const preflightOutputSchema = z.object({
  request_id: safeIdSchema,
  status: z.enum(["compatible", "provider-validation-required", "incompatible", "unavailable"]),
  source: safeIdSchema,
  model: z.string().min(1).optional(),
  operation: safeIdSchema,
  input_mode: z.string().min(1).optional(),
  task_type: safeIdSchema.optional(),
  runtime_version: z.string().min(1).optional(),
  required_parameters: z.array(z.string().min(1)).default([]),
  parameter_options: z.record(z.string(), z.array(primitiveSchema)).default({}),
  checked_parameters: z.array(z.string().min(1)).default([]),
  issues: z.array(issueSchema).default([])
});

export type ModelPreflightRequest = z.infer<typeof preflightOutputSchema>;
export type GenerationModelPreflight = {
  fullyValidated: boolean;
  billingAction: false;
  generationSubmitted: false;
  requests: ModelPreflightRequest[];
};
export type GenerationModelPreflightResult = GenerationModelPreflight & {
  ok: boolean;
  issues: Issue[];
};

export function runGenerationModelPreflight(
  adapter: AdapterDefinition,
  requests: GenerationRequest[]
): GenerationModelPreflightResult {
  if (adapter.kind !== "cli" || !adapter.model_preflight) {
    return {
      ok: false,
      issues: [{
        code: "models.preflight_unavailable",
        message: "selected adapter does not declare a non-billing model preflight"
      }],
      fullyValidated: false,
      billingAction: false,
      generationSubmitted: false,
      requests: []
    };
  }

  const outputs: ModelPreflightRequest[] = [];
  const issues: Issue[] = [];
  for (const request of requests) {
    const execution = spawnCommandSync(adapter.model_preflight.executable, adapter.model_preflight.args, {
      cwd: process.cwd(),
      input: `${JSON.stringify({ request: toAdapterGenerationRequest(request) })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4
    });
    if (execution.error || execution.status !== 0) {
      issues.push({
        code: "models.preflight_failed",
        message: "model preflight command could not complete",
        path: `generation.requests.${request.id}`
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(execution.stdout);
    } catch {
      issues.push({
        code: "models.preflight_output_invalid",
        message: "model preflight command returned invalid output",
        path: `generation.requests.${request.id}`
      });
      continue;
    }
    const validated = preflightOutputSchema.safeParse(parsed);
    if (!validated.success || validated.data.request_id !== request.id) {
      issues.push({
        code: "models.preflight_output_invalid",
        message: "model preflight output did not match the request",
        path: `generation.requests.${request.id}`
      });
      continue;
    }
    outputs.push(validated.data);
    if (["incompatible", "unavailable"].includes(validated.data.status)) {
      issues.push(...(validated.data.issues.length > 0
        ? validated.data.issues
        : [{
            code: `models.${validated.data.status}`,
            message: `model preflight reported ${validated.data.status}`,
            path: `generation.requests.${request.id}`
          }]));
    }
  }

  return {
    ok: issues.length === 0 && outputs.length === requests.length,
    issues,
    fullyValidated: outputs.length === requests.length && outputs.every((output) => output.status === "compatible"),
    billingAction: false,
    generationSubmitted: false,
    requests: outputs
  };
}
