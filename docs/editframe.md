# Editframe local backend

Optional **macOS-only** local render backend and preview entry. Process ownership, local Vite/Chrome render, and the preview CLI are supported on macOS (`darwin`) only. Other hosts reject owned-process APIs instead of pretending to clean up. It is not a cloud renderer, not WebMCP, and not a Gate substitute.

## Install

From the repository root, after a normal `npm ci`:

```sh
npm run editframe:install
```

This runs `npm ci --prefix backends/editframe/runtime` and pins `@editframe/cli@0.60.11`, `@editframe/elements@0.60.11`, `@editframe/vite-plugin@0.60.11`, and `vite@8.3.1`, with a narrow `werift@0.24.4` override. Unscoped `editframe@1.0.0` is a different package and is not the CLI.

Doctor and render do not install packages, download Playwright browsers, or fetch a bundled FFmpeg. The proven media path is static files under `public/media`. Native node-av / JIT transcode / WebRTC remain unverified and unused.

## Project

Set `edit.backend: editframe` in `project.yaml`. **Fast Edit v1** additionally supports both aspects, 18 cards, timed word emphasis, text effects, transitions, zoom, progress, global style/color/pacing and source + extra audio + synthesized SFX. See [Fast Edit](fast-edit.md) for the common contract and verification. The historical mode remains sequential **16:9 / 30fps** local clips, embedded clip audio, and manifest captions as timed `ef-text`. Unsupported: `9:16`, fps other than 30, transitions, presentation presets, extra BGM/narration/SFX tracks, `images`, `clip.motion`, `caption.visual`, `caption.pose`.

## Preview

After a successful local render, read the composition directory from that run's `render-report.json`:

```sh
# composition_dir is a fresh editframe-renders/<id> under the run, not a reused editframe-composition folder
node -e 'console.log(JSON.parse(require("fs").readFileSync("<run-dir>/render-report.json","utf8")).composition_dir)'
npm run editframe:preview -- <composition-dir>
```

The preview CLI writes a sibling authoring copy and serves the composition HTML (`ef-timegroup` document) on `127.0.0.1`. It does not rewrite the production run. Human play controls, GUI, Browser Export, WebMCP, and disk-save APIs are unverified. Browser Export is not a Gate.

## Wrapper

```sh
npm run editframe -- --version
npm run editframe -- render --help
```

Allowed: version/help/preview/render. Cloud subcommands are rejected. Child processes get `EF_NO_TELEMETRY=1` and do not inherit `EF_TOKEN` / `EF_HOST` / `EF_RENDER_HOST`.
