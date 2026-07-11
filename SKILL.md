# tsugite Skill

## Goal

Run a vendor-neutral video editing pipeline from a project `project.yaml` through validation, planning, gated execution, and quality checks.

## Roles

- Coordinator owns the selected `project.yaml` and is the only role allowed to execute non-dry-run `run` or `render`.
- Planner / Reviewer may run `validate`, `plan`, and `run --dry-run` only.
- Output QA inspects manifest, media metadata, timing, and final reports read-only.

## Required Flow

1. Read the selected `project.yaml`.
2. For generation requests, make the input mode explicit and use `bin/pipeline guides --json` to discover available prompt knowledge.
3. Run `bin/pipeline validate --config <project.yaml> --json`.
4. Run `bin/pipeline plan --config <project.yaml> --json` and inspect every `prompt_guidance` status before finalizing prompts.
5. Stop at Gate 1 and ask for approve / revise / abort.
6. Only after explicit approval, run generation or render commands.
7. Before Gate 2 approval, inspect `gate2-qc.json`; use approve_all only when the report and artifacts are acceptable.
8. Before Gate 3 approval, inspect `render-report.json`, `gate3-qc.json`, and the final artifact.

## Non-Negotiable Rules

- Keep the core neutral; engine-specific execution details live inside adapter or backend directories, while source-backed advisory data lives in the prompt knowledge catalogs.
- Prompt knowledge is advisory: never auto-rewrite a project prompt, and never treat a catalog as proof that an execution adapter or entitlement exists.
- If guidance is missing, unmatched, unsupported, or stale, disclose that state instead of silently applying another model's recipe.
- Never auto-advance from planning to credit-consuming execution.
- Do not report skipped steps as completed work.
- `re-render` is a Gate 3-only decision. It preserves Gate 1 and Gate 2 approval.
- Gate 2 `retry_specific` is not executable yet; use `revise` for a full re-plan instead of claiming a targeted retry.
- Record failures in `LESSONS.md` when they create a new operational rule.
