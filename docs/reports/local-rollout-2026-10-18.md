# Local rollout and open PR audit — 2026-10-18

The open queue was read through the GitHub API in two pages of 30 and four
items and matched the independent CLI query: **34 PRs**, 31 dependency-bot
updates, one feature PR and two production drafts. Twelve heads had CI failures;
four conflicted with main (#122, #181, #183, #185). Historical green CI on a
branch behind main is not current integration evidence.

Publishing a tag did not update the author's primary local checkout: it was
15 commits behind main and still had no v2 command entry. The production path
is the local repository plus agent/loopback confirmation page; public Desktop
installers have ended. This rollout adds the repository-level v2 entry and
agent routing, pairs rendering/UI dependency families, and verifies the actual
installed entry rather than treating a release URL as deployment evidence.

The reviewed old dependency requests are carried into one coherent CLI/Viewer
runtime update. Remotion modules are pinned together at 4.0.535, React and DOM
at 19.2.8, Vitest/coverage at 4.1.11. Updated lock entries cover source-map-js,
PostCSS/nanoid, undici and the nested fflate patch. Contract tests detect future
version skew, and Viewer gets an explicit dependency-audit CI step. Monthly
version-update groups separate rendering/test families and major reviews.
There is no automatic merge or credential/permission change.

This table records decisions, not permission to bulk-merge unrelated PRs.
Replacement PRs are closed only after exact current-main version evidence;
remaining work is not labeled completed merely because it is outside rollout.

| PR | Content | Observed CI / integration | Decision |
|---|---|---|---|
| [#99](https://github.com/Takamasa045/tsugite/pull/99) | build(deps): bump actions/setup-node from 6 to 7 | passed at reviewed head; behind | Retain: CI action major update is separate from the verified local runtime, rebase and runner compatibility validation required |
| [#104](https://github.com/Takamasa045/tsugite/pull/104) | chore(deps-dev): bump postcss from 8.5.18 to 8.5.26 in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#122](https://github.com/Takamasa045/tsugite/pull/122) | chore(deps): bump react-dom and @types/react-dom | passed at reviewed head; conflict | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#136](https://github.com/Takamasa045/tsugite/pull/136) | chore(deps): bump @xmldom/xmldom from 0.9.10 to 0.9.12 in /apps/desktop | failed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#139](https://github.com/Takamasa045/tsugite/pull/139) | chore(deps): bump fflate from 0.6.10 to 0.6.11 in /apps/workflow-viewer | failed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#147](https://github.com/Takamasa045/tsugite/pull/147) | chore(deps): bump react-dom and @types/react-dom in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#148](https://github.com/Takamasa045/tsugite/pull/148) | chore(deps-dev): bump @testing-library/react from 16.3.2 to 16.3.3 in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#161](https://github.com/Takamasa045/tsugite/pull/161) | chore(deps-dev): bump vitest from 4.1.10 to 4.1.11 in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#173](https://github.com/Takamasa045/tsugite/pull/173) | chore(deps): bump ip-address from 10.2.0 to 10.7.2 in /apps/desktop | passed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#174](https://github.com/Takamasa045/tsugite/pull/174) | chore(deps-dev): bump fast-uri from 3.1.4 to 3.1.8 in /apps/desktop | passed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#177](https://github.com/Takamasa045/tsugite/pull/177) | chore(deps-dev): bump tsx from 4.23.1 to 4.23.15 | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#179](https://github.com/Takamasa045/tsugite/pull/179) | chore(deps-dev): bump undici from 7.28.0 to 7.30.0 in /apps/desktop | failed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#180](https://github.com/Takamasa045/tsugite/pull/180) | chore(deps-dev): bump undici from 7.28.0 to 7.30.0 in /apps/workflow-viewer | failed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#181](https://github.com/Takamasa045/tsugite/pull/181) | Add kobo-launch-16x9 Remotion preset for the Online Kobo promo | failed at reviewed head; conflict | Retain draft: production-specific preset, conflicts with current registry; no completed implementation approval inferred from queue size |
| [#183](https://github.com/Takamasa045/tsugite/pull/183) | Add production lessons from the kobo season-2 announcement run | failed at reviewed head; conflict | Retain draft: production lessons/shared-policy acceptance and conflict resolution remain separate from this release |
| [#184](https://github.com/Takamasa045/tsugite/pull/184) | chore(deps): bump brace-expansion in /apps/desktop | failed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#185](https://github.com/Takamasa045/tsugite/pull/185) | Add durable ElevenLabs narration quotes and recovery | passed at reviewed head; conflict | Retain: conflicting v1 hosted-auth/billing feature spans 99 files and requires its own authority/recovery review; no login or scope expansion is part of v2 rollout |
| [#188](https://github.com/Takamasa045/tsugite/pull/188) | chore(deps-dev): bump @electron/asar from 3.4.1 to 4.3.1 in /apps/desktop | passed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#189](https://github.com/Takamasa045/tsugite/pull/189) | chore(deps-dev): bump source-map-js from 1.2.1 to 1.2.2 in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#190](https://github.com/Takamasa045/tsugite/pull/190) | chore(deps): bump sharp from 0.35.4 to 0.35.5 in /adapters/pixverse/runtime | passed at reviewed head; behind | Retain pending isolated optional-runtime validation; root CI does not install or audit these runtime trees |
| [#191](https://github.com/Takamasa045/tsugite/pull/191) | chore(deps): bump fast-uri from 3.1.7 to 3.1.8 in /adapters/pixverse/runtime | passed at reviewed head; behind | Retain pending isolated optional-runtime validation; root CI does not install or audit these runtime trees |
| [#192](https://github.com/Takamasa045/tsugite/pull/192) | chore(deps): bump source-map-js from 1.2.1 to 1.2.2 in /backends/editframe/runtime | passed at reviewed head; behind | Retain pending isolated optional-runtime validation; root CI does not install or audit these runtime trees |
| [#194](https://github.com/Takamasa045/tsugite/pull/194) | chore(deps-dev): bump @vitest/coverage-v8 from 4.1.11 to 5.0.4 | failed at reviewed head; behind | Retain: major Vitest/coverage migration must be paired; the current supported pair remains 4.1.11 |
| [#195](https://github.com/Takamasa045/tsugite/pull/195) | chore(deps-dev): bump @vitejs/plugin-react from 6.0.3 to 6.1.2 in /apps/workflow-viewer | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#196](https://github.com/Takamasa045/tsugite/pull/196) | chore(deps-dev): bump @types/node from 26.1.2 to 26.6.5 | passed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#197](https://github.com/Takamasa045/tsugite/pull/197) | chore(deps-dev): bump electron from 43.1.1 to 44.7.2 in /apps/desktop | passed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#198](https://github.com/Takamasa045/tsugite/pull/198) | chore(deps): bump react and @types/react in /apps/download-site | failed at reviewed head; behind | Retain for separate retired download-site maintenance; React/DOM updates need pairing and the Node type major needs its own minimum-version review |
| [#199](https://github.com/Takamasa045/tsugite/pull/199) | chore(deps-dev): bump @types/node from 22.19.19 to 26.6.5 in /apps/download-site | passed at reviewed head; behind | Retain for separate retired download-site maintenance; React/DOM updates need pairing and the Node type major needs its own minimum-version review |
| [#200](https://github.com/Takamasa045/tsugite/pull/200) | chore(deps-dev): bump vitest from 4.1.10 to 5.0.4 in /apps/workflow-viewer | failed at reviewed head; behind | Retain: major Vitest/coverage migration must be paired; the current supported pair remains 4.1.11 |
| [#201](https://github.com/Takamasa045/tsugite/pull/201) | chore(deps): bump @remotion/media from 4.0.528 to 4.0.535 | failed at reviewed head; behind | Replace with the coordinated, tested CLI/Viewer update; close only after its merge and target-version verification |
| [#202](https://github.com/Takamasa045/tsugite/pull/202) | chore(deps): bump react-dom and @types/react-dom in /apps/download-site | failed at reviewed head; behind | Retain for separate retired download-site maintenance; React/DOM updates need pairing and the Node type major needs its own minimum-version review |
| [#209](https://github.com/Takamasa045/tsugite/pull/209) | chore(deps-dev): bump playwright-core from 1.61.1 to 1.64.1 in /apps/desktop | passed at reviewed head; behind | Retain for development-only Desktop maintenance; public installers are ended and this is not the local production path |
| [#211](https://github.com/Takamasa045/tsugite/pull/211) | chore(deps): bump source-map-js from 1.2.1 to 1.2.2 in /adapters/hypit/runtime | passed at reviewed head; clean | Retain pending isolated optional-runtime validation; root CI does not install or audit these runtime trees |
| [#212](https://github.com/Takamasa045/tsugite/pull/212) | chore(deps): bump yaml from 2.9.0 to 2.9.1 in /v2 in the v2-dependencies group across 1 directory | passed at reviewed head; clean | Merged: current-main v2 YAML 2.9.1 patch, all required CI passed |

## Deployment evidence boundary

The primary checkout's seven modified tracked files were copied to a private
local backup and 22 untracked source files fingerprinted. Its original physical
node_modules was retained using an APFS copy-on-write clone; no production data
was moved. A three-way preview identified only the append-only lesson log and
the local voice-review additions as overlapping source edits. Both local voice
review and upstream generated-audio review must survive the update.

Actual installed SHA, build/startup results and URLs are recorded after apply
in private local evidence and the source-release report. A clean candidate
worktree or successful remote CI alone is not proof that primary was updated.
The v2 tracker remains 73/90 done: live paid-service acceptance, independent
novice trials and the remaining labs/governance/adoption conditions stay open.

## Applied result and refreshed queue

PR #212 and the coordinated runtime PR #213 were merged normally after CI. The primary checkout was advanced to `fb4932e`, retaining seven dirty tracked source files and 22 untracked source files in a private backup. Fresh repository, Viewer and v2 installs match the lockfiles. Root/Viewer builds passed. The primary `npm run --silent v2` entry completed init/check/plan/make/export in an isolated synthetic fixture: 6.021 seconds, 360×640, audio present and no ledger entries. This is software verification, not human approval of a production. The local Launcher returned HTTP 200 and discovered 78 projects; a separate new offline onboarding sample is waiting for its human plan check. No production media was moved.

After version verification, six remaining superseded PRs (#104, #122, #139, #147, #148, #161) were closed. Dependabot had already closed the other six replaced updates (#177, #180, #189, #195, #196, #201). It also regrouped four major updates (#188, #197, #199, #200) into three new major-review requests. The refreshed paginated API contains **20 open PRs**: 17 of the original 34 and three new requests. This count is a dated observation, not a promise that the bot queue will stop changing.

| New PR | Reviewed scope and CI | Disposition |
|---|---|---|
| [#214](https://github.com/Takamasa045/tsugite/pull/214) | Desktop Electron 44, Forge 8, asar 4; three CI jobs passed | Retain for separate Desktop major migration: ESM/Node minimum and installer acceptance need explicit validation |
| [#215](https://github.com/Takamasa045/tsugite/pull/215) | Download-site Node types 26, ESLint 10, TypeScript 7, vinext 1.2.0; download-site CI failed | Retain: retired-site major migration and failing site validation |
| [#216](https://github.com/Takamasa045/tsugite/pull/216) | Viewer Vitest/coverage 5, TypeScript 7, jsdom 30, jest-dom 7; root and Windows checks failed | Retain: paired major migration has not passed integration; production keeps verified Vitest/coverage 4.1.11 |

The primary checkout also exposed nested worktree copies to Vitest discovery (1,981 candidate files). The normal and coverage commands now explicitly exclude `.work/**` and `.claude/worktrees/**`, with a real discovery regression fixture. Working copies are preserved. A first whole-suite invocation in the restricted runner failed with loopback-listen EPERM; the same suite passed with the local execution permission required by its HTTP/browser fixtures: 2,393 passed, two skipped, no failures, with branch coverage 74.68%. Corrected primary discovery reports 165 files and zero nested-worktree matches.
