# Contribution issues prepared for review

These are local issue drafts, not published GitHub issues or assigned work.
Before release, a maintainer can select at least five and post them explicitly.
Each can be developed with synthetic media and no provider credentials. Preserve
the confirmation-page checks and never submit test approvals to real projects.

## 1. Test the sample with a first-time Windows user

Suggested labels: `good first issue`, `documentation`, `windows`.

Have one non-author follow the README in a new temporary directory with Node
22 and FFmpeg installed. Record versions, elapsed time excluding human review,
the first confusing step and a redacted console transcript. Confirm final MP4
playback and all three check states. Do not upload personal paths, media or
credentials. Acceptance: an opt-in human trial report and a focused documentation
fix. CI execution alone does not meet the user-trial condition.

## 2. Add a translated quick-start without duplicating safety rules

Suggested labels: `good first issue`, `documentation`, `translation`.

Add a Japanese quick-start linked to the English-first README. Cover the eight
commands, two terminals, service-specific budgets and page-only checks. Link
to the canonical recovery/license sections rather than inventing new promises.
Acceptance: commands checked against the offline sample, no CLI approval flag
or same-OS isolation claim, and a readable first-time-user walkthrough.

## 3. Improve accessible confirmation-page status messages

Suggested labels: `good first issue`, `accessibility`, `ui`.

Audit headings, labels, focus order and stale-plan errors with keyboard navigation
in an isolated sample. Improve the small server-rendered page without adding
third-party scripts or relaxing CSP/CSRF checks. Acceptance: recorded keyboard
steps, semantic HTML assertions for changes and the existing HTTP security suite.

## 4. Supply an additional portable timing template

Suggested labels: `good first issue`, `templates`.

Create a short timing-template fixture using synthetic sample footage. Include
unequal clip lengths and plain captions, with no provider requests or media
embedded in the pack. Acceptance: import into a fresh project, review and export
locally with zero credits, plus a test that no approval or generation request is
imported. Do not claim support for an arbitrary native effect graph.

## 5. Expand plain subtitle edge-case coverage

Suggested labels: `good first issue`, `testing`, `captions`.

Add small SRT cases for Unicode text, an empty cue and boundary times. Decide
explicitly which cases are accepted or rejected, then test parser behavior and
WebVTT escaping. Acceptance: deterministic tests without a model/download,
no HTML injection and no cue beyond the approved timeline.

## 6. Verify real local Whisper transcription

Suggested labels: `help wanted`, `plugins`, `local-only`.

With an explicitly chosen existing whisper.cpp binary/model, transcribe a
licensed redistributable short fixture and record tool/model identity and output.
No download is part of the test command. Acceptance: real SRT can be planned,
reviewed and rendered locally; test evidence distinguishes this from the mock.
This requires someone with the runtime/model and is not a novice starter issue.

## Release decisions still owned by the author

Actual maintainer assignments, the v1 support duration/branch policy, the labs
repository location, public issue creation, gallery hosting and npm publication
remain pending. Fork allowance preserves each upstream license. The local
implementation and issue drafts do not authorize those external operations.
