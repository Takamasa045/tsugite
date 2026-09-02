# Planning and dry-run

Planning turns a validated project into a deterministic execution plan, while `run --dry-run` exposes intended actions without executing adapters or writing run state.

## Sub-features

- `PLN-CLI-01` — produce a deterministic plan for the copied project.
- `PLN-CLI-02` — inspect backend and prompt-guidance decisions.
- `PLN-CLI-03` — preview execution with `run --dry-run` and no adapter call.

## How to get to it (user POV)

- Run `node bin/pipeline plan --config` after validation.
- Run `node bin/pipeline run --config --dry-run` for the no-execution preview.
- The loopback launcher's Plan and dry-run actions are separate browser/API entry points and are uncovered here.

## Driving it with Node CLI

Preconditions: Launch and Doctor completed and `VERIFY_TSUGITE_MANIFEST` points to their run manifest; network is denied. This feature is mapped but was not exercised in the bootstrap slice.

1. Run `VERIFY_TSUGITE_PROJECTS_HOME="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.scratch.projects_home)' "$VERIFY_TSUGITE_MANIFEST")"` and `VERIFY_TSUGITE_CONFIG="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.scratch.config)' "$VERIFY_TSUGITE_MANIFEST")"`.
2. Run `TSUGITE_PROJECTS_HOME="$VERIFY_TSUGITE_PROJECTS_HOME" /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' node bin/pipeline plan --config "$VERIFY_TSUGITE_CONFIG" --json`.
3. Expect exit 0, `ok: true`, `command: "plan"`, and a plan whose `run_id` is `local-fixture-run`.
4. Run `TSUGITE_PROJECTS_HOME="$VERIFY_TSUGITE_PROJECTS_HOME" /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' node bin/pipeline run --config "$VERIFY_TSUGITE_CONFIG" --dry-run --json`.
5. Expect exit 0, `ok: true`, `command: "run"`, dry-run output only, zero provider submission, and no `state.json` or run log.
6. Preserve both stdout/stderr/exit records and a before/after project snapshot before marking the entry verified.

## Gotchas

- The variable values must come from a new run-owned manifest; never point them at a user's normal `projects/` directory.
- `run --dry-run` is not authorization for non-dry-run `run`, rendering, or a Gate decision.
- Prompt catalogs and backend declarations are advisory capabilities, not provider execution proof.
- This mapped path has no bootstrap-run evidence yet and must remain reported as uncovered until driven separately.
