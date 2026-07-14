# CLAUDE.md

Use `SKILL.md` as the canonical workflow.

## Claude Code workflow

- Start with a one-sentence goal and completion condition, then follow `SKILL.md`.
- Use `/tsugite-plan <project.yaml> | <creative brief> | <duration>` for the safe planning loop.
- Use `/tsugite-verify [path or test]` after code or documentation changes.
- Use `/tsugite-finalize <project.yaml>` only after the user explicitly declares that selected video complete.
- `.claude/settings.json` allows routine checks, asks before gated execution or Git publication, and denies secret-file access and destructive commands.
- Never use `--dangerously-skip-permissions` for this repository.
- Stop at each Gate until the human chooses approve, revise, or abort.
- Keep core files neutral and move engine-specific behavior into adapter directories.

## Optional Shitate handoff

- Shitate is not required for normal Tsugite usage.
- Use `/shitate-import <project.yaml> <shitate-root> <character> <run-id> ...` only when the user requests the handoff.
- Show the source, destination, and manifest/request updates, then obtain explicit approval before `bin/pipeline shitate-import`.
- The import only copies a locked snapshot. It does not generate media, update Gates, send data externally, or authorize non-dry-run execution.
