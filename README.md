# tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Vendor-neutral video pipeline that connects generation adapters and editing backends through a single manifest contract.

Each video job has its own `project.yaml`. For distribution, the repository keeps copyable examples under `examples/` and ignores user projects under `projects/`. The safe flow is:

1. Validate the project and manifest.
2. Create a plan.
3. Stop at Gate 1 for human approval.
4. Run generation or assembly only after Coordinator approval.
5. Stop at Gate 2 for output QA.
6. Render only after Gate 2 approval.
7. Stop at Gate 3 for final video QA.

## Current Scope

- Manifest validation and local asset checks.
- Adapter registry for `cli`, `mcp-agent`, and `mcp-client` styles.
- CLI generation adapter wrappers for PixVerse/Kling.
- Source- and freshness-backed T2V/I2V prompt knowledge catalogs for PixVerse, Kling, and Seedance.
- A story-guide catalog covering 34 narrative, persuasion, documentary, genre, and music-video structures plus 35 contextual film-grammar and AI-video principles.
- MCP-agent generation adapter contract for Topview.
- Optional OpenClaw CLI bridge and Hermes analysis handoff adapters.
- Local-media and generated-media assembly into `dist/<run-id>/`.
- Gate-bound editorial EDL compilation that retimes selected cuts, captions, and chapters for both Remotion and HyperFrames without modifying source media.
- Gate 2 QC report generation using manifest and media probes.
- Gate 3 QC report generation for final duration, resolution, fps, and audio/video streams.
- First-class image assets, speaker/pose metadata, and guarded presentation presets.
- A Remotion starter for turning an article into a 60-second, 16:9 two-speaker dialogue.
- A Remotion Q&A dialogue template for FAQ-style question lists with QUESTION/ANSWER cards.
- Remotion and HyperFrames backend contracts.
- Guarded `run` / `render` commands that require Coordinator role and prior Gate approval.
- A standalone, read-only 3D workflow viewer under `apps/workflow-viewer/`.

## 3D Workflow Viewer

The viewer turns bundled samples or CLI-generated Tsugite snapshots into a navigable 3D production floor with status-aware nodes, dependency lines, node details, and seekable event playback. Default labels and summaries use plain, non-technical Japanese; internal names, references, timestamps, and logs stay under the collapsed details section. The CLI can export current state into it, while the Viewer itself keeps no backend, provider calls, project mutation, or execution authority.

```sh
cd apps/workflow-viewer
npm install
npm run dev
npm run test:coverage
npm run build
```

See [`apps/workflow-viewer/README.md`](apps/workflow-viewer/README.md) for the JSON contract, controls, samples, and current limitations.

## Setup

Prerequisites are Git, Node.js 22.x, npm 10 or newer, and FFmpeg including `ffprobe`.

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows
winget install --id Gyan.FFmpeg -e
```

On Windows, reopen the terminal after installation. `npm ci` installs Remotion, HyperFrames, and the other repository dependencies locally; no global Remotion or HyperFrames install is needed. HyperFrames is a development dependency, so do not use `npm ci --omit=dev`.

Provider CLIs such as PixVerse/Kling, external Topview/OpenClaw/Hermes runtimes, credentials, and billing configuration are not installed or configured automatically. Prepare only the adapter you select, then rerun `doctor`. Doctor performs non-charging version, local-package, and declared-bridge checks. It does not contact provider authentication or generation APIs; required human verification is reported as `status: manual` with a `remediation`. Any unresolved blocking check makes the overall `ok` value `false`.

## Commands

```sh
npm ci
npm run check
bin/pipeline story-guides --request "A 30-second vertical ad showing value and proof" --duration 30 --json
bin/pipeline guides --json
cp -R examples/local-fixture projects/my-first-run
bin/pipeline doctor --config projects/my-first-run/project.yaml --json
bin/pipeline validate --config projects/my-first-run/project.yaml --json
bin/pipeline plan --config projects/my-first-run/project.yaml --json
bin/pipeline review --config projects/my-first-run/project.yaml --open --json
bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
bin/pipeline finalize --config projects/my-first-run/project.yaml --json
```

`review` derives `dist/<run-id>/review/index.html` and `review-data.json` from the validated project, manifest, and plan. It presents a caption-first storyboard, character sheets, shot details, cost, and Gate 1 commands without changing `state.json` or executing generation. Gate 1 approval and run start verify that both artifacts exist and belong to the current project. Use `--output <directory>` to override the destination, `--state-dir <directory>` for an alternate state root, and `--open` only when you want to open the local HTML. Use the canonical output location when the artifact must satisfy Gate 1.

`viewer` converts the validated project and plan plus the current `state.json`, `run-log.md`, review, and Gate 2 / Gate 3 QC artifacts into `dist/<run-id>/viewer/index.html` and `workflow.json`. Run summaries and generation request records from `run-log.md` appear in the material-generation details. When Gate 2 QC references real media, the snapshot copies a bounded preview set (2 generated videos, 4 images, and 2 audio files) into `viewer/previews/`; the Gate 2 panel can display or play them directly. The Gate 3 final video is also copied and appears on the render, final-approval, and completion steps. References outside the run directory, links, missing files, and unsupported extensions are not copied. It is a read-only snapshot: it does not run adapters, change gates, or write state. Install the Viewer dependencies once with `npm --prefix apps/workflow-viewer ci`; rerun the command after the pipeline state changes. The timeline is deterministically reconstructed from the plan order and current artifacts because Tsugite does not yet persist a complete event history. `--output`, `--state-dir`, and `--open` follow the same local-artifact conventions as `review`.

`run` and `render` are intentionally gated:

```sh
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

Do not run non-dry-run `run` or `render` without explicit human approval.
Gate 3 also accepts `re-render`, which preserves Gate 1 and Gate 2 approval and returns the run to rendering. Gate 2 `retry_specific` is not implemented yet; use `revise` for a full re-plan.

Only after the user explicitly declares the selected video complete, use `finalize` to clean up superseded media. The default preview is read-only. After reviewing its scope, a Coordinator may add `--apply`; this keeps the final run, source media referenced by the final manifest, and text records, while deleting video, audio, and image files from older runs, older QA, and unused project media. The result is recorded in `completion-record.json` inside the final run.

```sh
bin/pipeline finalize --config projects/my-first-run/project.yaml --json
bin/pipeline finalize --config projects/my-first-run/project.yaml --apply --actor coordinator --json
```

## Optional Shitate Import

When using the separate Shitate repository, optionally import a selected run and anchor as an immutable, SHA-256-locked project snapshot. Shitate is not required for normal Tsugite usage.

```sh
bin/pipeline shitate-import \
  --config projects/my-project/project.yaml \
  --shitate-root /absolute/path/to/shitate \
  --character hero \
  --run-id 20260713_three-view_v1 \
  --anchor references/images/main-anchor.png \
  --request-id shot-001 \
  --json
```

The command copies local files, adds the anchor and speaker to the manifest, and optionally changes one request to I2V. It never runs generation or changes a Gate. `negative.txt` is preserved but not silently applied because the current PixVerse video CLI has no negative-prompt option. See [Shitate Integration](docs/shitate.md).

## Blog Dialogue Template

`templates/blog-dialogue-60s/` turns article source notes and a timed two-speaker script into a deterministic Remotion manifest. Copy it under `projects/`, add the local teacher character, rebuild the manifest, then use `validate`, `plan`, and `run --dry-run` before any gated execution.

## Q&A Dialogue Template

`templates/qa-dialogue/` turns a FAQ `qa_list` into the same Remotion dialogue presentation with auto-timed QUESTION/ANSWER cards. Edit `qa.json`, run `node build-manifest.mjs .`, then use `validate`, `plan`, and `run --dry-run` before any gated execution.

## Project File

Minimal local-media project, as used by `examples/local-fixture/project.yaml`:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

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

`plan` returns request-specific `prompt_guidance` when the model and input mode match. Set `prompt_guide.catalog` when the knowledge catalog differs from the execution adapter. A catalog never implies execution capability and never rewrites the prompt. See [Model Prompt Knowledge](docs/prompt-guides.md).

Optional OpenClaw/Hermes adapters are distribution-time opt-ins. The base
install does not require them; set them up only when a `project.yaml` selects
one of those adapters. See [Optional Adapters](docs/optional-adapters.md).

## Growing the Pipeline

Tsugite does not become more personalized just because you generate many videos. It improves when you feed review notes, retry reasons, and repeated preferences back into the repository.

Use this loop:

1. Create a project under `projects/`.
2. Generate or assemble only after the Gate approvals.
3. Review the output and write what worked, what failed, and why you retried.
4. Keep one-off notes inside that project.
5. Promote repeated lessons into reusable examples, templates, adapter/backend constraints, validation/doctor checks, tests/fixtures, operational rules, or public contracts.

Recommended promotion rule:

```text
One-off preference       -> projects/<job>/notes.md
Reusable style choice    -> examples/ or templates/
Machine-checkable issue  -> constraints.yaml / validate / doctor + tests/fixtures
Judgment-based rule      -> LESSONS.md -> SKILL.md / CLAUDE.md / AGENTS.md
QA rule                  -> Gate 2 / Gate 3 checks + report schema/tests
Public contract change   -> README / manifest/schema.md / docs/requirements.md
```

Every promotion should leave either a reproducing fixture and test, or a human-readable operating rule. Gate 2 / Gate 3 check changes should update the report shape and tests together.

This is how the repo can grow toward your taste while still staying safe for distribution. Local projects stay ignored under `projects/`, and only reusable improvements are committed back to the source.

## Repository Rules

- Keep core code vendor-neutral. Vendor-specific execution behavior belongs under `adapters/` or `backends/`; source-backed advisory data belongs under `knowledge/video-models/`.
- Adapter directories must include `constraints.md`.
- `mcp-agent` adapters must include `SKILL.md`.
- Put user work under `projects/`; keep `examples/` copyable and resettable.
- Failures that produce reusable rules should be recorded in `LESSONS.md`.

## Production Notes

- `examples/local-fixture/project.yaml` is a fixture-style local validation config. Copy it into `projects/` before editing.
- `projects/*` is ignored by git so local prompts, media, manifests, `dist/`, and run state stay out of distributable commits.
- `npm ls` may report `@emnapi/runtime` as extraneous after `npm ci` on npm 11 because optional wasm child packages remain in the lockfile while their platform-specific parents are skipped. Treat this as non-blocking only when `npm ci`, `npm audit`, build, tests, `validate`, `plan`, and `run --dry-run` all pass.
- `npm run check` enforces the vendor boundary, TypeScript build, the full test suite, and 80% minimum statement, branch, function, and line coverage for `src/`.
- Vite may warn because this workspace path contains `*`. Tests currently pass in this path; move the repo to a path without `*` if that warning becomes operationally noisy.
