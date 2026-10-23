# Development checkpoint — alpha readiness

The package version is **2.0.0-alpha.7**. The last published prerelease is
**2.0.0-alpha.5** (2026-10-19). v1 source is **0.18.0**. None of these is
formal v2, paid-service, or independent-user acceptance. This checkpoint does
not push tag `v2.0.0-alpha.7`.

Install links for the release being prepared select `v2.0.0-alpha.7`. The
published archive remains
[v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5).
See [alpha.5 distribution](docs/release-alpha5.md), the root
[changelog](../CHANGELOG.md), and [requirements](docs/requirements.md).
Source work continues on `main`. The earlier `codex/tsugite-v2` worktree is
historical.

This checkpoint does **not** re-run the test suites. Dated counts stay in
[verification](docs/verification.md) (alpha.1 local: 73 passed; alpha.2 local:
75 passed) and the
[alpha.5 GitHub release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5)
(local v2: 88 passed, five optional-runtime skips; local root: 2,397 passed,
two skipped). Do not treat those numbers as a fresh run of this docs change.

HyperFrames pins are tracked separately (both currently 0.8.173):

- v1 root: **0.8.173** (`package.json`, `backends/hyperframes/apply-pinned-patches.mjs`)
- v2 adapter: **0.8.173** (`v2/plugins/hyperframes`; version enforced in `index.mjs`)

An earlier local note that a shared install held 0.8.24 while a worktree
expected 0.8.75 describes a past environment, not the current source pins.

Owner-facing migration decisions (adopted 2026-10-19) are in
[v1→v2 migration decision record](docs/migration-plan.ja.md).
Paid acceptance is last; Kling may need prepaid credits.

The following dated checkpoints are retained as development history. They must
not override the alpha.5 release record.

## Historical — alpha.2

Alpha.2 fixed three reproduced archive/caption review findings and recorded 75
local tests with no failures/skips. It refreshed the optional MCP dependency
graph after a separate v2 audit found four advisory packages in alpha.1. The
fresh graph had zero advisories; required v2 audit and MCP-version checks were
added. Alpha.1 was superseded without changing its tag/assets.

## Historical — alpha.1

The [alpha.1 release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.1)
was published from main merge `73f00cf` through PR #203. All seven assets were
downloaded anonymously and matched SHA-256. Three-OS offline CI and the separate
real Remotion lane passed; existing v1 CI and Viewer also passed with a fresh
pinned install. The tracker then recorded 73 done, seven partial and ten
external requirements. No formal v2, paid-service or independent-user
acceptance was claimed.

The full v2 migration was not declared complete. Work continued on
`codex/tsugite-v2` in the durable `.work/tsugite-v2-worktree`; the foundation was
saved at local commit `9c8baaf`, with the next checkpoint at `fbaa6f6`.

Latest expanded check at that checkpoint: **73 passed, 0 failed, 0 skipped**
under external-network denial, using existing local browser/HF/Whisper runtimes
and synthetic HTTP. Source changes added audio/captions/trims, expanded copy
migration, optional real Remotion output, explicit service mocks, HyperFrames
HTML/mock, local Whisper and Fast Edit contracts, packs/Skill installation,
bounded exact-version npm archive acquisition, usable plugin scaffolds and
page-only receipt settlement. Later work added actual local HyperFrames/Whisper,
18-card Fast Edit with SFX, documented HTTP transports and private connection
references, locked native-data archives and non-destructive separation of 11
experimental compatibility components.

The external-network-denied CLI smoke completed 20 steps and wrote an 8.021322s
360×640 video with sound/subtitles, two mock ledger entries and zero credits.
See the [verification report](docs/verification.md) for that dated evidence
and [local issue drafts](docs/contribution-backlog.md) for release preparation.

A freshly installed tarball also completed the sample outside the repository.
The 30-second synthetic demo is rendered and reviewed. No formal
v2/independent-user gate is claimed.

Evidence is retained under ignored `v2/evidence/phase2/`, including exact
baseline comparison, test log, sound/caption output and decoded Remotion frame.
See [extended workflows](docs/phase-two.md) and [requirements](docs/requirements.md).
