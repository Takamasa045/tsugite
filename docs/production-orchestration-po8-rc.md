# Production Orchestration PO-8 RC integration

**Status:** fixture-only structural repair (round 4) in tree. Package version remains `0.9.0`. Independent audit remains **NO-GO** for Windows/live/desktop; structural production-path repairs for authority, effect observer, recovery seed, Gate semantics, migration durability, and runtime readers are in tree.

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

## Structural repair round 4

- **Runtime authority:** validate + CLI run/render/finalize/gate/recover/migrate/rollback consume the same durable pointer resolver (`runtimeAuthority` / `effectiveRuntimeMode`). YAML mismatch fail-closed. `GenerationJobMachine` shadow never falls through to direct `adapter.submit`.
- **Effect observer:** `armAllBoundaries` / fixture bulk-arm abolished. Each real production wrapper (`machine`, `writeState`, `grantLedger`, `render`, `finalize`) self-registers. Unregistered effect fails closed before execution. Proven zero only after real wrapper registration + sealed zero attempts.
- **Recovery:** seeds real job/event + runs `runActiveLocalRecovery` (no missing-job catch→awaiting_human fake). Unknown price, grant exhaustion, and local_ok proven from real outcomes.
- **Gate semantics:** `gateSemanticFingerprint` compares status + subject/decision/approval digests; shadow denies Gate mutation; writeState notes only on semantic change.
- **Migration/rollback durability:** required artifact create-only or byte-identical adoption only; soft-fail `.catch(() => undefined)` removed. CLI E2E preview→apply→status→rollback→status with journal/digest proof.
- **Runtime readers:** pointer authority consumed on run/render/finalize/gate/recover paths (not status display alone).
- **Version:** package remains `0.9.0`; design pack frozen.

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
