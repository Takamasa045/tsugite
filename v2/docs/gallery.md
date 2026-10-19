# Zero-credit example gallery

Start with files you own, review the plan, and export locally. These examples
use synthetic test footage and generated local tones; no provider was charged.
The alpha.4 source-only release includes no videos or images. Earlier alpha.2
assets remain available below; do not install that older version to watch them. Create examples locally
with the commands below; these are software fixtures, not independent-user
acceptance trials.

## Watch the existing public samples

- [18-second Fast Edit cards sample](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.2/fast-edit-18-cards.mp4): 360×640 synthetic test-pattern footage with editing graphics, not a real talking-head before/after comparison.
- [30-second workflow explainer](https://github.com/Takamasa045/tsugite/releases/download/v2.0.0-alpha.2/demo-30s.mp4): an illustrated explanation, not a screen recording or independent-user trial.
- [Original release and checksums](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.2).

These samples show existing functionality. They do not establish finished-client
work, subjective quality gains, or improvement over a normal AI request. New
same-source before/after and revision comparisons remain unperformed. No new
media is published by these documentation changes.

## First video, no account

See the [offline installation and first-video steps](install.md).

`init → plan → confirmation page → make → export` produces a six-second vertical
installation-check sample, not a showcase of editing quality. The release tarball was installed outside the repository for this trial;
all checks were submitted by a fixture harness and its credit ledger stayed empty.

## Fast Edit: eighteen cards

Install the optional Fast Edit renderer and use the contained decisions example
in [extended workflows](phase-two.md).

Timed words and reviewed editing decisions drive cards, word emphasis, text
effects, transitions, zoom, progress and deterministic local SFX. The optional
renderer uses existing Remotion peers/browser and has its own license guidance.
See [extended workflows](phase-two.md) for the decision format and installation.


## Share a reusable part

- `init --pack template.json` exports timing slots without source media or generation requests.
- `note --pack taste.json` exports private observations/rules only when you explicitly choose to share them.
- `plugin knowledge story` installs a local Markdown guidance snapshot; it never implies generation capability.

Importing a pack creates a new review context. It cannot import approval, spend
credits or publish media. See the [requirement tracker](requirements.md) for
remaining acceptance and governance decisions.
