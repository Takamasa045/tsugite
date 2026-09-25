# Editframe backend constraints

- Opt-in runtime only: `npm run editframe:install` (`npm ci --prefix backends/editframe/runtime`). Doctor and render must not run `npm install`, `npx`, or download FFmpeg/Playwright browsers.
- Wrapper: `node backends/editframe/cli.mjs`. Allowed tokens are `--version` / `-V` / `-h` / `--help`, `preview`, and `render`. Cloud commands (`auth`, `sync`, `cloud-render`, `transcribe`, `webhook`, `process`) are rejected.
- Pin `@editframe/cli@0.60.11`, `@editframe/elements@0.60.11`, `@editframe/vite-plugin@0.60.11`, `vite@8.3.1`, with a narrow `werift@0.24.4` override. Unscoped `editframe` is not the CLI.
- Child env always sets `EF_NO_TELEMETRY=1` and drops `EF_TOKEN`, `EF_HOST`, and `EF_RENDER_HOST`.
- Local media is copied to a fresh `editframe-renders/<id>/public/media` directory and referenced as `/media/<generated-name>`. Do not emit `src="assets/..."`. Verify HTML `text/html` and media `video/*` from the owned 127.0.0.1 listener before `editframe render --url`.
- Captions are plain timed `ef-text` from the manifest. whisper and `ef-captions` JSON are not required.
- Outside Fast Edit, unsupported rendering-affecting fields fail closed: `9:16`, fps other than 30, transitions, presentation presets, extra audio tracks, `images`, `clip.motion`, `caption.visual`, `caption.pose`.
- Native node-av helpers, JIT `/api/v1/transcode`, and WebRTC are unverified and unused on this static path.
- Preview writes an authoring copy and never rewrites the production run. Browser Export is not a Gate. WebMCP and disk-save APIs are unverified.
- Process ownership, local Vite/Chrome render, and preview CLI cleanup are macOS-only. Other platforms must reject owned-process APIs rather than expose an untested cleanup path.
- Stop only the owned Vite/Chrome/CLI process group. Do not kill by process name.

- Fast Edit v1 uses the common intent schema, clone-aware `ef-timegroup.onFrame`, local color-treated derivatives, and the shared deterministic audio mixer. Its complete capability set applies to `manifest.fast_edit`; legacy capabilities remain separate. Vertical and horizontal at 30fps are supported. No field is dropped as a fallback.
