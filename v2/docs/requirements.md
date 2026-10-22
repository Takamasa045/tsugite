# V2 requirement and evidence tracker

Source: the complete user-supplied v2 design, **339 lines / 20,533 bytes**,
dated 2026-10-18, read in full. The earlier 327-line attachment was also
compared in full; twelve added lines contain decisions/references, while the
implementation requirements are unchanged.

Later user decisions override attachment proposals: name **継手 / Tsugite**,
English-first documentation, confirmation-page-only approvals, separate
service-credit budgets, optional official branding, forks allowed subject to
licenses. The reported number of Remotion users is not an eligibility finding.
A subsequent explicit instruction authorizes commit/push and the existing
GitHub main/source-release/tag process after verification. It does not authorize
new service registration, credential changes or paid generation.

Status: **done** = implemented in this alpha; **partial** = explicit subset;
**pending** = not implemented/verified; **external** = requires release, real
people, external service or a separate approved operation. A passing offline
sample is phase-one foundation evidence, not completion of the fourteen-week
product roadmap or proof of paid integrations.

| ID | Requirement from the complete design | Status | Implementation / verification |
|---|---|---|---|
| C01 | Rewrite a thin new core, independent of v1 | done | `v2/src`, no v1 code imports; existing entry points untouched |
| C02 | At most 15,000 core lines | done | `wc -l v2/src/*.mjs`; currently well below target |
| C03 | Vendor-neutral core, replaceable source/analysis/voice/rendering parts | done | Versioned video/audio source, renderer and zero-credit analysis contracts; no vendor names in core |
| C04 | Files are authority: YAML/JSON/JSONL/Markdown | done | YAML config, JSON plans/approvals/transactional event history, Markdown rules |
| C05 | CLI under every agent entrance; no agent-only powers | done | Shared dispatcher, MCP tests |
| C06 | Human confirmation before money/irreversible operations | done | Page-only checks also guard configured live transports; fake-HTTP approval-before-send regression; clean remains reversible |
| C07 | Explicit project budget enforcement | done | Fixed-point service limits; atomic full-batch reservations |
| C08 | Defaults have real execution records; others labs/community | done | Only local offline plugin bundled; contract labels enforced |
| C09 | Portable private preferences | done | Project/global preference lifecycle, local grouping and portable taste packs |
| C10 | npm, MCP and Agent Skills standard interfaces | done | Independent npm-format package, standard MCP SDK and short portable Agent Skill; registry publication is separate |
| U01 | Noncoding creators can work outside the repository | done | Absolute CLI path / packed npm binary operates on own folder |
| U02 | First sample needs only Node + FFmpeg, no account/key | done | `init`, actual offline smoke |
| U03 | `init` creates zero-generation-cost sample media | done | Local synthetic footage; no download |
| U04 | `plan` opens storyboard/duration/zero-cost page | done | Default local server/browser opener; HTTP page tests |
| U05 | Page approves plan, `make` + `export` produce final.mp4 | done | Real six-second MP4 integration test |
| U06 | One-line `note` influences next plan | done | Observations in deterministic context; no automatic prose-to-edit inference |
| U07 | First result within ten minutes | partial | Timed machine smoke; three novice user trials pending |
| U08 | Transcription/captions/reframing workflows | done | Real local CPU Whisper transcription plus audio normalization, SRT/MP4 captions and reframing |
| F01 | Single tsugite.yaml entry, standard folder layout | done | Strict config validation and init layout |
| F02 | Versioned shared timeline joins sources/renderers | done | Planned clips, durations, format, content identity |
| F03 | Defaults fill omitted model/resolution/fps | done | Plugin normalization resolves model/quality/aspect and core fps before plan approval; private defaults are bound to identity |
| F04 | Service budgets replace ambiguous `300 credits` | done | Ambiguous scalar rejected; individual service maps |
| F05 | Global config/auth/preferences under ~/.tsugite | done | Private versioned ~/.tsugite/config.json with scalar defaults and environment credential references; lazy secret resolution; never writes credentials |
| G01 | Plan/clips/final checks | done | Prerequisite enforcement + stage-bound records |
| G02 | Confirmation page is the only approval action | done | No CLI/MCP approval command; rejection tests |
| G03 | Raw plan change invalidates approval | done | Whitespace and forged-plan regressions |
| G04 | Settings/assets/plugins/preferences changes invalidate | done | Deterministic recomputation + source hashes |
| G05 | Unattended runs stop before plan check | done | `plan --no-review`; make fails pending approval |
| G06 | Review shows material and final output | done | Session-bound videos, current file hashes, final duration |
| G07 | Remake only one clip | done | Page creates new attempt/plan; unaffected task reuse tested |
| G08 | Optional zero-credit/no-new-asset clips auto-pass | done | Only explicit setting + zero new tasks + probed inputs |
| G09 | Guard accidental operation without false OS isolation claim | done | README, page footer, architecture and Skill |
| B01 | Budget ledger survives failures, retries and restarts | done | Atomic jobs/ledger/events, uncertain reservations retained |
| B02 | No duplicate execution or parallel over-reservation | done | Exclusive project lock + task identity; concurrency tests |
| B03 | Never add different provider credits | done | Separate ledger view and independent bounds |
| B04 | Provider idempotency/reconciliation | partial | Durable async IDs, Kling external-ID query, bounded status/resume and page-only reconciliation; no false retry/refund/remote credit-cap guarantee; paid acceptance pending |
| T01 | Observation → habit → rule, no PR/code changes | done | Page promotion after final; no git mutation |
| T02 | Three related observations trigger one prompt after final | done | Conservative local wording normalization plus explicit grouping; no preference upload |
| T03 | Accepted rules append taste/rules.md and auto-load next plan | done | Promotion/replan integration test |
| T04 | Count helped/missed and offer retirement after two misses | done | Page results, counters and explicit page retirement; tested |
| T05 | Project and global preference scopes | done | Global/project context, habits, promotion and statistics; global writes serialized |
| T06 | Optional machine-checkable rule conditions | done | Media duration/dimensions and explicitly labeled BGM timeline-schedule checks |
| T07 | Taste packs import/export, explicit sharing only | done | Local JSON pack; imports are suggestions; no upload |
| T08 | Preferences never leave the computer automatically | done | No provider path/telemetry in core |
| P01 | One plugin = one package, declarations + constraints | done | SDK scaffold, validation and local content-pinned install |
| P02 | Free mock required; core tests use no paid services | done | Mock required as file; scaffold test + isolated mock-credit cases |
| P03 | plugin new scaffold starts with passing tests | done | Generated standalone Node test executed |
| P04 | plugin add named npm package | done | Exact npm package/version acquisition without lifecycle scripts; bounded tar validation and identity matching; mocked registry tests plus a real local npm archive; registry network acceptance unverified |
| P05 | Community/labs labels, optional official namespace | done | No vendor endorsement assumed; no official requirement |
| P06 | Remotion renderer with accurate license notice | done | Independent optional renderer; real audio/caption MP4 fixture on Mac; sequential still-image holds share the local timeline; tested peers/browser pinned in plan; accurate license guidance; v1 project-specific motion/character graphs stay on v1 |
| P07 | HyperFrames renderer with music/SFX | done | HyperFrames **0.8.173** pinned in the v2 adapter (real export evidence was recorded on 0.8.24) (`v2/plugins/hyperframes`; version enforced in `index.mjs`), timed captions, looping BGM and SFX under external-network denial. Independent of the v1 root pin **0.8.75** (`package.json`, `backends/hyperframes`). Existing v1 dependencies unchanged |
| P08 | PixVerse/Kling source plugins | partial | Official current PixVerse V6 text, image-to-video, transition, extend, upscale, prompt-only modify and image-reference Fusion HTTP transports, dated rates, identity recovery and synthetic protocol tests implemented; Kling remains text-only on HTTP. Formal 2.0.0 does not accept PixVerse by an API-key paid call. The subscription CLI path is in this package and is tested with a fake CLI. The remaining check is a real generation and a full export through the service CLI while that subscription is already logged in. Kling and TopView use the same CLI-login policy. That real-machine check is not done, and this tracker adds no Tsugite login command |
| P09 | Local media analysis/Whisper | done | Real existing whisper.cpp/large-v3-turbo model CPU transcript under network denial; binary/model digests retained |
| P10 | ElevenLabs narration | partial | Official timestamped TTS plus documented music (`music_v2_5`) and SFX (`eleven_text_to_sound_v2`) HTTP transports, local WAV conversion and synthetic tests implemented; `credits: null` keeps the reservation after a received file. One billed 2-second SFX is the recorded paid acceptance (#243). Speech and music paid acceptance are still open. v1 hosted-MCP v4/Turbo and composition plans are not this transport |
| P11 | Fast Edit plugin | done | Standalone validated 18-card decision compiler and real frame-time renderer with emphasis/effects/transitions/zoom/SFX; editable v1 Fast Edit migration; no Jev path changed |
| P12 | Story/prompt/H3 knowledge packs | done | Portable local story/prompt guidance snapshots; advice never implies execution support |
| P13 | Tesseract/Editframe/Hypit, TopView/MiniMax as labs | partial | Non-destructive local source-separation packages and zero-cost integrity inspections implemented; experimental v1 execution retained; new labs remote/maintainer review awaits author |
| P14 | Premiere/AE, Canvas/Studio/3D, Shitate/character as labs | partial | External editing Skills/helpers/viewer/character sources separated with inspection-only manifests; no new runtime capability claim; remote relocation/maintainer acceptance pending |
| P15 | Separate tsugite-labs repo, promote on evidence | external | Creating/moving repositories not performed |
| A01 | --json CLI foundation | done | JSON operation results/errors, strict flags |
| A02 | Eight workflow commands with plain user terms | done | Eight workflow commands plus explicit MCP transport |
| A03 | SKILL.md <=200 lines and client portability | done | Short standalone v2 Skill |
| A04 | MCP plan/status/make interface | done | Standard SDK stdio + same dispatcher; no approval tool |
| A05 | One-command Claude Code/Codex installer | done | plugin skill --to explicit-client-skills; works for normal Claude Code/Codex Skill directories without overwrite |
| A06 | Unified review/viewer confirmation page | done | One localhost page serves all three checks |
| D01 | Independent npm package, clone-free installation | done | Local tarball clean-installed outside repo with public YAML dependency, then packaged CLI/page completed a 6-second zero-credit sample; no npm publication |
| D02 | macOS/Windows/Linux CI every update | done | All three OS lanes passed check, offline/extended CLI smoke and pack; separate Ubuntu real Remotion lane passed; [run 39125766734](https://github.com/Takamasa045/tsugite/actions/runs/39125766734) |
| D03 | Templates, taste and knowledge packs shareable separately | done | Versioned timing template import/export, taste JSON and local Markdown knowledge packs |
| D04 | Site gallery with examples | done | [Gallery](gallery.md) merged to existing public GitHub project; all example assets downloaded anonymously and SHA-256 verified |
| D05 | README first screen value + 30-second demo | done | Synthetic 30-second 720p demo published in [alpha release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.1), downloaded and verified |
| D06 | At least five good-first-issues | done | Five `good first issue` issues published on 2026-10-20 with owner approval: #228–#232 (drafts 1, 3, 4, 5, 7 in contribution-backlog.md). Draft 2 (Japanese quick-start) is done as of alpha.5 |
| D07 | Monthly grouped dependency maintenance, few dependencies | done | YAML-only core + optional MCP SDK; monthly grouped /v2 policy, v1 entries unchanged |
| D08 | Author governs; plugin maintainers assigned | external | Actual maintainer assignment required before release |
| M01 | v1 maintained during transition; active projects finish on v1 | done | Worktree isolation and untouched v1 sources/data |
| M02 | Move v1 maintenance to v1 branch | external | Branch policy/rename withheld; needs release coordination |
| M03 | Copy migration for v1 project data | done | Supported editable data and full Fast Edit decisions copy; explicit final snapshot plus non-executable native metadata/media archive; character locks verified; originals/keys/state/approvals preserved |
| M04 | Remove desktop/download-site/worktree/Agent Services from v2 | done | Independent package excludes all of them; no v1 deletion |
| M05 | Replace finalize digest ceremony with clean preview + page | done | Preview-hash-bound reversible trash move |
| M06 | Four phases/14 weeks, independent-user gate each phase | external | Foundation only; no real-user gate claimed |
| M07 | Start new productions on v2 only after phase two | external | Alpha is for isolated trials; v1 productions unchanged |
| S01 | Three non-author novice trials on three OSs in ten minutes | external | Requires actual people/OSs; matrix is not a user trial. Prep kit is onboarding/trial-kit.ja.md; paid acceptance remains last |
| S02 | 20 non-author videos within three months | external | Post-release metric |
| S03 | Three community plugins within three months | external | Post-release metric |
| S04 | One monthly dependency-update PR | external | Post-release policy; v1 bots not modified |
| S05 | Fork users notified; maintenance duration agreed | external | No external messages sent; policy pending |
| X01 | Plan forgery / CLI or MCP approval bypass tests | done | `tests/workflow.node.mjs` |
| X02 | Duplicate execution / concurrency / failure ledger tests | done | Same integration suite + mock credits only |
| X03 | Traversal/symlink/XSS/CSRF/DNS-rebinding-style Host tests | done | Actual loopback HTTP and filesystem fixture tests |
| X04 | No paid generation/new service registration/credential edits | done | None performed; subsequent push/GitHub release authorization recorded above |
| X05 | Preserve production data and dirty primary worktree | done | Durable dedicated .work/tsugite-v2-worktree with local checkpoint commits; primary changes/projects preserved |

## Formal 2.0.0

`v2/package.json` stays `2.0.0-alpha.5`. This section records the release
judgment. It does not tag, publish a GitHub Release, or publish to npm.
The same table is in the [Japanese decision record](migration-plan.ja.md) and
the [English decision record](migration-plan.md).

Do not call this package 2.0.0 until every row below is met.

| Criterion | Now |
| --- | --- |
| ElevenLabs SFX paid acceptance | **Done.** One 2-second request. An explicit `credits: null` marks the received audio successful and keeps the reservation until the confirmation page settles it ([#243](https://github.com/Takamasa045/tsugite/pull/243)) |
| ElevenLabs speech and music paid acceptance | Open. The one SFX request does not cover them |
| Passing PixVerse by an API-key paid acceptance | **Removed from the criteria.** This row overrides the 2026-10-19 stage-2 wording for PixVerse |
| PixVerse real-machine check on the subscription CLI | **Open.** The path is in this package and tests use a fake CLI. While the PixVerse CLI is logged in with that subscription, confirm a real generation and a full export of that generation. This tracker adds no Tsugite login command |
| Kling and TopView | Same policy: use each service's CLI while that subscription is already logged in, not an API key in settings. The path is in this package. Real-machine checks are open. They do not stand in for the PixVerse check |
| Owner's explicit approval to make v2 the default for new productions (stage 4, M07) | Open. Pointing the README at v2 is not that approval |
| Keep v1 in maintenance (M01) | Existing `project.yaml` productions finish on v1. Moving the maintenance branch (M02) is open |
| Three non-author first trials (U07 / S01) | Open. Separate from paid acceptance and the CLI check |

PixVerse, Kling, and TopView are not connected by writing an API key into the
project. ElevenLabs is outside that CLI policy.

## Remaining acceptance and rollout

Locally implementable code and reproducible evidence are in this alpha.
The remaining partial rows refer to the subscription-CLI real-machine check,
remaining ElevenLabs speech/music acceptance, independent
users or author/maintainer decisions. The experiments
remain explicitly v1 compatibility sources; their inventory is not a promise
of new v2-native execution. See [local readiness](local-readiness.md) for each
external requirement and the precise supported boundary.
The owner-facing [v1→v2 migration decision record](migration-plan.ja.md)
records the 2026-10-19 decision: the recommended feature split is adopted,
paid acceptance is last (lowest-credit service first; Kling may need prepaid
credits), and execution order is 1 → 3 → 4 → 5 → 2. On 2026-10-22 the PixVerse
acceptance method changed from an API-key paid call to a subscription-CLI
real-machine check. The English copy is [migration-plan.md](migration-plan.md).
Remaining owner choices are the three testers, the v2 default cutover,
and v1 wind-down.

The registry acquisition command has synthetic hostile-output tests and real
local npm-archive installation evidence; independent community package review
and live registry acquisition acceptance are still separate from core packaging.
Optional richer guidance/semantic matching remains future enhancement; the
implemented conservative local matching and explicit grouping never upload notes.

Do not call this a formal complete v2 or mark independent-user gates passed.
A reviewed alpha source release is authorized, with no paid generation, new
account, credentials change or destructive v1 migration. Actual push/CI/tag/asset
results are recorded only after read-back. PR #203 merged at `73f00cf`, and
`v2.0.0-alpha.1` is a public prerelease at that commit. All seven release assets
were downloaded without authentication and matched their SHA-256 values.
Current totals: **74 done, 6 partial, 10 external** (90 requirements). This does
not turn the remaining acceptance gates into completed implementation claims.
