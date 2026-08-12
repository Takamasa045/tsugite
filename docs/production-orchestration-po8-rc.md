# Production Orchestration PO-8 RC integration

**Status:** fixture-only structural repair (round 6) in tree. Package version remains `0.9.0`. Readiness stays **GO-WITH-CAVEATS** (Windows/live/browser/packaged desktop incomplete). Exit blockers EB1 (Gate1 V2 projection authority) and EB2 (gate_mutation effect_policy thread) are closed with focused evidence.

This document is **outside** the frozen T00 design pack under `docs/design/production-orchestration-v1/`. Design pack hashes must not change.

## Structural repair round 6 (Exit blockers)

- **EB1 Critical:** `inspectGate1Review` / `resolveCurrentVideoPromptReview` now thread trusted `ResolvedRuntimeAuthority` from CLI validate (not disk YAML re-resolve). Migration active is pointer-only (YAML non-rewrite); without authority, empty V2 projection falsely triggered `gate.video_prompt_changed`. Gate1 inspect/run CLI paths pass `validation.runtime_authority`. E2E: migrate preview→apply active→review→inspect with/without authority; provider/effect 0.
- **EB2 High:** `renderAssembledMedia` markGateAwaiting(gate_3)→`writeState` and CLI active cascade `writeState` (run/render/finalize) now thread the same observer `effect_policy` + `previous` to deepest gate_mutation boundary. Wrapper self-registers + notes; deny stops before mutation; semantic no-op count 0; shadow migration keeps gate_mutation 0/unknown. Legacy `approved_input_digest` semantics unchanged. Policy-less direct library calls remain compatible.

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

## Structural repair round 5 (retained)

- **Pointer/YAML split-brain:** `ResolvedRuntimeAuthority.runtime_mode` is projected via `projectWithRuntimeAuthority` / `orchestrationModeFromAuthority` into plan/run/review bodies (not CLI entry checks alone). Durable pointer is SoT; YAML non-legacy mismatch fail-closed. Migration does not rewrite `project.yaml`.
- **Effect observer honesty:** post-migrate/rollback `registerBoundariesViaProductionWrappers` theater removed. Production CLI threads `effect_policy` to gate/run/render/finalize wrappers. Unregistered channels stay `unknown`; proven-zero only for actually registered boundaries.
- **submission_unknown:** fixture uses real `GenerationJobMachine` transitions (with/without `provider_job_id`); resubmit refused; digests bind real outcomes.
- **Paid deny:** `GrantCreditLedger.reserve` under deny policy proves `PC_EFFECT_DENIED` (no direct observer API).
- **Artifact duplicate:** ArtifactStore create adopts only after byte/digest exact readback; journal advance only after required artifact exact verify.
- **Readiness desktop:** without `desktop:audit` evidence → `partial`/`unverified` with exit-evidence reasons; Windows/live/browser/packaged caveats retained.
- **Gate fingerprint:** Gate2 selected completion, Gate3 final SHA, GateBundle/decision/approval binding in canonical fingerprint; `writeState` effect_policy threaded from gate CLI. Legacy `approved_input_digest` semantics unchanged.
- **Migration preview:** `from_mode` / `previewMigrationWithPointer` uses pointer reader chain; resume reuses sealed journal `source_mode`.
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
