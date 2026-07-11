# Audio slots

Optional. Keep empty arrays in `video.json` for a silent draft.

- Put one narration file per caption segment when ready.
- Wire paths into `video.json` → `audio.narration[]` with `start` / `end` matching captions.
- After audio is added, set `presentation.draft` to `false` only when the mix is intentional.
