---
name: verify-tsugite
description: Verify Tsugite's primary project.yaml CLI surface with a run-owned local fixture, network-denied Doctor, real project validation, durable evidence, and ownership-checked cleanup. Use after Tsugite CLI or project-contract changes and before claiming the local validation path works.
app: Tsugite
surface: CLI
---

# Verify Tsugite

This skill verifies exactly one primary surface: the public `node bin/pipeline` CLI. The loopback browser launcher, generated 3D Viewer, and development-only Electron shell are secondary surfaces and remain uncovered by this first slice.

## Launch

Run from the Tsugite repository root. Required local tools are Node.js 22.12 or newer within the 22.x line, npm 10 or newer, `ffmpeg`, `ffprobe`, `/usr/bin/sandbox-exec`, and repository dependencies already present in `node_modules`.

The helper never installs dependencies. If `node_modules/tsx/package.json` is absent, stop. The repository's documented install command is `npm ci`, but it may contact the npm registry and is outside this verification run until dependency and network access are separately authorized.

The complete cold-reader path is:

```sh
node .agents/skills/verify-tsugite/scripts/verify.mjs all --feature project-validation
```

For stepwise operation, Launch and retain the returned manifest path:

```sh
VERIFY_TSUGITE_MANIFEST="$(node .agents/skills/verify-tsugite/scripts/verify.mjs launch --feature project-validation | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).manifest))')"
```

Launch creates a unique `verify-tsugite-{run-id}` directory under Node's local temporary directory, copies `examples/local-fixture` into its own `projects/local-fixture`, and writes `run-manifest.json` under `verification/evidence/verify-tsugite/{run-id}/`. Readiness is the Launch JSON with `ok: true` and `status: "launched"`. No long-lived server exists; Doctor and Drive each start a fresh isolated CLI process.

Before each CLI starts, the helper writes its positive PID, equal process-group ID, cwd, argv, revision, source-identity digest, dependency identity, run-owned project home, and start time to the durable manifest. A gated runner prevents the CLI from starting before that ownership record is durable.

## Doctor

Run the read-only Doctor after Launch:

```sh
node .agents/skills/verify-tsugite/scripts/verify.mjs doctor --manifest "$VERIFY_TSUGITE_MANIFEST"
```

Doctor fails closed unless all of the following still match Launch: repository root and product name, Git revision and dirty-source digest (working-tree and staged diffs), helper hash, `package-lock.json` hash, `node_modules` real path, scratch ownership record, copied fixture hash, and macOS network-deny sandbox. It then runs the public `node bin/pipeline doctor --config` command against the config and `TSUGITE_PROJECTS_HOME` recorded in the manifest. The helper invocation above is the exact runnable recipe; `doctor.exit.json` records its fully expanded inner argv.

The exact expanded argv is preserved in `doctor.exit.json`. Doctor is healthy only when the command exits 0, returns `ok: true`, and every observed Node, npm, ffprobe, ffmpeg, project, Remotion backend, and Remotion tool check is `ready`. It must leave the copied project byte-for-byte unchanged. Unknown ownership, a stale process, changed source, shared state, a missing dependency, or unavailable network isolation blocks Drive; Doctor never repairs or seeds anything.

## Drive

The selected feature is `project-validation`. After Doctor reports `status: "verified"`, run:

```sh
node .agents/skills/verify-tsugite/scripts/verify.mjs drive --manifest "$VERIFY_TSUGITE_MANIFEST" --feature project-validation
```

The helper starts the real `node bin/pipeline validate --config` CLI under the same network-deny boundary, using the config and `TSUGITE_PROJECTS_HOME` recorded in the manifest. The helper invocation above is the exact runnable recipe; `validate.exit.json` records its fully expanded inner argv.

The action is verified only when the exit code is 0, `ok` is true, `issues` is empty, the command is `validate`, `launcher_already_home` is true, `launcher_linked` is false, and `launcher_projects_home` resolves to the recorded scratch home. A second fixture read must match the first, and no `dist`, `state.json`, or `run-log.md` may appear. The helper does not call `run`, `render`, `gate`, a provider, or a remote service.

## Evidence

Durable evidence is stored outside disposable scratch at `verification/evidence/verify-tsugite/{run-id}/`. Fresh evidence is ignored by Git so it does not create revision cycles. The directory contains:

- `run-manifest.json`: feature, entry point, expanded command identity, cwd, host/runtime, revision and source digest, run ID, timestamps, process ownership, result, and cleanup status.
- `fixture-source.json` and `fixture-copied.json`: Launch copy proof.
- `doctor.stdout.json`, `doctor.stderr.txt`, and `doctor.exit.json`: runtime action, state, stderr, exit, argv, signal, and timeout proof.
- `fixture-before.json`, `validate.stdout.json`, `validate.stderr.txt`, `validate.exit.json`, and `fixture-after.json`: validation action, observed state, and the second read proving no project mutation.
- `cleanup.json`: exact scratch removal, evidence preservation, and any positively identified PIDs signaled.
- `evidence-validation.json`: final `verified` or `blocked` checks.

After Cleanup, validate the bundle:

```sh
node .agents/skills/verify-tsugite/scripts/verify.mjs validate-evidence --manifest "$VERIFY_TSUGITE_MANIFEST"
```

The result is `verified` only when Doctor, Drive, Cleanup, read-back equality, network denial, and the no-Gate/no-render process history all pass. Failed commands remain `blocked` with their stdout, stderr, exit data, and unmet condition. The helper records no tokens, cookies, credentials, personal data, or provider URLs.

## Cleanup

Run Cleanup after success and after every failed Doctor or Drive:

```sh
node .agents/skills/verify-tsugite/scripts/verify.mjs cleanup --manifest "$VERIFY_TSUGITE_MANIFEST"
```

Cleanup is idempotent. It removes only the exact temporary directory whose basename, parent, `run_id`, manifest path, cwd, and projects home match the scratch ownership record. It never removes the evidence directory or generated skill.

If a recorded runner remains, Cleanup re-reads the process table, requires a positive PID, requires PID equal to the recorded process group, and requires the command to contain this helper's `__runner` marker. Only positively enumerated PIDs in that verified group are signaled. If ownership is ambiguous, Cleanup leaves the process and scratch untouched and records `blocked`; it never kills by process name or an unverified process group.

## Helpers

`.agents/skills/verify-tsugite/scripts/verify.mjs` is the only shipped helper and is executable. Invoke it with Node from the repository root.

- `launch [--run-id id] --feature project-validation`: creates new scratch and evidence; refuses existing paths and invalid IDs; outputs the manifest path.
- `doctor --manifest path`: performs identity checks and the public Doctor action; writes Doctor evidence.
- `drive --manifest path --feature project-validation`: performs real project validation and mutation read-back; writes action evidence.
- `cleanup --manifest path`: ownership-checks live PIDs and removes only scratch; preserves evidence.
- `validate-evidence --manifest path`: reads the preserved bundle and writes the final validation report.
- `all --feature project-validation [--run-id id]`: runs Launch, Doctor, Drive, Cleanup, and evidence validation; Cleanup is attempted even when Doctor or Drive blocks.

All inputs are local paths or the single feature ID. Outputs are JSON on stdout plus the named durable files. The helper owns only its unique temp directory, evidence directory, gated runner PIDs, and copied fixture.
