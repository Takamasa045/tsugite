# Pipeline doctor

A user can ask Tsugite whether this machine (and, optionally, one project) is ready before any generation. `doctor` prints a machine-readable list of checks (Node 22.12+ in the 22.x line, npm 10+, ffprobe, ffmpeg, and with `--config` the project, selected backend file, and declared setup probes). It does not write Gate state, does not submit generation, and does not create a launcher shelf link.

## Sub-features

- `doctor-runtime` Report `node`, `npm`, `ffprobe`, `ffmpeg` without a project file.
- `doctor-project` With `--config`, add `project`, `backend:<name>`, and backend/adapter setup probes only.
- `doctor-fail-closed` Any blocking miss sets top-level `ok` to false; remediations stay local (install ffmpeg, `npm ci`).

## How to get to it (user POV)

- Repository root terminal: `node bin/pipeline doctor` or `node bin/pipeline doctor --config <project.yaml>`.
- Command help: `node bin/pipeline help doctor`.
- After clone, README “Developer and manual setup” and Bootstrap tell agents to run doctor on the zero-credit sample — not on a paid connection.
- The local launcher does not run doctor; it is a CLI-only readiness surface.

## Driving it with CLI --json

Preconditions:

- Cwd is the Tsugite repository root; `npm ci` has completed if you will use `doctor-project` (Remotion probe imports `@remotion/renderer` / `@remotion/bundler`).
- Isolation is optional for `doctor-runtime` (no shelf link). For `doctor-project`, still use the isolated fixture so you never pass a production `--config`.
- ffmpeg/ffprobe on PATH. This skill does not install system packages.

- **Action.** User asks “is this machine ready?” Exact command: `node bin/pipeline doctor --json`. Observable result: exit 0, stdout JSON with `"ok": true`, `"command": "doctor"`, and `checks` containing objects named `node`, `npm`, `ffprobe`, `ffmpeg` each with `"ok": true` and `"status": "ready"`. Save stdout as `evidence/doctor.json`.

- **Action.** User points doctor at the bundled local sample (via the isolated copy). Exact commands:

```sh
eval "$(.cursor/skills/verify-tsugite/helpers/isolate-local-fixture.sh)"
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline doctor --config "$VERIFY_CONFIG" --json
```

Observable result: exit 0, `checks` also include `project` (detail is the config path), `backend:remotion` (file `backends/remotion/render.mjs` exists), and `tool:remotion` (setup probe from `backends/remotion/capabilities.yaml`). No `credential:*` checks — this fixture has no generation adapter.

- **Action.** User has a missing tool. Exact command is the same `doctor --json`. Observable result: exit 1, `"ok": false`, the missing check has `"status": "missing"`, `"blocking": true`, and a `remediation` string (ffmpeg text mentions install; Node mentions 22.12). Do not install providers to “make ok green” for this skill.

## Gotchas

- `doctor` with `--config` calls `validateProject` internally but **does not** call `ensureProjectVisibleOnLauncherShelf`. `validate` / `plan` / `review` do.
- Project-scoped `ok` can be false for a valid local-media YAML if Remotion packages are missing — run `npm ci`, do not treat that as a project-authoring bug.
- Catalog / connection presence is not a doctor success. Do not pass generation projects (PixVerse/Kling credentials) as the default proof target.
- Do not use `npm run setup` here unless the user already approved Bootstrap; `setup:check` is the read-only sibling.
