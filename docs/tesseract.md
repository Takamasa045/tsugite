# Tesseract local render backend

Tesseract is an optional `edit.backend: tesseract` renderer. Tsugite creates a native editable `.tsrct` project, asks the local Tesseract CLI to export a video, and checks the resulting stream metadata. The CLI is maintained and licensed by Mirage; it is not included in this repository.

## Review terms before setup

Review the [current Tesseract terms](https://mirage.app/legal/tesseract-terms) and the `TERMS.md` included in the exact CLI release bundle before installing or using it. The CLI is distributed by Mirage under its own terms; Tsugite cannot determine whether a particular professional, commercial, or product-development use is permitted.

## Pinned CLI and host support

Tsugite pins Tesseract CLI **0.2.0**. The [official release](https://github.com/mirage-hq/Tesseract/releases/tag/v0.2.0) adds Linux support, export options including 4K and 60 fps, improved font support, and CLI usage telemetry. The source tree is pinned to 0.2.0, but this development host still has the older 0.1.0 binary; native 0.2.0 behavior described below is wired and mock-tested, not yet verified by a real 0.2.0 render.

The official CLI supports Apple Silicon and Intel macOS, 64-bit Windows 10 or later, and Linux x86_64 with glibc 2.35 or later. Linux also requires Python 3, Bash, coreutils, and unzip for installation; at runtime it needs zlib, ALSA, libstdc++, a Vulkan loader, and a compatible Vulkan driver. Mesa lavapipe is a software-rendering option for headless systems. Other operating systems, architectures, and Linux libc implementations are unsupported.

The standard generated-layer route accepts 16:9 or 9:16 projects at 30 fps, with source clips matching 1920×1080 or 1080×1920 exactly. An optional full `native_edit.payload.document` route supports these six Tsugite canvas presets: 16:9 (1920×1080), 9:16 (1080×1920), 1:1 (1080×1080), 4:5 (1080×1350), 3:4 (810×1080), and 5:4 (1350×1080); it accepts 24, 30, or 60 fps. A native document may select `720p`, `1080p`, or `4k` MP4 export. These settings scale each canvas edge by 2/3, 1, or 2 respectively (for example, square 4K is 2160×2160 and 4:5 4K is 2160×2700); canvas dimensions and encoded output dimensions are checked separately. With no explicit native resolution, export defaults to 1080p. Optional `native_edit.payload.export.fps` must equal `meta.fps`. The renderer verifies output dimensions, frame rate, and duration.

The Linux CLI bundle does not include an H.264 encoder. Install FFmpeg with libx264 and AAC, then set `edit.backend_options.tesseract.ffmpeg_path` to its absolute executable path. Tsugite checks that it is an executable regular file and passes `--encoder-backend external-ffmpeg-command --ffmpeg-path <absolute-path>` to the official CLI; the same binary is used for source decoding. Symlink paths and non-Linux use of this option are rejected. This is required for Linux MP4 output.

## Install the pinned CLI

After reviewing the release terms, run this explicit command from the Tsugite repository root:

```sh
npm run tesseract:install
```

The command downloads the exact 0.2.0 ZIP and `.sha256` sidecar for the detected host from the public GitHub release, verifies the archive hash, extracts into a temporary directory, and invokes the matching upstream `install.sh` or `install.ps1`. It then runs `tsrct --version` and requires the exact 0.2.0 pin. The temporary download and extracted files are removed afterward. A download or hash failure stops before extraction and installation.

This is an opt-in command. `npm ci`, `doctor`, and `render` do not install Tesseract. The Tsugite setup wrapper adds no credentials or cloud setup and forwards only the small set of system environment variables needed by the official installer. It sends no project files or media. The upstream installer is run unchanged.

## CLI usage telemetry

The 0.2.0 CLI enables usage telemetry by default. Only `project.create`, `export`, `preview`, and `filmstrip` emit events; installation and other commands are not tracked. Events include the command, CLI version, operating system, architecture, random event/run/installation IDs, and completion status and duration. The CLI does not send prompts, project contents, filenames, paths, raw arguments, or error text. See the [versioned upstream telemetry guide](https://raw.githubusercontent.com/mirage-hq/Tesseract/v0.2.0/skills/tesseract-video/references/telemetry.md).

To opt out, run `tsrct telemetry disable` with the installed CLI before rendering. Check the saved choice with `tsrct telemetry status`; the preference persists. Tsugite does not enable or disable telemetry on your behalf. On Linux, the CLI stores settings under `$XDG_CONFIG_HOME/tesseract/telemetry`, or `~/.config/tesseract/telemetry` if `XDG_CONFIG_HOME` is absent or not absolute. Tsugite preserves `XDG_CONFIG_HOME` when it launches the Linux CLI so this saved opt-out continues to apply. On macOS and Windows the CLI uses the release's documented per-user settings locations.

## Doctor and installed command

Doctor checks the same version probe used by the backend:

```sh
node backends/tesseract/cli.mjs --version
```

The resolver checks the documented per-user install location first, then the executable on `PATH`. It rejects unsupported hosts, a missing command, and any CLI version other than 0.2.0. A missing CLI reports `npm run tesseract:install` as remediation; it never installs automatically.

Official install locations are:

- macOS: `~/Library/Application Support/Tesseract/bin/tsrct`
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/Tesseract/bin/tsrct`
- Windows: `%LOCALAPPDATA%\Tesseract\bin\tsrct.cmd`

## Local GPU access on macOS

Tesseract export needs a compatible local GPU adapter. In an isolated macOS fixture, the Tsugite Tesseract backend rendered one video clip successfully with host GPU access. A separate sandboxed CLI export attempt failed during adapter discovery because it could not access the host GPU/Metal adapter. If export fails during adapter discovery, check that the local execution environment can access the Mac's GPU/Metal device.

## Supported project scope

Set `edit.backend: tesseract` in `project.yaml`. Current support is intentionally limited to:

- Local MP4, MOV, or M4V clip sources, trimmed and placed sequentially; embedded clip audio can be enabled or disabled.
- Local BGM, narration, and SFX tracks. Each track is cut from its source beginning and placed at its manifest `start` time; real-render verification currently covers one added audio track.
- Title and caption overlays using an imported, catalog-supported font with glyphs for the text. Tsugite backend renders have been visually verified with Inter / Regular for English and Noto Sans JP Thin / Regular for Japanese.
- Standard generated layers: 16:9 or 9:16 at 30 fps. One 640×360 fixture exported as 640×360, so this route requires source clips to match the requested composition dimensions exactly: 1920×1080 for 16:9 or 1080×1920 for 9:16. It rejects mismatches before launching the CLI. The export's encoded frame rate and dimensions are also checked after rendering.
- `clips[].motion.transition_to_next`: `fade`, `slide-left`, `slide-right`, `zoom-in`, and `zoom-out`. The outgoing trimmed frame is held for the cue duration while the next clip enters at its approved timeline boundary. Slides move the incoming frame from the right/left edge into center; zoom starts at 80%/120% and settles at 100% around the frame center. Clip duration and source range remain unchanged.
- Clip entrance/exit `fade`, `zoom-in`, and `zoom-out`, plus clip emphasis `pulse`. Caption entrance/exit `fade`, `slide-left`, `slide-right`, `rise`, `zoom-in`, and `zoom-out`, plus caption emphasis `pulse`. These cues animate the whole video frame or the text layer, as selected by the typed manifest cue. Easing is linear; overlapping cues that would replace the same native property are rejected.
- Typed audio-reactive `pulse`, `shake`, and `flicker` cues on clips or captions. Tsugite reads a local audio track, computes short-window PCM RMS, and writes deterministic, editable keyframes into the `.tsrct`. This is an offline render-time analysis, not a live waveform binding. Re-run the render after changing the source audio. Windows must be 20–2000 ms, strength 0–1, analysis is limited to 120 seconds and 240 keyframes, shake is capped at 24 px, and flicker opacity never drops below 20%. Silent windows return to their neutral transform/opacity.

## Native authoring in the Tsugite workflow

Use this route when the edit needs the full native Tesseract action/document surface. Put the complete runtime-shaped document, action list, and optional export settings in `native_edit.payload`, based on the installed runtime schemas before Gate 1. Set `native_edit.mode: replace` when a full document defines the complete exported timeline; it may produce a composition with no video clip. In that mode, `manifest.clips` may remain as source assets and storyboard context, but do not create extra native layers. The backend rejects manifest captions, audio tracks, clip motion, and a manifest title in this mode; author captions and audio inside the native document and declare their local media in `native_edit.assets`. Images and additional native media also require a full document that references them. Standalone actions can modify existing native layers, but do not import sources or create media layers. The Gate 1 page shows the payload digest and size, declared resource names, generated bindings, and detected code-input hashes/previews. Gate 1 approval binds the complete native manifest and SHA-256 fingerprints of all declared local source assets and fonts; changing either after approval changes the approval digest.

`native_edit.mode: extend` is the default action-only route: it keeps the generated manifest composition and applies `native_edit.payload.actions` to that composition using the installed runtime's supported standalone action schema. Use it for supported layer, FX, text/shape, grouping, or animation actions. It cannot include `payload.document`; canvas or full composition changes require a complete schema-shaped document with `mode: replace`. Actions do not import media or create media layers. Declare assets or fonts only when a full document or a supported action references them. Native export controls and ProRes sidecars require the full-document `replace` route.

After Gate 1, Tsugite copies declared local media and fonts into the run, rewrites them to run-relative paths, resolves generated-asset binding tokens, and Gate 2 QC fingerprints/probes declared media. The explicitly authorized renderer imports the staged assets and fonts, commits the complete document, applies the approved actions, then writes and PNG-validates `preview.png` and `filmstrip.png` before exporting `final.mp4` from the same staged project. Optional ProRes MOV sidecars are exported from that same project. Inspect the MP4, preview, filmstrip, and any declared MOVs together in Gate 3. The images are diagnostic artifacts, not approvals; each MOV is fingerprinted and checked against its Gate 1 declaration. `final.mp4` remains the canonical video. Native authoring keeps the existing Gate 1, Gate 2, and Gate 3 decisions.

Use the installed pinned CLI before Gate 1 to discover the exact schemas for that runtime and to start from a valid project document:

```sh
tsrct project schema --document > /tmp/tesseract-document-schema.json
tsrct project schema > /tmp/tesseract-action-schema.json
tsrct project create --project /tmp/tesseract-authoring.tsrct
tsrct project import-asset --project /tmp/tesseract-authoring.tsrct --file /path/to/approved/scene.webp --asset-id scene_still --kind image
tsrct project import-font --project /tmp/tesseract-authoring.tsrct --file /path/to/approved/Inter-Regular.ttf
tsrct project checkout --project /tmp/tesseract-authoring.tsrct --output /tmp/tesseract-authoring.json
```

Build the complete document from the checked-out project and installed document schema, preserving required fields and the composition. Store the complete object under `native_edit.payload.document`, not as a partial diff. Every full native document also requires `native_edit.primary_output`, with dimensions, fps, and exact audio-stream expectation matching the document and export settings; set these before Gate 1. Example manifest fragment:

```jsonc
{
  "native_edit": {
    "mode": "replace",
    "primary_output": { "width": 1920, "height": 1080, "fps": 30, "audio_required": false },
    "assets": [
      { "asset_id": "scene_still", "src": "assets/scene.webp", "kind": "image" }
    ],
    "payload": {
      "document": { "/* complete document object from the installed CLI schema */": "..." },
      "actions": [
        { "/* complete action object copied from its installed schema definition */": "..." }
      ]
    }
  }
}
```

The `document` and `actions` placeholders above mark where the complete schema-shaped objects go; they are not valid Tesseract objects. There is no static document example that is guaranteed across CLI releases: obtain the installed version's required fields and default IDs with `project create`, then `project checkout`, and preserve that complete structure. For a generated result that does not exist before Gate 1, put an asset binding token in the document's schema-defined asset-ID field, for example `tsugite:request:opening:image:1` (the exact request ID, media kind, and one-based result index matter). After successful generation, Tsugite replaces that token with the corresponding generated asset ID before Gate 2 review. Generated audio follows the same contract: declare an audio-producing `generation.requests` entry and put a token such as `tsugite:request:voiceover:audio:1` in the document's schema-defined audio `source.assetId`; assembly preserves the resolved ID in `native_edit.assets` and does not add a second `manifest.audio` track. `project.audio` is unsupported for a full native replacement document because it has no explicit native-layer binding; Tsugite stops before invoking either generation or audio adapters. For local media, `src` is relative to the manifest directory; assembly copies the file into the run and rewrites it to a run-relative path. Use `manifest.clips` only for source video inputs in replace mode; declare additional native media in `native_edit.assets` and fonts in `native_edit.fonts`, then reference each imported asset ID from the document. Manifest `audio` and `captions` are rejected in replace mode: put the media declaration in `native_edit.assets` and build audio/caption layers in the full document. Native action `type` values must appear in the installed `tsrct project schema` discriminator; the official CLI validates the complete action payload when it applies actions. Tsugite checks document required fields, duration, and canvas in the backend before commit. The renderer writes and validates the Tesseract preview and filmstrip before exporting MP4; inspect these diagnostic images with the final video during Gate 3. They are not Gate 1 approvals.

Native font files are declared separately from imported media because a text layer refers to a Tesseract family/style pair:

```json
{
  "native_edit": {
    "mode": "replace",
    "primary_output": { "width": 1920, "height": 1080, "fps": 30, "audio_required": false },
    "fonts": [
      { "src": "assets/fonts/Inter-Regular.ttf", "family": "Inter", "style": "Regular" },
      { "src": "assets/fonts/Inter-Bold.otf", "family": "Inter", "style": "Bold" }
    ],
    "payload": { "document": { "...": "copy the full object from project checkout and edit schema-defined fields" } }
  }
}
```

The fragment shows the font declaration shape; replace the document placeholder with the complete checked-out document. Each local font is copied into the run and included in Gate 1 fingerprints. `family` and `style` are optional but must be provided together; the imported face must match the Text layer. TTF, OTF, and TTC are accepted, up to 64 files. The CLI checks for missing fonts on commit. The single `edit.backend_options.tesseract.font_path` option is reserved for Tsugite-generated text overlays and cannot stand in for these document fonts.


### ProRes MOV and alpha-solo sidecars

Tesseract 0.2.0's optional `--format prores` output is available on macOS. Set `payload.export.prores_sidecar: true` for a full-composition MOV. Set `payload.export.prores_alpha_solo: "main:3"` for a selected composition/layer alpha-solo MOV; this selector must identify an existing native layer. These options can be used together. They require a full `native_edit.payload.document` and do not replace the canonical `final.mp4`.

Every requested MOV must have exactly one Gate 1-bound `native_edit.outputs` entry with the fixed kind/path pair and its expected duration, dimensions, fps, video codec, alpha, and audio values:

```jsonc
{
  "native_edit": {
    "mode": "replace",
    "payload": {
      "document": { "/* full document copied from the installed CLI schema */": "..." },
      "export": {
        "resolution": "4k",
        "fps": 60,
        "prores_sidecar": true,
        "prores_alpha_solo": "main:3"
      }
    },
    "primary_output": { "width": 3840, "height": 2160, "fps": 60, "audio_required": true },
    "outputs": [
      {
        "kind": "prores_mov", "path": "final-prores.mov", "duration_seconds": 10,
        "width": 3840, "height": 2160, "fps": 60, "video_codec": "prores",
        "alpha_required": false, "audio_required": true
      },
      {
        "kind": "alpha_solo_prores_mov", "path": "final-prores-alpha.mov", "duration_seconds": 4.25,
        "width": 3840, "height": 2160, "fps": 60, "video_codec": "prores",
        "alpha_required": true, "audio_required": false
      }
    ]
  }
}
```

The document placeholder above is not a valid native document. Declare the full-composition MOV duration equal to `meta.target_duration_seconds`. Alpha-solo export can use the selected layer's active window and be shorter; enter its expected duration from the authored document instead of estimating it from the project duration. `primary_output.audio_required` is an exact stream expectation: `true` requires an audio stream and `false` requires none. The backend checks the exported files against their Gate 1 declarations, including ProRes codec, alpha-capable pixel format when requested, audio presence or absence, and duration within one frame plus 30 ms. Gate 3 independently probes and fingerprints each declared MOV and binds the sorted set to approval. Changing a MOV after approval invalidates Gate 3. The render report lists sidecars by kind and run-relative path; Gate 3 QC records their hashes and probe results.

The renderer wiring and mocked export path are tested, but real ProRes and alpha-solo output have not yet been verified with an installed Tesseract 0.2.0 CLI. Treat the result as mock-tested until a real 0.2.0 export is checked on macOS.

Fast Edit is unsupported. The backend rejects top-level `manifest.transitions` (use reviewed `clips[].motion.transition_to_next` cues), speaker artwork, chapter cards, and styled caption speaker/pose/emphasis fields. Image files are not turned into composition layers by the generated-layer route; add them through `native_edit.assets` and reference them from a full schema-based native document. The backend also rejects unsupported motion presets such as `wipe`, `pan-left`, `pan-right`, and `parallax`, and rejects a descriptive-only `presentation.motion_design` summary without executable cues. These listed unsupported elements fail closed rather than being silently dropped or converted.

Text overlays require a font family/style accepted by Tesseract's font catalog, an imported font resource, and glyph coverage for the actual text. Importing a local font that returned `Monaco` / `Regular` did not make that value valid for `createFxTextLayer`; the official CLI rejected `source_text.font_family` as unsupported. The Tsugite backend has rendered English title/caption text with an imported Google Fonts OFL Inter TTF using `Inter` / `Regular`, and Japanese title/caption text with Google Fonts OFL `NotoSansJP[wght].ttf`. For that variable font, `project import-font` returns `Noto Sans JP Thin` / `Regular`; the adapter uses this returned face when no family/style override is configured. Explicit `font_family` and `font_style` settings must match the imported metadata. Inter lacks Japanese glyphs, so it renders tofu for Japanese. Configure `edit.backend_options.tesseract.font_path` with the local font file and use a catalog-supported face whose glyphs cover all text; importing an arbitrary local font does not make its family catalog-supported.

## Verification status

The repository tests use fake CLI executables and a fake release archive. They cover host and version selection, argument passing, checksum failure, the explicit installer boundary, native document/action and font imports, asset-ID bindings, export options, and preview/filmstrip publication. Mock tests do not establish that a particular installed runtime accepts a schema or can render it.

Real render verification used the official CLI 0.1.0 and host GPU access:

- A clip-only Tsugite backend render produced `final.tsrct`, `final.mp4`, and `render-report.json`. QA confirmed the native Video layer, asset ID, and `sourceRange`; ffprobe reported H.264 at 1080×1920, 30 fps, 30 frames, and 1 second, and full decode passed.
- A combined fixture with an English title, English caption, and 440 Hz added audio track passed full decode. The 1-second MP4 was H.264 1080×1920/30 fps with AAC 48 kHz stereo. Visual QA confirmed the text was clear. Native inspection confirmed Text layer ids 3 and 4 using Inter / Regular over 0–1000 ms, Audio layer id 2 at volume 0.5 with matching source range, and report track count 1. The tone measured mean -27.1 dB and peak -23.9 dB, consistent with the configured 0.5 gain.
- A Japanese title/caption fixture with added BGM produced `final.tsrct` (97,091 bytes), `final.mp4` (51,372 bytes), and `render-report.json` (888 bytes). The 1-second MP4 was H.264 1080×1920/30 fps with AAC 48 kHz stereo; full decode passed. Visual QA confirmed `日本語` and `Noto Sans JP 字幕確認` were legible without tofu. Native inspection confirmed both Text layers used the imported face returned as Noto Sans JP Thin / Regular over 0–1000 ms and Audio layer id 2 at volume 0.5.

- An isolated two-clip 16:9 backend render exercised a trimmed 3-second moving source, `slide-left` transition, incoming zoom, Japanese captions, and added audio. The native project preserved red sourceRange 500–1500 ms and added an outgoing `hold` remap at source time 1499 ms through the 1500 ms transition end. H.264 output was 1920×1080/30 fps, 60 frames/2 seconds; AAC audio was present and full decode passed. The input's frame 15 and frame 44 hashes differed, confirming that the source moves. During the slide, the same unobscured 200×1080 red region at 1.1 s and 1.4 s had SSIM 1.000000, confirming that the trimmed final image remained held. Native inspection showed center-anchored video layers and the report recorded all applied cues.

- Separate isolated adapter renders verified `fade`, `slide-right`, `zoom-in`, and `zoom-out` transitions. Each produced a 1920×1080 H.264, 30 fps, 60-frame, 2-second MP4; ffprobe and full decode passed. Representative transition-mid frames showed the opacity dissolve, the slide entering from the left, and the zoom variants scaling around the frame center.

- Offline audio-envelope verification exercised clip shake and Japanese caption flicker/pulse in one backend render. Native inspection showed clip position returning to the center baseline, caption opacity returning to 100%, and caption scale returning to 100% at cue ends. The output was H.264 1920×1080/30 fps, 60 frames/2 seconds with AAC 48 kHz stereo; full decode and visual QA passed. These are baked editable keyframes; they do not update automatically if the source audio changes.

- A Japanese caption entrance `zoom-in` rendered through the adapter as a 1920×1080 H.264, 30 fps, 30-frame, 1-second MP4. Frames at 0.1 s and 0.5 s show the text enlarging while keeping its center fixed; native inspection confirmed the compensated center anchor `[806.5, 65]` at position `[960.5, 929]`. Full decode passed.

Inter produces tofu for Japanese because it lacks Japanese glyphs. An imported `Monaco` / `Regular` face was rejected with `source_text.font_family is not supported; choose a font from the font catalog`. Export in a sandbox without GPU adapter access failed during adapter discovery.
