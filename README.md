# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Tsugite is a local video-production workshop. It carries assets, production logs, decisions, and preferences forward instead of treating each AI video as a disposable result.

Source version **0.16.0**. Public Desktop installers have ended; everyday use is this GitHub repository plus Codex, Claude Code, or another local coding agent, with a loopback browser launcher for inspection. See the [changelog](CHANGELOG.md).

**Start here:** [Easy start](#easiest-way-to-start) · [What you can do](#what-you-can-do) · [Production flow](#safe-production-flow) · [Commands](#commands)

## What it is

Tsugite connects generation services, local media, and editing backends through one **manifest** contract. Each job keeps its own plan, human Gates, QA, and logs.

You do not need to understand Git or the terminal first. Codex, Claude Code, or another compatible coding agent can prepare the first local workspace after a paste-in setup request.

## What you can do

Use this map to find the right entry. Optional tools never replace Gates, `run`, or `render`.

### Safe production flow

Every job has a `project.yaml`. Copyable examples live under `examples/`. Your work stays gitignored under `projects/`.

1. Validate the project and manifest.
2. Create a plan.
3. Stop at **Gate 1** for human approval.
4. Generate or assemble only after Coordinator approval.
5. Stop at **Gate 2** for output QA.
6. Render only after Gate 2 approval.
7. Stop at **Gate 3** for final video QA.

`run` and `render` require the Coordinator role and a prior Gate. Do not run them without explicit human approval.

### Generate clips

| Tool | Role | Docs |
| --- | --- | --- |
| PixVerse / Kling CLI adapters | Text-to-video and image-to-video through the pipeline | [Optional adapters](docs/optional-adapters.md) |
| Prompt catalogs | Source-backed T2V / I2V advice for PixVerse, Kling, and Seedance. A catalog is not an execution capability and does not rewrite prompts | [Prompt guides](docs/prompt-guides.md) |
| Story guides | 34 narrative structures plus 35 film-grammar / AI-video principles, chosen with reasons | [Story guides](docs/story-guides.md) |
| TopView skill CLI | T2V and single-frame I2V | [TopView CLI](docs/topview-cli.md) |
| H3 Prompt Director | Typed Creative IR → deterministic English prompt for MiniMax H3 (`minimax-h3`) | [H3 Prompt Director](docs/h3-prompt-director.md) |

MiniMax direct and MiniMax HTTP stay **preflight-only**. Do not present them as ready to send. Provider CLIs, credentials, and billing are never installed automatically; prepare only the adapter you select, then rerun `doctor`.

### Edit inside the pipeline

These are `edit.backend` renderers. The same manifest / EDL contract feeds them.

| Backend | Role | Docs |
| --- | --- | --- |
| Remotion | Default local renderer, captions, presentation presets | `edit.backend: remotion` |
| HyperFrames | Local renderer plus official `media-use` BGM / SFX | [HyperFrames audio](docs/hyperframes-audio.md) |
| Editframe | Optional **macOS** local renderer and preview. Install with `npm run editframe:install`, then `edit.backend: editframe`. Preview uses an authoring copy. WebMCP and disk-save APIs are unverified | [Editframe](docs/editframe.md) |
| Tesseract | Optional local project/export backend. Requires official CLI 0.1.0; review its terms before installing. Supports reviewed clip/text motion, cut transitions, and offline audio-reactive keyframes; Fast Edit remains unsupported | [Tesseract](docs/tesseract.md) |
| **Jev Fast Edit v1** | Same strict, backend-neutral edit intent on Remotion, HyperFrames, and Editframe (cards, captions, transitions, zoom, SFX, 16:9 and 9:16). Needs local-whisper word timestamps first. Select only with `edit.backend` plus `edit.fast_edit`. Not a new renderer | [Fast Edit](docs/fast-edit.md) |

Also in this path: Gate-bound editorial EDL (retimes selected cuts, captions, and chapters without changing source files), first-class image assets and speaker / pose metadata, and guarded presentation presets. Query installed presets with `node bin/pipeline presets --backend remotion --json` instead of typing an unverified ID.

### Edit outside the pipeline (Adobe and other local tools)

These are **agent-operated external editors**. They are not a `pipeline render` backend. Existing Gates still apply to the Tsugite project.

| Tool | Skill | What is in scope | Docs |
| --- | --- | --- | --- |
| **Premiere Pro** | `$premiere-editing` (Claude Code: `/premiere-editing`) | macOS. Cuts, transitions, audio, captions, color; local MCP; on-screen verification | [Premiere Pro](docs/premiere-pro.md) |
| **After Effects** | `$after-effects-editing` (Claude Code: `/after-effects-editing`) | macOS. Official local `DoScriptFile` helper: inspect, fixture, title layers, save-as. On-screen preview is a separate check | [After Effects](docs/after-effects.md) |
| PixVerse Canvas | Official CLI 1.4.4, opt-in | `npm run pixverse:install`, then `npm run --silent pixverse -- canvas ...`. External Canvas entry, not a pipeline backend. Live Canvas mutation is not claimed by install checks | [PixVerse Canvas](docs/pixverse-canvas.md) |
| HyperFrames Studio | Pinned 0.8.24 WebMCP | `npm run hyperframes:studio -- <composition-dir>` on an authoring copy. Inspect / text / style edit is verified on patched 0.8.24 + native Chrome 152. Motion authoring and other hosts are unverified. Studio edits do not update the pipeline manifest; a later `render` regenerates HTML | [Studio WebMCP](docs/hyperframes-studio-webmcp.md) |

### Analyze local footage

- API-free `pipeline analyze` with the local-media-analysis adapter (FFmpeg / `ffprobe` only).
- Optional local-whisper analysis for transcripts, filler candidates, chapters, extractive summaries, and English captions. Models are never auto-downloaded.
- For a project with `composition`, run `analyze` then `compose` before `review`. `compose` writes at most three backend-neutral proposals; you pick exactly one `edit.composition.proposal_id`. Only `run` after Gate 1 materializes the reordered manifest.

See [local analysis](docs/local-analysis.md) and `examples/local-analysis/`.

### Inspect work

The loopback launcher lists `projects/*/project.yaml`, templates, Gates, Preferences & Learnings, and Safe Maintenance. It does not install an AI CLI, spend credits, send assets, start generation, render, or change a Gate.

The 3D Viewer is a read-only snapshot of the current run. Details: [Local launcher](#local-launcher-and-3d-viewer).

### Optional extras

| Extra | Role | Docs |
| --- | --- | --- |
| Hypit production | Adapter-owned authoring path (`npm run hypit:install`). Not a pipeline render backend and not a substitute for Gate 1 / 3. Live `hypit build` / MP4 acceptance are not claimed by the source bump. Needs Node.js 22.15+ in the 22.x line for the Hypit runtime; core stays 22.12 | [Hypit](docs/hypit.md) |
| Editframe examples | Opt-in pinned gallery of 27 official samples: `npm run editframe:examples:install` then `npm run editframe:examples` | [Editframe examples](docs/editframe-examples.md) |
| Agent Services | Separate registry for public read-only Remote MCP (`services` / `service-tools` / `service-call`). Isolated from generation `connections` | [Agent Services](docs/agent-services.md) |
| Shitate import | Copy a SHA-256-locked character snapshot from a separate Shitate repo. Not required for normal use | [Shitate](docs/shitate.md) |
| Character add | Copy a speaker (poses, mouth frames, images) from any source manifest | [Commands](#character-add) |
| Hermes | Optional analysis handoff adapter | [Optional adapters](docs/optional-adapters.md) |

## Easiest way to start

1. Open an empty working folder in Codex, start Claude Code in that folder, or use another coding agent that can work with local files and run shell commands.
2. Paste the short setup request below into the agent.
3. Review the environment and setup result.
4. Approve only the system changes that are actually required.

You do not need to type `git clone` or npm commands yourself.

## Setup request for Codex, Claude Code, or another coding agent

```text
Safely set up the official Tsugite repository
https://github.com/Takamasa045/tsugite
inside this empty folder.
Start with read-only environment checks and wait for my approval before any system installation.
After cloning, use the official setup:check and setup commands through doctor, validate, and plan for the zero-credit sample.
Do not overwrite existing files, log in, configure secrets, spend credits, run generation, render, approve Gates, commit, or push.
```

The canonical copy-ready Japanese request is in [Codex・Claude Codeなどで使う Tsugiteセットアップ依頼文](docs/onboarding/codex-setup-prompt.ja.md).

## After setup

- Inspect the bundled “はじめての継手” sample in the local launcher.
- Try `validate`, `plan`, and `review` using only local media.
- Create a personal project under `projects/`.
- Select and configure only the generation provider you actually need.

## Safety boundary

The official Bootstrap automates only repository-local dependencies, the zero-credit sample, `doctor`, `validate`, and `plan`. It does not install system packages, change `PATH`, log in to external services, configure secrets, spend credits, invoke `run` or `render`, change a Gate, commit, push, or publish. See the [Japanese setup contract](docs/onboarding/setup-contract.ja.md).

Gate 2 `retry_specific` is not implemented and is not planned for 1.0; use `revise` for a full re-plan. Gate 3 accepts `re-render`, which keeps Gate 1 and Gate 2 approval.

## Developer and manual setup

From an already cloned repository root, the dependency-free Bootstrap can start before `node_modules` exists:

```sh
npm run setup:check
npm run setup
npm run setup:open  # only when you also want the launcher
```

Append `-- --json` for a machine-readable report. `setup:check` is read-only. OS-specific prerequisites are in [Detailed setup](#detailed-setup-and-os-notes).

## Agent skills

Codex discovers `.agents/skills/tsugite/SKILL.md`. Invoke it with `$tsugite`, or let Codex select it for matching video work.

Claude Code exposes `.claude/skills/tsugite/SKILL.md` as `/tsugite` and loads the same canonical workflow. Focused shortcuts:

- `/tsugite-plan` — validate → plan → Gate 1 review (does not approve the Gate)
- `/tsugite-verify` — document or test checks after code/docs changes
- `/tsugite-finalize` — only after you explicitly declare the selected video complete
- `/tsugite-learning-review` — prepare local learning-promotion candidates
- `/shitate-import` — optional locked snapshot copy
- `/premiere-editing` / `/after-effects-editing` — Adobe as external editors

The root `SKILL.md` is a legacy compatibility entry.

## Local launcher and 3D viewer

Open the Tsugite repository in Codex or Claude Code, then use the loopback browser launcher beside it. Electron remains for development and regression tests only; see [Desktop](docs/desktop.md).

```sh
npm --prefix apps/workflow-viewer ci  # first time only
npm run viewer:open
```

The launcher and artifact server bind only to dynamically selected `127.0.0.1` ports. Stop with `Ctrl+C` in the launching terminal. It never requests browser notification permission, sends desktop notifications, runs as a resident service, or uses an external notification destination.

What it does:

- Lists direct `projects/*/project.yaml` entries by the required `name` field (Japanese is fine).
- Refreshes a read-only 3D snapshot into a private `0700` temp directory for the current session, never back through a project output path.
- Summarizes local `feedback.jsonl` on the **Preferences & Learnings** shelf (`observed` / `recurring` / `promoted` / `verified`). At most 128 projects and 1,000 latest records; pending learning-promotion proposals get an unread-style badge. Approval only permits a separate implementation task — it never rewrites prompts, templates, rules, Gates, or state.
- **Safe Maintenance** keeps Git worktree cleanup and completed-project media finalize as **separate** preview → confirm → apply flows. No bulk delete. The browser never sends a filesystem path; the server holds a short-lived review id and re-checks live state before calling the canonical CLI.

The 3D Viewer turns the current snapshot into a navigable production floor (status-aware nodes, dependency lines, node details, event playback). When Gate 2 QC references real media, the snapshot copies a bounded preview set (2 generated videos, 4 images, 2 audio files). The Gate 3 final video is copied onto the render / final-approval / completion steps. It does not run adapters, change Gates, or write state.

JSON contract, controls, and limits: [`apps/workflow-viewer/README.md`](apps/workflow-viewer/README.md).

## Detailed setup and OS notes

Prerequisites: Git, Node.js 22.12 or newer in the 22.x LTS line, npm 10 or newer, and FFmpeg including `ffprobe`. Optional Hypit production additionally requires Node.js 22.15 or newer in the 22.x line.

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows
winget install --id Gyan.FFmpeg -e
```

On Windows, reopen the terminal after installation. Canonical launcher and CLI entrypoints: [native Windows and PowerShell guide](docs/windows.md). Use `node bin/pipeline ...` in PowerShell; do not invoke the extensionless `bin/pipeline` file. Reopen PowerShell after installing or updating Node.js, FFmpeg, or a provider CLI.

`npm ci` installs Remotion, HyperFrames, and the other repository dependencies locally. HyperFrames is a development dependency, so do not use `npm ci --omit=dev`.

```powershell
npm ci
npm --prefix apps/workflow-viewer ci
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
npm run viewer:open
```

After a successful local first-time setup, Codex and Claude Code ask once whether to add the optional learning-promotion automation. Registration needs an explicit host choice; a decline suppresses the repeat question for that setup. See [Learning Promotion Review](docs/automations/learning-promotion-review.md).

HyperFrames BGM / SFX never fall back to ElevenLabs automatically. See [HyperFrames audio](docs/hyperframes-audio.md).

## Commands

General help lists every command and its safety level without reading a project or contacting a provider:

```sh
node bin/pipeline --help
node bin/pipeline help validate
```

Add `--json` when a script needs stable machine-readable output.

```sh
npm ci
npm run check
node bin/pipeline story-guides --request "A 30-second vertical ad showing value and proof" --duration 30 --json
node bin/pipeline guides --json
node bin/pipeline presets --backend remotion --json
cp -R examples/local-fixture projects/my-first-run
node bin/pipeline doctor --config projects/my-first-run/project.yaml --json
node bin/pipeline validate --config projects/my-first-run/project.yaml --json
node bin/pipeline plan --config projects/my-first-run/project.yaml --json
node bin/pipeline review --config projects/my-first-run/project.yaml --open --json
node bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
node bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
node bin/pipeline finalize --config projects/my-first-run/project.yaml --json
```

`review` writes `dist/<run-id>/review/index.html` and `review-data.json` (caption-first storyboard, character sheets, shot details, cost, motion direction). The Gate 1 decision appears once at the end and does not change `state.json`. Gate 1 approval requires both artifacts at the canonical location for the current project. `--open` only opens the local HTML.

`viewer` writes `dist/<run-id>/viewer/index.html` and `workflow.json` from the validated project, plan, `state.json`, `run-log.md`, review, and Gate 2 / Gate 3 QC. The timeline is reconstructed from plan order and current artifacts because Tsugite does not yet persist a complete event history.

Long-form local analysis (no external API):

```sh
cp -R examples/local-analysis projects/my-seminar
node bin/pipeline doctor --config projects/my-seminar/project.yaml --json
node bin/pipeline validate --config projects/my-seminar/project.yaml --json
node bin/pipeline plan --config projects/my-seminar/project.yaml --json
node bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

For local Whisper, copy `examples/local-analysis/project-editorial.yaml` and point `model_path` plus required `model_sha256` at a trusted existing `.pt`.

Fast Edit preparation (does not approve a Gate or render). Configure `local-whisper-analysis` first so each source clip has word timestamps:

```sh
node bin/pipeline analyze --config projects/my-first-run/project.yaml --actor coordinator
node bin/pipeline fast-edit --config projects/my-first-run/project.yaml --actor coordinator
```

See [Fast Edit](docs/fast-edit.md) before `--allow-external-analysis` or `--decisions`.

Gated execution:

```sh
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
node bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
node bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

Only after you explicitly declare the selected video complete, record the canonical output, QA evidence, and a closeout retrospective, then preview `finalize`. The default preview is read-only and prints a `plan_digest`. A Coordinator may apply with that exact digest. This keeps the final run, source media referenced by the final manifest, and text records, while deleting video / audio / image files from older runs, older QA, and unused project media. `--state-dir` is accepted only when it equals `project.dist_dir`.

```sh
node bin/pipeline finalize --config projects/my-first-run/project.yaml --json
# copy plan_digest from the preview JSON, then:
node bin/pipeline finalize --config projects/my-first-run/project.yaml --apply --actor coordinator --expected-plan-digest <plan_digest> --json
```

After a coding task is explicitly marked complete, audit leftover Git worktrees before removing any of them. Default `worktrees` is a read-only JSON preview. Apply requires Coordinator and one or more explicit `--path` values; it never uses `git worktree remove --force`, never deletes branches, and refuses primary / current, dirty, unmerged, locked, missing, or protected ignored content such as `projects/` and `.env`.

```sh
node bin/pipeline worktrees --json
node bin/pipeline worktrees --apply --actor coordinator --path ../tsugite-feature-task --json
```

If completion is approved while local `main` is busy, you can defer that exact clean worktree and later `--reconcile` from primary clean main. See [Deferred Worktree Reconcile](docs/automations/worktree-reconcile.md) and [Worktree Cleanup Alert](docs/automations/worktree-cleanup-alert.md). A `worktree_warning` is a count of already-removable leftovers (threshold 3). It never authorizes deletion.

## Public Agent Services (Remote MCP)

Public read-only Remote MCP endpoints (Cloudflare Search MCP and Azumi Experience) live in [`agent-services/registry.yaml`](agent-services/registry.yaml). They are not generation connections, do not accept arbitrary caller URLs, and never unlock side effects from this CLI. Queries are not purchase actions (`billing_action=false`) but may still consume provider quota (`provider_usage_possible=true`).

```sh
node bin/pipeline services --json
node bin/pipeline service-tools --service itopan-search --json
node bin/pipeline service-call --service itopan-search --tool search --arguments '{"query":"AIエージェント"}' --json
```

See [Agent Services](docs/agent-services.md) for the fail-closed Human Gate and current read-only scope.

## Optional Shitate Import

When using the separate Shitate repository, optionally import a selected run and anchor as an immutable, SHA-256-locked project snapshot. Shitate is not required for normal Tsugite usage.

```sh
node bin/pipeline shitate-import \
  --config projects/my-project/project.yaml \
  --shitate-root /absolute/path/to/shitate \
  --character hero \
  --run-id 20260713_three-view_v1 \
  --anchor references/images/main-anchor.png \
  --request-id shot-001 \
  --json
```

The command copies local files, adds the anchor and speaker to the manifest, and optionally changes one request to I2V. It never runs generation or changes a Gate. See [Shitate Integration](docs/shitate.md).

## Character Add

Copy a speaker (poses, mouth frames, and images) from any source manifest into a target project, without Shitate.

```sh
node bin/pipeline character-add \
  --config projects/my-project/project.yaml \
  --from-manifest fixtures/manifests/dialogue.valid.json \
  --speaker left \
  --json
```

Image paths in the source manifest are resolved relative to the manifest directory. The command is idempotent on exact match, refuses conflicting speakers, and never runs generation or changes a Gate.

## Project file

Minimal local-media project, as used by `examples/local-fixture/project.yaml`:

```yaml
slug: local-fixture
name: ローカル検証フィクスチャ
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

`name` is required (Japanese is fine). The launcher lists projects by this display name; you can rename it later from the selection panel without changing `slug` or the folder name.

Generation projects add a `generation` section:

```yaml
generation:
  adapter: pixverse
  requests:
    - id: shot-001
      prompt: short prompt
      model: v6
      duration: 5
      aspect: "16:9"
      input_mode: text-to-video
      params: {}
```

`plan` returns request-specific `prompt_guidance` when the model and input mode match. Set `prompt_guide.catalog` when the knowledge catalog differs from the execution adapter.

Fast Edit example:

```yaml
edit:
  backend: remotion # or hyperframes / editframe
  fast_edit:
    enabled: true
    beat_seconds: 2.5 # optional
```

For MiniMax H3 (`minimax-h3`), use the optional Creative IR + deterministic compiler instead of freehand section prose. See [H3 Prompt Director](docs/h3-prompt-director.md) and [`examples/h3-prompt-director/`](examples/h3-prompt-director/).

The optional Hermes adapter is distribution-time opt-in. The base install does not require it. See [Optional Adapters](docs/optional-adapters.md).

## Growing the pipeline

Tsugite does not become more personalized just because you generate many videos. It improves when you feed review notes, retry reasons, and repeated preferences back into the repository.

Structured feedback stays local in each `projects/<job>/feedback.jsonl`. Record a stable `key` for the same preference across projects. The lifecycle is `observed` → `recurring` → `promoted` → `verified`. Approval is always a human decision and only grants implementation permission; neither `pipeline feedback` nor the launcher changes prompts, templates, checks, or operating rules automatically.

1. Create a project under `projects/`.
2. Generate or assemble only after the Gate approvals.
3. Review the output and record what worked, what failed, and why you retried with `pipeline feedback`.
4. Keep one-off notes inside that project.
5. Use repeated records with the same `key` as evidence, then promote a reusable change only after human approval.
6. Verify the promoted change against a later output before marking the feedback `verified`.

An optional Codex Automation, Claude Desktop/Cowork scheduled task, or Claude Code session may prepare this approval queue (at most three complete, non-duplicate pending proposals per run). Keep only one durable schedule. See [Learning Promotion Review](docs/automations/learning-promotion-review.md).

```sh
node bin/pipeline feedback --config projects/my-first-run/project.yaml \
  --key opening-audio --category audio --signal prefer --stage observed \
  --summary "Start music within the first 0.5 seconds" --json
```

Recommended promotion rule:

```text
One-off preference       -> projects/<job>/notes.md + feedback.jsonl (observed)
Repeated preference key  -> feedback.jsonl (recurring; review for promotion)
Reusable style choice    -> examples/ or templates/
Machine-checkable issue  -> constraints.yaml / validate / doctor + tests/fixtures
Judgment-based rule      -> LESSONS.md -> .agents/skills/tsugite/SKILL.md / CLAUDE.md / AGENTS.md
QA rule                  -> Gate 2 / Gate 3 checks + report schema/tests
Public contract change   -> README / manifest/schema.md / docs/requirements.md
```

Every promotion requires human approval and should leave either a reproducing fixture and test, or a human-readable operating rule.

## Repository rules

- Keep core code vendor-neutral. Vendor-specific execution behavior belongs under `adapters/` or `backends/`; source-backed advisory data belongs under `knowledge/video-models/`.
- Adapter directories must include `constraints.md`.
- `mcp-agent` adapters must include `SKILL.md`.
- Put user work under `projects/`; keep `examples/` copyable and resettable.
- Failures that produce reusable rules should be recorded in `LESSONS.md`.

## Production notes

- `examples/local-fixture/project.yaml` is a fixture-style local validation config. Copy it into `projects/` before editing.
- `projects/*` is ignored by git so local prompts, media, manifests, `dist/`, and run state stay out of distributable commits.
- `npm ls` may report `@emnapi/runtime` as extraneous after `npm ci` on npm 11 because optional wasm child packages remain in the lockfile while their platform-specific parents are skipped. Treat this as non-blocking only when `npm ci`, `npm audit`, build, tests, `validate`, `plan`, and `run --dry-run` all pass.
- `npm run check` enforces the vendor boundary, TypeScript build, the full test suite, and minimum coverage of 80% statements, functions, and lines, plus 74.4% branches for `src/` (held after Production Orchestration; restoring 75% remains debt). Coverage uses at most four Vitest workers so process-heavy fixtures remain stable on high-core machines and CI runners.
- `npm run security:audit` checks both the production dependency tree and the full development tree, failing on moderate-or-higher advisories.
- Vite may warn because this workspace path contains `*`. Tests currently pass in this path; move the repo to a path without `*` if that warning becomes operationally noisy.
- 1.0 still requires live provider/billing evidence and packaged Desktop UAT. Windows smoke is verified on GitHub Actions. Desktop installers stay outside this source release.
