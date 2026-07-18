# Changelog

## Unreleased

## 0.4.0 - 2026-07-18

- Added a Gate-bound audio adapter contract and HyperFrames `media-use` integration for HyperFrames-first BGM generation and SFX resolution, with no automatic ElevenLabs fallback.
- Extended the dedicated learning-promotion review automation to Claude Desktop/Cowork and Claude Code with explicit, backward-compatible source provenance, shared launcher pickup, and host-native notification guidance.

## 0.3.1 - 2026-07-18

- Added the local launcher and interactive 3D workflow viewer, including project discovery, visual thumbnails, project refresh, stable return navigation, and Windows support.
- Added safe completed-project finalization, Shitate snapshot imports, local and optional external analysis workflows, and richer Gate 1 visual review artifacts.
- Fixed launcher project refresh so unsupported presentation presets remain viewable while unsafe or structurally invalid projects stay blocked.
- Replaced launcher desktop notifications with a startup-loaded, unread-style pickup for pending proposals created by the dedicated learning-promotion automation; manual proposals and other workflows stay out of the pickup.
- Added strict automation provenance to promotion proposals, CLI source flags, pending-priority aggregation, and a reproducible local Codex automation contract that appends at most three complete, non-duplicate proposals without changing shared source.
- Added append-only feedback promotion proposals, human approve/reject decisions, and an explicit approval-waiting workflow in the local launcher without automatically changing shared rules or project state.
- Added a repository-discoverable Tsugite skill for Codex, a Claude Code `/tsugite` compatibility entry, shared feedback-promotion guidance, and configuration regression tests.
- Fixed PixVerse image-to-video requests so provider-derived framing is not overridden by `--aspect-ratio`.
- Extended Gate 3 QC with fail-closed FFmpeg analysis for black segments of at least one second and silent segments of at least three seconds.
- Added a source-backed catalog of 34 story, persuasion, documentary, genre, and music-video frameworks plus 35 film-grammar and AI-video principles; the read-only `story-guides` CLI returns primary/supporting structures, rejected alternatives, timing presets, and context-selected principles.
- Hardened `doctor` with executable version probes, declarative backend/adapter setup checks, OS-specific remediation, and explicit manual handoff status.
- Added the read-only `review` CLI, `ReviewDocument v1`, staged local character assets, and an offline Gate 1 HTML storyboard that never mutates run state.
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
