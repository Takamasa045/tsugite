# Local media analysis constraints

- This adapter is offline-only and must not use HTTP, external APIs, API keys, or automatic model downloads.
- `adapter.yaml` must keep `offline: true` and declare every supported output explicitly.
- Source media is read-only.
- FFmpeg input protocols are restricted to local `file` and `pipe`; playlists cannot fetch network media.
- Silence ranges are review candidates, not automatic deletions.
- `source_start` / `source_end` always refer to the original media timeline.
- Optional speech-to-text engines must be separate local adapters with explicit local model paths.
