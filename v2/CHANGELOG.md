# Changelog

`v2/package.json` is `2.0.0-alpha.7`. The combined release body is
[docs/release-notes/github-release-body.md](docs/release-notes/github-release-body.md).
This changelog does not push the tag or publish the Release.

## 2.0.0-alpha.7 - 2026-10-22

- Admit patched Node 22.23.4+, 24.22.1+ and 26.12.1+ in their respective major lines, using one shared runtime policy and a three-OS CI matrix. Keep Node 22.23.4 / npm 10.9.8 as the default until Node 26 LTS and provider acceptance.
- Remove the repository's Electron Desktop app and embedded terminal; use the browser launcher/Viewer with Codex or Claude Code. Project folders, approvals and user data are unchanged.
- Fix Viewer tests on Node 26 by using jsdom's browser storage instead of Node's process-global Web Storage. Optional Hypit setup still requires Node 22.
- Preserve the alpha.6 service-acceptance limitations. No live service generation or billing is part of this runtime release.

## 2.0.0-alpha.6 - 2026-10-22

- Point the repository README at v2 for new work. Keep v1 `0.18.0` as
  maintenance for existing `project.yaml` productions. Document `init`,
  `check`, `plan`, `make`, `export`, `init --from-v1` (with `--flatten`
  and `--archive-v1`), and `plugin story consult` from the current CLI.
  Consult works from a git checkout and from the npm package:
  [#246](https://github.com/Takamasa045/tsugite/pull/246) ships
  `knowledge/story-frameworks/catalog.yaml` inside the package. The
  conversation itself is [#245](https://github.com/Takamasa045/tsugite/pull/245).
- Record merged alpha work: [#241](https://github.com/Takamasa045/tsugite/pull/241)
  (PixVerse image-to-video and transition, ElevenLabs voice settings, still
  holds), [#242](https://github.com/Takamasa045/tsugite/pull/242) (PixVerse
  extend, upscale, modify, image Fusion, and ElevenLabs music and SFX), and
  [#243](https://github.com/Takamasa045/tsugite/pull/243) (an explicit
  `credits: null` is a successful file plus a kept reservation).
- Record one ElevenLabs SFX paid acceptance (2 seconds). Speech and music paid
  acceptance stay open.
- Connect PixVerse, Kling, and TopView through each service CLI while that
  subscription is already logged in
  ([#248](https://github.com/Takamasa045/tsugite/pull/248)). The path is in
  this package and tests use a fake CLI. Do not treat an API key in settings
  as the connection. The subscription-CLI real-machine check is not done: a
  real generation and a full export while logged in are still required. This
  note adds no login command. Formal 2.0.0 drops PixVerse API-key paid
  acceptance.
