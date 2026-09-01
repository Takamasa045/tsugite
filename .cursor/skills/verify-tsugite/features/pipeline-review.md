# Pipeline review / storyboard

A user can generate a Gate 1 creative review without approving a Gate or starting generation. `review` writes a caption-first storyboard as local HTML plus `review-data.json` (shot list, motion/animation plan, production conditions). CLI JSON reports `"gate": "gate-1"` and `"gate_state": "unchanged"`. `--open` only opens the local HTML; omit it for headless proof. Catalog safety is `local-write`.

## Sub-features

- `review-artifacts` Writes `index.html` and `review-data.json`; JSON returns `review_path`, `review_data_path`, `asset_count`.
- `review-no-gate` `gate_state` is `unchanged`; no `state.json` is created in the output directory.
- `review-storyboard` `review-data.json` has a `storyboard` array derived from the manifest (local-fixture: two 1s clips, target 2s).

## How to get to it (user POV)

- README: `node bin/pipeline review --config projects/my-first-run/project.yaml --open --json`.
- Help: `node bin/pipeline help review` (`--config`, `--output`, `--state-dir`, `--open`).
- Default destination when `--output` is omitted: `<project.dist_dir>/<run_id>/review/` (for this fixture, `dist/local-fixture-run/review/`).
- Gate 1 approval in the Tsugite skill requires those two artifacts to exist and belong to the current project. This verification skill **stops after writing them**.

## Driving it with CLI --json

Preconditions:

- Isolated fixture via `helpers/isolate-local-fixture.sh`.
- `--output` under `.cursor/skills/verify-tsugite/evidence/review-out` so cleanup of `tmp/` does not delete the storyboard proof.
- Do not pass `--open` unless a display is required; `--open` failure is `review.open_failed` and does not imply the files are missing.
- Do not run `gate` afterward.

- **Action.** User generates the Gate 1 storyboard for the isolated sample. Exact commands:

```sh
eval "$(.cursor/skills/verify-tsugite/helpers/isolate-local-fixture.sh)"
mkdir -p .cursor/skills/verify-tsugite/evidence/review-out
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline review \
  --config "$VERIFY_CONFIG" \
  --output .cursor/skills/verify-tsugite/evidence/review-out \
  --json
```

Observable result: exit 0, `"ok": true`, `"command": "review"`, `"gate": "gate-1"`, `"gate_state": "unchanged"`, `"opened": false`. `review_path` ends with `index.html`, `review_data_path` ends with `review-data.json`. HTML contains `Gate 1`. `review-data.json` `storyboard` length is 2. `test ! -f .cursor/skills/verify-tsugite/evidence/review-out/state.json`. Save CLI stdout as `evidence/pipeline-review.json`.

- **Action.** User inspects the storyboard data. Exact command: `node -e "const d=require('./.cursor/skills/verify-tsugite/evidence/review-out/review-data.json'); console.log(d.storyboard.length)"`. Observable result: `2`.

## Gotchas

- Default `--output` (omitted) writes into the isolated project `dist/`, which is removed when `tmp/` is cleaned. Always `--output` into `evidence/` for a surviving proof.
- Composition projects need `analyze` then `compose` before review; `examples/local-fixture` has no `composition` — do not run analyze/compose for this feature.
- `review-preview` is a **different**, approval-gated command (`--actor coordinator --shot <id>`). Not this feature.
- Shelf linker still runs; keep `TSUGITE_PROJECTS_HOME` isolated.
- Writing review is not Gate 1 approval and does not authorize `run`.
