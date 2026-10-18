# Zero-credit example gallery

Start with files you own, review the plan, and export locally. These examples
use synthetic test footage and generated local tones; no provider was charged.
The current gallery lives on this project's GitHub site, alongside the source
release. The videos are alpha examples, not independent-user acceptance trials.

## First video, no account

[![Synthetic local sample](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.1/sample-preview.png)](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.1/sample.mp4)

`init → plan → confirmation page → make → export` produces a six-second vertical
sample. The release tarball was installed outside the repository for this trial;
all checks were submitted by a fixture harness and its credit ledger stayed empty.

## Fast Edit: eighteen cards

[![Fast Edit cards](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.1/fast-edit-preview.png)](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.1/fast-edit-18-cards.mp4)

Timed words and reviewed editing decisions drive cards, word emphasis, text
effects, transitions, zoom, progress and deterministic local SFX. The optional
renderer uses existing Remotion peers/browser and has its own license guidance.
See [extended workflows](phase-two.md) for the decision format and installation.

## Thirty-second walkthrough

[Watch the demo](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.1/demo-30s.mp4).
It illustrates the six steps with synthetic footage and an alpha label. It is
not a recording of a paid service or a human trial.

## Share a reusable part

- `init --pack template.json` exports timing slots without source media or generation requests.
- `note --pack taste.json` exports private observations/rules only when you explicitly choose to share them.
- `plugin knowledge story` installs a local Markdown guidance snapshot; it never implies generation capability.

Importing a pack creates a new review context. It cannot import approval, spend
credits or publish media. See the [requirement tracker](requirements.md) for
remaining acceptance and governance decisions.
