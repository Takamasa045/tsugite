# HyperFrames media-use audio adapter constraints

- This adapter invokes the official `media-use` audio engine only after Gate 1 approval.
- It passes `--only bgm,sfx`; TTS and ElevenLabs are outside this adapter contract.
- `bgm.mode: generate` uses the HyperFrames Lyria/MusicGen path. Cloud Lyria is disabled unless `audio.params.allow_cloud_bgm: true` is explicit.
- `bgm.mode: retrieve` uses the authenticated HeyGen music catalog and never falls back to generation.
- SFX uses HeyGen retrieval when authenticated or the bundled `media-use` library offline. It is not AI-generated.
- Missing requested BGM or SFX fails closed before Gate 2 instead of silently producing a different audio plan.
- Every returned audio file must be a regular file inside the guarded run directory.
- Never forward `ELEVENLABS_API_KEY`; do not fall back to ElevenLabs automatically.
