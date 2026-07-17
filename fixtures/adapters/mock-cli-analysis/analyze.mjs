let input = "";
for await (const chunk of process.stdin) input += chunk;

const payload = JSON.parse(input);
const request = payload.request ?? {};
const source = payload.source ?? {};
const inputs = payload.inputs ?? [];
const dataByOutput = {
  captions: {
    captions: [
      { id: "caption-001", source_start: 0.1, source_end: 0.9, text: "こんにちは" }
    ]
  },
  chapters: {
    chapters: [
      { id: "chapter-001", source_start: 0.1, source_end: 0.9, title: "導入" }
    ]
  },
  cut_points: {
    cut_points: [
      {
        id: "silence-001",
        kind: "silence",
        source_start: 0.25,
        source_end: 0.75,
        action: "review",
        confidence: 1
      }
    ]
  },
  transcript: {
    language: "ja",
    segments: [
      {
        id: "segment-001",
        source_start: 0.1,
        source_end: 0.9,
        text: "えっと こんにちは",
        words: [
          { text: "えっと", source_start: 0.1, source_end: 0.3 },
          { text: "こんにちは", source_start: 0.35, source_end: 0.9 }
        ]
      }
    ]
  },
  summary: {
    language: "ja",
    summaries: [
      {
        id: "summary-001",
        source_start: 0.1,
        source_end: 0.9,
        text: "あいさつ"
      }
    ]
  },
  subtitle_track: {
    source_language: "ja",
    target_language: "en",
    captions: [
      {
        id: "subtitle-001",
        source_segment_id: "segment-001",
        source_start: 0.1,
        source_end: 0.9,
        text: "Hello"
      }
    ]
  }
};
const base = {
  schema_version: 1,
  request_id: request.id,
  output: request.output,
  source: {
    clip_id: source.clip_id,
    analysis_start_seconds: source.analysis_start_seconds,
    analysis_end_seconds: source.analysis_end_seconds,
    duration_seconds: source.duration_seconds,
    sha256: source.sha256
  },
  data: dataByOutput[request.output] ?? {},
  metadata: {
    engine: "fixture-local-analysis",
    api_used: false,
    network_used: false,
    received_test_secret: process.env.TSUGITE_TEST_SECRET ?? null,
    input_request_ids: inputs.map((input) => input.request_id)
  }
};
const override = request.params?.output_override;
const output = override
  ? {
      ...base,
      ...override,
      source: { ...base.source, ...(override.source ?? {}), sha256: source.sha256 },
      data: { ...base.data, ...(override.data ?? {}) },
      metadata: { ...base.metadata, ...(override.metadata ?? {}) }
    }
  : base;

process.stdout.write(`${JSON.stringify(output)}\n`);
