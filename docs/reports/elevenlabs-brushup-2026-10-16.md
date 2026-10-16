# ElevenLabs narration brushup evidence — 2026-10-16

PR: https://github.com/Takamasa045/tsugite/pull/185

## Result

The implementation separates explicit quote, human approval, new submission,
existing-job recovery, and audit-only retrieval. Unknown amounts and uncertain
submissions fail closed. The adapter owns a durable receipt chain; core/CLI/Viewer
read one local status projection. No new live paid API call, OAuth grant, scope
expansion, client publication, merge, or external reply was performed in this
brushup.

- S0-A `7b45f77`: persist journal ancestors and containing directory before submit.
  This independently addresses review `discussion_r4290171354`.
- S0-B `3416452`: actual public CLI Gate chain; repair audio-only storyboard fallback.
- CI `9809cce`, `65e0e04`, `771abbd`: fixture clock propagation, reviewed dependency
  patches/offline browser preparation, and quote command catalog expectations.
- S1 `0e6c050`, `4a6b304`: bounded safe errors, unknown pricing, explicit quote and
  exact request/profile/epoch/schema/expiry/limit binding to Gate 1.
- S2 `5abe426`: versioned receipts, same-job recovery and partial-run reuse.
- S3: public auth, process-safe refresh/rotation uncertainty, shared status/cards,
  stale/double execution guards, and original-approval audit retrieval.

## Evidence and limits

| Area | Evidence |
|---|---|
| D01–D05 durability | Real macOS directory fsync; every injected fs failure gives submit 0; two OS processes; SIGKILL before submit/ID save, after accepted save, during download and after link; separate persistence model |
| Public G01–G09 | Actual `node bin/pipeline`, real Gates/digests/orchestrator/MP3 probe/QC/small Remotion render. External MCP/MP3/token transport only is fixture-controlled, with external-deny/loopback-only macOS process sandbox. S2 full suite 8 passed |
| Pricing/binding | Unknown/null versus measured zero; exact decimal USD units/limits; expiry boundaries; text/voice/model/profile/epoch/schema changes; on-disk Gate proof; explicit estimate-only quantity 1; no implicit quote in planning |
| R01–R11 | Durable accepted identity, status-only URL refresh, hash/codec-proven orphan reuse, partial 2-request states, project unresolved digest/run-ID guard, persistent budgets, legacy/partial/symlink rejection; changed approval fails ordinary adoption. Explicit audit-only recovery leaves current manifest/QC/Gates untouched |
| A01–A09 | Auth action guards, pinned endpoints/scopes/PKCE/state/issuer; two actual OS processes refresh once; process death/save failure retains non-secret uncertainty; fixed callback port collision/timeout; status/cache have no refresh/save effects; no plaintext secret fallback |
| U01–U07 | Existing local-media flow retained; common status and cost/request card; unknown has no generate control; resume-only action; 2-tab server guard plus CLI lock; DOM keyboard/focus/notification tests; technical QA and listening explicitly separated |

S3 focused regression: 190 passed; later 41 overlapping targeted checks passed.
Public recovery/audit/partial-run cases: 4 passed. Loopback callback/launcher cases:
3 passed. Canvas DOM cases: 12 passed. Root and Viewer no-emit typechecks passed.
These are local fixture results, not additional live service tests. Full CI is
reported separately below. Manual screen-reader, subjective listening and an
actual power-loss test were not performed. The older live sample and Library
artifact remain the live evidence; ASR/codec/volume checks do not prove listening.

## CI

- `65e0e04`: all three mandatory jobs green, run
  https://github.com/Takamasa045/tsugite/actions/runs/38844293747
- `771abbd`: all three mandatory jobs green, run
  https://github.com/Takamasa045/tsugite/actions/runs/38850228436
- `5abe426`: all 2,493 root tests passed; branch coverage 74.31% missed the existing
  74.4% threshold. Site and Windows passed. Direct read-model/auth/main regression
  tests were added; thresholds and detectors remain unchanged.
- Final S3 CI/review outcome will be recorded after the pushed head completes.

Local full coverage was interrupted by ENOSPC earlier; it is not counted as a
successful check. Later local heavy installs/builds/coverage were suppressed to
respect the capacity constraint. Two existing local CLI render tests also could
not launch their browser in the restricted shell; their failure is not used as
positive evidence. The external-deny public CLI render and CI results are separate.

Root full dependency audit and site production audit reached zero findings in the
CI repair stage. Site **full** audit still reports eight high developer dependency
findings through unpatched `braces@3.0.3`; it is not fully clean. The existing
optional development audit gate was not weakened. See
[CI repair report](elevenlabs-ci-repair-2026-10-16.md).

## Support boundary

See [adapter documentation](../elevenlabs-v4.md#supported-and-verified-scope).
Dedicated secure storage is macOS Keychain only. New submit/resume persistence is
macOS/Linux; Windows fails closed while directory sync is unsupported. Receipt
preview is local-only. Operator-managed bearer grant epochs are attestations,
not automatic account/workspace verification. Project digest protection is local
and does not replace provider idempotency across metadata-free copies.

The observed hosted schema declares `eleven_v4`, **not** `eleven_v4_turbo`; there
is no silent substitute. Quotes are a five-minute client validity window and
submission approval limits, not a provider-enforced billing cap. Old journals
without recovery fields stay unknown. Durable polling budgets bound counts and
scheduled waits, not total wall time. Audit retrieval requires the same canonical
request; changed content must be recovered from its original specification.
