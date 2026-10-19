# Ways to ask

Only examples that match shipped behavior. Each one splits **what you need**, **approval before execution**, and **generation-service billing**. The short list is in [README.md](../../README.md).

Requests that cannot be backed by code (unverified live generation quality, automatic model download, actually sending to MiniMax) are omitted. No billed dry-run was executed for this page.

## A 30-second vertical ad — structure only

Planning only. No clip generation.

> I want a 30-second vertical social ad that shows value and proof. Propose the structure and stop at the plan check (Gate 1). Do not generate yet.

- **What you need:** A set-up production and a short brief (who should see what).
- **Approval before execution:** `story-guides` → `plan` → `review` do not advance a Gate. `review` does not change `state.json`. This example stops at Gate 1. `run` needs a separate explicit approval.
- **Generation-service billing:** 0 on this path. A story-guide catalog is advice, not an execution capability.

## Chapter a local seminar video without sending it out

Local analysis of footage you already have. The “summary” is extractive from the transcript, not a generative paraphrase.

> Chapter and summarize this seminar video without sending it anywhere. Use a model file I already have; do not download one.

- **What you need:** A local video. Copy `examples/local-analysis/` into `projects/`. For local Whisper, point `model_path` and the required `model_sha256` at an existing `.pt`. Models are never auto-downloaded.
- **Approval before execution:** `analyze` requires `--actor coordinator`. Filler candidates stay as review actions, not auto-deletes. Adopting cuts still needs Gate 1.
- **Generation-service billing:** 0. No external API.

## An intro video with a locked character

Lock appearance and voice in plain language before the shot list.

> Make a product intro with this character. Confirm voice, look, mannerisms, and place first, then stop at the plan check (Gate 1).

- **What you need:** Plain-language voice and look notes, and a generation adapter you choose yourself. Unselected provider CLIs, credentials, and billing are never installed automatically. A `character-lock.json` snapshot is a separate Shitate import path.
- **Approval before execution:** The production Skill's Identity Lock Protocol runs before inventing shots. `run` only after Gate 1 and Coordinator approval.
- **Generation-service billing:** Yes. The selected generation service spends its own credits.

## Keep last time's “music in the first 0.5 seconds”

Preferences & Learnings. Recording a note does not rewrite the finished video.

> Keep last time's “start music within the first 0.5 seconds” in the next plan.

- **What you need:** After you have watched an output. Reuse the same `key` (for example `opening-audio`) for the same preference.
- **Approval before execution:** The record is local `feedback.jsonl`. Promotion into templates or rules is a **separate** task after a human approves it. Approval only permits that later work; it does not change prompts, templates, rules, Gates, or state by itself.
- **Generation-service billing:** 0 to record. A later `run` bills only if that run uses a paid generator.

## Open in Premiere Pro and fix a cut

Not a substitute for pipeline `render`. macOS external editor.

> Open this production in Premiere and fix only the cuts I named. Do not export or share yet.

- **What you need:** macOS, a licensed Premiere Pro install, and the [Premiere setup](../premiere-pro.md). Skill: `$premiere-editing` (Claude Code: `/premiere-editing`).
- **Approval before execution:** Real edits wait for Coordinator approval of that edit. An MCP confirmation token is not a Tsugite Gate. Existing Gates still apply.
- **Generation-service billing:** Premiere itself is paid software. This MCP path does not need an API key. Generation credits are unused unless you also generate.
