# tsugite

[English](README.md) | [日本語](README.ja.md)

Vendor-neutral video pipeline that connects generation adapters and editing backends through a single manifest contract.

The execution entrypoint is `project.yaml`. The safe flow is:

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
- Local-media and generated-media assembly into `dist/<run-id>/`.
- Gate 2 QC report generation using manifest and media probes.
- Remotion and HyperFrames backend contracts.
- Guarded `run` / `render` commands that require Coordinator role and prior Gate approval.

## Commands

```sh
npm ci
npm run check
bin/pipeline validate --config project.yaml --json
bin/pipeline plan --config project.yaml --json
bin/pipeline run --config project.yaml --dry-run --json
```

`run` and `render` are intentionally gated:

```sh
bin/pipeline gate --config project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config project.yaml --actor coordinator --json
bin/pipeline gate --config project.yaml --actor coordinator --gate gate-2 --decision approve --json
bin/pipeline render --config project.yaml --actor coordinator --json
```

Do not run non-dry-run `run` or `render` without explicit human approval.

## Project File

Minimal local-media project:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: fixtures/manifests/minimal.valid.json
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

## Repository Rules

- Keep core code vendor-neutral. Vendor-specific behavior belongs under `adapters/` or `backends/`.
- Adapter directories must include `constraints.md`.
- `mcp-agent` adapters must include `SKILL.md`.
- Failures that produce reusable rules should be recorded in `LESSONS.md`.

## Production Notes

- The checked-in `project.yaml` is a fixture-style local validation config, not a real production job.
- `npm ls` may report `@emnapi/runtime` as extraneous after `npm ci` on npm 11 because optional wasm child packages remain in the lockfile while their platform-specific parents are skipped. Treat this as non-blocking only when `npm ci`, `npm audit`, build, tests, `validate`, `plan`, and `run --dry-run` all pass.
- Vite may warn because this workspace path contains `*`. Tests currently pass in this path; move the repo to a path without `*` if that warning becomes operationally noisy.
