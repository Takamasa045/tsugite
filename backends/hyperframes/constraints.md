# HyperFrames backend constraints

- Run `npx --no-install hyperframes lint --json` before rendering.
- The runner must probe HyperFrames with `npx --no-install` so it never auto-installs packages during preflight.
- Every timed video, audio, and caption element uses `class="clip"` with explicit `data-start`, `data-duration`, and `data-track-index` attributes.
- Video clips are always muted. When a manifest clip has audio, the runner emits a separate audio element with the same timing and `data-media-start` trim offset.
- Captions use `class="clip caption"` and preserve manifest start/end timing.
- Generated projects contain a local static GSAP-compatible timeline runtime. They must not load scripts, media, or other assets from an external URL.
- When HyperFrames is unavailable, return a structured `hyperframes.dependency_missing` result and exit with code 30.
