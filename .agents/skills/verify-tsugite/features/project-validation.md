# Project validation

Project validation checks the real `project.yaml`, manifest, media, backend capabilities, and safety constraints without running adapters or changing a Gate.

## Sub-features

- `VAL-CLI-01` — validate the copied local fixture end to end.
- `VAL-CLI-02` — keep launcher shelf resolution inside the run-owned project home.
- `VAL-CLI-03` — prove that validation did not change project files or create pipeline state.

## How to get to it (user POV)

- Run `node bin/pipeline validate --config` from the repository root.
- A loopback launcher can request validation for a selected project, but that browser/API route is a separate uncovered entry point.

## Driving it with Node CLI

Preconditions: Launch and Doctor completed for `project-validation`, and `VERIFY_TSUGITE_MANIFEST` points to their durable run manifest.

1. Run `node .agents/skills/verify-tsugite/scripts/verify.mjs drive --manifest "$VERIFY_TSUGITE_MANIFEST" --feature project-validation`.
2. Expect exit 0 and helper JSON with `ok: true`, `status: "verified"`.
3. Read `validate.stdout.json`; expect `command: "validate"`, `ok: true`, `issues: []`, `launcher_already_home: true`, and `launcher_linked: false`.
4. Compare `fixture-before.json` and `fixture-after.json`; expect identical file paths, sizes, modes, and SHA-256 values.
5. Confirm the snapshots contain no `dist`, `state.json`, or `run-log.md`.
6. Run Cleanup, then `node .agents/skills/verify-tsugite/scripts/verify.mjs validate-evidence --manifest "$VERIFY_TSUGITE_MANIFEST"`; expect every final check to be true.

## Gotchas

- `validate` normally makes projects outside the durable home visible on the launcher shelf. The helper sets a fresh `TSUGITE_PROJECTS_HOME` and places the fixture inside it so no shared shelf link is created.
- `launcher_visible: true` proves visibility only inside the disposable project home; it does not prove the user's normal launcher UI.
- Validation is not planning, Gate approval, generation, rendering, or media QA.
