let input = "";
for await (const chunk of process.stdin) input += chunk;

const payload = JSON.parse(input);
const { request, source, external_input: externalInput } = payload;
const segments = externalInput?.segments ?? [];
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  request_id: request.id,
  output: "transcript",
  source: {
    clip_id: source.clip_id,
    analysis_start_seconds: source.analysis_start_seconds,
    analysis_end_seconds: source.analysis_end_seconds,
    duration_seconds: source.duration_seconds,
    sha256: source.sha256
  },
  data: {
    language: "ja",
    segments: segments.map((segment) => ({
      id: segment.id,
      source_start: segment.source_start,
      source_end: segment.source_end,
      text: segment.id === "segment-low" ? "えっと こんにちは" : segment.text,
      confidence: 0.98
    }))
  },
  metadata: {
    engine: "fixture-online-analysis",
    api_used: true,
    network_used: true,
    actual_credits: 0.25,
    input_scope: externalInput?.scope,
    received_segment_ids: segments.map((segment) => segment.id),
    source_path_received: typeof source.path === "string",
    dependency_count: Array.isArray(payload.inputs) ? payload.inputs.length : -1,
    credential_present: Boolean(process.env.TSUGITE_TEST_ANALYSIS_TOKEN),
    undeclared_secret_present: Boolean(process.env.TSUGITE_UNDECLARED_SECRET),
    credential_echo: request.params?.echo_credential ? process.env.TSUGITE_TEST_ANALYSIS_TOKEN : undefined
  }
})}\n`);
