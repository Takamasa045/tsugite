# Production Orchestration PO-8 RC integration

**Status:** fixture-only structural repair (round 3) in tree. Package version remains `0.9.0`. Readiness is **NO-GO** until durable journal complete + 8 exact module evidence + same-observer boundary zero + actual reader command evidence are all present (Windows/live/desktop remain caveats).

This document is **outside** the frozen T00 design pack under `docs/design/production-orchestration-v1/`. Design pack hashes must not change.

## What landed

| Surface | Path |
| --- | --- |
| Runtime authority (async, non-authoring) | `src/productionControl/runtimeAuthority.ts` |
| Mode diagnostics | `src/productionControl/rc/modeDiagnostics.ts` |
| Durable mode intent + CAS pointer | `src/productionControl/rc/modeIntent.ts` |
| Effect ledger (H2) | `src/productionControl/rc/effectLedger.ts` |
| Effect capability/observer + EffectPolicy | `src/productionControl/rc/effectCapability.ts` |
| Migration journal stage machine | `src/productionControl/rc/migrationJournal.ts` |
| Fixture module evidence (H1, strict authoring) | `src/productionControl/rc/fixtureEvidence.ts` |
| Control-plane status (M1) | `src/productionControl/rc/controlPlaneStatus.ts` |
| Revision bindings (M5, production exports) | `src/productionControl/rc/revisionBindings.ts` |
| Migration orchestrator | `src/productionControl/rc/migrationOrchestrator.ts` |
| Rollback orchestrator | `src/productionControl/rc/rollbackOrchestrator.ts` |
| 8-fixture rehearsal | `src/productionControl/rc/rehearsal.ts` |
| Release readiness (store-recomputed) | `src/productionControl/rc/releaseReadiness.ts` |
| Path fail-closed | `src/productionControl/rc/pathSafety.ts` |
| Fixtures (authoring/expected/adversarial) | `test/fixtures/production-control/po8/` |
| Tests | `test/production-control-po8-rc-integration.test.ts` |

## Structural repair round 3 (F1–F6)

- **F1/B** Real effect boundaries: `createEffectObserver` does **not** auto-arm. Armed only when each actual boundary wrapper registers. Explicit `EffectPolicy` (deny/noop) at production entries (generationJobs T05 submit, poll/download, Gate writeState, grant reserve/commit, render start, finalize apply). No AsyncLocal. Observer-less production stays unknown (never safe-zero). Proven zero only when all boundaries registered, sequence sealed, attempt count 0. Self-probe / separate zeroObserver removed. CLI flags from same sealed observer only.
- **F2/C** Production mode resolution once at validate/load via `runtimeAuthority` → `ValidateProjectResult.runtime_authority` (non-authoring). CLI main entries reuse it. Pointer authoritative when present; YAML/legacy only when pointer fully absent. YAML non-legacy / production_id / revision mismatch fail-closed. Shadow effect entry denied for recover/run/render/finalize.
- **F3/A** Fixture exact goldens are compiler/upgrader digests or production exported enums only. Job revision + binding digests. Recovery runs `runActiveLocalRecovery` (fixture poll/download, no submit) + unknown-price reserve block + paid deny observer. Mutation with expected unchanged fails.
- **F4/D** Migration journal create-only stages: planned → events → snapshot → artifacts → pointer → complete (fsync/readback/digest each). Resume exact same preview/production/revision only; conflicting journal fails. Crash hook matrix all stages. Rollback pointer rebuild; CLI post-rollback asserts `resolved_mode=legacy` / `source=pointer`.
- **F5/E** Readiness `buildReleaseReadinessReport` is NO-GO unless durable journal complete + 8 module evidence + same-observer zero + reader command evidence. `build_provenance` head/dirty never proves exits (`verified_separately` only).
- **F6** Production revision bindings reject package_version override; package.json digest fail-closed (no synthetic fallback).

## CLI (no non-dry-run run/render/finalize apply)

```sh
node bin/pipeline production-status --config <project.yaml> --json
node bin/pipeline production-migrate --config <project.yaml> --target shadow --json
node bin/pipeline production-migrate --config <project.yaml> --target active --apply --actor coordinator --expected-plan-digest <preview.digest> --json
node bin/pipeline production-rollback --config <project.yaml> --target legacy --json
```

Migration apply creates control-plane artifacts only. It does **not** rewrite `project.yaml`, mutate Gates, submit providers, render, or finalize-apply.

## Mode rules

| Mode | Behavior |
| --- | --- |
| legacy (default / `disabled` / unspecified) | Legacy linear path; control plane not required |
| shadow | Read-only compile + optional shadow artifacts; no execution; no Gate subject mutation |
| active | Authority required for effectful work; exact revision bindings |

## Version decision

Per `docs/design/production-orchestration-v1/migration-and-release.md`:

- Do **not** ship `1.0.0` until all exit criteria (including Windows smoke and required live evidence) are proven.
- This RC integration keeps **`0.9.0`**. It does not invent a package RC version bump without full release-gate proof.

## Unverified in this owner session unless separately recorded

- Windows real machine
- Live provider traffic / billing
- Full Desktop package audit (when not run)
- Non-fixture production traffic
