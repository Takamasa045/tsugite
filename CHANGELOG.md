# Changelog

## Unreleased

- Hardened project request IDs and adapter output paths against traversal, duplicates, mismatches, and symlink escapes.
- Added integrity checks for resumed Gate 2 runs and preserved generated asset/credit metrics.
- Added Gate 3 QC reports and a Gate 3-only `re-render` transition.
- Added config-aware `doctor` checks and strict CLI option parsing.
- Prevented raw provider CLI output from leaking through adapter errors.
- Added CI, Dependabot, Node engine constraints, and enforced 80% core coverage thresholds.

## 0.2.0 - 2026-07-09

- Added optional OpenClaw CLI bridge and Hermes analysis handoff adapters.
- Documented optional adapter setup for distribution-time opt-in use.
- Added tests that keep optional adapters out of base validation unless selected.
- Added reserved manifest support for caption speaker labels and chapters.
- Added adapter `class` metadata for generation and analysis contracts.
- Expanded planned Gate steps and state tracking for Gate 1-3 approvals.
- Connected Gate approval state to the CLI and guarded non-dry-run run/render commands.
- Added local-media run assembly that copies manifest assets into the run directory and waits at Gate 2.
- Added the Remotion backend runner for local-media renders, render reports, and Gate 3 handoff.
- Extended vendor boundary checks to backend names.

## 0.1.0

- Added the initial neutral manifest contract and Phase 0 CLI skeleton.
