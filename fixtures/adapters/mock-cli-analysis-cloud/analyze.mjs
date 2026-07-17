let input = "";
for await (const chunk of process.stdin) input += chunk;

const payload = JSON.parse(input);
const { request, source, external_input: externalInput } = payload;
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  request_id: request.id,
  output: "summary",
  source: {
    clip_id: source.clip_id,
    analysis_start_seconds: source.analysis_start_seconds,
    analysis_end_seconds: source.analysis_end_seconds,
    duration_seconds: source.duration_seconds,
    sha256: source.sha256
  },
  data: {
    language: "ja",
    summaries: [{ id: "summary-cloud", source_start: 0.1, source_end: 0.9, text: "クラウド要約" }]
  },
  metadata: {
    engine: "fixture-cloud-analysis",
    api_used: true,
    network_used: true,
    actual_credits: 0.5,
    input_scope: externalInput?.scope,
    source_path_received: typeof source.path === "string",
    credential_present: Boolean(process.env.TSUGITE_TEST_ANALYSIS_TOKEN)
  }
})}\n`);
