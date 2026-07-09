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
- MCP-agent generation adapter contract for Topview.
- Optional OpenClaw CLI bridge and Hermes analysis handoff adapters.
- Local-media and generated-media assembly into `dist/<run-id>/`.
- Gate 2 QC report generation using manifest and media probes.
- Remotion and HyperFrames backend contracts.
- Guarded `run` / `render` commands that require Coordinator role and prior Gate approval.

## Commands

```sh
npm ci
npm run check
cp -R examples/local-fixture projects/my-first-run
bin/pipeline validate --config projects/my-first-run/project.yaml --json
bin/pipeline plan --config projects/my-first-run/project.yaml --json
bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
```

`run` and `render` are intentionally gated:

```sh
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve --json
bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
```

Do not run non-dry-run `run` or `render` without explicit human approval.

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
      model: v4.5
      duration: 5
      aspect: "16:9"
      params: {}
```

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

- Keep core code vendor-neutral. Vendor-specific behavior belongs under `adapters/` or `backends/`.
- Adapter directories must include `constraints.md`.
- `mcp-agent` adapters must include `SKILL.md`.
- Put user work under `projects/`; keep `examples/` copyable and resettable.
- Failures that produce reusable rules should be recorded in `LESSONS.md`.

## Production Notes

- `examples/local-fixture/project.yaml` is a fixture-style local validation config. Copy it into `projects/` before editing.
- `projects/*` is ignored by git so local prompts, media, manifests, `dist/`, and run state stay out of distributable commits.
- `npm ls` may report `@emnapi/runtime` as extraneous after `npm ci` on npm 11 because optional wasm child packages remain in the lockfile while their platform-specific parents are skipped. Treat this as non-blocking only when `npm ci`, `npm audit`, build, tests, `validate`, `plan`, and `run --dry-run` all pass.
- Vite may warn because this workspace path contains `*`. Tests currently pass in this path; move the repo to a path without `*` if that warning becomes operationally noisy.
