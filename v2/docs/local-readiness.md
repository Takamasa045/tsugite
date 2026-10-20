# Local implementation and external acceptance

The alpha is locally usable without accounts. The clean-install sample, sound,
captions, source mocks, optional Remotion/HyperFrames, real local Whisper, full
Fast Edit decisions and safe copy/archive migration have direct local evidence.
Service protocol code has synthetic HTTP evidence and explicit live opt-in;
actual paid acceptance has not happened. These are different evidence classes.

The current [alpha source release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5)
is public. The first public prerelease was
[alpha.1](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.1).
The three-OS CI matrix, separate Ubuntu Remotion lane and existing v1
required CI passed for the published alphas. Gallery/demo/tarball links were
anonymously downloaded and verified against SHA-256. See the
[verification record](verification.md) and
[alpha.5 distribution](release-alpha5.md).

The experimental components have a non-destructive source-separation/export
tool and 11 independent compatibility packages with integrity inspections. They
remain v1 experiments, not newly certified v2 execution capabilities. No native
editor graph is silently flattened into a supported edit. Choose supported
editable migration or an explicit final copy plus the original metadata/media
archive. Character archives require verified lock hashes.

The following require other people, external runtime/account acceptance or a
maintainer decision; a machine fixture cannot honestly complete them:

| Requirement IDs | Remaining acceptance / decision |
|---|---|
| U07, S01 | Three independent novice trials on the three OSs, including human timing; kit in [trial-kit.ja.md](onboarding/trial-kit.ja.md) |
| B04, P08, P10 | Actual service request/status/final billing and account credit-unit acceptance; paid generation is postponed to the end, lowest-credit service first; Kling may need prepaid credits |
| P13, P14, P15 | Review/maintain the separated experiments and choose a new labs remote; the current authorization names the existing repository only |
| D06, D08 | Assign actual maintainers; five `good first issue` issues are published (#228–#232) and the trial report form is prepared |
| M02, M07, S05 | v1 support duration/branch policy, fork-user notice and the new-production cutover after independent acceptance |
| M06, S02, S03, S04 | Independent phase gates and post-release adoption/maintenance metrics |

The existing repository's established distribution is a source-only GitHub
release, with a private root npm package. An alpha source/tag release may carry
the reviewed v2 tarball and synthetic demo. It does not imply npm registry
publication, a new account, a formal v2 release or that the independent-user
gates passed. The authorized push, CI, tag and asset publication have now been
read back; the independent-user and live-account gates above remain open.
