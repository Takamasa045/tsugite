# Production Orchestration PO-8 RC integration

**Status:** fixture-only structural repair (round 2) in tree. Package version remains `0.9.0`.

This document is **outside** the frozen T00 design pack under `docs/design/production-orchestration-v1/`. Design pack hashes must not change.

## What landed

| Surface | Path |
| --- | --- |
| Mode diagnostics | `src/productionControl/rc/modeDiagnostics.ts` |
| Durable mode intent + CAS pointer | `src/productionControl/rc/modeIntent.ts` |
| Effect ledger (H2) | `src/productionControl/rc/effectLedger.ts` |
| Effect capability/observer (call-site) | `src/productionControl/rc/effectCapability.ts` |
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

## Structural repair round 2 (A–G)

- **A** Fixture exact authoring bind: strict parse of `fixture_id` / `project` / `authoring` / `expected.golden_digests` / `adversarial`; `fixture_digest` bound into every module evidence; no hardcoded DIGEST_A–F, bare marker `"0"`/`"1"`, or void project inputs.
- **B** Effect evidence at actual call-sites: `EffectObserver` + deny `EffectCapability`; `markFixtureInProcessBoundary` removed; CLI safety flags derived from observer/ledger; uninstrumented channels stay `unknown` → readiness NO-GO.
- **C** Durable mode authority: control-root `current-mode` pointer is authoritative; YAML/pointer production_id / revision mismatch fail-closed; pointer CAS with `expected_previous_intent_digest` + root lock + readback; shadow denies effect entry in production path (`assertShadowModeDeniesEffect`).
- **D** Rollback real readers: CLI main path `legacy → shadow → active → rollback → legacy` without hand-writing YAML active; after rollback, validate/plan/review/run --dry-run/finalize preview read durable legacy pointer.
- **E** Readiness authenticity: exits recomputed from evidence store digests / command exit_code+hash; no unconditional proven; commit SHA is `verified_separately` only.
- **F** Revision bindings import exported production schema versions; `package.json` realpath/regular/hash.
- **G** `production-status` returns sanitized mode authority, presence digest, and read-only effect evidence (no absolute paths / secrets).

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
