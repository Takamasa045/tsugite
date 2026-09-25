# Hypit adapter constraints (Phase 1)

Hypit is an independent video Distribution, not a Tsugite generation clip
adapter and not a Tsugite render backend.

- Pin `@hypit/hypit@0.2.13`. Do not use the unscoped npm name `hypit` (404).
- Skill and executable have separate install channels.
- `check` / `plan` do not submit a Build. They do load project `activation` JS.
- `build` is unconditionally denied in Phase 1. No env or grant array unlocks it.
- `runtime up` / `programs up` start local processes. `auth login` writes credentials.
- `pricing` is a Provider network read. Phase 1 does not call it.
- Reuse accepted Outputs only with `<build-record>` + `<satisfy>`.
- Missing cost stays unknown. Never store amount 0 as a default.
- Observation fingerprints are not approvals.
- Live check/plan uses one exact argv profile, exact `chat.svml`/`chat.svrun`, and the exact prepared workspace.
- Spawn is refused unless official source bytes and pinned activation bytes still match.
- `--package-root` / `--runtime` / `--asset-root` are denied anywhere on check/plan.
- This is not arbitrary-source isolation.
- Keep Hypit identifiers out of `src/` (vendor boundary).
- Do not add a parallel approval authority beside `src/productionControl`.
