# CLAUDE.md

Use `SKILL.md` as the canonical workflow.

- Start with `bin/pipeline validate --config project.yaml --json`.
- Follow with `bin/pipeline plan --config project.yaml --json`.
- Stop at each Gate until the human chooses approve, revise, or abort.
- Keep core files neutral and move engine-specific behavior into adapter directories.
