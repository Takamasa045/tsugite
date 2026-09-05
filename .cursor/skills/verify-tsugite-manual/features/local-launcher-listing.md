# Local launcher project listing

A user can open a loopback-only browser launcher that lists local `*/project.yaml` shelves (display `name`, slug, run id, validity) without generating media, spending credits, or changing a Gate. The CLI starts two 127.0.0.1 servers, prints `url`, `port`, and `project_count`, then waits. The listing JSON is `GET /api/projects` → `{ ok: true, projects, directArtifacts }`.

## Sub-features

- `launcher-start` `viewer-launcher` binds loopback, rebuilds the Viewer bundle, prints `project_count`.
- `launcher-list-json` `GET /api/projects` includes the isolated fixture (`slug: local-fixture`, `name: ローカル検証フィクスチャ`, `valid: true`).
- `launcher-no-side-effects` Listing and opening the launcher do not run validate/plan/review/run/render or Gate CLI.

## How to get to it (user POV)

- README: `npm --prefix apps/workflow-viewer ci` once, then `npm run viewer:open` (wrapper for `node bin/pipeline viewer-launcher --open`).
- Direct CLI: `node bin/pipeline viewer-launcher [--projects-dir <directory>] [--port <port>] [--open] [--json]`.
- Help: `node bin/pipeline help viewer-launcher`.
- User looks at the shelf in the browser; this skill proves the same list via HTTP JSON. Desktop empty-shelf folder picker is not a supported distribution path.

## Driving it with CLI + curl

Preconditions:

- `npm ci` at repo root **and** `npm --prefix apps/workflow-viewer ci`. Start always runs `npm --prefix apps/workflow-viewer run build` (`src/viewer/artifact.ts` `ensureViewerBundle`).
- Isolated home already contains the copied fixture (`helpers/isolate-local-fixture.sh`) so the durable-home scan and `--projects-dir` both see only that shelf.
- Pass `--port 0` (OS picks a free port). Do **not** pass `--open` on a headless agent.
- Record the launcher PID. Host header must match `127.0.0.1:<port>` (curl does this when you use the printed `url`).

- **Action.** User starts the launcher against the isolated shelf. Exact commands:

```sh
test -n "${VERIFY_CONFIG:-}" && test -f "$VERIFY_CONFIG" || exit 1 # Reuse the Isolate run.
TSUGITE_PROJECTS_HOME="$TSUGITE_PROJECTS_HOME" node bin/pipeline viewer-launcher \
  --projects-dir "$TSUGITE_PROJECTS_HOME" \
  --port 0 \
  --json
```

Observable result: process stays running. First JSON on stdout: `"ok": true`, `"command": "viewer-launcher"`, `"url"` like `http://127.0.0.1:<port>`, integer `port`, `project_count` ≥ 1, `"opened": false`. Save that JSON as `evidence/launcher-start.json`. Store `$LAUNCHER_PID` of **this** node process.

- **Action.** User (or agent) reads the shelf list. Exact command: `curl -sS "$LAUNCHER_URL/api/projects"`. Observable result: HTTP 200, `"ok": true`, `projects` array contains an entry with `slug` `local-fixture` (and display name `ローカル検証フィクスチャ`) and `valid` true. Save as `evidence/launcher-projects.json`. Do not POST `/api/projects/.../action`, generate, refresh, or maintenance apply.

- **Action.** Stop only this server. Exact command: `kill -INT "$LAUNCHER_PID"` (or `kill -TERM`). Observable result: process exits; later `curl` to that URL fails. Do not `pkill`.

## Gotchas

- Without isolated `TSUGITE_PROJECTS_HOME`, default discovery also reads durable `projects/` **and** other git worktree `projects/` shelves (`discoverLauncherProjectDirectories`). That can list real production jobs. Always isolate.
- `project_count` in start JSON is the initial scan; `GET /api/projects` reloads.
- Token is injected into HTML (`meta name="tsugite-launcher-token"`) but is **not** in CLI JSON. GET `/api/projects` does not require it; POSTs do (`x-tsugite-token` + Origin). Never scrape secrets into evidence.
- Invalid `--port` (non-integer) exits 1 with `viewer_launcher.port` and does not start a server.
- Viewer build failure (`viewer_launcher.start_failed`) means `apps/workflow-viewer` deps or `npm run build` failed — fix that checkout, do not skip by claiming the CLI listed projects.
- The launcher is `local-write` because it may write a private `0700` temp snapshot dir for the session; that dir is removed on close. It must not write back into a project `dist/` for listing-only.
