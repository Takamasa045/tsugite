# v1 to v2 migration decision

This file is the English copy of the owner decision in
[migration-plan.ja.md](migration-plan.ja.md). The Japanese file is the record
the owner adopted. This copy matches that record as of 2026-10-22, including
the formal 2.0.0 criteria.

The owner **adopted the recommendation unchanged on 2026-10-19**. It was
written from facts checked in the repository and public releases, plus
production counts the owner supplied separately.

## Owner decision (2026-10-19)

- Adopt the table below unchanged (Remotion / PixVerse / ElevenLabs are covered
  in v2. Production-specific Remotion graphs stay on v1. HyperFrames / MiniMax /
  Editframe / Hypit / Kling / Tesseract stay experimental).
- **Stage 2 (paid acceptance, P08 / P10 / B04) goes last.** Do not spend now.
  When it happens, start with the lowest-credit service. Kling may need prepaid
  credits.
- Stage 1 and stage 3 preparation (trial kit and issue drafts) may proceed
  without spending. Do not loosen the confirmation page, budgets, or secret
  handling.
- A version bump, npm publication, `projects/` edits, paid API calls, and
  creating GitHub issues are not part of this decision.

Current position (2026-10-22):

- The production authority is **v1 0.18.0** (`project.yaml`). v1 stays in
  maintenance. New-work guidance starts at v2. The version number is unchanged.
- The independent trial distribution is **v2 2.0.0-alpha.5** (`tsugite.yaml`).
  The formal 2.0.0 judgment at the end of this file is the one to use.
- ElevenLabs SFX has one recorded paid acceptance (2 seconds). Speech and music
  are open.
- PixVerse, Kling, and TopView are not connected by writing an API key into
  settings. Use each service's CLI while that subscription is already logged
  in. Support arrives in order. The real-machine check is open.
- Three non-author first trials are open. Synthetic tests do not complete paid
  acceptance or a real-machine check.

Production names are omitted. Counts are the owner's tally.

## Five stages

Stage numbers are requirement groups. The order of work is **1 → 3 → 4 → 5 → 2**.
Stage 2 (paid acceptance) is numbered 2 and is done after stage 5. Stage 3
trials and published issues do not wait for stage 2.

Do not start the next stage's publication or billing before the previous stage
in that order is finished. Stage 2 billing starts only after stage 5, and only
after the owner names the account, the cap, and the service.

| Stage | Work | Done when | Owner approval |
| --- | --- | --- | --- |
| 1. Gaps that code alone can close | Close the unpaid gaps among the features the owner marked for v2. Do not loosen the confirmation page, budgets, or secret handling | The targeted gaps are covered by tests. Docs match the implementation. No paid API, `run`, or `render` | Confirm which gaps are in this stage. No billing |
| 2. Paid service acceptance (last) | Check **P08** (PixVerse / Kling), **P10** (ElevenLabs), and **B04** (credit consistency on failure and retry) in real billing units. **Do this last, after stage 5.** Start with the lowest-credit service. Kling may need prepaid credits | One real request per service the owner picks is quoted, run, and settled (or held after failure) through the confirmation page. Synthetic tests are not acceptance | **Required.** Do not start until the owner names the account, cap, and service. Deferred as of 2026-10-19 |
| 3. Human trials and published issues | **U07** / **S01** (three non-authors, three OSs, a first result within ten minutes) and **D06** (at least five good first issues). Of **M06** (four phases, fourteen weeks, an independent user gate each phase), the gate **for this alpha** is the three-person trial. Do not complete all of M06 here | Three trial records (time, first stuck point, no personal data). At least five public GitHub issues. Remaining M06 phases stay open | **Required.** The owner chooses who to ask and which issues to open |
| 4. Switch the default to v2 | **M07** (new productions start on v2), **M02** (where v1 maintenance lives), **S05** (notice to fork users), **D08** (maintainer names), and version **2.0.0**. The alpha gate in stage 3 does not finish M06, so the owner decides whether the remaining phase gates proceed | New-production guidance defaults to v2. How v1 remains is written down. The 2.0.0 publication scope matches the owner's instruction. The rest of M06 is written down | **Required.** The default switch and 2.0.0 wait for an explicit owner approval |
| 5. Wind down v1 | **P15** (where experiments go), **S02**–**S04** (post-release volume, external plugins, monthly updates) | Experiment destinations are chosen. The v1 stop date and what remains (finishing existing productions) are written down. Post-release targets are measured after publication. They are not a start condition for this stage | **Required.** Stopping, moving, or notifying outside parties waits for an explicit owner approval |

This alpha is not formal v2 and not the production default. Until stage 4 is
approved, existing `project.yaml` productions continue on v1. For PixVerse, the
2026-10-22 note below overrides the stage-2 completion cell. API-key paid
acceptance is not a formal-release criterion.

The three-person trial is the **current alpha** slice of the independent user
gate M06 asks for. Stage 3 does not complete the four-phase, fourteen-week
plan. Before stage 4, the owner decides what to do with the remaining phase
gates.

## Features in real productions, and v2

Counts are the owner's tally. Productions inside the repository were not
re-counted.

"v2 now" is what the repository plugins, labs notes, and alpha.5 distribution
docs showed.

| Feature | Productions | v2 now | Adopted policy | Short reason | Evidence |
| --- | --- | --- | --- | --- | --- |
| Remotion (standard assembly) | 62 | Optional plugin. Real export evidence. Passes the confirmation page. Still-image holds were added in stage 1 | **Cover in v2** | Highest count. v2 has a real export path | [`v2/plugins/remotion`](../plugins/remotion/constraints.md), [requirement P06](requirements.md) |
| Production-specific Remotion motion and characters | (inside the 62) | `init --from-v1` does not accept the graph. Only a finished-video copy (`--flatten`) or an archive of the source data (`--archive-v1`) | **Keep on v1** | There is no direct graph migration. A forced conversion would not stay editable | [`v2/src/migrate.mjs`](../src/migrate.mjs), [migration steps](phase-two.md#copying-a-complex-v1-project) |
| PixVerse | 20 | HTTP paths and synthetic tests for V6 text, image-to-video, transition, extend, upscale, modify, and image Fusion. **API-key paid acceptance is not a formal-release criterion.** Real generation and a full export on the subscription CLI are open | **Cover in v2** | High count. Formal release checks a logged-in CLI on a real machine | [`v2/plugins/pixverse`](../plugins/pixverse/constraints.md), [requirement P08](requirements.md) |
| ElevenLabs | 14 | HTTP paths and synthetic tests for official models, voice_settings, music, and SFX. **One SFX paid acceptance is recorded** (2 seconds; explicit `credits: null` is a successful file plus a kept reservation). Speech and music are open | **Cover in v2** | High count. Paid acceptance other than SFX stays in stage 2 | [`v2/plugins/elevenlabs`](../plugins/elevenlabs/constraints.md), [requirement P10](requirements.md) |
| HyperFrames | 8 | v2 adapter pinned to **0.8.173**. Real audio/caption export evidence was taken on 0.8.24. v1 is also pinned to **0.8.173** | **Stay in labs** | The pin matches v1, and 0.8.173 still needs its own real export evidence | [`v2/plugins/hyperframes`](../plugins/hyperframes/constraints.md); v1 pin is 0.8.173 in the root `package.json` |
| MiniMax | 8 | No v2 execution plugin. Separated as a v1 experimental source | **Stay in labs** | There is count, and no v2 execution path. Stage 1 does not add a plugin for it | [Labs list](../labs/README.md), [requirement P13](requirements.md) |
| Editframe | 6 | No v2 execution plugin. Optional v1 runtime. Not in the distribution tarball | **Stay in labs** | An unresolved High dependency alert. Kept out of the v2 distribution | [alpha.5 distribution](release-alpha5.md), GitHub Dependabot [#131](https://github.com/Takamasa045/tsugite/security/dependabot/131), [labs list](../labs/README.md) |
| Hypit | 3 | Not a v2 renderer. v1 production entry separated as an experimental source | **Stay in labs** | Low count, and it is not a v2 exporter | [Labs list](../labs/README.md), [requirement P13](requirements.md) |
| Kling | 2 | Text HTTP path and synthetic tests. Connection is a logged-in CLI, not an API key. Support arrives in order. Real-machine check is open. Labs | **Stay in labs** | Low count. Same connection policy as PixVerse. The owner chooses whether to try it with PixVerse | [`v2/plugins/kling`](../plugins/kling/constraints.md), [requirement P08](requirements.md) |
| Tesseract | 2 | No v2 execution plugin. Optional v1 renderer separated as an experimental source | **Stay in labs** | Low count, and a weak case for the v2 default | [Labs list](../labs/README.md), [requirement P13](requirements.md) |
| Fast Edit | (already in v2) | 18-card decisions and real frame export. Copy from v1 Fast Edit is supported | No gap (already v2) | No further migration decision | [`v2/plugins/fast-edit`](../plugins/fast-edit/constraints.md), [requirement P11](requirements.md) |
| Whisper | (already in v2) | Transcript evidence with a local whisper.cpp and an existing model. Labeled labs, and implemented | No gap (already v2) | No further migration decision | [`v2/plugins/whisper`](../plugins/whisper/constraints.md), [requirement P09](requirements.md) |

## How to read the adopted policy

The owner adopted these three meanings as recommended.

- **Cover in v2:** grow it as a v2 production path. Close unpaid code gaps in
  stage 1. Check anything that needs a paid or real-machine confirmation in
  stage 2 (last).
- **Stay in labs:** do not put it in the v2 default set. Someone who needs it
  opts in. Do not promote it until a maintainer and real-machine evidence exist.
- **Keep on v1:** finish the current v1 production there. Into v2, copy a
  finished video or archive the data. Do not move the edit graph.

Stage 1 covers the unpaid gaps for Remotion / PixVerse / ElevenLabs, the rows
marked for v2.

Remaining owner choices (who the three stage-3 people are, which five issues
to publish, stage 4 onward, and the rest of M06) come after the stage-1 code
and the trial kit. The Japanese quick start was done in alpha.5. Stage 3 steps
are in the [trial kit](onboarding/trial-kit.ja.md) and the
[contribution backlog](contribution-backlog.md).

## Out of scope for this file

- Version bumps, npm publication, desktop redistribution, automatic production
  migration.
- Running a paid API, writing secrets, or editing `projects/`.
- Production names or anyone's personal footage.

## Stage 1 progress (2026-10-21)

On this date the unpaid stage-1 gaps were closed. There was no paid API, no
real render, and no `projects/` edit. v1 code was not reused or imported.

| Target | Gap closed | Gap still open |
| --- | --- | --- |
| Remotion (standard assembly) | PNG/JPEG/WebP holds for an explicit duration on the same timeline as local. Live keeps the extension and passes it to `Img`. Production-specific motion and characters stay out of scope | Those presets, motion, and characters **stay on v1**. Cover fit and transitions between clips are unimplemented. Real Remotion export stays an optional runtime, as before |
| PixVerse | Local stills bound into the plan with `make.inputs`. Official HTTP for V6 image-to-video and first/last-frame transition. Audio-on uses the official V6 rates 7/9/12/23 credits/s. Files over 20 MB are rejected at planning. Synthetic upload and generate tests exist. extend, upscale, prompt-only modify, and image Fusion were added with official HTTP and rates | Video-reference Fusion, mask/swap, motion-control, template, voice, and PixVerse music are unimplemented. API-key paid acceptance is not a formal-release criterion. The subscription-CLI real-machine check is open |
| ElevenLabs | Allowed models (`eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`, `eleven_v3`) plus `voice_settings`, `language_code`, and `apply_text_normalization`. `mode: music` (`music_v2_5`, 3–600s) and `mode: sfx` (`eleven_text_to_sound_v2`, 0.5–30s) are validated at planning. `credits: null` is a successful file plus a kept reservation. Temporary conversion files are removed. Normalize fills the generic `track` (bgm / sfx / narration). Published credits and USD disagree, so `max_credits` is only a reservation ceiling. One paid SFX (2 seconds) is accepted | v1 hosted-MCP v4/Turbo is not this HTTP path. Composition plans and inpainting are unimplemented. Speech and music paid acceptance, and a real voice acceptance, stay in stage 2. An audio-only timeline (no video clip) is unsupported |
| Core | `make.inputs` is limited to files under assets, and the hash is bound into the plan. Those files are not timeline clips. Only an explicit `credits: null` is an unknown settled amount that keeps the reservation (a missing field breaks the contract). Generated audio kind is the generic `track`. v2 isolation uses `TSUGITE_HOME` (`TSUGITE_PROJECTS_HOME` is unused) | v1 generation requests are not imported automatically (the existing warning remains) |

Everything in stage 2 except the one ElevenLabs SFX paid request is outside
this progress note. So are the PixVerse, Kling, and TopView subscription-CLI
connections, and the HyperFrames / MiniMax / Editframe / Hypit / Tesseract
experiments.

## Formal 2.0.0 (2026-10-22)

`v2/package.json` stays `2.0.0-alpha.5`. This section records the judgment. It
does not tag, publish a GitHub Release, or publish to npm.

Do not call the package formal 2.0.0 until every row below is met.

| Criterion | Now |
| --- | --- |
| ElevenLabs SFX paid acceptance | **Done.** One 2-second request. An explicit `credits: null` marks the received audio successful and keeps the reservation until the confirmation page settles it ([#243](https://github.com/Takamasa045/tsugite/pull/243)) |
| ElevenLabs speech and music paid acceptance | Open. The one SFX request does not cover them |
| Passing PixVerse by an API-key paid acceptance | **Removed from the criteria.** This row overrides the 2026-10-19 stage-2 wording for PixVerse |
| PixVerse real-machine check on the subscription CLI | **Open.** While the PixVerse CLI is logged in with that subscription, confirm a real generation and a full export of that generation. Another change is implementing the path. This file adds no login command |
| Kling and TopView | Same policy: use each service's CLI while that subscription is already logged in, and do not write an API key into settings. Support arrives in order. Real-machine checks are open. They do not stand in for the PixVerse check |
| Owner's explicit approval to make v2 the default for new productions (stage 4, M07) | Open. Pointing the README at v2 is not that approval |
| Keep v1 in maintenance (M01) | Existing `project.yaml` productions finish on v1. Moving the maintenance branch (M02) is open |
| Three non-author first trials (U07 / S01) | Open. Separate from paid acceptance and the real-machine check |

The same judgment is in [requirements.md](requirements.md).

## Still unknown

- Production counts came from the owner. They were not re-counted in the
  repository.
- v2 tests were re-run on 2026-10-21. `npm --prefix v2 run check` was **131
  passed / 0 failed / 5 skipped** (optional runtimes and an explicit Whisper).
  Earlier records stay dated in [verification.md](verification.md) and the
  [alpha.5 release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5).
- HyperFrames is pinned to 0.8.173 in both the v1 adapter and the v2 adapter
  (`package.json` and the pin file). Older 0.8.75 / 0.8.24 notes are previous
  pins.
