# Production Orchestration PO-8 RC integration

**Status:** fixture-only structural repair (round 7) in tree. Package version remains `0.9.0`. Readiness stays **GO-WITH-CAVEATS** (Windows/live/browser/packaged desktop incomplete). Exit blockers EB1 (validate→compile authority real entry) and EB2 (gate_mutation effect_policy thread) are closed with focused evidence.

This document is **outside** the frozen T00 design pack under `docs/design/production-orchestration-v1/`. Design pack hashes must not change.

## Structural repair round 7 (EB1 real-entry split-brain)

- **EB1 Critical (round 7):** `validateProject` resolved pointer authority but still passed raw YAML `project` into `compileProjectVideoPrompts` / generation-unit resolver. Those bodies re-read `project.orchestration.mode`, so migration `pointer=active` + YAML `disabled|omit` became outer-active / inner-legacy split-brain. Fix: after authority resolve, build trusted `projectWithRuntimeAuthority` before all active-mode-dependent compile/asset/resolver work; `compileProjectVideoPrompts` prefers explicit `runtime_authority` DI over untrusted YAML-only mode. Round6 inspect-only temporary YAML `mode=active` rewrite removed. Real CLI temp fixture: migrate preview→apply active → native V2 with YAML mode omit/disabled → validate→plan→review→inspectGate1Review / gate dry boundary; pointer sole SoT; shadow mismatch fail-closed; disabled legacy invariant; provider/effect 0.
- **EB2 High (retained from round 6):** `renderAssembledMedia` markGateAwaiting(gate_3)→`writeState` and CLI active cascade `writeState` (run/render/finalize) thread observer `effect_policy` + `previous` to deepest gate_mutation boundary. Deny stops before mutation; semantic no-op count 0; shadow migration keeps gate_mutation 0/unknown. Legacy `approved_input_digest` semantics unchanged.

## Structural repair round 6 (Exit blockers — retained)

- **EB1 (inspect thread):** `inspectGate1Review` / `resolveCurrentVideoPromptReview` thread trusted `ResolvedRuntimeAuthority` from CLI validate (not disk YAML re-resolve alone). Gate1 inspect/run CLI paths pass `validation.runtime_authority`.
- **EB2 High:** deepest gate_mutation `writeState` effect_policy thread as above.

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
