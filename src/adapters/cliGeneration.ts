import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Manifest } from "../manifest/schema.js";
import { toExecutionGenerationRequest, type GenerationRequest } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import type { AdapterDefinition } from "./registry.js";

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const generatedClipSchema = z
  .object({
    id: safeIdSchema,
    src: z.string().min(1),
    duration: z.number().positive(),
    fps: z.number().positive(),
    resolution: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    }),
    audio: z.boolean().default(false)
  })
  .passthrough();

const cliOutputSchema = z
  .object({
    request_id: safeIdSchema,
    credits: z.number().nonnegative().default(0),
    clips: z.array(generatedClipSchema).min(1),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .superRefine((output, context) => {
    const seen = new Set<string>();
    for (const [index, clip] of output.clips.entries()) {
      if (seen.has(clip.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "clip ids must be unique",
          path: ["clips", index, "id"]
        });
      }
      seen.add(clip.id);
    }
  });

export type CliGenerationRequestResult = {
  request_id: string;
  attempts: number;
  credits: number;
  clips: Array<z.infer<typeof generatedClipSchema>>;
  metadata: Record<string, unknown>;
};

export type CliGenerationResult = {
  clips: Manifest["clips"];
  credits: number;
  requests: CliGenerationRequestResult[];
};

export type CliGenerationOptions = {
  runId: string;
  runDir: string;
};

export function runCliGenerationAdapter(
  adapter: AdapterDefinition,
  requests: GenerationRequest[],
  options: CliGenerationOptions
): Result<CliGenerationResult> {
  if (adapter.kind !== "cli") {
    return {
      ok: false,
      issues: [{ code: "run.adapter_kind_unsupported", message: `adapter kind '${adapter.kind}' is not executable here` }]
    };
  }

  if (!adapter.command) {
    return {
      ok: false,
      issues: [{ code: "run.adapter_command_missing", message: "cli adapter command is not declared" }]
    };
  }

  const results: CliGenerationRequestResult[] = [];
  const clips: Manifest["clips"] = [];
  const clipIds = new Set<string>();

  for (const request of requests) {
    const result = runRequest(adapter, request, options);
    if (!result.ok) return result;
    const duplicateClip = result.request.clips.find((clip) => clipIds.has(clip.id));
    if (duplicateClip) {
      return {
        ok: false,
        issues: [
          {
            code: "run.adapter_output_clip_id_duplicate",
            message: `adapter returned duplicate clip id '${duplicateClip.id}'`,
            path: `generation.requests.${request.id}.clips`
          }
        ]
      };
    }
    for (const clip of result.request.clips) clipIds.add(clip.id);
    results.push(result.request);
    clips.push(...result.request.clips.map((clip) => generatedClipToManifestClip(clip)));
  }

  return {
    ok: true,
    issues: [],
    clips,
    credits: results.reduce((sum, request) => sum + request.credits, 0),
    requests: results
  };
}

function runRequest(
  adapter: AdapterDefinition,
  request: GenerationRequest,
  options: CliGenerationOptions
): Result<{ request: CliGenerationRequestResult }> {
  const maxAttempts = Math.max(1, adapter.retry.max_attempts + 1);
  let lastIssue: Issue | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(adapter.command!.executable, adapter.command!.args, {
      cwd: process.cwd(),
      input: `${JSON.stringify({ request: toExecutionGenerationRequest(request), run_id: options.runId, run_dir: options.runDir })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20
    });

    if (result.error) {
      return {
        ok: false,
        issues: [{ code: "run.adapter_spawn_failed", message: "adapter command could not be started" }]
      };
    }

    if (result.status === 0) {
      const parsed = parseCliOutput(result.stdout, request.id);
      if (!parsed.ok) return parsed;
      const outputValidation = validateCliOutput(parsed.output, request.id, options.runDir);
      if (!outputValidation.ok) return outputValidation;
      return {
        ok: true,
        issues: [],
        request: {
          request_id: parsed.output.request_id,
          attempts: attempt,
          credits: parsed.output.credits,
          clips: parsed.output.clips,
          metadata: parsed.output.metadata
        }
      };
    }

    const status = result.status ?? 1;
    const mapped = adapter.exit_code_map[String(status)] ?? "failed";
    lastIssue = {
      code: `run.adapter_exit.${mapped}`,
      message: adapterErrorMessage(),
      path: `generation.requests.${request.id}`
    };

    if (!adapter.retry.retryable_exit_codes.includes(status) || attempt === maxAttempts) {
      return { ok: false, issues: [lastIssue] };
    }
  }

  return {
    ok: false,
    issues: [lastIssue ?? { code: "run.adapter_failed", message: "adapter command failed" }]
  };
}

function validateCliOutput(
  output: z.infer<typeof cliOutputSchema>,
  requestId: string,
  runDir: string
): Result<Record<never, never>> {
  if (output.request_id !== requestId) {
    return {
      ok: false,
      issues: [
        {
          code: "run.adapter_output_request_id_mismatch",
          message: `adapter request_id '${output.request_id}' does not match '${requestId}'`,
          path: `generation.requests.${requestId}.request_id`
        }
      ]
    };
  }

  let realRunDir: string;
  try {
    realRunDir = realpathSync(runDir);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "run.adapter_output_clip_src_invalid",
          message: "run directory is unavailable",
          path: `generation.requests.${requestId}.clips`
        }
      ]
    };
  }

  for (const [index, clip] of output.clips.entries()) {
    const sourcePath = isAbsolute(clip.src) ? clip.src : resolve(process.cwd(), clip.src);
    let realSourcePath: string;
    try {
      realSourcePath = realpathSync(sourcePath);
    } catch {
      return clipSourceIssue(
        "run.adapter_output_clip_src_invalid",
        "clip src must resolve to an existing regular file inside runDir",
        requestId,
        index
      );
    }

    if (!isWithinDirectory(realSourcePath, realRunDir)) {
      return clipSourceIssue(
        "run.adapter_output_clip_src_outside_run_dir",
        "clip src must resolve inside runDir",
        requestId,
        index
      );
    }

    try {
      if (!statSync(realSourcePath).isFile()) {
        return clipSourceIssue(
          "run.adapter_output_clip_src_invalid",
          "clip src must be a regular file",
          requestId,
          index
        );
      }
    } catch {
      return clipSourceIssue(
        "run.adapter_output_clip_src_invalid",
        "clip src could not be inspected safely",
        requestId,
        index
      );
    }
  }

  return { ok: true, issues: [] };
}

function isWithinDirectory(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory.length > 0 &&
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

function clipSourceIssue(
  code: string,
  message: string,
  requestId: string,
  clipIndex: number
): Result<Record<never, never>> {
  return {
    ok: false,
    issues: [
      {
        code,
        message,
        path: `generation.requests.${requestId}.clips.${clipIndex}.src`
      }
    ]
  };
}

function parseCliOutput(stdout: string, requestId: string): Result<{ output: z.infer<typeof cliOutputSchema> }> {
  try {
    const parsed = cliOutputSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      return {
        ok: false,
        issues: [
          {
            code: "run.adapter_output_schema",
            message: parsed.error.issues[0]?.message ?? "invalid adapter output",
            path: `generation.requests.${requestId}`
          }
        ]
      };
    }
    return { ok: true, issues: [], output: parsed.data };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "run.adapter_output_json",
          message: error instanceof Error ? error.message : String(error),
          path: `generation.requests.${requestId}`
        }
      ]
    };
  }
}

function generatedClipToManifestClip(clip: z.infer<typeof generatedClipSchema>): Manifest["clips"][number] {
  return {
    ...clip,
    in: 0,
    out: clip.duration
  };
}

function adapterErrorMessage(): string {
  return "adapter command failed";
}
