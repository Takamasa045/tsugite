# Changelog

## Unreleased

- Hardened `doctor` with executable version probes, declarative backend/adapter setup checks, OS-specific remediation, and explicit manual handoff status.
- Added the read-only `review` CLI, `ReviewDocument v1`, staged local character assets, and an offline Gate 1 HTML storyboard that never mutates run state.
- Added the `qa-dialogue` template: FAQ `qa_list` input expands into a Remotion `article-dialogue-16x9` manifest with QUESTION/ANSWER cards, auto timing, and shared character mouth frames.
- Article dialogue header label can be overridden via `presentation.label` (used by Q&A as `Q&A DIALOGUE`).
- Added first-class manifest image assets, speaker/pose metadata, backend presentation preset checks, and guarded image assembly/QC.
- Added the Remotion `article-dialogue-16x9` presentation and a reusable 60-second blog dialogue template with deterministic script-to-manifest generation.
- Pinned local images before credit-bearing generation, added image SHA-256 resume integrity, and preserved legacy run digests across new empty schema defaults.

## 0.3.0 - 2026-07-10

- Added source-backed PixVerse, Kling, and Seedance T2V/I2V prompt knowledge catalogs, structured model limits, a read-only `guides` CLI, request-specific plan guidance, and input-mode execution validation.
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
