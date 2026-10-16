// Offline projection of the authenticated connector schemas and response envelope.
export const creativeSpeechTool = {
  name: "creative_generate_speech",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string" }, prompt: { type: "string" }, voice_id: { type: "string" },
      model_id: { type: "string", enum: ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_v3", "eleven_v4"] },
      estimate_only: { type: "boolean" }, generations_count: { type: "integer", minimum: 1, maximum: 4 }
    },
    required: ["context", "prompt", "voice_id", "model_id"]
  }
};
export const creativeStatusTool = {
  name: "creative_get_flow_run_status",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string" }, flow_id: { type: "string" },
      session_ids: { type: "array", items: { type: "string" } }
    },
    required: ["context", "flow_id", "session_ids"]
  }
};
export const pending = {
  flow_id: "fixture-flow", session_ids: ["fixture-session"], poll_after_seconds: 3,
  all_completed: false, has_failures: false
};
export function completed(request) {
  return {
    ...pending, all_completed: true,
    generations: [{
      id: "fixture-generation", status: "completed", modality: "audio", model_id: request.model,
      prompt: request.prompt,
      content_url: "https://storage.googleapis.com/xi-backend/database/workspace/fixture/content_generation/fixture-session/fixture-generation/content.mp3",
      price: { credits: 16, price_cents: 0.3168, cost_fiat_currency: "usd" }
    }],
    media: [{ generation_id: "fixture-generation", kind: "audio", voice: { voice_id: request.params.voice_id } }]
  };
}
