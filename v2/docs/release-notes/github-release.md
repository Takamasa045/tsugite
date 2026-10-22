# Draft GitHub Release notes (English)

Do not publish this file as a release. Do not tag. `v2/package.json` stays
`2.0.0-alpha.5`. The Japanese draft is
[github-release.ja.md](github-release.ja.md).

These notes describe alpha work after the
[v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5)
source release. New videos start on v2. Existing `project.yaml` productions
stay on v1 `0.18.0`.

## What landed

### #241 — PixVerse image-to-video and transition, ElevenLabs voice settings, stills

Synthetic HTTP coverage for PixVerse V6 image-to-video and first/last-frame
transition, local stills bound with `make.inputs`, and ElevenLabs speech model
and `voice_settings` checks. PNG, JPEG, and WebP holds share the local and
Remotion timeline when `seconds` is explicit. No live PixVerse call was made.

### #242 — PixVerse extend, upscale, modify, image Fusion, and ElevenLabs music and SFX

Synthetic HTTP coverage for those PixVerse modes and for ElevenLabs
`mode: music` and `mode: sfx`. Quotes stay explicit. No live call was made.

### #243 — ElevenLabs `credits: null`

One billed 2-second sound effect returned no numeric credit amount. An
explicit `credits: null` now marks the received file successful and keeps the
reservation until the confirmation page settles it. A missing `credits` field
is still a contract failure. That one SFX request is the recorded paid
acceptance. Speech and music paid acceptance are open.

### #245 and #246 — story conversation, and the catalog in the package

[#245](https://github.com/Takamasa045/tsugite/pull/245) lets a project start
from a structure conversation before footage. The conversation does not
generate, send data out, spend credits, or approve. Attaching the chosen
structure changes the plan hash, so an old approval cannot continue. Footage
is not rebuilt automatically.
[#246](https://github.com/Takamasa045/tsugite/pull/246) ships the same catalog
bytes and the source notice inside the v2 package. `plugin story consult`
works from a git checkout and from the npm package. It reads only
`knowledge/story-frameworks/catalog.yaml` in that package. It does not search
a parent directory. The catalog is data, not a promise that those forms can
be generated.

```sh
npm run --silent v2 -- plugin story consult --request "60秒の静かな自然映像。ドラマ・CTA不要" --seconds 60
```

After you keep a JSON plan, run `plugin story check` and then
`plugin story bind`, then `plan`.

## How PixVerse, Kling, and TopView connect

Use each service's CLI while that subscription is already logged in. The path
is in this package and tests use a fake CLI. Do not connect them by writing an
API key into project settings. This draft does not choose a login or a billing
account, and it does not add a Tsugite login command. The real-machine check
is open.

The offline sample (`init`, `check`, `plan`, `make`, `export`) does not call
those CLIs.

## Formal 2.0.0 is not this alpha

Judgment, in [migration-plan.md](../migration-plan.md):

- ElevenLabs SFX paid acceptance: done (the 2-second request above).
- ElevenLabs speech and music paid acceptance: open.
- PixVerse API-key paid acceptance: removed from the criteria.
- PixVerse real-machine check on the subscription CLI: open. That check is a
  real generation and a full export of that generation while the CLI is logged
  in with the subscription.
- Kling and TopView follow the same CLI-login policy. The path is in this
  package. Their real-machine checks are open and do not replace the PixVerse
  check.
- Three non-author first trials, and an explicit owner approval to make v2 the
  default, are still open.

Copy a supported v1 production with `init <directory> --from-v1 <v1-directory>`.
`--flatten` copies one finished video. `--archive-v1` keeps a bounded archive.
Approvals and secrets are not copied. Production-specific Remotion and
character graphs stay on v1.
