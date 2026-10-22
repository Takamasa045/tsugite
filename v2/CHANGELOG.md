# Changelog

`v2/package.json` stays `2.0.0-alpha.5`. This file records work on that alpha.
It is not a version bump. Draft GitHub Release text, which is not published,
is in [docs/release-notes/](docs/release-notes/github-release.md).

## Unreleased

- Point the repository README at v2 for new work. Keep v1 `0.18.0` as
  maintenance for existing `project.yaml` productions. Document `init`,
  `check`, `plan`, `make`, `export`, and `init --from-v1` (with `--flatten`
  and `--archive-v1`) from the current CLI. The story conversation in
  [#245](https://github.com/Takamasa045/tsugite/pull/245) is described without
  a command example, because that command is not in this tree.
- Record merged alpha work: [#241](https://github.com/Takamasa045/tsugite/pull/241)
  (PixVerse image-to-video and transition, ElevenLabs voice settings, still
  holds), [#242](https://github.com/Takamasa045/tsugite/pull/242) (PixVerse
  extend, upscale, modify, image Fusion, and ElevenLabs music and SFX), and
  [#243](https://github.com/Takamasa045/tsugite/pull/243) (an explicit
  `credits: null` is a successful file plus a kept reservation).
- Record one ElevenLabs SFX paid acceptance (2 seconds). Speech and music paid
  acceptance stay open.
- State the connection policy for PixVerse, Kling, and TopView: use each
  service's CLI while that subscription is already logged in. Support arrives
  in order. Do not treat an API key in settings as the connection. Formal 2.0.0
  drops PixVerse API-key paid acceptance and instead requires a real-machine
  check on that CLI path (a real generation and a full export). That check is
  open. This note adds no login command.
