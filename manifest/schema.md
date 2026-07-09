# Manifest Schema

The manifest is the single editing contract between generation adapters and editing backends.

Minimum JSON fields:

- `meta.aspect`: `16:9` or `9:16`
- `meta.fps`: positive number
- `meta.target_duration_seconds`: positive number
- `meta.slug`: stable project slug
- `clips[]`: `id`, local `src`, `in`, `out`, `duration`, `fps`, `resolution`, `audio`
- `audio`: `bgm`, `narration`, `sfx` track arrays
- `captions[]`: optional timed text. `speaker` is reserved for speaker labels.
- `chapters[]`: optional chapter ranges with `title`, `start`, and `end`
- `provenance[]`: optional source metadata

Unknown fields are accepted to preserve legacy RenderManifest compatibility.
