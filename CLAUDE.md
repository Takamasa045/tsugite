# CLAUDE.md

Read [AGENTS.md](AGENTS.md) for repository-wide constraints and conditional entry points. Start with a one-sentence goal and completion condition. For code/documentation work and worktree selection or cleanup, read [development and verification](docs/development-workflow.md).

## Claude Code entry points

- For video-production work, use `/tsugite` or `.claude/skills/tsugite/SKILL.md` to load the canonical `.agents/skills/tsugite/SKILL.md` completely. Its Identity Lock Protocol, story-guides-before-shots, Gate decisions, and completion requirements apply.
- Use `/tsugite-plan <project.yaml> | <creative brief> | <duration>` for safe planning through Gate 1 review, without approving the Gate.
- Use `/tsugite-verify [path or test]` after code or documentation changes. Follow the change conditions in development and verification: typo/explanation/link-only edits use document checks; code, execution instructions, approval rules, or Skill behavior changes require focused tests and `npm run check`. Viewer changes also require Viewer checks.
- Use `/tsugite-finalize <project.yaml>` only after the user explicitly declares that selected video complete.
- Use `/shitate-import <project.yaml> <shitate-root> <character> <run-id> ...` only for a requested optional Shitate handoff. Show the source, destination, and manifest/request updates and obtain explicit approval before copying the locked snapshot. It authorizes no generation, Gate update, external send, or non-dry-run execution.
- After local first-time setup and a successful `doctor`, before the next substantive proposal, follow [the one-time automation question](docs/automations/learning-promotion-review.md#初回セットアップ後の確認). Registration requires an explicit choice; do not ask again in that setup after a decline.
- Use `/tsugite-learning-review [optional run id]` only to prepare the dedicated local learning-promotion approval queue under [its workflow](docs/automations/learning-promotion-review.md). `/loop 24h /tsugite-learning-review` is short-lived and session-scoped, not a durable schedule.

## Permissions

- Keep `.claude/settings.json` in default permission mode and retain `.claude/hooks/guard-sensitive-actions.mjs`. Routine checks, ask rules, secret-file denials, and destructive-command denials are defined there; they are not replaced by a prose link or a Skill's `allowed-tools`.
- Gate decisions, non-dry-run execution, commit, push, and PR creation remain approval-gated. Never use `--dangerously-skip-permissions`.
- Stop at every Gate for a human decision except the narrow, opted-in Gate 2 auto-pass described in AGENTS and the canonical Skill: 0 credits, 0 new assets, and no QC issue. Report its evidence; it does not itself start a render.
