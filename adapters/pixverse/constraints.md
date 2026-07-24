# PixVerse adapter constraints

- Video, transition, extend, reference, and template duration must be 3, 5, or 10 seconds. Music always uses provider auto-duration; a project duration is an editorial target and is never forwarded as `--duration-seconds`.
- Video, reference, and template aspect must be 16:9 or 9:16. Image-to-video framing follows its input image.
- If a seed is supplied, it must be between 0 and 2147483647.
- Keep generated assets local under `dist/<run-id>/` before returning success.
- Normalize transient CLI failures to the shared exit-code contract.
- Use dry-run estimates before any command that can consume credits.
- `input_mode: image-to-video` requires `params.image`; `text-to-video` rejects it so guidance and paid execution cannot diverge.
- Image-to-video omits the provider `--aspect-ratio` flag because framing is derived from the input image; project-level aspect validation remains required.
