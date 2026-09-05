# Pipeline plan

A user can turn a validated local project into a deterministic execution plan without calling a generation adapter or spending credits. The CLI prints a `plan` object: `run_id`, clip duration, and ordered steps (validate → creative-review → gate-1 → assemble-manifest → gate-2 → render → gate-3 for local-media-only). `prompt_guidance` is omitted when there are no generation requests. Catalog safety is `read-only`; the same shelf linker as validate still runs.

## Sub-features

- `plan-local-steps` Local remotion project gets the assemble/render gate ladder with no generation or audio-generation step.
- `plan-no-execution` Creating a plan does not run adapters, write `state.json`, or change Gates.
- `plan-prompt-guidance` Generation projects may include per-request `prompt_guidance`; absence of a catalog match is a status, not proof the adapter can run. Not the default proof target.

## How to get to it (user POV)

- README: `node bin/pipeline plan --config projects/my-first-run/project.yaml --json` after validate.
- Help: `node bin/pipeline help plan` (`usage`: `node bin/pipeline plan --config <project.yaml> [--json]`).
- Agents run plan after validate and inspect every `prompt_guidance` status before finalizing prompts. Local-fixture has none.
- `--open` is rejected on plan (`cli.option_unsupported`); opening HTML is `review`, not plan.

## Driving it with CLI --json

Preconditions:

- Isolated fixture from `helpers/isolate-local-fixture.sh` (same as validate).
- Validate already `ok` on that config, or plan will fail closed on the same validation issues.
- Do not pass `--open`.

- **Action.** User requests a plan for the isolated local sample. Exact commands:

```sh
test -n "${VERIFY_CONFIG:-}" && test -f "$VERIFY_CONFIG" || exit 1 # Reuse the Isolate run.
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline plan --config "$VERIFY_CONFIG" --json
```

Observable result: exit 0, `"ok": true`, `"command": "plan"`, `plan.run_id` is `local-fixture-run`, `plan.steps` names are `validate`, `creative-review`, `gate-1`, `assemble-manifest`, `gate-2`, `render`, `gate-3`. No `prompt_guidance` key on this local-media plan. Save stdout as `evidence/pipeline-plan.json`.

- **Action.** Confirm nothing executed. Observable result: JSON has no `dry_run` / `executed` field (those belong to `run --dry-run`); isolated `dist/` has no new `state.json` from plan alone.

## Gotchas

- Plan does not mean the user approved Gate 1. Later `run` still requires coordinator + approval.
- `fixtures/projects/local-valid.yaml` plans a **pixverse** generation request. Its step list and `prompt_guidance` differ. Do not use it for this feature’s happy path.
- Shelf linker runs after a successful validate inside the same CLI process — keep `TSUGITE_PROJECTS_HOME` isolated.
- Story-framework advice is a different command: `node bin/pipeline story-guides --request "…" --duration 30 --json` (`scope: creative-guidance-only`, `execution_capability: not-evaluated`). Do not substitute it for `plan`.
