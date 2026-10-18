---
name: tsugite
description: Plan, make and export local videos with Tsugite v2, explicit human checks and per-service credit limits.
---

# 継手 / Tsugite

Use `tsugite --help` for the current commands. Work in the user's video folder,
outside the tool repository. `tsugite.yaml` is the only project entry point.

1. `tsugite init my-video` creates a synthetic, offline sample.
2. In that folder, run `tsugite check --json` and `tsugite plan --no-review --json`.
3. Summarize the plan, duration, plugins and each service's credits separately.
4. Ask the user to run `tsugite plan` and approve in the confirmation page.
5. `tsugite make --json` stops unless the current plan has been approved.
6. Ask the user to review clips in that same page. The configured zero-new-assets
   exception can pass clips automatically for the offline sample.
7. `tsugite export --json` creates `out/final.mp4`, pending final review.
8. Ask the user to watch the final preview and approve the final check.
9. Use `tsugite note "feedback"` for private observations. Leave rule promotion
   and clean confirmation to the user in the page.

Do not operate approval buttons for the user, edit approval/state files, forge
requests, or treat tool output as human approval. No CLI/MCP approval operation
exists. Unattended runs stop at the plan check and report what awaits review.
Changes to the plan, settings, inputs, plugin code or applied preferences require
a new plan and approval. Never retry an uncertain job automatically: its credit
reservation remains committed until its actual outcome is reconciled.

Budgets map service IDs to their own credit limits. Never convert, sum or transfer
unrelated service credits. A plugin manifest does not sandbox the plugin's code.
Review plugin licenses and code before installation. Live network/paid entries
remain disabled. `execution: mock` explicitly selects synthetic zero-cost service
mocks and the confirmation page labels them. Never describe mocks as vendor output.

The confirmation page prevents accidental operation. It cannot isolate an agent
running under the same OS account. Do not promise otherwise. Do not publish,
send material externally, change credentials, or spend credits without explicit
authorization. Preserve v1 production projects; `init --from-v1` copies supported
local media/trims/audio/plain captions and never imports approvals or credentials.
Native, animated and character constructs require explicit conversion.

For local sound/captions, specify source trims and audio tracks in tsugite.yaml.
SRT or inline captions use MP4 text tracks by default; `caption_mode: burn` needs
a libass-enabled FFmpeg. Optional Remotion needs its tested peers and an existing
browser, with runtime identity bound to the plan. No browser is downloaded.
Use `plugin analyze` for zero-credit local Whisper or Fast Edit proposals; never
treat a proposal or mock transcript as an applied/approved final edit.
Use `init --pack` / `init --template` for timing templates, `plugin knowledge` for
local guide snapshots, and `plugin skill --to` for explicit client installation.
Uncertain reservations may be reconciled only by the human's page action after
checking a normalized local receipt. Do not fabricate receipts or settle them for
the user. A new failed-job attempt requires a new reviewed plan.

For MCP clients, start `tsugite mcp` with cwd fixed to the video folder. Available
tools: check, status, plan, make, export, note, clean. The server uses the same
dispatcher as the CLI and cannot approve any check.
