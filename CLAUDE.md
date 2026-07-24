# CLAUDE.md

Use `/tsugite` or `.claude/skills/tsugite/SKILL.md` to load the canonical workflow at `.agents/skills/tsugite/SKILL.md`.

## Claude Code workflow

- Start with a one-sentence goal and completion condition, then follow the loaded Tsugite skill.
- Use `/tsugite-plan <project.yaml> | <creative brief> | <duration>` for the safe planning loop.
- Use `/tsugite-verify [path or test]` after code or documentation changes.
- Use `/tsugite-learning-review [optional run id]` to prepare only the dedicated local learning-promotion approval queue; `/loop 24h /tsugite-learning-review` is short-lived and session-scoped.
- After local first-time setup and a successful `doctor`, ask once before the next substantive proposal: `初回設定が完了しました。任意で、ローカルの「好み・学び」を定期レビューし、Codex または Claude の標準通知で承認待ちを知らせる自動化も設定しますか？（設定する／今回はしない）`
- Only if the user chooses `設定する`, ask them to select Codex, Claude Desktop/Cowork, or Claude Code as the single primary host and choose a cadence. Follow `docs/automations/learning-promotion-review.md`; use only that host's standard notification settings and never enable custom desktop/browser notifications, Slack, or email. Do not ask again during the same setup flow after `今回はしない`.
- Use `/tsugite-finalize <project.yaml>` only after the user explicitly declares that selected video complete.
- `.claude/settings.json` allows routine checks, asks before gated execution or Git publication, and denies secret-file access and destructive commands.
- Never use `--dangerously-skip-permissions` for this repository.
- Stop at each Gate until the human chooses approve, revise, or abort. The only exception is Gate 2 auto-pass for a project that opted in with `gates.gate_2.auto_pass: qc_ok_no_new_assets`, and only when the run consumed 0 credits, generated 0 new assets, and QC reported no issue; report that evidence instead of asking for approval.
- Keep core files neutral and move engine-specific behavior into adapter directories.

## Optional Shitate handoff

- Shitate is not required for normal Tsugite usage.
- Use `/shitate-import <project.yaml> <shitate-root> <character> <run-id> ...` only when the user requests the handoff.
- Show the source, destination, and manifest/request updates, then obtain explicit approval before `bin/pipeline shitate-import`.
- The import only copies a locked snapshot. It does not generate media, update Gates, send data externally, or authorize non-dry-run execution.
