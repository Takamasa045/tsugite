import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Manifest } from "../manifest/schema.js";
import { spawnCommandSync } from "../platform/process.js";
import type { AnalysisRequest } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import type { AdapterDefinition } from "./registry.js";

const safeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe id");

const sourceSchema = z.object({
  clip_id: z.string().min(1),
  analysis_start_seconds: z.number().nonnegative(),
  analysis_end_seconds: z.number().positive(),
  duration_seconds: z.number().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).refine((source) => source.analysis_end_seconds > source.analysis_start_seconds, {
  message: "analysis_end_seconds must be greater than analysis_start_seconds"
});

const metadataSchema = z
  .object({
    engine: z.string().min(1),
    api_used: z.boolean(),
    network_used: z.boolean(),
    actual_credits: z.number().nonnegative().optional()
  })
  .passthrough();

const languageSchema = z
  .string()
  .min(2)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "must be a language tag");

const sourceRangeSchema = z
  .object({
    id: safeIdSchema,
    source_start: z.number().nonnegative(),
    source_end: z.number().positive()
  })
  .passthrough()
  .refine((range) => range.source_end > range.source_start, {
    message: "source_end must be greater than source_start"
  });

const cutPointSchema = sourceRangeSchema.extend({
  kind: z.enum(["silence", "scene", "filler", "manual"]),
  action: z.literal("review").default("review"),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).optional(),
  evidence: z
    .object({
      transcript_segment_id: safeIdSchema.optional(),
      matched_text: z.string().min(1).optional()
    })
    .passthrough()
    .optional()
});

const captionSchema = sourceRangeSchema.extend({
  text: z.string().min(1),
  speaker: z.string().min(1).optional()
});

const chapterSchema = sourceRangeSchema.extend({
  title: z.string().min(1)
});

const wordSchema = z
  .object({
    text: z.string().min(1),
    source_start: z.number().nonnegative(),
    source_end: z.number().positive(),
    confidence: z.number().min(0).max(1).optional()
  })
  .passthrough()
  .refine((word) => word.source_end > word.source_start, {
    message: "word source_end must be greater than source_start"
  });

const transcriptSegmentSchema = sourceRangeSchema
  .extend({
    text: z.string().min(1),
    speaker: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    words: z.array(wordSchema).optional()
  })
  .superRefine((segment, context) => {
    validateOrderedRanges(segment.words ?? [], context, ["words"]);
    for (const [index, word] of (segment.words ?? []).entries()) {
      if (word.source_start < segment.source_start || word.source_end > segment.source_end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "word timestamp must stay inside its transcript segment",
          path: ["words", index]
        });
      }
    }
  });

const summarySchema = sourceRangeSchema.extend({
  text: z.string().min(1),
  bullets: z.array(z.string().min(1)).optional()
});

const subtitleCaptionSchema = sourceRangeSchema.extend({
  source_segment_id: safeIdSchema,
  text: z.string().min(1)
});

const safeRelativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0")) {
      return false;
    }
    return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }, "must be a safe relative artifact path");

const sceneObservationSchema = sourceRangeSchema
  .extend({
    description: z.string().min(1),
    technical_notes: z.array(z.string().min(1)),
    selection_reasons: z.array(z.string().min(1)),
    confidence: z.number().min(0).max(1),
    evidence: z
      .object({
        representative_frame: safeRelativeArtifactPathSchema.optional(),
        timestamp_seconds: z.number().nonnegative().optional()
      })
      .passthrough()
  })
  .superRefine((observation, context) => {
    const timestamp = observation.evidence.timestamp_seconds;
    if (timestamp !== undefined && (timestamp < observation.source_start || timestamp > observation.source_end)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidence timestamp must stay inside its scene observation",
        path: ["evidence", "timestamp_seconds"]
      });
    }
  });

const similarityGroupSchema = z
  .object({
    id: safeIdSchema,
    member_observation_ids: z
      .array(safeIdSchema)
      .min(2)
      .superRefine((ids, context) => {
        const seen = new Set<string>();
        for (const [index, id] of ids.entries()) {
          if (seen.has(id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "similarity group member observation ids must be unique",
              path: [index]
            });
          }
          seen.add(id);
        }
      }),
    reason: z.string().min(1)
  })
  .passthrough();

const similarityGroupsSchema = z.array(similarityGroupSchema).superRefine((groups, context) => {
  const seen = new Set<string>();
  for (const [index, group] of groups.entries()) {
    if (seen.has(group.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "similarity group ids must be unique",
        path: [index, "id"]
      });
    }
    seen.add(group.id);
  }
});

const outputBase = {
  schema_version: z.literal(1),
  request_id: safeIdSchema,
  source: sourceSchema,
  metadata: metadataSchema
};

export const analysisAdapterOutputSchema = z.discriminatedUnion("output", [
  z.object({
    ...outputBase,
    output: z.literal("cut_points"),
    data: z.object({ cut_points: orderedRanges(cutPointSchema) })
  }),
  z.object({
    ...outputBase,
    output: z.literal("captions"),
    data: z.object({ captions: orderedRanges(captionSchema) })
  }),
  z.object({
    ...outputBase,
    output: z.literal("chapters"),
    data: z.object({ chapters: orderedRanges(chapterSchema) })
  }),
  z.object({
    ...outputBase,
    output: z.literal("transcript"),
    data: z.object({
      language: languageSchema,
      segments: orderedRanges(transcriptSegmentSchema)
    })
  }),
  z.object({
    ...outputBase,
    output: z.literal("summary"),
    data: z.object({
      language: languageSchema,
      summaries: orderedRanges(summarySchema)
    })
  }),
  z.object({
    ...outputBase,
    output: z.literal("subtitle_track"),
    data: z.object({
      source_language: languageSchema,
      target_language: languageSchema,
      captions: orderedRanges(subtitleCaptionSchema)
    })
  }),
  z.object({
    ...outputBase,
    output: z.literal("scene_observations"),
    data: z.object({
      scene_observations: orderedRanges(sceneObservationSchema)
    })
  }),
  z.object({
    ...outputBase,
    output: z.literal("similarity_groups"),
    data: z.object({
      similarity_groups: similarityGroupsSchema
    })
  })
]);

export type CliAnalysisRequestResult = z.infer<typeof analysisAdapterOutputSchema> & {
  attempts: number;
};

export type CliAnalysisResult = {
  results: CliAnalysisRequestResult[];
  actualCredits: number;
  apiUsed: boolean;
  networkUsed: boolean;
  externalTransfers: ExternalAnalysisTransfer[];
};

export type ExternalAnalysisTransfer = {
  request_id: string;
  adapter: string;
  input_scope: "low-confidence-segments" | "source-media" | "source-media-and-dependencies";
  source_sha256: string;
  segment_ids: string[];
  dependency_ids: string[];
};

export type CliAnalysisOptions = {
  runId: string;
  runDir: string;
  manifestDir: string;
  mode?: "local" | "hybrid" | "cloud";
  confidenceThreshold?: number;
  allowExternalAnalysis?: boolean;
  environment?: NodeJS.ProcessEnv;
};

export function runCliAnalysisAdapter(
  adapter: AdapterDefinition,
  requests: AnalysisRequest[],
  manifest: Manifest,
  options: CliAnalysisOptions
): Result<CliAnalysisResult> {
  if (adapter.kind !== "cli") {
    return failure("analysis.adapter_kind_unsupported", `adapter kind '${adapter.kind}' is not executable by pipeline analyze`);
  }
  if (!adapter.outputs) {
    return failure("analysis.adapter_outputs_required", "cli analysis adapter must declare supported outputs");
  }
  if (!adapter.command) {
    return failure("analysis.adapter_command_missing", "cli analysis adapter command is not declared");
  }

  const ordered = orderAnalysisRequests(requests);
  if (!ordered.ok) return ordered;
  const resultsById = new Map<string, CliAnalysisRequestResult>();
  const externalTransfers: ExternalAnalysisTransfer[] = [];
  for (const request of ordered.requests) {
    const inputs = requestDependencies(request).map((dependencyId) => resultsById.get(dependencyId)!);
    const executed = runCliAnalysisRequest(adapter, request, manifest, inputs, options);
    if (!executed.ok) return executed;
    resultsById.set(request.id, executed.result);
    if (executed.externalTransfer) externalTransfers.push(executed.externalTransfer);
  }

  const results = requests.map((request) => resultsById.get(request.id)!);

  return {
    ok: true,
    issues: [],
    results,
    actualCredits: sumCredits(results),
    apiUsed: results.some((result) => result.metadata.api_used),
    networkUsed: results.some((result) => result.metadata.network_used),
    externalTransfers
  };
}

export function runCliAnalysisRequest(
  adapter: AdapterDefinition,
  request: AnalysisRequest,
  manifest: Manifest,
  inputs: CliAnalysisRequestResult[],
  options: CliAnalysisOptions
): Result<{ result: CliAnalysisRequestResult; externalTransfer?: ExternalAnalysisTransfer }> {
  if (adapter.kind !== "cli") {
    return failure("analysis.adapter_kind_unsupported", `adapter kind '${adapter.kind}' is not executable by pipeline analyze`);
  }
  if (request.adapter && request.adapter !== adapter.name) {
    return failure(
      "analysis.request_adapter_mismatch",
      `analysis request '${request.id}' selects adapter '${request.adapter}', not '${adapter.name}'`,
      `analysis.requests.${request.id}.adapter`
    );
  }
  if (!adapter.outputs?.includes(request.output)) {
    return failure("analysis.output_unsupported", `analysis adapter '${adapter.name}' does not support '${request.output}'`);
  }
  if (!adapter.command) {
    return failure("analysis.adapter_command_missing", "cli analysis adapter command is not declared");
  }
  const mode = options.mode ?? "local";
  if (adapter.offline === false) {
    if (mode === "local") {
      return failure("analysis.online_adapter_forbidden", "local analysis mode cannot execute an online adapter");
    }
    if (!options.allowExternalAnalysis) {
      return failure(
        "analysis.external_permission_required",
        "external analysis requires the explicit --allow-external-analysis execution flag"
      );
    }
    if (!adapter.network) {
      return failure("analysis.network_contract_required", "online analysis adapter must declare its network input scope");
    }
  } else if (adapter.offline !== true) {
    return failure("analysis.offline_contract_required", "cli analysis adapter must explicitly declare offline");
  }

  const source = resolveSource(request, manifest, options.manifestDir);
  if (!source.ok) return source;
  const allowsCrossSourceDependencies = request.output === "similarity_groups"
    && inputs.every((input) => input.output === "scene_observations");
  const dependenciesMatchCurrentSources = allowsCrossSourceDependencies
    ? inputs.every((input) => {
        const current = resolveSource(
          { ...request, source_clip_id: input.source.clip_id },
          manifest,
          options.manifestDir
        );
        return current.ok && sameSource(input.source, current.source);
      })
    : inputs.every((input) => sameSource(input.source, source.source));
  if (!dependenciesMatchCurrentSources) {
    return failure(
      "analysis.dependency_source_mismatch",
      "analysis request dependencies must use the same source clip and fingerprint",
      `analysis.requests.${request.id}.depends_on`
    );
  }
  return runRequest(adapter, request, source.source, inputs, options);
}

type ResolvedSource = {
  clip_id: string;
  path: string;
  analysis_start_seconds: number;
  analysis_end_seconds: number;
  duration_seconds: number;
  sha256: string;
  size_bytes: number;
  modified_at_ms: number;
};

function resolveSource(
  request: AnalysisRequest,
  manifest: Manifest,
  manifestDir: string
): Result<{ source: ResolvedSource }> {
  const clip = request.source_clip_id
    ? manifest.clips.find((candidate) => candidate.id === request.source_clip_id)
    : manifest.clips.length === 1
      ? manifest.clips[0]
      : undefined;

  if (!clip) {
    return failure(
      request.source_clip_id ? "analysis.source_clip_not_found" : "analysis.source_clip_required",
      request.source_clip_id
        ? `analysis source clip '${request.source_clip_id}' was not found`
        : "source_clip_id is required when the manifest has multiple clips",
      `analysis.requests.${request.id}.source_clip_id`
    );
  }

  try {
    const sourcePath = realpathSync(isAbsolute(clip.src) ? clip.src : resolve(manifestDir, clip.src));
    const beforeHash = statSync(sourcePath);
    if (!beforeHash.isFile()) throw new Error("not a regular file");
    const sha256 = sha256File(sourcePath);
    const afterHash = statSync(sourcePath);
    if (sourceStatChanged(beforeHash, afterHash)) throw new Error("source changed while hashing");
    return {
      ok: true,
      issues: [],
      source: {
        clip_id: clip.id,
        path: sourcePath,
        analysis_start_seconds: clip.in,
        analysis_end_seconds: clip.out,
        duration_seconds: clip.out - clip.in,
        sha256,
        size_bytes: afterHash.size,
        modified_at_ms: afterHash.mtimeMs
      }
    };
  } catch {
    return failure(
      "analysis.source_unavailable",
      "analysis source must resolve to an existing regular local file",
      `analysis.requests.${request.id}.source_clip_id`
    );
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function runRequest(
  adapter: AdapterDefinition,
  request: AnalysisRequest,
  source: ResolvedSource,
  inputs: CliAnalysisRequestResult[],
  options: CliAnalysisOptions
): Result<{ result: CliAnalysisRequestResult; externalTransfer?: ExternalAnalysisTransfer }> {
  const maxAttempts = Math.max(1, adapter.retry.max_attempts + 1);
  let lastIssue: Issue | undefined;
  const externalInput = createExternalInput(adapter, inputs, options.confidenceThreshold ?? 0.7);
  if (!externalInput.ok) return externalInput;
  if (adapter.network?.input_scope === "low-confidence-segments" && externalInput.segmentIds.length === 0) {
    const transcript = inputs.find(
      (input): input is Extract<CliAnalysisRequestResult, { output: "transcript" }> => input.output === "transcript"
    );
    if (!transcript) {
      return failure("analysis.hybrid_transcript_dependency_required", "hybrid passthrough requires a transcript dependency");
    }
    return {
      ok: true,
      issues: [],
      result: {
        ...transcript,
        request_id: request.id,
        metadata: {
          engine: "hybrid-local-passthrough",
          api_used: false,
          network_used: false,
          actual_credits: 0
        },
        attempts: 0
      }
    };
  }
  const environment = options.environment ?? process.env;
  for (const variable of adapter.network?.credential_env ?? []) {
    if (!environment[variable]) {
      return failure("analysis.credential_missing", `required analysis credential '${variable}' is not set`, variable);
    }
  }
  const sourcePayload = adapter.network?.input_scope === "low-confidence-segments"
    ? publicSource(source)
    : source;
  const adapterInputs = adapter.offline || adapter.network?.input_scope === "source-media-and-dependencies"
    ? inputs
    : [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const execution = spawnCommandSync(adapter.command!.executable, adapter.command!.args, {
      cwd: process.cwd(),
      input: `${JSON.stringify({
        request,
        run_id: options.runId,
        run_dir: options.runDir,
        source: sourcePayload,
        inputs: adapterInputs,
        ...(externalInput.input ? { external_input: externalInput.input } : {})
      })}\n`,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      ...(adapter.network ? { timeout: adapter.network.timeout_ms } : {}),
      env: adapterEnvironment(adapter, environment),
      shell: false
    });

    if (execution.error) {
      if ((execution.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        return failure("analysis.adapter_timeout", "external analysis adapter timed out");
      }
      return failure("analysis.adapter_spawn_failed", "analysis adapter command could not be started");
    }
    if (execution.status === 0) {
      if (sourceChanged(source)) {
        return failure("analysis.source_changed", "analysis source changed while the adapter was running");
      }
      if (adapterOutputContainsCredential(execution.stdout, adapter, environment)) {
        return failure(
          "analysis.adapter_output_secret_detected",
          "analysis adapter output contained a declared credential and was rejected"
        );
      }
      const parsed = parseOutput(execution.stdout, request.id);
      if (!parsed.ok) return parsed;
      const validated = validateOutput(parsed.output, request, source, inputs, adapter);
      if (!validated.ok) return validated;
      const merged = mergeHybridTranscript(parsed.output, inputs, externalInput.segmentIds);
      if (!merged.ok) return merged;
      return {
        ok: true,
        issues: [],
        result: { ...merged.output, attempts: attempt },
        ...(adapter.network && adapter.network.input_scope !== "request-metadata" ? {
          externalTransfer: {
            request_id: request.id,
            adapter: adapter.name,
            input_scope: adapter.network.input_scope,
            source_sha256: source.sha256,
            segment_ids: externalInput.segmentIds,
            dependency_ids: adapterInputs.map((input) => input.request_id)
          }
        } : {})
      };
    }

    const status = execution.status ?? 1;
    const mapped = adapter.exit_code_map[String(status)] ?? "failed";
    lastIssue = {
      code: `analysis.adapter_exit.${mapped}`,
      message: "analysis adapter command failed",
      path: `analysis.requests.${request.id}`
    };
    if (!adapter.retry.retryable_exit_codes.includes(status) || attempt === maxAttempts) {
      return { ok: false, issues: [lastIssue] };
    }
  }

  return { ok: false, issues: [lastIssue ?? { code: "analysis.adapter_failed", message: "analysis adapter failed" }] };
}

function adapterOutputContainsCredential(
  stdout: string,
  adapter: AdapterDefinition,
  environment: NodeJS.ProcessEnv
): boolean {
  return (adapter.network?.credential_env ?? []).some((variable) => {
    const value = environment[variable];
    if (!value) return false;
    return value.length >= 8 ? stdout.includes(value) : stdout.includes(JSON.stringify(value));
  });
}

type ExternalInput = {
  scope: "low-confidence-segments" | "source-media" | "source-media-and-dependencies";
  segments: Array<Extract<CliAnalysisRequestResult, { output: "transcript" }>["data"]["segments"][number]>;
};

function createExternalInput(
  adapter: AdapterDefinition,
  inputs: CliAnalysisRequestResult[],
  confidenceThreshold: number
): Result<{ input?: ExternalInput; segmentIds: string[] }> {
  if (!adapter.network) return { ok: true, issues: [], segmentIds: [] };
  if (adapter.network.input_scope === "request-metadata") {
    return failure(
      "analysis.adapter_network_scope_invalid",
      "analysis adapters cannot use the request-metadata network scope"
    );
  }
  if (adapter.network.input_scope !== "low-confidence-segments") {
    return {
      ok: true,
      issues: [],
      input: { scope: adapter.network.input_scope, segments: [] },
      segmentIds: []
    };
  }
  const transcript = inputs.find(
    (input): input is Extract<CliAnalysisRequestResult, { output: "transcript" }> => input.output === "transcript"
  );
  if (!transcript) {
    return failure(
      "analysis.hybrid_transcript_dependency_required",
      "low-confidence external analysis requires a transcript dependency"
    );
  }
  const segments = transcript.data.segments.filter((segment) => {
    const confidence = segment.confidence ?? averageConfidence(segment.words ?? []);
    return confidence !== undefined && confidence < confidenceThreshold;
  });
  return {
    ok: true,
    issues: [],
    input: { scope: "low-confidence-segments", segments },
    segmentIds: segments.map((segment) => segment.id)
  };
}

function averageConfidence(words: Array<{ confidence?: number }>): number | undefined {
  const values = words.flatMap((word) => word.confidence === undefined ? [] : [word.confidence]);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function publicSource(source: ResolvedSource): Omit<ResolvedSource, "path" | "size_bytes" | "modified_at_ms"> {
  const { path: _path, size_bytes: _size, modified_at_ms: _modified, ...publicFields } = source;
  return publicFields;
}

function mergeHybridTranscript(
  output: z.infer<typeof analysisAdapterOutputSchema>,
  inputs: CliAnalysisRequestResult[],
  selectedIds: string[]
): Result<{ output: z.infer<typeof analysisAdapterOutputSchema> }> {
  if (selectedIds.length === 0 || output.output !== "transcript") {
    return { ok: true, issues: [], output };
  }
  const transcript = inputs.find(
    (input): input is Extract<CliAnalysisRequestResult, { output: "transcript" }> => input.output === "transcript"
  );
  if (!transcript) return { ok: true, issues: [], output };
  if (output.data.language !== transcript.data.language) {
    return failure("analysis.hybrid_language_mismatch", "hybrid transcript correction changed the transcript language");
  }
  const selected = new Set(selectedIds);
  const originals = new Map(transcript.data.segments.map((segment) => [segment.id, segment]));
  const corrections = new Map(output.data.segments.map((segment) => [segment.id, segment]));
  for (const correction of output.data.segments) {
    const original = originals.get(correction.id);
    if (!selected.has(correction.id) || !original) {
      return failure("analysis.hybrid_segment_unselected", "hybrid adapter returned an unselected transcript segment");
    }
    if (correction.source_start !== original.source_start || correction.source_end !== original.source_end) {
      return failure("analysis.hybrid_segment_range_changed", "hybrid adapter changed a selected source timestamp range");
    }
  }
  return {
    ok: true,
    issues: [],
    output: {
      ...output,
      data: {
        ...output.data,
        segments: transcript.data.segments.map((segment) => corrections.get(segment.id) ?? segment)
      }
    }
  };
}

function sumCredits(results: CliAnalysisRequestResult[]): number {
  return results.reduce((sum, result) => sum + (result.metadata.actual_credits ?? 0), 0);
}

function sourceChanged(source: ResolvedSource): boolean {
  try {
    const current = statSync(source.path);
    return current.size !== source.size_bytes || current.mtimeMs !== source.modified_at_ms;
  } catch {
    return true;
  }
}

function sourceStatChanged(
  before: { size: number; mtimeMs: number },
  after: { size: number; mtimeMs: number }
): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function parseOutput(
  stdout: string,
  requestId: string
): Result<{ output: z.infer<typeof analysisAdapterOutputSchema> }> {
  try {
    const parsed = analysisAdapterOutputSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      return failure(
        "analysis.adapter_output_schema",
        parsed.error.issues[0]?.message ?? "invalid analysis adapter output",
        `analysis.requests.${requestId}`
      );
    }
    return { ok: true, issues: [], output: parsed.data };
  } catch (error) {
    return failure(
      "analysis.adapter_output_json",
      error instanceof Error ? error.message : String(error),
      `analysis.requests.${requestId}`
    );
  }
}

function validateOutput(
  output: z.infer<typeof analysisAdapterOutputSchema>,
  request: AnalysisRequest,
  source: ResolvedSource,
  inputs: CliAnalysisRequestResult[],
  adapter: AdapterDefinition
): Result<Record<never, never>> {
  if (output.request_id !== request.id) {
    return failure("analysis.adapter_output_request_id_mismatch", "analysis adapter request_id does not match the request");
  }
  if (output.output !== request.output) {
    return failure("analysis.adapter_output_type_mismatch", "analysis adapter output type does not match the request");
  }
  if (
    output.source.clip_id !== source.clip_id ||
    output.source.sha256 !== source.sha256 ||
    output.source.analysis_start_seconds !== source.analysis_start_seconds ||
    output.source.analysis_end_seconds !== source.analysis_end_seconds ||
    output.source.duration_seconds !== source.duration_seconds
  ) {
    return failure("analysis.adapter_output_source_mismatch", "analysis adapter source fingerprint does not match the input");
  }
  if (adapter.offline && output.metadata.api_used) {
    return failure("analysis.adapter_api_used", "offline analysis adapters must not use an API");
  }
  if (adapter.offline && output.metadata.network_used) {
    return failure("analysis.adapter_network_used", "offline analysis adapters must not use network access");
  }
  if (adapter.offline === false && !output.metadata.network_used) {
    return failure("analysis.adapter_network_not_reported", "online analysis adapters must report network usage");
  }

  const ranges = outputRanges(output);
  if (
    ranges.some(
      (range) =>
        range.source_start < source.analysis_start_seconds ||
        range.source_end > source.analysis_end_seconds
    )
  ) {
    return failure("analysis.adapter_output_timestamp_out_of_range", "analysis timestamp is outside the selected source clip range");
  }
  if (output.output === "subtitle_track") {
    const transcriptInputs = inputs.filter(
      (input): input is Extract<CliAnalysisRequestResult, { output: "transcript" }> => input.output === "transcript"
    );
    const transcriptSegments = new Map<string, {
      language: string;
      segment: Extract<CliAnalysisRequestResult, { output: "transcript" }>["data"]["segments"][number];
    }>();
    for (const input of transcriptInputs) {
      for (const segment of input.data.segments) {
        transcriptSegments.set(segment.id, { language: input.data.language, segment });
      }
    }
    if (!transcriptInputs.some((input) => input.data.language === output.data.source_language)) {
      return failure(
        "analysis.adapter_output_translation_source_mismatch",
        "subtitle_track must depend on a transcript with the declared source language"
      );
    }
    for (const caption of output.data.captions) {
      const referenced = transcriptSegments.get(caption.source_segment_id);
      if (!referenced) {
        return failure(
          "analysis.adapter_output_translation_reference_missing",
          `subtitle caption references unknown transcript segment '${caption.source_segment_id}'`
        );
      }
      if (referenced.language !== output.data.source_language) {
        return failure(
          "analysis.adapter_output_translation_source_mismatch",
          "subtitle caption must reference a transcript in the declared source language"
        );
      }
      if (
        caption.source_start < referenced.segment.source_start ||
        caption.source_end > referenced.segment.source_end
      ) {
        return failure(
          "analysis.adapter_output_translation_range_mismatch",
          "subtitle caption timestamp must stay inside its referenced transcript segment"
        );
      }
    }
  }
  if (output.output === "similarity_groups") {
    const observationCounts = new Map<string, number>();
    for (const input of inputs) {
      if (input.output !== "scene_observations") continue;
      for (const observation of input.data.scene_observations) {
        observationCounts.set(observation.id, (observationCounts.get(observation.id) ?? 0) + 1);
      }
    }
    for (const group of output.data.similarity_groups) {
      for (const observationId of group.member_observation_ids) {
        const count = observationCounts.get(observationId) ?? 0;
        if (count === 0) {
          return failure(
            "analysis.adapter_output_similarity_reference_missing",
            `similarity group references unknown scene observation '${observationId}'`
          );
        }
        if (count > 1) {
          return failure(
            "analysis.adapter_output_similarity_reference_ambiguous",
            `similarity group reference '${observationId}' is ambiguous across dependencies`
          );
        }
      }
    }
  }
  return { ok: true, issues: [] };
}

function outputRanges(output: z.infer<typeof analysisAdapterOutputSchema>): Array<{ source_start: number; source_end: number }> {
  switch (output.output) {
    case "cut_points": return output.data.cut_points;
    case "captions": return output.data.captions;
    case "chapters": return output.data.chapters;
    case "transcript": return output.data.segments;
    case "summary": return output.data.summaries;
    case "subtitle_track": return output.data.captions;
    case "scene_observations": return output.data.scene_observations;
    case "similarity_groups": return [];
  }
}

function orderedRanges<T extends z.ZodType<{ source_start: number; source_end: number }>>(schema: T): z.ZodArray<T> {
  return z.array(schema).superRefine((ranges, context) => {
    validateOrderedRanges(ranges, context);
    const ids = new Set<string>();
    for (const [index, range] of ranges.entries()) {
      if (!("id" in range) || typeof range.id !== "string") continue;
      if (ids.has(range.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "source range ids must be unique",
          path: [index, "id"]
        });
      }
      ids.add(range.id);
    }
  });
}

function validateOrderedRanges(
  ranges: Array<{ source_start: number; source_end: number }>,
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = []
): void {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.source_start < ranges[index - 1]!.source_start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source ranges must be ordered by source_start",
        path: [...pathPrefix, index, "source_start"]
      });
    }
  }
}

function requestDependencies(request: AnalysisRequest): string[] {
  return request.depends_on ?? [];
}

function orderAnalysisRequests(requests: AnalysisRequest[]): Result<{ requests: AnalysisRequest[] }> {
  const requestsById = new Map<string, AnalysisRequest>();
  for (const request of requests) {
    if (requestsById.has(request.id)) {
      return failure("analysis.request_id_duplicate", `analysis request id '${request.id}' must be unique`);
    }
    requestsById.set(request.id, request);
  }
  for (const request of requests) {
    for (const dependencyId of requestDependencies(request)) {
      if (!requestsById.has(dependencyId)) {
        return failure(
          "analysis.dependency_not_found",
          `analysis dependency '${dependencyId}' was not found`,
          `analysis.requests.${request.id}.depends_on`
        );
      }
    }
  }

  const ordered: AnalysisRequest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (request: AnalysisRequest): boolean => {
    if (visiting.has(request.id)) return false;
    if (visited.has(request.id)) return true;
    visiting.add(request.id);
    for (const dependencyId of requestDependencies(request)) {
      if (!visit(requestsById.get(dependencyId)!)) return false;
    }
    visiting.delete(request.id);
    visited.add(request.id);
    ordered.push(request);
    return true;
  };
  for (const request of requests) {
    if (!visit(request)) {
      return failure("analysis.dependency_cycle", "analysis dependencies must not contain a cycle");
    }
  }
  return { ok: true, issues: [], requests: ordered };
}

function sameSource(
  left: CliAnalysisRequestResult["source"],
  right: ResolvedSource
): boolean {
  return (
    left.clip_id === right.clip_id &&
    left.sha256 === right.sha256 &&
    left.analysis_start_seconds === right.analysis_start_seconds &&
    left.analysis_end_seconds === right.analysis_end_seconds &&
    left.duration_seconds === right.duration_seconds
  );
}

function adapterEnvironment(adapter: AdapterDefinition, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ"
  ]);
  for (const variable of adapter.network?.credential_env ?? []) allowed.add(variable);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toUpperCase())));
}

function failure<T = Record<never, never>>(code: string, message: string, path?: string): Result<T> {
  return { ok: false, issues: [{ code, message, ...(path ? { path } : {}) }] };
}
