# HyperFrames backend constraints

- Run `npx --no-install hyperframes lint --json` before rendering.
- The runner must probe HyperFrames with `npx --no-install` so it never auto-installs packages during preflight.
- Every timed video, audio, and caption element uses `class="clip"` with explicit `data-start`, `data-duration`, and `data-track-index` attributes.
- Video clips are always muted. When a manifest clip has audio, the runner emits a separate audio element with the same timing and `data-media-start` trim offset.
- Captions use `class="clip caption"` and preserve manifest start/end timing.
- Generated projects contain a local static GSAP-compatible timeline runtime. They must not load scripts, media, or other assets from an external URL.
- When HyperFrames is unavailable, return a structured `hyperframes.dependency_missing` result and exit with code 30.
- Optional Studio WebMCP editing uses the pinned local CLI through `npm run hyperframes:studio -- <composition-dir>`; see [connection and verification](../../docs/hyperframes-studio-webmcp.md). It is a page-scoped editing surface, not hosted cloud MCP or a Gate approval mechanism.
- Studio source edits do not update the Tsugite manifest. `render.mjs` regenerates `index.html` and the local timeline from that manifest; use a separate authoring copy and reconcile approved changes into the pipeline source before rendering again.
