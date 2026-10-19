# Contribution issues prepared for review

These are local issue drafts, not published GitHub issues or assigned work.
Draft 2 is done for a first Japanese walkthrough (alpha.5). **Five** unpublished
`good first issue` candidates remain (1, 3, 4, 5, and 7). Draft 6 is a
`help wanted` follow-up, not a novice starter. Before release, a maintainer
can select at least five and post them explicitly. Do not create GitHub
issues from this file unless the owner asks. Each remaining draft uses
synthetic media and no provider credentials. Preserve the confirmation-page
checks and never submit test approvals to real projects.

Independent 10-minute trials use the
[trial kit](onboarding/trial-kit.ja.md) and the
[v2 trial report](../../.github/ISSUE_TEMPLATE/v2-trial-report.yml) form.
CI success is not a user trial.

## 1. Test the sample with a first-time Windows user

**Publish title:** `docs: first-time Windows trial of the alpha.5 sample`

Suggested labels: `good first issue`, `documentation`, `windows`, `v2`.

**Problem:** Requirement U07 / S01 needs a non-author Windows trial. CI does
not count.

**Work:** Follow the [trial kit](onboarding/trial-kit.ja.md) on a fresh
Windows machine with Node 22 and FFmpeg already installed. Use a new empty
folder. Do not write into this repository's `projects/`. File the result with
the v2 trial report form.

**Acceptance:**

- OS, Node, npm, and FFmpeg/`libx264` versions recorded
- Minutes to first playable `final.mp4`, excluding confirmation-page reading
- First stuck point in one or two sentences
- Confirmation that plan, clips, and final checks were used
- No personal paths, media, or credentials
- Optional follow-up PR only if a focused documentation fix is needed

**Out of scope:** paid APIs, credential changes, relaxing page checks, treating
CI as the trial.

## 2. Add a translated quick-start without duplicating safety rules

**Status: done (alpha.5).** Do not open this as a new issue.

The standalone package already ships [`v2/README.ja.md`](../README.ja.md),
[first-video](onboarding/first-video.ja.md) and
[see-and-choose](onboarding/see-and-choose.ja.md). The leftover command
walkthrough is now draft 7.

Original scope (history only): add a Japanese quick-start linked to the
English-first README covering the eight commands, two terminals,
service-specific budgets and page-only checks.

## 3. Improve accessible confirmation-page status messages

**Publish title:** `a11y: keyboard-check confirmation-page status copy`

Suggested labels: `good first issue`, `accessibility`, `ui`, `v2`.

**Problem:** The confirmation page is the only approval surface. Headings,
labels, focus order and stale-plan errors should work from the keyboard.

**Work:** In an isolated `tsugite init` sample, audit the small
server-rendered page. Improve status copy or semantics without adding
third-party scripts.

**Acceptance:**

- Keyboard steps recorded (Tab order, activate Approve, stale-plan error)
- Semantic HTML assertions for any markup change
- Existing HTTP security suite still passes
- CSP/CSRF/Origin checks unchanged or stricter

**Out of scope:** new frontend frameworks, weakening CSP, CLI/MCP approval,
writing approvals into real projects.

## 4. Supply an additional portable timing template

**Publish title:** `templates: add a short unequal-clip timing pack`

Suggested labels: `good first issue`, `templates`, `v2`.

**Problem:** Template packs should share timing without embedding media or
provider requests.

**Work:** Create a short timing-template fixture with synthetic sample
footage, unequal clip lengths and plain captions.

**Acceptance:**

- Import into a fresh project, review and export locally with zero credits
- Test that no approval or generation request is imported
- Pack contains no provider fields and no embedded media files
- Do not claim support for an arbitrary native effect graph

**Out of scope:** Remotion graphs, PixVerse/ElevenLabs live tasks, copying
v1 `edit.backend`.

## 5. Expand plain subtitle edge-case coverage

**Publish title:** `captions: cover Unicode, empty cue, and boundary times`

Suggested labels: `good first issue`, `testing`, `captions`, `v2`.

**Problem:** Parser and WebVTT escaping need explicit accept/reject cases
beyond the happy path.

**Work:** Add small SRT cases for Unicode text, an empty cue and boundary
times. Document which cases are accepted or rejected.

**Acceptance:**

- Deterministic tests without a model or download
- No HTML injection in WebVTT
- No cue beyond the approved timeline
- Empty or invalid cues fail with a stable error

**Out of scope:** paid caption services, burn-in pixel tests that need a
browser, changing approval rules.

## 6. Verify real local Whisper transcription

**Publish title:** `plugins: distinguish real Whisper output from the mock`

Suggested labels: `help wanted`, `plugins`, `local-only`, `v2`.

This is not a novice starter issue.

**Problem:** Mock transcripts must not be treated as applied final captions.

**Work:** With an explicitly chosen existing whisper.cpp binary and model,
transcribe a licensed redistributable short fixture. Record tool/model
identity and output. No download is part of the test command.

**Acceptance:**

- Real SRT can be planned, reviewed and rendered locally
- Test evidence distinguishes this from the mock
- Network-denied run; no provider credentials

**Out of scope:** downloading models in CI, changing page-only approval,
uploading transcripts.

## 7. Add a Japanese eight-command cheat-sheet that links safety rules

**Publish title:** `docs: Japanese cheat-sheet for the eight v2 commands`

Suggested labels: `good first issue`, `documentation`, `translation`, `v2`.

**Problem:** Alpha.5 already has a Japanese first-video guide. The eight
workflow commands, two-terminal `plan`/`make` split, and per-service budgets
are still easiest to scan in the English README. A short Japanese cheat-sheet
should link those rules, not rewrite them.

**Work:** Add a short Japanese page (or a README.ja.md section) listing the
eight commands with one-line purpose each. Link to the English README for
recovery, licenses, budgets and page-only checks. Keep the first-video guide
as the timed walkthrough.

**Acceptance:**

- Commands checked against the offline sample (`init` through `export`/`note`/`clean`)
- No CLI approval flag and no same-OS isolation claim
- Safety/license/budget sentences are links to canonical English sections
- Relative links resolve; no duplicate promises about paid services

**Out of scope:** replacing `first-video.ja.md`, creating GitHub issues,
changing Gate or credit behavior.

## Release decisions still owned by the author

Actual maintainer assignments, the v1 support duration/branch policy, the labs
repository location, public issue creation, gallery hosting and npm publication
remain pending. Fork allowance preserves each upstream license. The local
implementation and issue drafts do not authorize those external operations.
Who runs the three OS trials, and which five issues are posted, stays an
owner choice. Stage 2 paid acceptance stays last.
