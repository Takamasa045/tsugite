# Production Orchestration — current status

The T00 design pack under `docs/design/production-orchestration-v1/` is **byte-frozen**, including `docs/design/README.md`. That index still says 「未実装」 because the freeze predates 0.10.0. Do not edit those files to record later implementation. This page is the living status **outside** the freeze.

## Shipped in 0.10.0

- T00–T09 are in `src/productionControl/` and the `production-status` / `production-migrate` / `production-rollback` CLI.
- Default execution remains the legacy linear Gate path (`orchestration` omitted or `disabled`).
- `shadow` / `active` are explicit opt-in. Reading the design pack does not change version, Gates, generation, or billing.

## Not 1.0 yet

| Caveat | Status |
| --- | --- |
| Windows smoke on GitHub Actions | Done in 0.10.0 |
| Live provider / billing evidence | Not done |
| Packaged Desktop UAT | Partial / not a distribution path |
| MiniMax live HTTP / DNS / submit | Out of 1.0; preflight-only |
| Gate 2 `retry_specific` | Out of 1.0; use `revise` |

RC-era 0.9.0 evidence stays in [production-orchestration-po8-rc.md](./production-orchestration-po8-rc.md) and [reports/](./reports/). Those files do not override `package.json` **0.10.0**.
