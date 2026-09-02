# Gate 1 creative review

Gate 1 creative review writes a local storyboard HTML and `review-data.json` so a human can inspect the current project and plan before any approval or execution.

## Sub-features

- `REV-CLI-01` — write deterministic local review artifacts.
- `REV-CLI-02` — bind the review to the current project and plan.
- `REV-CLI-03` — keep Gate state unchanged until a human decides.

## How to get to it (user POV)

- Run `node bin/pipeline review --config --output` to write local review files.
- Open the resulting `index.html` manually for the static review surface; `--open` is intentionally excluded from automated verification.
- The loopback launcher can display review artifacts, but that served browser route is a separate uncovered entry point.

## Driving it with Node CLI

Preconditions: Launch and Doctor completed and `VERIFY_TSUGITE_MANIFEST` points to their run manifest; validation and planning pass; network is denied. This feature is mapped but was not exercised in the bootstrap slice.

1. Run `VERIFY_TSUGITE_PROJECTS_HOME="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.scratch.projects_home)' "$VERIFY_TSUGITE_MANIFEST")"` and `VERIFY_TSUGITE_CONFIG="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.scratch.config)' "$VERIFY_TSUGITE_MANIFEST")"`.
2. Run `TSUGITE_PROJECTS_HOME="$VERIFY_TSUGITE_PROJECTS_HOME" /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' node bin/pipeline review --config "$VERIFY_TSUGITE_CONFIG" --json`.
3. Expect exit 0, `ok: true`, `command: "review"`, `gate: "gate-1"`, `gate_state: "unchanged"`, and `opened: false`.
4. Read back the returned `review_path` and `review_data_path`; require both regular files inside the manifest's scratch project.
5. Hash both artifacts, confirm no `state.json` was created, and preserve stdout/stderr/exit plus the read-back hashes.

## Gotchas

- Do not use `--open` in an automated run; it targets a user's browser session and is a different surface.
- Review artifacts are required before Gate 1 approval, but their existence is not approval.
- Never call `gate`, non-dry-run `run`, `review-preview`, or `render` from this feature recipe.
- This mapped path has no bootstrap-run evidence yet and must remain reported as uncovered until driven separately.
