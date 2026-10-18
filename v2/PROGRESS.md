# Development checkpoint — alpha readiness

The full v2 migration is not declared complete. Work continues on
`codex/tsugite-v2` in the durable `.work/tsugite-v2-worktree`; the foundation is
saved at local commit `9c8baaf`, with the next checkpoint at `fbaa6f6`.
Subsequent explicit user authorization covers the existing repository's push,
main/source release and appropriate tag. No production data or credentials changed.

Latest expanded check: **73 passed, 0 failed, 0 skipped** under external-network
denial, using existing local browser/HF/Whisper runtimes and synthetic HTTP.
Source changes add audio/captions/trims, expanded copy migration, optional real
Remotion output, explicit service mocks, HyperFrames HTML/mock, local Whisper and
Fast Edit contracts, packs/Skill installation, bounded exact-version npm archive
acquisition, usable plugin scaffolds and page-only receipt settlement. Later work
adds actual local HyperFrames/Whisper, 18-card Fast Edit with SFX, documented
HTTP transports and private connection references, locked native-data archives
and non-destructive separation of 11 experimental compatibility components.

The external-network-denied CLI smoke completed 20 steps and wrote an 8.021322s
360×640 video with sound/subtitles, two mock ledger entries and zero credits.
See the updated [verification report](docs/verification.md) for exact evidence
and [local issue drafts](docs/contribution-backlog.md) for release preparation.

A freshly installed tarball also completed the sample outside the repository.
The 30-second synthetic demo is rendered and reviewed. Public CI/release results
will be recorded after execution; no formal v2/independent-user gate is claimed.

The root v1 suite still has **2386 passed, 1 failed, 2 skipped**. Its exact failure
also reproduces at unmodified `890270e` with the same shared dependency install:
expected HyperFrames 0.8.75, installed 0.8.24. The shared installation is unchanged.

Evidence is retained under ignored `v2/evidence/phase2/`, including exact baseline
comparison, test log, sound/caption output and decoded Remotion frame. New code
and evidence checks continue; do not interpret this checkpoint as final release.
See [extended workflows](docs/phase-two.md) and [requirements](docs/requirements.md).
