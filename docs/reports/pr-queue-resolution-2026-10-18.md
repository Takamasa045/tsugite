# Remaining PR queue resolution — 2026-10-18

This pass reviews the 20 items retained by the first rollout audit. Decisions
below supersede that audit's temporary holds. A queue closure is not a claim
that every proposed feature or major migration has been implemented. Replacement
requests are closed only after this integrated change passes normal CI and lands.
Source branches are not deleted. No private production is committed or moved.

## Changes selected for integration

| PR | Concrete disposition / verification |
|---|---|
| #99 | Apply setup-node v7 consistently across root, Desktop and v2 workflows; official action runs on Node 24 while the selected application runtime stays Node 22. Verify actual hosted Ubuntu/Windows/macOS jobs. |
| #136 | Desktop @xmldom/xmldom 0.9.12 retained in the resolved Forge 8 tree. |
| #173 | The old Desktop ip-address dependency path disappears with Forge 8; do not reintroduce the obsolete parent tree merely to bump its child. |
| #174 | The old Desktop fast-uri dependency path disappears with Forge 8. |
| #179 | Desktop's 7.x undici resolves to 7.30.0; audit both development and production dependency trees. |
| #184 | Desktop brace-expansion resolves to patched 1.1.21 and 5.0.12; the obsolete 2.x path is removed. |
| #209 | Desktop Playwright 1.64.1 paired with the selected Electron 44 toolchain. |
| #214 | Electron 44.7.2, Forge CLI/ZIP/Squirrel 8.0.1 and asar 4.3.1. Document Node 22.13+ for this development-only app. Remove the unused DMG maker's unresolved image-size chain; retain macOS ZIP and Windows Squirrel. This does not restart public installer distribution. Existing 88 source/package-boundary tests and full dependency audit pass. CI now installs without lifecycle scripts and runs these source checks; actual installed/signed app acceptance is not claimed. |
| #190 | PixVerse remains pinned to 1.4.6, sharp becomes 0.35.5 with the matching native/libvips packages; exercise real image encode/decode locally. |
| #191 | PixVerse fast-uri 3.1.8; check URI parsing and offline CLI help. |
| #192 | Editframe source-map-js 1.2.2, keeping the selected 0.60.11 runtime; check actual mapping API and offline CLI version. |
| #211 | Hypit source-map-js 1.2.2, preserving the 0.2.13 distribution pin; patch sharp to 0.35.5 and esbuild to 0.28.1 rather than silently switching the upstream distribution. Verify local import/image/build APIs and offline CLI help. |
| #181 | Preserve the original Kobo preset implementation and tests, adapt its registration to current main, and render the current shared root with every registered preset. Project media and local fonts are not copied or published. |
| #183 | Preserve the five original observations in [review candidates](production-review-candidates-2026-10-09.md), with historical claims clearly labeled. Do not silently promote audio shifts, color conversions or environment-specific limits into shared production policy. |

The initial Forge 7 install hit npm's disabled git-package fetch for an SSH
node-gyp dependency. No authentication or safety setting was relaxed. Forge 8
uses registry packages and removes that blocked path. The first Desktop pin test
correctly rejected the new Playwright version until the reviewed pin contract was
updated. Current source tests are not evidence of a signed installer run.

## Proposals excluded from this alpha

| PR | Why close the proposal instead of merging it |
|---|---|
| #194 | Coverage provider 5 by itself mismatches the supported Vitest 4.1.11 runner. Keep the audited, tested pair; a future coordinated test-framework migration needs its own acceptance. |
| #216 | Bundles Vitest/coverage 5, TypeScript 7, jsdom 30 and jest-dom 7; its reviewed root/Windows heads fail CI. These five major changes do not implement a missing v2 behavior. Preserve the existing 516-test Viewer baseline and defer the coordinated migration, rather than merge failed checks to reduce queue size. |
| #198 | React 19.3 alone mismatches the site's React DOM 19.2.8 and reviewed RSC 19.2.8 combination. Keep the tested matching set. |
| #202 | React DOM 19.3 alone requires React 19.3 while this site pins 19.2.8. Do not merge the opposite half of the same mismatch. |
| #215 | Changes vinext 0.0.45 to 1.2.0, ESLint 9 to 10, TypeScript 5 to 7 and Node types 22 to 26; site CI fails. This source-only v2 release neither deploys nor migrates the separate product site. Retain its current framework/runtime types, with the independently verified URI/brace-expansion patches. |
| #185 | Not merged or called complete. This is a separate 99-file v1 hosted OAuth/quote/billing/recovery proposal, conflicting with current main, not the v2 service-credit/page-approval contract. Integrating it would expand this release into an unaccepted authentication and charging workflow. Preserve the full source at `f450fd4fdf96d2cf8291b6744b1a366cc2e843b2` and its PR; reopen only for a separate reviewed feature with explicit connection/billing acceptance. No auth configuration, grants, accounts or paid calls are changed. |

For #185, future acceptance must reconcile its quote/gate binding with current
v1 behavior, review credential rotation and crash recovery against the latest
main, prove no duplicate charge after uncertain submission, and use explicit
human authorization for any live provider test. This document does not grant it.
For the other deferred major migrations, preserve current passing behavior and
reproduce the failed CI first; do not bypass checks or assert compatibility from
an old branch's green result.

## Preservation and public delivery

Production PR heads #181/#183/#185 are retained as immutable local backup refs;
a verified Git bundle records their complete histories in the author's private
backup. Closing a PR does not delete its source branch. Existing dirty tracked
files, private source and durable productions are retained separately from this
integration worktree.

The public v2 delivery is source-only: program tarball, checksum and English
installation instructions. No synthetic demo video or image is uploaded. The
previous alpha.3 tag remains unchanged; alpha.4 identifies the final source-only
package and guide. v2 remains an alpha with 73 done / seven partial / ten external
requirements. Paid-provider acceptance and independent novice trials remain
unperformed. Optional v1 compatibility labs are not v2-native runtime ports.


## Dependency audit scope

Desktop, PixVerse and Hypit audits pass with zero findings after the selected fixes. Root and Viewer are audited independently. Editframe still reports three high advisories through braces/micromatch/vite-plugin-singlefile; the current braces release is 3.0.3 and no patched compatible npm release was found. The product site has eight development-only advisories through the same unpatched braces family; production audit passes. Its pre-existing optional development audit does not establish a clean full tree. This cleanup corrects the misleading timeout-only warning without weakening the mandatory production check. Do not claim repository-wide zero vulnerabilities or enable an unsafe forced framework downgrade. These optional/development trees are not included in the standalone v2 tarball.

The pre-merge review found Forge 8 packager hooks now receive one options object. A regression uses the installed packager 20 runner itself, reproducing the old callback-hook failure on Unix and Windows options, then verifies the Promise-based hook and helper permissions. All 88 local Desktop source tests pass after the fix. This is still not signed/installed-app acceptance.
