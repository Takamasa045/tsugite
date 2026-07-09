import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { Manifest } from "../manifest/schema.js";
import type { GenerationRequest } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import type { AdapterDefinition } from "./registry.js";

const generatedClipSchema = z
  .object({
    id: z.string().min(1),
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

const cliOutputSchema = z.object({
  request_id: z.string().min(1).optional(),
  credits: z.number().nonnegative().default(0),
  clips: z.array(generatedClipSchema).min(1),
  metadata: z.record(z.unknown()).default({})
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

  for (const request of requests) {
    const result = runRequest(adapter, request, options);
    if (!result.ok) return result;
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
      input: `${JSON.stringify({ request, run_id: options.runId, run_dir: options.runDir })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20
    });

    if (result.error) {
      return {
        ok: false,
        issues: [{ code: "run.adapter_spawn_failed", message: result.error.message }]
      };
    }

    if (result.status === 0) {
      const parsed = parseCliOutput(result.stdout, request.id);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        issues: [],
        request: {
          request_id: parsed.output.request_id ?? request.id,
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
      message: adapterErrorMessage(result.stderr, result.stdout),
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

function adapterErrorMessage(stderr: string, stdout: string): string {
  const text = `${stderr}\n${stdout}`.trim();
  return text.length > 0 ? text.slice(0, 2000) : "adapter command failed";
}
