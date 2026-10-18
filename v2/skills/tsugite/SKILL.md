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
Review plugin licenses and code before installation. The current alpha accepts
local offline plugins only; network/paid integrations are not implemented.

The confirmation page prevents accidental operation. It cannot isolate an agent
running under the same OS account. Do not promise otherwise. Do not publish,
send material externally, change credentials, or spend credits without explicit
authorization. Preserve v1 production projects; `init --from-v1` only copies the
limited supported silent local-clip subset and never imports approvals.

For MCP clients, start `tsugite mcp` with cwd fixed to the video folder. Available
tools: check, status, plan, make, export, note, clean. The server uses the same
dispatcher as the CLI and cannot approve any check.
