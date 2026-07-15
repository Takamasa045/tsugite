let input = "";
for await (const chunk of process.stdin) input += chunk;

const payload = JSON.parse(input);
const transcript = payload.inputs?.find((entry) => entry.output === "transcript");
const segment = transcript?.data?.segments?.[0];
const { request, source, external_input: externalInput } = payload;
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  request_id: request.id,
  output: "subtitle_track",
  source: {
    clip_id: source.clip_id,
    analysis_start_seconds: source.analysis_start_seconds,
    analysis_end_seconds: source.analysis_end_seconds,
    duration_seconds: source.duration_seconds,
    sha256: source.sha256
  },
  data: {
    source_language: transcript?.data?.language ?? "ja",
    target_language: "en",
    captions: segment ? [{
      id: "subtitle-cloud",
      source_segment_id: segment.id,
      source_start: segment.source_start,
      source_end: segment.source_end,
      text: "Hello"
    }] : []
  },
  metadata: {
    engine: "fixture-cloud-translation",
    api_used: true,
    network_used: true,
    actual_credits: 0.5,
    input_scope: externalInput?.scope,
    source_path_received: typeof source.path === "string",
    dependency_count: payload.inputs?.length ?? 0,
    credential_present: Boolean(process.env.TSUGITE_TEST_ANALYSIS_TOKEN)
  }
})}\n`);
