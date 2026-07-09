# tsugite Skill

## Goal

Run a vendor-neutral video editing pipeline from `project.yaml` through validation, planning, gated execution, and quality checks.

## Roles

- Coordinator owns `project.yaml` and is the only role allowed to execute non-dry-run `run` or `render`.
- Planner / Reviewer may run `validate`, `plan`, and `run --dry-run` only.
- Output QA inspects manifest, media metadata, timing, and final reports read-only.

## Required Flow

1. Read `project.yaml`.
2. Run `bin/pipeline validate --config project.yaml --json`.
3. Run `bin/pipeline plan --config project.yaml --json`.
4. Stop at Gate 1 and ask for approve / revise / abort.
5. Only after explicit approval, run generation or render commands.

## Non-Negotiable Rules

- Keep the core neutral; engine-specific details live only inside adapter directories.
- Never auto-advance from planning to credit-consuming execution.
- Do not report skipped steps as completed work.
- Record failures in `LESSONS.md` when they create a new operational rule.
