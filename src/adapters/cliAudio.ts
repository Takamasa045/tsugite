import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { spawnCommandSync } from "../platform/process.js";
import type { AudioRequest } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import type { AdapterDefinition } from "./registry.js";

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const audioTrackSchema = z.object({
  id: safeIdSchema,
  src: z.string().min(1),
  start: z.number().nonnegative().default(0),
  end: z.number().positive().optional(),
  volume: z.number().min(0).max(1).optional()
}).superRefine((track, context) => {
  if (track.end !== undefined && track.end <= track.start) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "end must be greater than start", path: ["end"] });
  }
});

const cliAudioOutputSchema = z.object({
  credits: z.number().nonnegative().default(0),
  bgm: audioTrackSchema.optional(),
  sfx: z.array(audioTrackSchema).default([]),
  metadata: z.object({
    provider: z.string().min(1).optional(),
    bgm_mode: z.string().min(1).optional(),
    elevenlabs_used: z.boolean().default(false),
    fallback_used: z.boolean().default(false),
    fixture: z.boolean().optional()
  }).default({ elevenlabs_used: false, fallback_used: false })
});

export type CliAudioResult = z.infer<typeof cliAudioOutputSchema>;

export function runCliAudioAdapter(
  adapter: AdapterDefinition,
  request: AudioRequest,
  options: { runId: string; runDir: string; targetDurationSeconds: number }
): Result<CliAudioResult> {
  if (adapter.kind !== "cli" || adapter.class !== "audio") {
    return {
      ok: false,
      issues: [{ code: "run.audio_adapter_kind_unsupported", message: "audio adapter must be an executable cli adapter" }]
    };
  }
  if (!adapter.command) {
    return {
      ok: false,
      issues: [{ code: "run.audio_adapter_command_missing", message: "audio adapter command is not declared" }]
    };
  }

  const maxAttempts = Math.max(1, adapter.retry.max_attempts + 1);
  let lastIssue: Issue | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnCommandSync(adapter.command.executable, adapter.command.args, {
      cwd: process.cwd(),
      input: `${JSON.stringify({
        request: {
          ...(request.bgm ? { bgm: request.bgm } : {}),
          sfx: request.sfx,
          params: request.params
        },
        run_id: options.runId,
        run_dir: options.runDir,
        target_duration_seconds: options.targetDurationSeconds
      })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20
    });

    if (result.error) {
      return {
        ok: false,
        issues: [{ code: "run.audio_adapter_spawn_failed", message: "audio adapter command could not be started" }]
      };
    }
    if (result.status === 0) {
      const parsed = parseOutput(result.stdout);
      if (!parsed.ok) return parsed;
      const validated = validateOutput(parsed.output, request, options.runDir);
      if (!validated.ok) return validated;
      return { ok: true, issues: [], ...parsed.output };
    }

    const status = result.status ?? 1;
    const mapped = adapter.exit_code_map[String(status)] ?? "failed";
    lastIssue = {
      code: `run.audio_adapter_exit.${mapped}`,
      message: "audio adapter command failed",
      path: "audio"
    };
    if (!adapter.retry.retryable_exit_codes.includes(status) || attempt === maxAttempts) {
      return { ok: false, issues: [lastIssue] };
    }
  }
  return { ok: false, issues: [lastIssue ?? { code: "run.audio_adapter_failed", message: "audio adapter failed" }] };
}

function parseOutput(stdout: string): Result<{ output: CliAudioResult }> {
  try {
    const parsed = cliAudioOutputSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      return {
        ok: false,
        issues: [{ code: "run.audio_adapter_output_schema", message: parsed.error.issues[0]?.message ?? "invalid audio adapter output" }]
      };
    }
    return { ok: true, issues: [], output: parsed.data };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "run.audio_adapter_output_json", message: error instanceof Error ? error.message : String(error) }]
    };
  }
}

function validateOutput(output: CliAudioResult, request: AudioRequest, runDir: string): Result<Record<never, never>> {
  if (request.bgm && !output.bgm) {
    return { ok: false, issues: [{ code: "run.audio_adapter_bgm_missing", message: "audio adapter did not return the requested BGM" }] };
  }
  if ((!request.bgm && output.bgm) || (request.bgm && output.bgm?.id !== request.bgm.id)) {
    return { ok: false, issues: [{ code: "run.audio_adapter_bgm_mismatch", message: "audio adapter returned a BGM that does not match the request" }] };
  }
  if (output.metadata.fallback_used) {
    return { ok: false, issues: [{ code: "run.audio_adapter_fallback_forbidden", message: "audio adapter used a fallback while the request requires fail-closed execution" }] };
  }
  const requestedSfxIds = request.sfx.map((entry) => entry.id).sort();
  const outputSfxIds = output.sfx.map((entry) => entry.id).sort();
  if (JSON.stringify(requestedSfxIds) !== JSON.stringify(outputSfxIds)) {
    return { ok: false, issues: [{ code: "run.audio_adapter_sfx_mismatch", message: "audio adapter did not return every requested SFX" }] };
  }
  const tracks = [...(output.bgm ? [output.bgm] : []), ...output.sfx];
  const ids = new Set<string>();
  for (const track of tracks) {
    if (ids.has(track.id)) {
      return { ok: false, issues: [{ code: "run.audio_adapter_track_id_duplicate", message: `audio adapter returned duplicate track id '${track.id}'` }] };
    }
    ids.add(track.id);
    const issue = validateTrackPath(track.src, runDir);
    if (issue) return { ok: false, issues: [issue] };
  }
  return { ok: true, issues: [] };
}

function validateTrackPath(src: string, runDir: string): Issue | undefined {
  let realRunDir: string;
  let realSourcePath: string;
  try {
    realRunDir = realpathSync(runDir);
    realSourcePath = realpathSync(isAbsolute(src) ? src : resolve(process.cwd(), src));
    if (!statSync(realSourcePath).isFile()) throw new Error("not a regular file");
  } catch {
    return { code: "run.audio_adapter_output_src_invalid", message: "audio src must be an existing regular file inside runDir" };
  }
  const pathFromRun = relative(realRunDir, realSourcePath);
  if (
    pathFromRun.length === 0 ||
    pathFromRun === ".." ||
    pathFromRun.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRun)
  ) {
    return { code: "run.audio_adapter_output_src_outside_run_dir", message: "audio src must resolve inside runDir" };
  }
  return undefined;
}
