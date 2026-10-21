# elevenlabs source

Labs. Implements the documented timestamped text-to-speech protocol with
synthetic HTTP tests; no live paid acceptance is claimed. Allowed speech models
are `eleven_multilingual_v2` (default), `eleven_turbo_v2_5`, `eleven_flash_v2_5`
and `eleven_v3`. Optional official `voice_settings` (`stability`,
`similarity_boost`, `style`, `speed` 0.7–1.2, `use_speaker_boost`), `language_code` and
`apply_text_normalization` are forwarded when set. `options.mode: music` uses
`/v1/music` with `music_v2_5` (or `music_v2` / `music_v1`), 3–600s
`music_length_ms`, optional `force_instrumental`, and a 4100-character prompt
cap. Music and SFX wait up to `60s + 2s` per requested second (20-minute cap).
`options.mode: sfx` uses
`/v1/sound-generation` with `eleven_text_to_sound_v2`, 0.5–30s,
`prompt_influence` 0–1 and optional `loop`. Music/SFX reject `voice_id` and
speech settings; composition plans stay unimplemented. Hosted-MCP Eleven v4 / Turbo
from v1 is not this HTTP transport. Offline mode blocks the network entry.
Explicit mock mode produces synthetic zero-credit media and validates the same
request/payload contract as planning, including an explicit `voice_id`. Live
quotes require an explicit positive `max_credits`; they do not invent a charge
from character count, duration, or the published music/SFX rate tables (those
tables disagree on credits vs USD). Live mode requires an explicitly enabled private
connection, a service budget, and a page-approved plan. Keys are read lazily
from the chosen environment reference, never written to the project.
Credentials never belong in source options. The synchronous endpoint has no
durable task id; a `credits: null` receipt keeps the reservation and still
marks received audio as done. Temporary conversion files are removed.

Unknown failures/credits hold the reservation; do not infer refunds or automatically repeat submission. Inspect the source package and the connection guide before enabling live mode. A local reservation is not a vendor-enforced remote billing cap.

See the core distribution's docs/connections.md for the dated official references and supported subset. The standalone transport uses no external dependency and accepts an explicitly supplied fetch function, API origin, credentials and trusted download origins.
