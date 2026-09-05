# Live proof (cloud VM, 2026-09-01)

This file is the surviving record after Cleanup. Commands were run from `/workspace` on branch `cursor/verify-tsugite-skill-5aab`.

## Launch

```sh
npm ci
node bin/pipeline --help --json
```

- `npm ci`: 436 packages, 0 vulnerabilities.
- Help exit 0. JSON `"ok": true`, 30 commands including `doctor`, `validate`, `plan`, `review`, `viewer-launcher`.
- Artifact: `evidence/launch-help.json`

## Doctor

```sh
node bin/pipeline doctor --json
```

- Exit 0. `"ok": true`, `"command": "doctor"`.
- Checks: `node` ready (v22.14.0), `npm` ready, `ffprobe` ready, `ffmpeg` ready.
- Artifact: `evidence/doctor.json`

## Feature driven

`pipeline-validate` (`features/pipeline-validate.md`)

```sh
eval "$(.cursor/skills/verify-tsugite/helpers/isolate-local-fixture.sh)"
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline validate --config "$VERIFY_CONFIG" --json
```

- Isolated home: `/workspace/.cursor/skills/verify-tsugite/tmp/projects-home`
- Config: `…/verify-local-fixture/project.yaml` (copy of `examples/local-fixture`)
- Exit 0. `"ok": true`, `"command": "validate"`, `issues: []`
- `"launcher_visible": true`, `"launcher_already_home": true`, `"launcher_linked": false`
- Repo `projects/` still only `.gitkeep` + `README.md` (no production symlink).
- Artifact: `evidence/pipeline-validate.json`

## Cleanup

```sh
rm -rf .cursor/skills/verify-tsugite/tmp
```

- No long-running process was started (CLI validate is not a server).
- Isolated shelf removed. Evidence directory kept.
- Confirmed after cleanup:
  - `evidence/PROOF.md` exists
  - `evidence/launch-help.json` exists
  - `evidence/doctor.json` exists
  - `evidence/pipeline-validate.json` exists
  - `tmp/` is gone
