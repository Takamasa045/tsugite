# Local verification — 2026-10-18

## Continued implementation checkpoint

Current durable worktree:
`/Users/takamasa/Projects/開発/tsugite/.work/tsugite-v2-worktree`, branch
`codex/tsugite-v2`. The earlier temporary worktree below was moved intact;
the foundation commit is `9c8baaf`. No v1 sources or productions were edited.

The expanded v2 check has **53 passed, 0 failed, 0 skipped**, including real
Remotion video/audio/caption export using existing local peer packages and an
explicit existing browser. No browser/runtime download or cloud call ran.
New tests cover sound mixing, subtitle extraction/WebVTT, trims/reframing,
source mocks, page-only receipt settlement, durable provider job identity,
packs/knowledge/Skill install, native-v1 final-copy migration, preservation of
untracked outputs, registry identity/tar validation and usable scaffold output.

The expanded real CLI smoke ran with external networking denied by macOS,
allowing loopback only. Its **20 successful steps** use explicit synthetic
service mocks and a run-owned fixture. It produced **8.021322 seconds,
360×640, with sound and subtitles**, and two ledger entries settled at **zero**
credits. Automated fixture form submissions are not human production approval.
Output SHA-256:
`1afd66dc3c4ea83b6e16e56d598a085746f0bc612e938d0abef2d339812ada46`.

Proof JSON, current check log and copied MP4 are retained in ignored
`v2/evidence/phase2/`. That folder also holds the baseline comparison: the v1
HyperFrames failure reproduces at untouched base `890270e` and v1 source paths
are unchanged. The existing shared dependency installation is preserved.

Live registry acquisition has mocked command/hostile archive tests; a real
locally npm-packed Fast Edit archive was installed into an isolated project.
No registry network acceptance or clean registry install is claimed. Package
dry-run excludes node_modules, evidence, test outputs and production media.

Still unverified: actual Windows/Linux runs and independent-user trials,
HyperFrames real v2 rendering, real local Whisper transcription and all live
source-provider transports/credit accounting. Default FFmpeg on this host lacks
libass, so burn-in mode correctly fails preflight; soft MP4 captions work.
The optional full FFmpeg binary on this host has a missing library and was not
repaired. No public release, paid generation or credentials change occurred.

The following phase-one report is retained as historical evidence; its
23-test count and temporary path do not describe the latest checkpoint.

## Phase-one report

This is an alpha implementation report, not approval of a real production or
completion of all v2 requirements. Worktree `/tmp/tsugite-v2`, branch
`codex/tsugite-v2`, based on `origin/main` at `890270e`. Primary checkout remains
on its original branch and retains its pre-existing dirty files and projects.

## V2 result

- `npm run check` in `v2/`: **23 tests passed**, 0 failed/skipped, including real
  FFmpeg MP4 export and a real SDK MCP stdio handshake. Latest runtime was Node
  v22.23.2. The test run took about 19 seconds.
- Covered plan/config/asset/preference/knowledge/plugin modification, byte-only
  plan edits, semantic plan forgery and no revival of superseded approval.
- Covered absent CLI/MCP approval operations, out-of-order checks, duplicate
  execution, exclusive locks, distinct parallel reservations, per-service bounds,
  failed and over-reported settlements retaining uncertain reservations.
- Covered path traversal, symlink parents, XSS, CSRF, cross-site requests, wrong
  Origin/Host/session/content type, media session protection and stale scope.
- Covered one-clip retry, final-media tampering, preview-bound clean into trash,
  copy-only v1 migration, global/project habit promotion, idempotent per-final
  rule results, two-miss retirement and optional final-media preference checks.
- `npm pack --dry-run` succeeds. Distribution contains only v2 runtime, local
  plugin, short Skill, English docs and license; v1 apps/providers/projects are
  absent. No npm publication occurred.
- A real local npm tarball was extracted outside the repository. With only the
  already-installed YAML package copied alongside it, packaged `init`, `check`
  and `plan --no-review` all succeeded. This checks the package boundary without
  claiming a registry install or downloading optional dependencies.
- A lockfile was generated offline from already-present dependency metadata.
  This is **not** a fresh registry vulnerability audit or clean-install result.

## Real CLI offline evidence

The test-only `scripts/offline-smoke.mjs` drove init → check → plan → confirmation
form → make → export → final confirmation form → note through the real CLI and
loopback page. Forms were submitted by a test harness in its own fixture, not by
a human approving a production. Source runtime identity and output hashes are
in the retained evidence JSON.

The successful run was additionally constrained by macOS:

```sh
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))' node scripts/offline-smoke.mjs
```

It produced a **6-second 360×640 H.264 MP4**, about **1.6 seconds** of machine
execution, with an empty ledger (no credits spent or reserved). This timing
excludes installing dependencies and human review; it is not a novice trial.
SHA-256: `2028836f3bc6d0503a46cf32aef4a939f19557ed6ebe38c61c504a4ce66fce2d`.
Retained run: `tsugite-v2-evidence-fcV7Qv` in this host's temporary directory.

## Existing v1 result

Root `npm run check`: vendor boundary and TypeScript build passed. With loopback
allowed, root tests had **2,386 passed, 1 failed, 2 skipped** (160 files; 158 passed,
1 failed, 1 skipped). The failure is
`test/hyperframes-studio-webmcp.test.ts` → `patches only the reviewed CLI zip imports`.
The worktree expects HyperFrames **0.8.75**, while its shared existing
`node_modules` contains **0.8.24**. That installation was not patched or replaced.
Coverage thresholds are not certified by this failing run.

The first sandboxed root run also failed loopback server tests with EPERM. Those
environmental failures disappeared in the authorized loopback-capable rerun.

The repository's `verify-tsugite` Skill completed its exact v1 Doctor/validate
fixture under network denial, with identical fixture read-back, no Gate/render
operations and successful scratch cleanup. Evidence remains at
`verification/evidence/verify-tsugite/20261018t103906743z-f32c75/` in the worktree.
It does not verify v2 planning or page behavior; those have the separate tests above.

## Not verified or released

No paid/live generation, provider accounts, credential changes, npm publication,
GitHub push/PR, external sharing or production-data edits occurred. macOS is the
only locally executed OS; the new three-OS CI matrix has not run remotely.
No clean registry installation, viewer app checks (unchanged app), novice user
trials or v2 Remotion/HyperFrames/live-provider verification is claimed.
See [requirements](requirements.md) for the complete staged backlog.
