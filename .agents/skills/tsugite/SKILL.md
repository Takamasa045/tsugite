---
name: tsugite
description: Plan, produce, review, QA, or finalize a Tsugite video project from project.yaml under human approval gates, including character consistency and optional Shitate handoff. Use for video-production work, not repository code maintenance, documentation-only edits, or a mere mention of Tsugite.
---

# Tsugite

## Goal

Run a vendor-neutral video editing pipeline from a project `project.yaml` through validation, planning, gated execution, and quality checks.

When the user speaks in natural language (not YAML), translate their intent into IR yourself. Never require them to author `locked_blocks`, `scenes`, or hashes by hand.

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

1. Read the selected `project.yaml` (or create one from a natural-language brief under durable `projects/`) and state the goal and completion condition in one sentence.
   Create production projects under the durable launcher projects home (main worktree `projects/`, or `TSUGITE_PROJECTS_HOME`) **before** any production work, not only inside ephemeral feature worktrees. After the first `validate`, confirm `launcher_visible` / `launcher_project_root` so the launcher lists the draft. Never `git worktree remove` a tree that still holds the only copy of a project (draft or final).
2. **Identity-lock decision (natural language):** If the request matches Identity Lock Triggers below, run the Identity Lock Protocol **before** inventing a full shot list. Do not ask the user to write YAML, sha256, or IR field names.
3. Before proposing structure or shots, run `bin/pipeline story-guides --request "<creative brief>" --duration <seconds> --json`; explain the primary framework, supporting frameworks, rejected alternatives, timing preset, and applied film grammar. When identity lock applies, prefer continuity-friendly grammar (including `scene-master-blocking` when relevant).
4. For generation requests, make the input mode explicit and run `bin/pipeline guides --json` to discover available prompt knowledge.
5. Write or update IR (`h3` / `video_prompt`) yourself from the brief and identity-lock confirmations. Use `bin/pipeline lock-block` to compute locked-block hashes; never hand-edit sha256 alone.
6. Run `bin/pipeline validate --config <project.yaml> --json`. Resolve any `LOCK-E001` before Gate 1. Treat `identity.subject_unlocked` as a plan warning to report in plain language: fixed prose approval alone does **not** clear it. Set `locked: true` only after the user has visually confirmed identity across multi-condition or multi-shot generation results (or explicitly accepts residual risk for a low-stakes run).
7. Run `bin/pipeline plan --config <project.yaml> --json` and inspect every `prompt_guidance` status before finalizing prompts.
8. For a multi-source composition project, run `analyze` and then `compose` as Coordinator. Compare the proposals in `review`, set exactly one `edit.composition.proposal_id`, and regenerate `review`; an unselected or stale proposal is not eligible for Gate 1 approval.
9. Run `bin/pipeline review --config <project.yaml> --open --json`, inspect the storyboard HTML and `review-data.json`, including the motion/animation plan and production conditions, then stop at Gate 1. Ask for the Gate 1 decision exactly once, after those checks, with approve / revise / abort; do not present an earlier Gate 1 prompt during planning or review preparation.
10. Run generation or render commands only after explicit approval.
11. Before Gate 2 approval, inspect `gate2-qc.json`; use `approve_all` only when the report and artifacts are acceptable. When the project opted in with `gates.gate_2.auto_pass: qc_ok_no_new_assets` and `run` returned `gate_2_auto_passed: true`, do not ask for a Gate 2 decision; instead report the evidence that allowed it (QC issues, actual credits, newly generated asset count) and that the state moved to `rendering`. The state moving to `rendering` does not start a render: `render` still runs only as an explicitly approved command. When `run` returns `gate_2_auto_passed: false`, report `gate_2_auto_pass_blocked_reason` and ask for the Gate 2 decision as usual.
12. Before Gate 3 approval, inspect `render-report.json`, `gate3-qc.json`, and the final artifact.
13. When the user explicitly declares the selected video complete, record the canonical output, QA proof, and a closeout retrospective covering failures, improvements, and next-run lessons (explicitly record when there were no failures). Append each failure to the project `feedback.jsonl`; append reusable rules to `LESSONS.md`. Check prior feedback by the same failure key and prior lessons by matching symptom and cause: if it recurs, record it as `recurring` and assess it as a promotion candidate. Create a pending promotion proposal only when its target, change summary, and verification plan are concrete; never modify shared rules without human approval. Include the recording and promotion-candidate result in the completion report, then preview `bin/pipeline finalize --config <project.yaml> --json`, copy `plan_digest` from that JSON, and apply only as Coordinator with `bin/pipeline finalize --config <project.yaml> --apply --actor coordinator --expected-plan-digest <plan_digest> --json` when the retained run and deletion scope match the completed project. Optional `--state-dir` must equal `project.dist_dir` only. After apply, confirm `launcher_visible` / `launcher_project_root` (durable main `projects/` home); feature-worktree-only projects must be promoted there so the launcher lists them and worktree cleanup cannot erase the only copy.

## Repository Work and Worktree Lifecycle

For code or documentation changes, read [development and verification](../../../docs/development-workflow.md). Before choosing a worktree and at task completion, follow its worktree selection, preview, approval, protected-content, defer/reconcile, and report-only warning rules. A production project's only copy must never be removed with a worktree.

## Identity Lock Triggers

Apply the Identity Lock Protocol when **any** of the following is true for a generation-oriented video request:

- The user supplies or names a **character** (image, sheet, Shitate character, recurring persona, named cast).
- The brief is **multi-shot narrative / story / dialogue sequence** with the same person or place across cuts (including Japanese asks like 長尺・ストーリー・複数カット・キャラを揃えて).
- The user asks for **identity / face / voice / location consistency** across shots.
- Duration and structure imply **3+ generated shots** that share cast or setting (not a single isolated clip).

**Do not force identity lock** for pure local-media edit of existing clips with no character generation, single one-off B-roll without a recurring subject, or explicit user instruction to skip consistency machinery.

## Identity Lock Protocol (natural language → IR)

Human-facing language only. YAML, hashes, and IR paths stay agent-side.

1. **Restate the brief** in one sentence (what story / place / duration / who appears).
2. **Character lock draft (once):** From the user's words + any reference image / Shitate import, propose plain-language fixed lines for:
   - voice (register, tempo, accent, manner — not emotion labels alone)
   - appearance (stable visual identity; body features, clothing baseline)
   - manner (physical micro-actions, gaze, breath — not bare emotion words)
   Show these to the user as readable prose (not schema keys). Ask once: この声・外見・仕草の固定で進めてよいか.
3. **Scene lock draft (once per location):** Propose an anchor-based place description (not "left/right" alone) and optional lighting/palette. Ask once if multi-shot shares a place.
4. **State variants when needed:** If the character changes state (wet, injured, costume change), separate as variants + assets; do not mix states into one appearance paragraph.
5. **Write IR yourself** under `generation.requests[].h3` or `video_prompt`:
   - `subjects[].locked_blocks` via `bin/pipeline lock-block --config <project.yaml> --subject <id> --field <voice|appearance|manner> --text "..."` (or `--text-file`)
   - `scenes[]` + `shots[].scene`
   - `shots[].cast` / `variants` when state-separated assets exist
   - `subject_expectations` when person-consistency QA will run
6. **Wire Shitate only when requested:** import snapshot first, then point `source_asset` / variant assets at the imported anchor paths. Do not leave Shitate external paths in the IR.
7. **`locked` flag:** Keep `locked: false` (or omit) through first planning and after fixed-prose approval. Approving voice/appearance/manner **text** is not enough. Set `locked: true` only after the user has checked generated results for identity consistency across the intended conditions (or multiple shots), or after they explicitly accept residual drift risk. Never auto-run credit-burning stress tests, and never flip the flag silently.
8. **Shot list after locks:** Build shots that **reference** the fixed subject/scene; do not rephrase locked voice/appearance/manner or location_map per shot. Shot text may only append action/timing.
9. **Revise loop:** On user feedback, change **one** thing per regeneration cycle (one shot visual, or one camera, or one locked field via `lock-block`). If plan/review shows `iteration.multi_block_change` or `iteration.retry_saturation`, explain in plain Japanese and suggest simplifying or splitting the shot — do not auto-regenerate.
10. **Gate boundaries unchanged:** Identity lock never approves Gates, never starts `run`/`render`, and never spends credits without explicit human approval.

### Agent communication pattern (example)

User: 「このキャラで、夜の船着き場の短い話を作って」

Agent (before full shotlist):

- ゴール一文
- 固定する声・外見・仕草（読みやすい日本語 or 生成向け英語プロス）
- 場所の固定（アンカー基準）
- 「この固定で plan に進めてよいか」

Only after that confirmation (or explicit “そのまま進めて”), write IR + `lock-block`, then `story-guides` → `validate` → `plan` → `review` → Gate 1.

## Feedback Promotion

- Keep one-off preferences in `projects/<job>/notes.md`.
- After local first-time setup and a successful `doctor`, before the next substantive proposal, follow [the one-time automation question](../../../docs/automations/learning-promotion-review.md#初回セットアップ後の確認). Ask once; create no schedule without the user's explicit host/cadence choice; keep one durable schedule and only the chosen host's standard notifications. Do not ask again in the same setup flow after a decline.
- After recurring evidence has a concrete target, change summary, and verification plan, record a pending promotion proposal and obtain explicit human approval before editing shared source.
- Treat launcher approve / reject actions as append-only local feedback decisions. Approval means implementation may begin; it does not itself modify templates, rules, checks, Gates, or project state.
- Use the optional Codex or Claude host automation only to review preference/learning promotion candidates while the launcher is open or closed. It may append at most three complete, non-duplicate pending proposals per run through `pipeline feedback`; it must identify its supported source, and must not edit shared source, implement approved proposals, inspect other automations, or send browser, custom desktop, or external notifications. Codex or Claude may surface the dedicated run through the host's normal notification policy.
- Promote reusable project shapes and style choices into `examples/` or `templates/`.
- Promote machine-checkable failures into constraints, `validate`, or `doctor`, with a reproducing fixture and test.
- Record new operating rules in `LESSONS.md`, then promote judgment-based rules into this skill or `AGENTS.md`.
- Promote QA decision rules into Gate 2 / Gate 3 checks, report schemas, fixtures, and tests.
- Keep `LESSONS.md` append-only and mark promoted entries with their validation status.
- Completion closeout must record failures, improvements, and next-run lessons in addition to canonical-output and QA evidence. Use the same failure `key` across projects to detect recurrence and compare lesson symptoms and causes; no matching prior record is a confirmed non-candidate, while a recurring failure needs an explicit promotion-candidate assessment even when there is not yet enough detail to propose a change.

## Optional Shitate Handoff

- Treat Shitate as an optional external character-design repository, not a normal pipeline dependency.
- Use `bin/pipeline shitate-import` only when the user explicitly requests a Shitate snapshot handoff.
- Before import, show the source root, character, run ID, anchor, destination, and planned manifest/request updates, then obtain explicit approval.
- Copy a SHA-256-locked snapshot into `media/shitate/`; do not generate media, update Gates, send data externally, or authorize non-dry-run execution during import.
- After import, fold the snapshot into identity lock: `source_asset` / `variants[].source_asset` under project-local paths only, then run Identity Lock Protocol steps for voice/appearance text if still missing.
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
- Apply only with `--expected-plan-digest` taken from the matching preview `plan_digest`. `--state-dir` for finalize must equal `project.dist_dir`; other values are rejected before any run lock.
- Keep the selected final run, final-manifest media, and text records. Delete only superseded media from older runs, older QA, and unused project media, then write `completion-record.json`.
- Treat Gate 2 `retry_specific` as unavailable; use `revise` for a full re-plan.
- Stop at every Gate for a human decision, with one narrow exception: Gate 2 auto-pass for a project that opted in with `gates.gate_2.auto_pass: qc_ok_no_new_assets`. It applies only when the run consumed 0 credits, generated 0 new assets, and `gate2-qc.json` reported no issue at all. One QC issue always stops the run; credits above 0 never auto-pass; a generation project can never opt in. Gate 1 and Gate 3 always require a human decision.
- In Claude Code, keep `.claude/settings.json` in default permission mode. Keep Gate decisions, non-dry-run execution, commit, push, and PR creation approval-gated.

## References

- Read `../../../references/lessons-graduation.md` when promoting feedback into reusable rules, templates, checks, or contracts.
- Read `../../../templates/README.md` before selecting or adding a reusable project template.
- Read `../../../docs/story-guides.md` when interpreting story-framework recommendations.
- Read `../../../docs/prompt-guides.md` when generation prompt guidance is involved.
- Read `../../../docs/connections.md` before selecting or adding an external video, image, or audio generation connection.
- Read `../../../docs/design/identity-lock-and-scene-consistency.md` when applying Identity Lock Protocol (machine contracts for locked_blocks / scenes / variants / iteration).
- Read `../../../docs/design/identity-lock-m0-contract.md` for Phase A hash/inject boundaries and `lock-block` CLI.
- Read `../../../docs/shitate.md` only for an explicitly requested Shitate handoff.
- Read `../../../docs/automations/learning-promotion-review.md` when creating, reviewing, or running the dedicated learning-promotion automation.
