# Tesseract local render backend

Tesseract is an optional `edit.backend: tesseract` renderer. Tsugite creates a native editable `.tsrct` project, asks the local Tesseract CLI to export a video, and checks the resulting stream metadata. The CLI is maintained and licensed by Mirage; it is not included in this repository.

## Review terms before setup

Read the [current Tesseract terms](https://mirage.app/legal/tesseract-terms) before installing or using the CLI. The terms make some professional and commercial uses subject to eligibility requirements and restrict some uses to build competing products. Confirm that your intended use is permitted. Tsugite does not assess that eligibility.

## Install the pinned CLI

Tesseract CLI **0.1.0** is the version pinned by the official Tesseract skills. The optional installer supports Apple Silicon and Intel macOS, plus 64-bit Windows 10 or later. Linux and other architectures are unsupported.

After reviewing the terms, run this explicit command from the Tsugite repository root:

```sh
npm run tesseract:install
```

The command downloads the exact 0.1.0 ZIP and `.sha256` sidecar for the detected host from the public GitHub release, verifies the archive hash, extracts into a temporary directory, and invokes the matching upstream `install.sh` or `install.ps1`. It then runs `tsrct --version` and requires the exact 0.1.0 pin. The temporary download and extracted files are removed afterward. A download or hash failure stops before extraction and installation.

This is an opt-in command. `npm ci`, `doctor`, and `render` do not install Tesseract. The Tsugite setup wrapper adds no credentials, telemetry, or cloud setup and forwards only the small set of system environment variables needed by the official installer. The wrapper sends no project files or media. The upstream installer is run unchanged.

## Doctor and installed command

Doctor checks the same version probe used by the backend:

```sh
node backends/tesseract/cli.mjs --version
```

The resolver checks the documented per-user install location first, then the executable on `PATH`. It rejects unsupported hosts, a missing command, and any CLI version other than 0.1.0. A missing CLI reports `npm run tesseract:install` as remediation; it never installs automatically.

Official install locations are:

- macOS: `~/Library/Application Support/Tesseract/bin/tsrct`
- Windows: `%LOCALAPPDATA%\Tesseract\bin\tsrct.cmd`

## Local GPU access on macOS

Tesseract export needs a compatible local GPU adapter. In an isolated macOS fixture, the Tsugite Tesseract backend rendered one video clip successfully with host GPU access. A separate sandboxed CLI export attempt failed during adapter discovery because it could not access the host GPU/Metal adapter. If export fails during adapter discovery, check that the local execution environment can access the Mac's GPU/Metal device.

## Supported project scope

Set `edit.backend: tesseract` in `project.yaml`. Current support is intentionally limited to:

- Local MP4, MOV, or M4V clip sources, trimmed and placed sequentially; embedded clip audio can be enabled or disabled.
- Local BGM, narration, and SFX tracks. Each track is cut from its source beginning and placed at its manifest `start` time; real-render verification currently covers one added audio track.
- Title and caption overlays using an imported, catalog-supported font with glyphs for the text. Tsugite backend renders have been visually verified with Inter / Regular for English and Noto Sans JP Thin / Regular for Japanese.
- 16:9 or 9:16 projects at 30 fps. The export's encoded frame rate and dimensions are checked after rendering.

Fast Edit is unsupported. The backend also rejects image assets, speaker artwork, chapter cards, transitions, clip motion, presentation motion design, and styled caption speaker/pose/emphasis/visual fields. These listed unsupported elements fail closed rather than being silently dropped or converted.

Text overlays require a font family/style accepted by Tesseract's font catalog, an imported font resource, and glyph coverage for the actual text. Importing a local font that returned `Monaco` / `Regular` did not make that value valid for `createFxTextLayer`; the official CLI rejected `source_text.font_family` as unsupported. The Tsugite backend has rendered English title/caption text with an imported Google Fonts OFL Inter TTF using `Inter` / `Regular`, and Japanese title/caption text with Google Fonts OFL `NotoSansJP[wght].ttf`. For that variable font, `project import-font` returns `Noto Sans JP Thin` / `Regular`; the adapter uses this returned face when no family/style override is configured. Explicit `font_family` and `font_style` settings must match the imported metadata. Inter lacks Japanese glyphs, so it renders tofu for Japanese. Configure `edit.backend_options.tesseract.font_path` with the local font file and use a catalog-supported face whose glyphs cover all text; importing an arbitrary local font does not make its family catalog-supported.

## Verification status

The repository tests use fake CLI executables and a fake release archive. They cover host and version selection, argument passing, checksum failure, and the explicit installer boundary.

Real render verification used the official CLI 0.1.0 and host GPU access:

- A clip-only Tsugite backend render produced `final.tsrct`, `final.mp4`, and `render-report.json`. QA confirmed the native Video layer, asset ID, and `sourceRange`; ffprobe reported H.264 at 1080×1920, 30 fps, 30 frames, and 1 second, and full decode passed.
- A combined fixture with an English title, English caption, and 440 Hz added audio track passed full decode. The 1-second MP4 was H.264 1080×1920/30 fps with AAC 48 kHz stereo. Visual QA confirmed the text was clear. Native inspection confirmed Text layer ids 3 and 4 using Inter / Regular over 0–1000 ms, Audio layer id 2 at volume 0.5 with matching source range, and report track count 1. The tone measured mean -27.1 dB and peak -23.9 dB, consistent with the configured 0.5 gain.
- A Japanese title/caption fixture with added BGM produced `final.tsrct` (97,091 bytes), `final.mp4` (51,372 bytes), and `render-report.json` (888 bytes). The 1-second MP4 was H.264 1080×1920/30 fps with AAC 48 kHz stereo; full decode passed. Visual QA confirmed `日本語` and `Noto Sans JP 字幕確認` were legible without tofu. Native inspection confirmed both Text layers used the imported face returned as Noto Sans JP Thin / Regular over 0–1000 ms and Audio layer id 2 at volume 0.5.

Inter produces tofu for Japanese because it lacks Japanese glyphs. An imported `Monaco` / `Regular` face was rejected with `source_text.font_family is not supported; choose a font from the font catalog`. Export in a sandbox without GPU adapter access failed during adapter discovery.
