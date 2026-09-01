# Pipeline validate

A user can check that a `project.yaml` plus its local `manifest.json` and media files are consistent before planning. `validate` is catalogued as `read-only` for the project/manifest, but the CLI still registers the project on the durable launcher shelf (directory link when the project is outside that home). For a valid local-media job the user sees `"ok": true`, an empty or non-blocking `issues` list, and `launcher_visible` / `launcher_project_root` so the launcher can list the draft.

## Sub-features

- `validate-local-media` Accept `examples/local-fixture` shape: remotion backend, two local clips, no `generation` block.
- `validate-issues` Failed checks return `"ok": false` and `issues[].code` (manifest path, missing clip, schema) on stderr when `--json`.
- `validate-launcher-shelf` After success, JSON includes `launcher_visible`, `launcher_already_home`, `launcher_linked`, `launcher_projects_home`, `launcher_project_root`, `launcher_config_path`.

## How to get to it (user POV)

- README “Commands”: `node bin/pipeline validate --config projects/my-first-run/project.yaml --json` after copying the sample.
- `projects/README.md` and Bootstrap: copy `examples/local-fixture` or `examples/quickstart-local`, then validate.
- Help: `node bin/pipeline help validate` (`usage`: `node bin/pipeline validate --config <project.yaml> [--json]`).
- Agents following `.agents/skills/tsugite/SKILL.md` run validate before Gate 1. Users do not type YAML hashes.

## Driving it with CLI --json

Preconditions:

- `helpers/isolate-local-fixture.sh` has been run so `VERIFY_CONFIG` is a copy under `TSUGITE_PROJECTS_HOME`. This keeps the shelf linker from touching production `projects/`.
- Isolated copy still has `media/clip-001.mp4` and `media/clip-002.mp4` (7264-byte bundled clips in `examples/local-fixture/media/`).
- `npm ci` done. ffmpeg not required for this fixture’s validate (asset existence + schema).

- **Action.** User validates the isolated local sample. Exact commands:

```sh
eval "$(.cursor/skills/verify-tsugite/helpers/isolate-local-fixture.sh)"
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline validate --config "$VERIFY_CONFIG" --json
```

Observable result: exit 0, stdout JSON `"ok": true`, `"command": "validate"`, `issues` empty, `"launcher_visible": true`, `"launcher_already_home": true` (copy lives inside the isolated home so no new symlink), `"launcher_linked": false`. `launcher_config_path` equals the isolated `project.yaml`. This checkout also emits `resolved_mode` / `mode_source` from runtime-authority resolution; they are diagnostic, not a Gate. Save stdout as `evidence/pipeline-validate.json`.

- **Action.** User validates a broken path. Exact command: `node bin/pipeline validate --config /nonexistent/project.yaml --json`. Observable result: exit 1, stderr JSON `"ok": false`, `issues` non-empty (load/path code). Do not create that path.

- **Action.** Confirm the durable production shelf was not mutated. Exact command: `git status --short projects` and `ls projects`. Observable result: no new symlink named `local-fixture` or `verify-local-fixture` under repo `projects/` while `TSUGITE_PROJECTS_HOME` was the isolated directory.

## Gotchas

- **Shelf side effect:** without `TSUGITE_PROJECTS_HOME`, a successful validate of a fixture outside `projects/` creates `projects/<slug>` as a directory symlink. That is why isolation is mandatory even though the command’s catalog safety is `read-only`.
- Asset `src` must stay inside the project asset root (`src/manifest/assets.ts`). Do not point the isolated manifest at `../../../../fixtures/media/…`.
- `fixtures/projects/local-valid.yaml` is a **generation** fixture (`adapter: pixverse`). Do not use it as the default user-facing local-media proof.
- `launcher_visible` false with `ok` false means shelf registration failed (lock/boundary). Stop; do not retry against durable `projects/`.
- Validate does not write `dist/` or `state.json`.
