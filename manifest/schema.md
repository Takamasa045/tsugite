# Manifest Schema

The manifest is the single editing contract between generation adapters and editing backends.

Minimum JSON fields:

- `meta.aspect`: `16:9` or `9:16`
- `meta.fps`: positive number
- `meta.target_duration_seconds`: positive number
- `meta.slug`: stable project slug
- `clips[]`: `id`, local `src`, `in`, `out`, `duration`, `fps`, `resolution`, `audio`
- `images[]`: optional first-class local image assets with `id`, `src`, and optional `alt` / `alpha_required`
- `speakers[]`: optional speaker definitions with left/right placement, accent color, pose-to-image mappings, and optional three-image `mouth_frames` ordered closed / half-open / open
- `presentation`: optional backend-neutral preset selection, source metadata, and `motion_design`
- `audio`: `bgm`, `narration`, `sfx` track arrays
- `captions[]`: optional timed text. `speaker` selects a declared speaker when a presentation is active; `pose`, `emphasis`, and `visual` carry deterministic dialogue presentation metadata. `visual.motion` may declare entrance, emphasis, exit, and next-shot transition cues.
- `chapters[]`: optional chapter ranges with `title`, `start`, and `end`
- `provenance[]`: optional source metadata

Unknown fields are accepted to preserve legacy RenderManifest compatibility.

Motion direction stays backend-neutral in the manifest. `presentation.motion_design` accepts a required `summary`, optional `pacing`, and optional `principles[]`. A shot motion block may be attached to `captions[].visual.motion` or `clips[].motion`:

```json
{
  "entrance": {
    "preset": "slide-left",
    "label": "Bring in the headline",
    "description": "Move the headline in from the left and settle it",
    "target": "headline",
    "duration_seconds": 0.45,
    "easing": "ease-out"
  },
  "implementation_notes": ["Keep the background still"]
}
```

Supported review preview presets are `none`, `fade`, `slide-left`, `slide-right`, `rise`, `zoom-in`, `zoom-out`, `pan-left`, `pan-right`, `parallax`, `pulse`, and `wipe`. The review HTML treats these as safe visual approximations. The selected editing backend remains responsible for implementing the approved motion in its own frame or timeline model.

`images[]` are copied into the guarded run directory and included in Gate 2 decode, dimension, alpha (when requested), and SHA-256 integrity checks. A selected `presentation.preset` must be declared by the editing backend capabilities before execution. Silent `article-dialogue-16x9` presentations must remain marked as drafts.

When `mouth_frames` is present, every referenced image id must exist in `images[]`. A dialogue presentation backend may cycle `closed → half-open → open → half-open` for the active speaker while leaving the listener on the closed frame.
