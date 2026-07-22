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

## Connection Selection

- Before selecting or writing a `project.yaml` for external video, image, or audio generation, resolve three separate choices: the requested media capability, the generation model, and the connection profile that pays for and authenticates the request.
- If the user explicitly names both a connection/service and a compatible model, keep that choice and do not ask the connection question again. If the user names only a model and more than one compatible ready connection exists, list those connections and ask: `どのサービスを使って生成しますか？`
- If no connection is named, show only the compatible connections and their verified status, then ask the same question before fixing the project configuration or starting any external action. Do not infer a paid route from a model catalog, previous project, preferred default, or installed executable.
- Even when exactly one compatible ready connection exists, ask the connection question whenever the user did not explicitly name the service. Never silently select or fall back to a connection, subscription, model, or billing account.
- If no compatible connection is ready, explain that planning and editing can continue without a subscription, then offer local/existing media, manual import of externally generated media, a supported local generator, or connection setup. Do not pressure the user to subscribe to every provider.
- Never ask the user to paste API keys, session cookies, auth links, tokens, or other secrets into chat, `project.yaml`, or repository files. Direct them to the provider's login flow, OS credential store, or declared environment-variable setup instead.
- Treat connection status as runtime evidence, not a promise. A model catalog is advisory; an installed transport, authenticated subscription, available entitlement, and sufficient credits are separate checks.

## Required Flow

1. Read the selected `project.yaml` and state the goal and completion condition in one sentence.
2. Before proposing structure or shots, run `bin/pipeline story-guides --request "<creative brief>" --duration <seconds> --json`; explain the primary framework, supporting frameworks, rejected alternatives, timing preset, and applied film grammar.
3. For generation requests, make the input mode explicit and run `bin/pipeline guides --json` to discover available prompt knowledge.
4. Run `bin/pipeline validate --config <project.yaml> --json`.
5. Run `bin/pipeline plan --config <project.yaml> --json` and inspect every `prompt_guidance` status before finalizing prompts.
6. Run `bin/pipeline review --config <project.yaml> --open --json`, inspect the storyboard HTML and `review-data.json`, including the motion/animation plan and production conditions, then stop at Gate 1. Ask for the Gate 1 decision exactly once, after those checks, with approve / revise / abort; do not present an earlier Gate 1 prompt during planning or review preparation.
7. Run generation or render commands only after explicit approval.
8. Before Gate 2 approval, inspect `gate2-qc.json`; use `approve_all` only when the report and artifacts are acceptable.
9. Before Gate 3 approval, inspect `render-report.json`, `gate3-qc.json`, and the final artifact.
10. When the user explicitly declares the selected video complete, record the canonical output, QA proof, and retrospective; preview `bin/pipeline finalize --config <project.yaml> --json`, then apply it as Coordinator only when the retained run and deletion scope match the completed project.

## Feedback Promotion

- Keep one-off preferences in `projects/<job>/notes.md`.
- After the local first-time setup is complete and before the next substantive proposal, ask once: `初回設定が完了しました。任意で、ローカルの「好み・学び」を定期レビューし、Codex または Claude の標準通知で承認待ちを知らせる自動化も設定しますか？（設定する／今回はしない）`
- If the user chooses `設定する`, ask which one host to use (Codex, Claude Desktop/Cowork, or Claude Code) and the desired cadence. Then follow `docs/automations/learning-promotion-review.md`; keep only one durable schedule active. If the user declines, do not ask again in the same setup flow.
- Do not create a schedule, enable push notifications, request browser/OS notification permission, or select a host without that explicit choice. Notifications are limited to the selected host's standard notification settings; never add a custom desktop notification, Slack, email, or other external destination.
- After recurring evidence has a concrete target, change summary, and verification plan, record a pending promotion proposal and obtain explicit human approval before editing shared source.
- Treat launcher approve / reject actions as append-only local feedback decisions. Approval means implementation may begin; it does not itself modify templates, rules, checks, Gates, or project state.
- Use the optional Codex or Claude host automation only to review preference/learning promotion candidates while the launcher is open or closed. It may append at most three complete, non-duplicate pending proposals per run through `pipeline feedback`; it must identify its supported source, and must not edit shared source, implement approved proposals, inspect other automations, or send browser, custom desktop, or external notifications. Codex or Claude may surface the dedicated run through the host's normal notification policy.
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
- Read `../../../docs/connections.md` before selecting or adding an external video, image, or audio generation connection.
- Read `../../../docs/shitate.md` only for an explicitly requested Shitate handoff.
- Read `../../../docs/automations/learning-promotion-review.md` when creating, reviewing, or running the dedicated learning-promotion automation.
