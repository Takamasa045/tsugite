# Alpha.5 distribution scope

Version `2.0.0-alpha.5` is the next installable **prerelease**, not stable v2
acceptance. It includes the production guide and QA fixes reviewed in
[PR #220](https://github.com/Takamasa045/tsugite/pull/220), plus standalone
English/Japanese entry points and first-video instructions. Existing alpha
archives and active v1 productions remain unchanged.

## Distribution

Use `tsugite-2.0.0-alpha.5.tgz` and `SHA256SUMS` from the
[GitHub Release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5).
Verify the checksum before local installation. This is the established GitHub
source-release/tarball route. No npm registry package, new account, desktop
installer, video, image or private profile is published by this release.

The tarball includes the independent v2 runtime, generic guides, plugin
contracts, documentation and short Agent Skill. It excludes v1 backends,
experimental labs archives, tests, generated media, private prompts/profiles,
credentials and unrelated local tool updates. Optional plugins are not newly
certified by being included; their documented peers and licenses still apply.

## Dependency risk and source-archive distinction

Repository alert [#131](https://github.com/Takamasa045/tsugite/security/dependabot/131)
remains open for `braces` 3.0.3 in the optional **v1** Editframe runtime lockfile.
The High advisory, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
concerns stack exhaustion with deeply nested patterns. The alert lists no
patched version. This release does not install, bundle or repair that runtime.

The dedicated v2 tarball does not contain that lockfile, Editframe, or a `braces`
dependency. Its installed dependencies are audited separately. GitHub also
creates automatic **Source code** archives for the tag; those are the full
repository and still contain the optional v1 lockfile. They are not the v2
installation artifact, and no repository-wide zero-vulnerability claim is made.
Use the named v2 tarball for this release; assess the unresolved advisory before
separately enabling legacy Editframe.

## Verification and limits

Release acceptance requires the pinned source CI, tarball/source equality,
checksum verification, clean local installation, real packaged CLI/page offline
export, the production-guide workflow and an MCP stdio/version boundary check.
The GitHub Release records the exact completed runs, digests and downloaded
artifact evidence after execution. Fixture form submissions are software tests,
not human production approvals. Sampled frames and PCM checks are not a full
watch/listen or a quality comparison.

Independent novice trials, actual paid-provider/final billing acceptance,
experimental maintainer decisions, and same-source A/B quality/time comparisons
remain open. No paid generation, credential changes or production-data migration
is performed for this release. The confirmation page prevents accidental actions;
it cannot isolate a process with the same OS account.
