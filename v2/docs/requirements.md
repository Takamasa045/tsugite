# V2 requirement and evidence tracker

Source: latest user attachment `libfile_30ea2d42851481918c90aa840eca1ca3`,
**339 lines / 20,533 bytes**, dated 2026-10-18, read in full using Library's
canonical read route, `has_more: false`. Earlier attachment
`libfile_d227b132c88c819186d010e8789ab218`, **327 lines**, was also read in full.
The added twelve lines are the unresolved-decisions checklist and references;
the implementation requirements before that checklist are unchanged.

Later user decisions override attachment proposals: name **継手 / Tsugite**,
English-first documentation, confirmation-page-only approvals, separate
service-credit budgets, optional official branding, forks allowed subject to
licenses. The reported number of Remotion users is not an eligibility finding.

Status: **done** = implemented in this alpha; **partial** = explicit subset;
**pending** = not implemented/verified; **external** = requires release, real
people, external service or a separate approved operation. A passing offline
sample is phase-one foundation evidence, not completion of the fourteen-week
product roadmap or proof of paid integrations.

| ID | Requirement from the complete design | Status | Implementation / verification |
|---|---|---|---|
| C01 | Rewrite a thin new core, independent of v1 | done | `v2/src`, no v1 code imports; existing entry points untouched |
| C02 | At most 15,000 core lines | done | `wc -l v2/src/*.mjs`; currently well below target |
| C03 | Vendor-neutral core, replaceable source/analysis/voice/rendering parts | partial | Source/renderer contract, analysis declaration; voice/analysis execution pending |
| C04 | Files are authority: YAML/JSON/JSONL/Markdown | done | YAML config, JSON plans/approvals/transactional event history, Markdown rules |
| C05 | CLI under every agent entrance; no agent-only powers | done | Shared dispatcher, MCP tests |
| C06 | Human confirmation before money/irreversible operations | partial | Page-only checks; paid providers disabled; clean reversible |
| C07 | Explicit project budget enforcement | done | Fixed-point service limits; atomic full-batch reservations |
| C08 | Defaults have real execution records; others labs/community | done | Only local offline plugin bundled; contract labels enforced |
| C09 | Portable private preferences | partial | Project/global rule text, pack import/export; richer lifecycle below |
| C10 | npm, MCP and Agent Skills standard interfaces | partial | Independent package/stdio SDK/short Skill; publication not performed |
| U01 | Noncoding creators can work outside the repository | done | Absolute CLI path / packed npm binary operates on own folder |
| U02 | First sample needs only Node + FFmpeg, no account/key | done | `init`, actual offline smoke |
| U03 | `init` creates zero-generation-cost sample media | done | Local synthetic footage; no download |
| U04 | `plan` opens storyboard/duration/zero-cost page | done | Default local server/browser opener; HTTP page tests |
| U05 | Page approves plan, `make` + `export` produce final.mp4 | done | Real six-second MP4 integration test |
| U06 | One-line `note` influences next plan | done | Observations in deterministic context; no automatic prose-to-edit inference |
| U07 | First result within ten minutes | partial | Timed machine smoke; three novice user trials pending |
| U08 | Transcription/captions/reframing workflows | pending | Local alpha is silent sequential video cuts |
| F01 | Single tsugite.yaml entry, standard folder layout | done | Strict config validation and init layout |
| F02 | Versioned shared timeline joins sources/renderers | done | Planned clips, durations, format, content identity |
| F03 | Defaults fill omitted model/resolution/fps | partial | Local renderer defaults; per-provider model defaults pending |
| F04 | Service budgets replace ambiguous `300 credits` | done | Ambiguous scalar rejected; individual service maps |
| F05 | Global config/auth/preferences under ~/.tsugite | partial | Configurable taste home; no credential storage/changes introduced |
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
| B04 | Provider idempotency/reconciliation | pending | Interface supplies key; live-provider reconciliation not implemented |
| T01 | Observation → habit → rule, no PR/code changes | done | Page promotion after final; no git mutation |
| T02 | Three related observations trigger one prompt after final | partial | Normalization + explicit grouping; broader semantic matching pending |
| T03 | Accepted rules append taste/rules.md and auto-load next plan | done | Promotion/replan integration test |
| T04 | Count helped/missed and offer retirement after two misses | done | Page results, counters and explicit page retirement; tested |
| T05 | Project and global preference scopes | done | Global/project context, habits, promotion and statistics; global writes serialized |
| T06 | Optional machine-checkable rule conditions | partial | Final duration/dimensions checked and recorded; BGM-specific checks await audio support |
| T07 | Taste packs import/export, explicit sharing only | done | Local JSON pack; imports are suggestions; no upload |
| T08 | Preferences never leave the computer automatically | done | No provider path/telemetry in core |
| P01 | One plugin = one package, declarations + constraints | done | SDK scaffold, validation and local content-pinned install |
| P02 | Free mock required; core tests use no paid services | done | Mock required as file; scaffold test + isolated mock-credit cases |
| P03 | plugin new scaffold starts with passing tests | done | Generated standalone Node test executed |
| P04 | plugin add named npm package | partial | Local reviewed directories only; registry installation pending |
| P05 | Community/labs labels, optional official namespace | done | No vendor endorsement assumed; no official requirement |
| P06 | Remotion renderer with accurate license notice | partial | Official-source guidance supplied; v2 renderer pending |
| P07 | HyperFrames renderer with music/SFX | pending | v1 unchanged, no v2 verification claim |
| P08 | PixVerse/Kling source plugins | pending | No live generation or credits used |
| P09 | Local media analysis/Whisper | partial | Local video probing; Whisper/transcription pending |
| P10 | ElevenLabs narration | pending | No API/credentials selected |
| P11 | Fast Edit plugin | pending | v1 implementation remains available on v1 |
| P12 | Story/prompt/H3 knowledge packs | partial | Project Markdown context; automatic guide conversion pending |
| P13 | Tesseract/Editframe/Hypit, TopView/MiniMax as labs | pending | No code relocation; existing v1 paths retained |
| P14 | Premiere/AE, Canvas/Studio/3D, Shitate/character as labs | pending | No v2 runtime claims or destructive move |
| P15 | Separate tsugite-labs repo, promote on evidence | external | Creating/moving repositories not performed |
| A01 | --json CLI foundation | done | JSON operation results/errors, strict flags |
| A02 | Eight workflow commands with plain user terms | done | Eight workflow commands plus explicit MCP transport |
| A03 | SKILL.md <=200 lines and client portability | done | Short standalone v2 Skill |
| A04 | MCP plan/status/make interface | done | Standard SDK stdio + same dispatcher; no approval tool |
| A05 | One-command Claude Code/Codex installer | pending | Manual Skill installation documented |
| A06 | Unified review/viewer confirmation page | done | One localhost page serves all three checks |
| D01 | Independent npm package, clone-free installation | partial | Package/lock/bin/files boundary; publish withheld |
| D02 | macOS/Windows/Linux CI every update | partial | Dedicated matrix defined; remote runs not performed |
| D03 | Templates, taste and knowledge packs shareable separately | partial | Taste JSON, Markdown context; template import/export pending |
| D04 | Site gallery with examples | external | No site publishing requested/performed |
| D05 | README first screen value + 30-second demo | partial | Value-first v2 README; distributable demo pending |
| D06 | At least five good-first-issues | external | No GitHub writes authorized; proposed backlog below |
| D07 | Monthly grouped dependency maintenance, few dependencies | done | YAML-only core + optional MCP SDK; monthly grouped /v2 policy, v1 entries unchanged |
| D08 | Author governs; plugin maintainers assigned | external | Actual maintainer assignment required before release |
| M01 | v1 maintained during transition; active projects finish on v1 | done | Worktree isolation and untouched v1 sources/data |
| M02 | Move v1 maintenance to v1 branch | external | Branch policy/rename withheld; needs release coordination |
| M03 | Copy migration for v1 project data | partial | Untrimmed silent local clips only; rejects unsupported conversion |
| M04 | Remove desktop/download-site/worktree/Agent Services from v2 | done | Independent package excludes all of them; no v1 deletion |
| M05 | Replace finalize digest ceremony with clean preview + page | done | Preview-hash-bound reversible trash move |
| M06 | Four phases/14 weeks, independent-user gate each phase | external | Foundation only; no real-user gate claimed |
| M07 | Start new productions on v2 only after phase two | external | Alpha is for isolated trials; v1 productions unchanged |
| S01 | Three non-author novice trials on three OSs in ten minutes | external | Requires actual people/OSs; matrix is not a user trial |
| S02 | 20 non-author videos within three months | external | Post-release metric |
| S03 | Three community plugins within three months | external | Post-release metric |
| S04 | One monthly dependency-update PR | external | Post-release policy; v1 bots not modified |
| S05 | Fork users notified; maintenance duration agreed | external | No external messages sent; policy pending |
| X01 | Plan forgery / CLI or MCP approval bypass tests | done | `tests/workflow.node.mjs` |
| X02 | Duplicate execution / concurrency / failure ledger tests | done | Same integration suite + mock credits only |
| X03 | Traversal/symlink/XSS/CSRF/DNS-rebinding-style Host tests | done | Actual loopback HTTP and filesystem fixture tests |
| X04 | No paid generation/npm publication/push/credential edits | done | No such operation performed |
| X05 | Preserve production data and dirty primary worktree | done | All implementation under /tmp dedicated worktree |

## Suggested first contribution backlog (not posted)

1. Add captions and existing audio to the offline local renderer with a real fixture.
2. Extend copy-only migration to a single explicit trimmed clip.
3. Add human-reviewed semantic grouping of taste observations without uploading text.
4. Extend machine-checkable taste conditions to audio when the renderer supports it.
5. Add template pack import/export with version and path validation.
6. Build one optional renderer package, document its license, and retain real-render evidence.

## Release blockers

Live integrations, recovery/reconciliation UI, broader semantic preference grouping,
full v1 migration, agent installers, platform results and novice trials remain.
The npm package, gallery, labs relocation, issue creation and branch policy are
deliberately not published or changed by this local implementation. Do not call
this complete v2 or mark the phase-one independent-user gate as passed.
