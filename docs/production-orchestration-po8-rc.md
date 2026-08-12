# Production Orchestration PO-8 RC integration

**Status:** fixture-only implementation in tree. Package version remains `0.9.0`.

This document is **outside** the frozen T00 design pack under `docs/design/production-orchestration-v1/`. Design pack hashes must not change.

## What landed

| Surface | Path |
| --- | --- |
| Mode diagnostics | `src/productionControl/rc/modeDiagnostics.ts` |
| Durable mode intent | `src/productionControl/rc/modeIntent.ts` |
| Effect ledger (H2) | `src/productionControl/rc/effectLedger.ts` |
| Fixture module evidence (H1) | `src/productionControl/rc/fixtureEvidence.ts` |
| Control-plane status (M1) | `src/productionControl/rc/controlPlaneStatus.ts` |
| Revision bindings (M5) | `src/productionControl/rc/revisionBindings.ts` |
| Migration orchestrator | `src/productionControl/rc/migrationOrchestrator.ts` |
| Rollback orchestrator | `src/productionControl/rc/rollbackOrchestrator.ts` |
| 8-fixture rehearsal | `src/productionControl/rc/rehearsal.ts` |
| Release readiness (M2) | `src/productionControl/rc/releaseReadiness.ts` |
| Path fail-closed | `src/productionControl/rc/pathSafety.ts` |
| Fixtures | `test/fixtures/production-control/po8/` |
| Tests | `test/production-control-po8-rc-integration.test.ts` |

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
