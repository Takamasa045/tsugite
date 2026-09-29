# ElevenLabs Eleven v4 adapter

- Generation only: `operation: voice`, `model: eleven_v4` or `eleven_v4_turbo`, one `prompt` of at most 2,000 characters, and `params.voice_id`.
- The output is a single MP3 narration asset inside the current run directory. No references, other models, extra parameters, or automatic fallback.
- `models` validates the local request contract only. It does not validate entitlement, the voice ID, credits, or pricing.
- The first external submission is the Gate 1 approved Coordinator run. The adapter uses the hosted ElevenLabs MCP endpoint and a scoped OAuth bearer token supplied in `ELEVENLABS_MCP_ACCESS_TOKEN`; it does not use the ElevenLabs API key or log credentials or provider error bodies.
- The adapter discovers a speech tool with `text`, `voice_id`, and `model_id` inputs before calling it. If the hosted MCP schema excludes the requested model, it fails without generation. Eleven v4 Turbo is documented by ElevenLabs for the Text to Dialogue WebSocket; hosted MCP support remains unverified.
- A failed or uncertain MCP tool call is not retried automatically because ElevenLabs may already have billed it. Tsugite reports provider credits as unmeasured; zero in the numeric field does not mean free.
