---
name: tsugite
description: Plan, validate, review, execute, quality-check, and finalize Tsugite video projects from project.yaml with human approval gates. Use when a user asks to create, edit, review, render, QA, or complete a video in this repository, or mentions Tsugite, project.yaml, story-guides, Gate 1-3, shitate-import, or finalize.
---

# Tsugite

## Goal

Run a vendor-neutral video editing pipeline from a project `project.yaml` through validation, planning, gated execution, and quality checks.

## Roles

- Treat the Coordinator as the owner of the selected `project.yaml` and the only role allowed to execute non-dry-run `run` or `render`.
- Limit Planner / Reviewer work to `validate`, `plan`, `review`, and `run --dry-run`.
- Keep Output QA read-only while inspecting manifests, media metadata, timing, artifacts, and final reports.

## Required Flow

1. Read the selected `project.yaml` and state the goal and completion condition in one sentence.
2. Before proposing structure or shots, run `bin/pipeline story-guides --request "<creative brief>" --duration <seconds> --json`; explain the primary framework, supporting frameworks, rejected alternatives, timing preset, and applied film grammar.
3. For generation requests, make the input mode explicit and run `bin/pipeline guides --json` to discover available prompt knowledge.
4. Run `bin/pipeline validate --config <project.yaml> --json`.
5. Run `bin/pipeline plan --config <project.yaml> --json` and inspect every `prompt_guidance` status before finalizing prompts.
6. Run `bin/pipeline review --config <project.yaml> --open --json`, inspect the storyboard HTML and `review-data.json`, then stop at Gate 1 and ask for approve / revise / abort.
7. Run generation or render commands only after explicit approval.
8. Before Gate 2 approval, inspect `gate2-qc.json`; use `approve_all` only when the report and artifacts are acceptable.
9. Before Gate 3 approval, inspect `render-report.json`, `gate3-qc.json`, and the final artifact.
10. When the user explicitly declares the selected video complete, record the canonical output, QA proof, and retrospective; preview `bin/pipeline finalize --config <project.yaml> --json`, then apply it as Coordinator only when the retained run and deletion scope match the completed project.

## Feedback Promotion

- Keep one-off preferences in `projects/<job>/notes.md`.
- After recurring evidence has a concrete target, change summary, and verification plan, record a pending promotion proposal and obtain explicit human approval before editing shared source.
- Treat launcher approve / reject actions as append-only local feedback decisions. Approval means implementation may begin; it does not itself modify templates, rules, checks, Gates, or project state.
- Use the optional Codex automation only to review preference/learning promotion candidates while the launcher is open or closed. It may append at most three complete, non-duplicate pending proposals per run through `pipeline feedback`; it must not edit shared source, implement approved proposals, inspect other automations, or send browser, desktop, or external notifications. Codex itself may surface the dedicated automation run through its normal notification policy.
- Promote reusable project shapes and style choices into `examples/` or `templates/`.
- Promote machine-checkable failures into constraints, `validate`, or `doctor`, with a reproducing fixture and test.
- Record new operating rules in `LESSONS.md`, then promote judgment-based rules into this skill or `AGENTS.md`.
- Promote QA decision rules into Gate 2 / Gate 3 checks, report schemas, fixtures, and tests.
- Keep `LESSONS.md` append-only and mark promoted entries with their validation status.

## Optional Shitate Handoff

- Treat Shitate as an optional external character-design repository, not a normal pipeline dependency.
- Use `bin/pipeline shitate-import` only when the user explicitly requests a Shitate snapshot handoff.
- Before import, show the source root, character, run ID, anchor, destination, and planned manifest/request updates, then obtain explicit approval.
- Copy a SHA-256-locked snapshot into `media/shitate/`; do not generate media, update Gates, send data externally, or authorize non-dry-run execution during import.
- After import, run `validate`, `plan`, `review`, and `run --dry-run` before considering Gate 1.

## Non-Negotiable Rules

- Keep the core neutral; place engine-specific execution details inside adapter or backend directories, and source-backed advisory data inside prompt knowledge catalogs.
- Treat prompt knowledge as advisory. Never auto-rewrite a project prompt or treat a catalog as proof that an execution adapter or entitlement exists.
- Treat story guidance as advisory. Choose by goal, duration, medium, and audience response instead of forcing every project into one framework.
- Abstract structural roles from established methods. Do not copy distinctive expression or concrete plots from existing works or creators.
- Disclose missing, unmatched, unsupported, or stale guidance instead of silently applying another model's recipe.
- Never auto-advance from planning to credit-consuming execution.
- Require a valid `dist/<run-id>/review/index.html` and `review-data.json` for the current project before Gate 1 approval.
- Do not report skipped steps as completed work.
- Treat `re-render` as a Gate 3-only decision that preserves Gate 1 and Gate 2 approval.
- Treat `finalize` as completion-only cleanup. Require a completed run, Gate 3 approval, final QA proof, and the user's explicit completion declaration before `--apply`.
- Keep the selected final run, final-manifest media, and text records. Delete only superseded media from older runs, older QA, and unused project media, then write `completion-record.json`.
- Treat Gate 2 `retry_specific` as unavailable; use `revise` for a full re-plan.
- In Claude Code, keep `.claude/settings.json` in default permission mode. Keep Gate decisions, non-dry-run execution, commit, push, and PR creation approval-gated.

## References

- Read `../../../references/lessons-graduation.md` when promoting feedback into reusable rules, templates, checks, or contracts.
- Read `../../../templates/README.md` before selecting or adding a reusable project template.
- Read `../../../docs/story-guides.md` when interpreting story-framework recommendations.
- Read `../../../docs/prompt-guides.md` when generation prompt guidance is involved.
- Read `../../../docs/shitate.md` only for an explicitly requested Shitate handoff.
- Read `../../../docs/automations/learning-promotion-review.md` when creating, reviewing, or running the dedicated learning-promotion automation.
