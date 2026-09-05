# Tsugite verification feature map

Agent-facing map of user-visible, zero-credit surfaces. Product facts come from `README.md`, `src/cli/commandCatalog.ts`, and the commands below — not from memory.

## Baseline preconditions

- Repository root as cwd. `package.json` `name` is `tsugite`. Entry: `node bin/pipeline`.
- Node.js 22.12+ in the 22.x line, npm 10+, `ffmpeg` and `ffprobe` on PATH (same as `README.md` Detailed setup).
- `npm ci` completed so `tsx` and Remotion packages exist.
- Isolation: `TSUGITE_PROJECTS_HOME` = `.cursor/skills/verify-tsugite-manual/tmp/run-<unique>/projects-home` and a copy of `examples/local-fixture` created by `helpers/isolate-local-fixture.sh`. Never `--config` a production job under durable `projects/`.
- No provider login, no secrets in chat or YAML, no `run` without `--dry-run`, no `render`, no `gate`.

## Driving conventions

- Always pass `--json`. Exit 0 writes the payload to stdout; exit 1 writes it to stderr (`src/cli.ts` `output()`).
- Commands that take a project: `--config <project.yaml>`.
- `review` / `viewer` accept `--output` and `--state-dir`. For proof that must survive cleanup, pass `--output` under `evidence/`.
- `viewer-launcher` prints JSON then blocks until SIGINT/SIGTERM. Record PID + `url`. GET `/api/projects` is unauthenticated in-process (tests call it with `fetch(url + "/api/projects")`); Host must be the loopback URL host. Mutations need `x-tsugite-token` — this map never POSTs.
- Japanese UI strings (e.g. project `name: ローカル検証フィクスチャ`) are expected; this skill stays English.

## Proof / skip reporting

When driving a feature, record:

- **proved** — command, exit code, evidence path, one-line observable (e.g. `"ok": true`, `"command": "validate"`).
- **skipped** — reason that is true in this checkout (missing ffmpeg, viewer `npm ci` not run, no display for `--open`). Do not skip because a command is inconvenient.
- **blocked** — command ran and `ok` is false; paste the `issues[].code` or failing `checks[].name`.

Never report a skipped or unrun command as proved.

## Feature entry contract

Each `features/*.md` file:

1. H1 title and one paragraph of user-visible behavior.
2. `## Sub-features` — backtick ids, one line each.
3. `## How to get to it (user POV)` — entry points a user actually has.
4. `## Driving it with <harness>` — Preconditions, then **Action.** lines with exact commands and observables.
5. `## Gotchas`

## Feature files

| File | User-facing behavior | Harness |
| --- | --- | --- |
| [pipeline-doctor.md](pipeline-doctor.md) | Local runtime (and optional project) readiness report | CLI `--json` |
| [pipeline-validate.md](pipeline-validate.md) | Validate project.yaml + manifest + local assets | CLI `--json` |
| [pipeline-plan.md](pipeline-plan.md) | Deterministic plan without running adapters | CLI `--json` |
| [pipeline-review.md](pipeline-review.md) | Gate 1 storyboard HTML + `review-data.json`, no Gate change | CLI `--json` |
| [local-launcher-listing.md](local-launcher-listing.md) | Loopback launcher lists isolated `project.yaml` shelves | CLI + `curl` |

Not mapped (do not drive as success criteria): paid `run` / `render`, Gate decisions, `finalize --apply`, Shitate import, Remote MCP `service-call`, Desktop Electron packaging.
