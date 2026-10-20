# Google Gemini TTS direct connection

- This adapter calls the Gemini API Interactions endpoint only. It accepts `operation: voice` with `model: gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts` and returns one WAV narration asset.
- Single speaker: set `prompt` to the exact spoken text and `params.voice_id` to a prebuilt voice name. Optional `params.style` supplies one short delivery direction.
- Two speakers: set `params.speakers` to two `{speaker, voice}` entries with prebuilt voice names. Write `prompt` as one `Speaker: spoken text` line per turn. Optional `params.turn_styles` is an array aligned to the turns. No automatic script rewriting occurs.
- The request is submitted once. An uncertain or failed response is never retried automatically, because a retry may incur another charge.
- The adapter uses `GEMINI_API_KEY` from the process environment, a fixed Google HTTPS endpoint, `store: false`, a bounded response, and a timeout. It does not log the key, request text, or provider response. The generated WAV stays inside the run directory.
- `credits: 0` means Tsugite credit units are unavailable for the Gemini API. It does **not** mean free generation; Google billing must be reviewed separately before Gate 1 approval.
- Audio references passed to PixVerse are separate generation requests under the PixVerse connection and its own approval and billing path. Audio reference is conditioning, not proof of exact transcript or lip sync. Keep the approved WAV as the final audio track when exact words matter.
