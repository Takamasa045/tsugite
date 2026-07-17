let input = "";
for await (const chunk of process.stdin) input += chunk;

const payload = JSON.parse(input);
const { request, source } = payload;
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
    segments: [
      { id: "segment-low", source_start: 0.1, source_end: 0.4, text: "えと こんにちわ", confidence: 0.42 },
      { id: "segment-high", source_start: 0.5, source_end: 0.9, text: "本題です", confidence: 0.96 }
    ]
  },
  metadata: { engine: "fixture-confidence", api_used: false, network_used: false }
})}\n`);
