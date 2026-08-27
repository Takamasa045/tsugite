# PixVerse adapter constraints

- Video, transition, extend, and template duration must be 3, 5, or 10 seconds. `create reference` also accepts `duration: auto`. Music uses provider auto-duration unless `params.duration_seconds` is set; project duration is never forwarded as `--duration-seconds`.
- `create reference` may send `--task-type` (`auto` / `reference` / `edit` / `extend`) for Seedance 2.5. Video, reference, and template aspect may be `16:9`, `9:16`, or `auto`.
- Video, reference, and template aspect must be 16:9 or 9:16. Image-to-video framing follows its input image.
- If a seed is supplied, it must be between 0 and 2147483647.
- Keep generated assets local under `dist/<run-id>/` before returning success.
- Normalize transient CLI failures to the shared exit-code contract.
- Use dry-run estimates before any command that can consume credits.
- `input_mode: image-to-video` requires `first_frame` or legacy `params.image` (at least one). Prompt-only I2V with neither still fails before credits.
- `input_mode: text-to-video` rejects `params.image` so guidance and paid execution cannot diverge.
- `input_mode: transition` requires at least one image source among `input_images`, `first_frame`, `params.image`, or `reference_images`. Transition image-count rules stay in project schema / route checks.
- `input_mode: reference` requires at least one of `input_images`, `input_videos`, or `input_audios`. Audio-only prohibition and reference caps stay in `h3_execution_route`.
- Image-to-video omits the provider `--aspect-ratio` flag because framing is derived from the input image; project-level aspect validation remains required.
- H3 execution route truth lives in `constraints.yaml` → `h3_execution_route` (model, durations, qualities, aspects, reference caps, audio/image mix rules). Core does not hardcode these values.
