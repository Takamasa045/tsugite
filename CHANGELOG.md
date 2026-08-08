# Changelog

## Unreleased

- Added a launcher **Safe Maintenance** shelf (安全な整理) that keeps Git worktree cleanup and completed-project media finalize as separate preview → review → explicit apply flows. Browsers send only short-lived server-held review IDs (never full paths); apply revalidates live state and invokes the canonical `worktrees` / `finalize` CLI without `--force`, branch deletion, or bulk delete.
- Finalize CLI now reports an explicit `already_finalized` flag (record existence + no remaining media candidates + durable launcher home), so path-only `completion_record` values cannot be mistaken for a finished cleanup.

## 0.8.0 - 2026-08-06

- Added the H3 Prompt Director with typed request compilation for text-to-video, image-to-video, first/last-frame, reference, and voiceover workflows; deterministic prompt rendering; adapter capability checks; fail-closed validation; and review/run artifacts while preserving generation, billing, and Gate approval boundaries.
- Added read-only launcher cards for safe completed direct-edit artifacts that have a valid `completion-record.json` without requiring a `project.yaml`, while rejecting malformed, oversized, symlinked, or out-of-shelf records.
- Refined the HyperFrames expression shelf into a browse-and-copy catalog with separate individual and combined prompt copy flows, without automatically injecting expression text into production requests or implying execution capability.
- Simplified template completion by removing the optional finish selector and its related request/state plumbing.

## 0.7.3 - 2026-08-04

- Added transaction-safe project storage finalization with lock and identity revalidation, recovery journals, durable-project promotion, completion records, and fail-closed protection for canonical media and project boundaries.
- Added non-billing runtime model preflight for TopView and PixVerse/PixBurst in the CLI and generation canvas, allowing new provider models without a Tsugite static allowlist while preserving provider-side validation and generation approval boundaries.
- Added threshold-based warnings for accumulated safely removable worktrees, including daily host guidance, exact-path non-force cleanup, and fresh warning counts when apply-time revalidation fails.
- Improved HyperFrames expression browsing, recommendation, selection, and preview playback, including reduced-motion and keyboard-focus coverage.
- Improved long local caption rendering and added the Remotion skate-cam presentation preset with audio and layout safeguards.
- Added GitHub community health files and refreshed audited Remotion, MCP SDK, HyperFrames, Node type, and download-site dependency pins.

## 0.7.2 - 2026-07-30

- Refined the template wizard and copy guidance, added launcher summaries for learning reviews and presentation presets, and introduced browsable HyperFrames references plus an expression library with recommendations and previews.
- Added guarded worktree lifecycle commands and approval-bound deferred reconciliation, including isolated merge verification, identity revalidation, local fast-forward, and non-force cleanup that fails closed on conflicts or drift.

## 0.7.1 - 2026-07-28

- Fixed Viewer run-log compatibility for limited annotated `## Requests (...)` headings and assembly detail rows that omit `attempts`, showing `試行回数記録なし` instead of inventing values, while still rejecting malformed request lines and Gate 2 sections placed after Requests.

- Added `character-add` CLI (`node bin/pipeline character-add --config <project.yaml> --from-manifest <manifest.json> --speaker <id>`) to copy a speaker and its images from a source manifest into a target project without generation or Gate changes.

- Added an opt-in conditional Gate 2 auto-pass (`gates.gate_2.auto_pass: qc_ok_no_new_assets`) for local-media projects, applied only when the run consumed no credits, generated no new assets, and passed every Gate 2 QC check; the approval is recorded through the same inspection and digest the human path uses, with `decision_source: auto_qc`, and `run` always reports why an auto-pass did not apply.

- Ended public distribution of the Desktop app, removed installer links from the product site, changed the supported entry point to GitHub source with Codex / Claude Code, and limited Desktop packaging CI to manual developer-only smoke checks without uploaded artifacts.

- Added project naming, template selection, character gallery, durable project shelf, dialogue-production, preview, run-log, and safe Codex setup improvements.
- Removed local-only presentation presets and their dedicated assets from public source distribution.

## 0.6.0 - 2026-07-23

- Added deterministic multi-source composition proposals for three or more local videos, with brief constraints, story guidance, scene and transcript evidence, similarity suppression, and human comparison of up to three strategy-preserving alternatives.
- Added the Coordinator-controlled `compose` command, ReviewDocument v3 composition comparison, explicit proposal selection, Gate 1 digest binding, and stale rejection when source bytes, analysis settings, brief, manifest, or proposal artifacts change.
- Added a backend-neutral composition EDL compiler that reorders source-aware clips, captions, and chapters only after Gate 1 approval, then reuses the existing Gate 2, render, and Gate 3 integrity checks.
- Added local FFmpeg scene observations and representative frames without network or credential access, including indirect playlist rejection, contained writes, source SHA-256 verification, and malformed-artifact fail-closed checks.
- Includes the guarded generation routes, Desktop and launcher improvements, onboarding, automation guidance, dependency hardening, and cross-platform fixes introduced during the `0.6.0-beta.1` and `0.6.0-beta.2` prereleases.

## 0.6.0-beta.2 - 2026-07-22

- Added guarded PixVerse, Kling, and TopView generation routes plus an optional in-app AI CLI workspace without weakening the existing run, render, or Gate boundaries.
- Added launcher Gate review links, safer artifact navigation during active CLI work, and Windows portability fixes for the new agent and review flows.
- Added the Tsugite Desktop download landing page, refined its motion and safety guidance, and added a reproducible macOS ad-hoc packaging path for limited beta distribution.
- Added host-specific setup guidance for the learning-promotion review automation while keeping notification and approval boundaries explicit.
- Added a typed CLI command catalog with general and command-specific help, safer unknown-command guidance, and aligned cross-platform onboarding examples.
- Added a Desktop-only recovery path for empty project shelves that safely validates, saves, and restarts into a newly selected workspace without accepting renderer-supplied paths or interrupting active work, plus packaged macOS and Windows E2E coverage for the full recovery flow.
- Patched transitive Hono, URI parsing, and image-processing dependencies, added compatibility regression tests, and made CI reject moderate-or-higher production and development advisories.
- Patched the download site's transitive build and image dependencies, added runtime security contracts, and made its CI audit production and development dependencies independently from the root install.

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
