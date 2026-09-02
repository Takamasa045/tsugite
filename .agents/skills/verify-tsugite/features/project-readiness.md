# Project readiness

Project readiness tells a user whether the local Tsugite runtime, Remotion backend, and copied `project.yaml` are worth driving before any planning or execution.

## Sub-features

- `RDY-CLI-01` — check supported Node and npm versions.
- `RDY-CLI-02` — check ffmpeg and ffprobe.
- `RDY-CLI-03` — validate the copied project and import the configured Remotion tooling.

## How to get to it (user POV)

- Run the public CLI `doctor` command with no project for machine-only readiness.
- Run `doctor --config` against a project for runtime plus project/backend readiness.
- The loopback launcher's setup display is a separate browser entry and is uncovered by this CLI slice.

## Driving it with Node CLI

Preconditions: repository dependencies already exist; Launch has produced `VERIFY_TSUGITE_MANIFEST`; the manifest points to an owned temporary project home; `/usr/bin/sandbox-exec` is available.

1. Run `node .agents/skills/verify-tsugite/scripts/verify.mjs doctor --manifest "$VERIFY_TSUGITE_MANIFEST"`.
2. Expect exit 0 and helper JSON with `ok: true`, `status: "verified"`.
3. Read `doctor.stdout.json`; expect `command: "doctor"`, `ok: true`, and every Node, npm, ffprobe, ffmpeg, project, backend, and tool check to be `ready`.
4. Read `doctor.exit.json`; expect the expanded argv to begin with `/usr/bin/sandbox-exec` and its profile to deny all network access.

## Gotchas

- `doctor` can probe adapter-specific tools when a project selects an adapter; this slice uses the local fixture with no external adapter.
- A passing `doctor` does not approve Gate 1, provider access, generation, rendering, publication, or payment.
- Running against `examples/local-fixture` directly is read-only, but the maintained recipe uses a copied project so Doctor and Drive share one owned identity.
