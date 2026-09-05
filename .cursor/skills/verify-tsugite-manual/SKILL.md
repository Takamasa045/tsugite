---
name: verify-tsugite-manual
description: Manually verify Tsugite CLI doctor, validate, plan, review/storyboard, or loopback launcher listing with isolated local media. Use the matching feature recipe; this is distinct from the network-denied Doctor/validate helper in .agents/skills/verify-tsugite. No paid generation, render, or Gate changes.
---

# Verify Tsugite Manually

Tsugite is a vendor-neutral local video-production workshop. The user-facing production path is the CLI: `node bin/pipeline <command>` from a `project.yaml`. A loopback-only browser launcher and read-only 3D viewer exist beside it. Public Desktop distribution has ended; the Electron shell is development/regression only.

This skill proves **local, zero-credit** behavior. It does not run `run` (except the documented `--dry-run` note below), `render`, `gate`, paid generation, push, or publish.

## Related verification entry

The [network-denied macOS helper](../../../.agents/skills/verify-tsugite/SKILL.md) is named `verify-tsugite` and automates only Doctor and validate with run-owned scratch and durable evidence. These manual recipes cover different surfaces and do not inherit that helper's network or ownership guarantees. Select by path, not name alone.

The previous `.cursor/skills/verify-tsugite/` entry has been renamed to avoid collision with the automatic helper. Historical files in `evidence/` retain their original paths and results; they are not evidence of this revision.

## Surfaces

| Surface | Role | How a user reaches it |
| --- | --- | --- |
| **CLI pipeline (primary)** | validate / plan / review / doctor / run / render / gates | Repository root: `node bin/pipeline …` (PowerShell: same; do not invoke extensionless `bin/pipeline` directly) |
| Local launcher (secondary) | Lists `project.yaml` shelves, templates, Preferences & Learnings; does not generate, render, or change Gates | `node bin/pipeline viewer-launcher --json` or `npm run viewer:open` |
| Per-project 3D viewer | Read-only snapshot under `dist/<run-id>/viewer/` | `node bin/pipeline viewer --config <project.yaml> --json` |
| Japanese docs | Human onboarding | `README.ja.md`, `docs/onboarding/` |

Canonical workflow text for agents is `AGENTS.md` and `.agents/skills/tsugite/SKILL.md`. Command catalog and safety levels live in `src/cli/commandCatalog.ts` and `node bin/pipeline --help`.

## Isolate (mandatory)

`validate`, `plan`, and `review` call `ensureProjectVisibleOnLauncherShelf`. A project outside the durable home gets a **directory symlink** under that home (default: repo `projects/`, or `TSUGITE_PROJECTS_HOME`).

Do **not** point `--config` at production jobs (miraichi, matsumoto v3/v4, empathy, kusakari, or anything already under durable `projects/` that is not this skill’s isolated copy).

Every Drive action in this skill:

1. Runs from the **repository root**.
2. Sets `TSUGITE_PROJECTS_HOME` to `.cursor/skills/verify-tsugite-manual/tmp/run-<unique>/projects-home`.
3. Uses a **copy** of `examples/local-fixture` (bundled 2-clip local media, `credits: 0` in provenance). Do not edit `examples/`.

```sh
VERIFY_SETUP="$(bash .cursor/skills/verify-tsugite-manual/helpers/isolate-local-fixture.sh)" || exit 1
eval "$VERIFY_SETUP"
# Retain VERIFY_RUN_DIR, VERIFY_RUN_ID, TSUGITE_PROJECTS_HOME, and VERIFY_CONFIG until Cleanup.
```

Run Isolate once per verification session, then reuse its variables across features in the same shell. If an execution tool starts a fresh shell per call, restore the exact recorded run variables rather than launching a replacement run. Each launch creates a new owned directory; it never replaces another run. The helper rejects symlinks and quotes shell values, including paths containing whitespace, apostrophes, or shell metacharacters. On failure, stop; do not evaluate failed output or use production projects.

`examples/local-fixture` is the source of truth for the copy (`slug: local-fixture`, `name: ローカル検証フィクスチャ`, `run_id: local-fixture-run`, `edit.backend: remotion`, clips `media/clip-001.mp4` and `media/clip-002.mp4`).

## Launch

No long-running process is required for doctor / validate / plan / review.

From the repository root, after a clone:

```sh
# Prerequisites observed in this repo: Node.js >=22.12 <23, npm >=10, ffmpeg + ffprobe on PATH
node --version
npm --version
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

npm ci
node bin/pipeline --help --json
node bin/pipeline help validate --json
```

`npm ci` is required (`bin/pipeline` loads `src/cli.ts` via `tsx`). `--help --json` must exit 0 and list commands including `doctor`, `validate`, `plan`, `review`, `viewer-launcher`. Safety: `doctor` / `validate` / `plan` are `read-only`; `review` and `viewer-launcher` are `local-write`; `run` / `render` / `gate` are `approval-gated`.

Optional read-only bootstrap probe (does not install system packages or spend credits):

```sh
npm run setup:check -- --json
```

### Long-running launcher (only for `local-launcher-listing`)

`viewer-launcher` always rebuilds `apps/workflow-viewer` (`npm --prefix apps/workflow-viewer run build`) then binds **127.0.0.1** on a dynamic port and **waits until the process is signaled**. First time:

```sh
npm --prefix apps/workflow-viewer ci
```

Start without `--open` (opening a browser is not required for proof):

```sh
test -n "${VERIFY_CONFIG:-}" && test -f "$VERIFY_CONFIG" || exit 1 # Reuse the Isolate run.
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline viewer-launcher \
  --projects-dir "$TSUGITE_PROJECTS_HOME" \
  --port 0 \
  --json
```

Record the PID of **this** process and the JSON `url` / `port` / `project_count`. Do not use `--open` on a headless proof. Kill only that PID (see Cleanup).

## Doctor

Environment doctor is read-only. It does **not** call the launcher shelf linker.

```sh
node bin/pipeline doctor --json
```

Expect exit 0 when the machine is ready. JSON shape:

```json
{ "ok": true, "command": "doctor", "checks": [] }
```

Each check has `name`, `ok`, `status` (`ready` | `missing` | `manual`), `blocking`, and optional `version` / `detail` / `remediation`. Baseline names without `--config`: `node`, `npm`, `ffprobe`, `ffmpeg`. Any blocking miss makes top-level `ok` false.

Project-scoped doctor (still no shelf link). Use the isolated copy:

```sh
test -n "${VERIFY_CONFIG:-}" && test -f "$VERIFY_CONFIG" || exit 1 # Reuse the Isolate run.
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline doctor --config "$VERIFY_CONFIG" --json
```

Additional checks for `examples/local-fixture`: `project`, `backend:remotion`, `tool:remotion` (probes `import('@remotion/renderer')` and `import('@remotion/bundler')` — needs `npm ci`, does not render).

If `ok` is false, stop and record the failing check names. Do not “fix” production projects. Do not install provider CLIs or set API keys for this skill.

## Drive

Read `features/README.md`, then one feature file. Prefer CLI `--json` over guessing UI. Exact commands and observables are in each feature file.

Forbidden while using this skill:

- `node bin/pipeline run` without `--dry-run`
- `node bin/pipeline render`
- `node bin/pipeline gate`
- `node bin/pipeline finalize --apply`
- `node bin/pipeline recover --apply` / `--confirm-paid`
- Mutating durable `projects/` jobs
- `git push` of production media, tags, or releases

`run --dry-run` is implemented (`safety: approval-gated` but `--dry-run` sets `executed: false` and does not submit generation). It is **not** a mapped feature here; do not treat catalog presence as execution capability.

## Evidence

Write proof under `.cursor/skills/verify-tsugite-manual/evidence/` (this directory is committed as the example location). Suggested names:

| File | Source |
| --- | --- |
| `evidence/launch-help.json` | stdout of `node bin/pipeline --help --json` |
| `evidence/doctor.json` | stdout of `node bin/pipeline doctor --json` |
| `evidence/<feature>.json` | stdout of the driven CLI command |
| `evidence/PROOF.md` | launch command, doctor `ok`, feature id, evidence paths, cleanup confirmation |

For `review`, also keep copies of `review_path` / `review_data_path` **inside** `evidence/` (default review writes into the isolated project `dist/<run-id>/review/`, which is gitignored and removed on cleanup). Use `--output` pointing at `evidence/review-out/` when you need those HTML/JSON files to survive.

Do not delete `evidence/` during Cleanup.

## Cleanup

Cleanup removes **session scratch only**. Never delete `evidence/`, this skill’s markdown, or production `projects/`.

1. If a launcher (or any other process) was started for this run, send `SIGINT` or `SIGTERM` to **that PID only**. The CLI already closes the HTTP servers on those signals. Do not `pkill -f pipeline`, do not kill by process name, do not kill unrelated Node processes.
2. After stopping this run's processes and preserving evidence, remove only its owned scratch:

```sh
bash .cursor/skills/verify-tsugite-manual/helpers/isolate-local-fixture.sh --cleanup "$VERIFY_RUN_DIR" "$VERIFY_RUN_ID"
```

The cleanup command requires matching repository, exact run directory, and run ID in the ownership marker. It rejects foreign targets, missing markers, symlinks, and special files; on refusal leave the target untouched and report it. It never signals a process or deletes evidence or another run. Do not remove the entire `tmp/` parent.

3. Confirm evidence still exists, e.g. `test -f .cursor/skills/verify-tsugite-manual/evidence/PROOF.md`.
4. Do not `git clean`, do not remove `examples/`, `fixtures/`, or durable `projects/`.

## Helpers

| Path | Purpose |
| --- | --- |
| `helpers/isolate-local-fixture.sh` | Creates an owned `tmp/run-<unique>/projects-home/verify-local-fixture`, prints quoted run variables, and supports ownership-checked `--cleanup` |
| `features/README.md` | Feature map, preconditions, proof/skip reporting |
| `features/*.md` | One user-facing feature each |

Harness preference: CLI `--json`, then `curl` to `http://127.0.0.1:<port>/api/projects` for the launcher, then Vitest only when a feature file says so (`npx vitest run test/cli.test.ts test/doctor.test.ts test/review-cli.test.ts test/viewer-launcher.test.ts` — tests use their own tmpdirs and must not be pointed at production projects).
