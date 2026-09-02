# Story guidance

Story guidance recommends a primary framework, supporting frameworks, rejected alternatives, timing, and film grammar before a user designs shots.

## Sub-features

- `STR-CLI-01` — list available story frameworks.
- `STR-CLI-02` — recommend frameworks for a brief and duration.
- `STR-CLI-03` — surface timing allocation and film grammar without changing a project.

## How to get to it (user POV)

- Run `node bin/pipeline story-guides --json` to list the catalog.
- Run `node bin/pipeline story-guides --request "30秒の縦型SNS広告。価値と実績を見せる" --duration 30 --json` for the documented recommendation entry.
- Creative planning shown later in review artifacts is downstream evidence, not proof that this command was driven.

## Driving it with Node CLI

Preconditions: repository dependencies already exist and the command runs under a local network-deny boundary. This feature is mapped but was not exercised in the bootstrap slice.

1. Run `/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' node bin/pipeline story-guides --request "30秒の縦型SNS広告。価値と実績を見せる" --duration 30 --json`.
2. Expect exit 0, `ok: true`, `command: "story-guides"`, and `scope: "creative-guidance-only"`.
3. Expect a first-choice framework, supporting candidates, rejected candidates with reasons, duration allocation, and film grammar in stdout.
4. Preserve stdout, stderr, expanded argv, and exit code before claiming this entry verified.

## Gotchas

- Guidance is advisory and does not prove adapter availability, entitlement, credits, or output quality.
- Do not copy distinctive plots or creator expression; the repository abstracts structural roles.
- This mapped path has no bootstrap-run evidence yet and must remain reported as uncovered until driven separately.
