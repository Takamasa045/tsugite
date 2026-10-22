# Tsugite

[日本語](README.ja.md) | [English](README.md) | [中文](README.zh.md) | [한국어](README.ko.md)

New videos start on **v2** (current package `2.0.0-alpha.6`, not the formal 2.0.0 release). A person reviews the plan before generation, and the fixes you keep carry into the next film. Existing `project.yaml` productions stay on **v1** (`0.18.0`), which remains in maintenance.

Earlier command lists are in the [technical reference](docs/reference.md).

## Who it's for

- You do not want to retype the same brief from scratch every time.
- You want a generation service to bill only after you have reviewed the plan.
- You want last time's fixes to still be there on the next film.

Ask Codex or Claude Code in your own language.

## Get started

You do not have to type the commands yourself.

1. Have this repository on your machine.
2. Paste the request below to the agent.
3. Open the confirmation URL from the report yourself, and press approval yourself.

```text
Prepare a zero-credit six-second sample with Tsugite v2 (2.0.0-alpha.6) in this repository.
Official repository:
https://github.com/Takamasa045/tsugite
Read AGENTS.md and v2/skills/tsugite/SKILL.md.
After npm --prefix v2 ci --ignore-scripts, run
npm run --silent v2 -- through init, check, and plan.
Tell me the confirmation-page URL. I will press the approval button.
Run make and export only after I have approved.
Do not set API keys, spend credits, change an existing project.yaml, commit, or push.
```

You need Node.js 22.12 or newer on the 22.x line, npm 10 or newer, and FFmpeg with `ffprobe` and `libx264`. The longer walkthrough is the [six-second environment check](docs/onboarding/first-video.ja.md).

## Quick start

Run these from the repository root. The sample uses no billing and no external service. `plan` prints the confirmation URL and stays running. The browser opens only when you add `--open`. v2 does not read `TSUGITE_PROJECTS_HOME`. `./my-video` is a new folder. It does not write into the existing `projects/` shelf.

macOS / Linux:

```sh
npm --prefix v2 ci --ignore-scripts
npm run --silent v2 -- init ./my-video
npm run --silent v2 -- check --project ./my-video
npm run --silent v2 -- plan --project ./my-video
```

Windows PowerShell uses the same four lines.

```powershell
npm --prefix v2 ci --ignore-scripts
npm run --silent v2 -- init ./my-video
npm run --silent v2 -- check --project ./my-video
npm run --silent v2 -- plan --project ./my-video
```

After you approve the plan, export from a second terminal. PowerShell uses the same lines.

```sh
npm run --silent v2 -- make --project ./my-video
npm run --silent v2 -- export --project ./my-video
```

The file is `my-video/out/final.mp4`. The sample creates no new assets, so clip review passes on its own. A project that generates assets needs clip approval on the page before `export`. `npx tsugite` does not fetch this alpha.

## Start from a story conversation

You can settle the structure before any footage or generation. The conversation needs no images and no confirmation page. It does not generate, send data out, spend credits, or approve. After you attach the chosen structure to the project, `plan` above opens the page. Changing the structure invalidates the old approval. The changed parts are listed for another look. Footage is not rebuilt automatically.

The same command works from this repository and from the npm package. Consult reads only the catalog shipped in the package, `knowledge/story-frameworks/catalog.yaml`. Sources are in `NOTICE.md` beside it. It does not search a parent directory. The catalog is data. It does not mean those forms can be generated.

```sh
npm run --silent v2 -- plugin story consult --request "60秒の静かな自然映像。ドラマ・CTA不要" --seconds 60
```

PowerShell uses the same line. After you keep a JSON plan, run `plugin story check` and then `plugin story bind`, then `plan`. Detail is in [story consult](v2/docs/story-consult.ja.md). The conversation is [#245](https://github.com/Takamasa045/tsugite/pull/245). The packaged catalog is [#246](https://github.com/Takamasa045/tsugite/pull/246).

## Copy a v1 production into v2

The original `project.yaml` production stays where it is. Approvals and secrets are not copied. Supported local clips, audio, and plain captions are copied into a new folder.

```sh
npm run --silent v2 -- init ./my-video --from-v1 /path/to/v1-project
```

PowerShell uses the same line. Replace the path with your production. A production-specific Remotion graph or character edit graph is not converted. To copy only a finished video, add `--flatten out/final.mp4`. To also keep a bounded archive of the old data, add `--archive-v1`. Both require `--from-v1`. Approve the new plan on the confirmation page afterward.

## How generation services connect

PixVerse, Kling, and TopView are not connected by writing an API key into settings. Use each service's CLI while that subscription is already logged in. v2 calls those CLIs after the confirmation page approves a plan. The real-machine check is still open. This page does not choose the login or the billing account, and it does not add a login command. The quick start above does not call those CLIs.

ElevenLabs sound effects have one recorded paid acceptance. Paid acceptance for speech and music is still open. A real PixVerse generation, and a full export of that generation, are still open as a subscription-CLI check on a real machine.

## v1 stays in maintenance

![Local launcher after setup, with the sample production はじめての継手 in the list](docs/guide/assets/launcher-my-first-tsugite.webp)

Existing `project.yaml` productions finish on v1 `0.18.0`. Their command entry is `node bin/pipeline`. The list is the [technical reference](docs/reference.md#commands). Windows notes are in the [native Windows and PowerShell guide](docs/windows.md). The first-time setup request is [here](docs/onboarding/codex-setup-prompt.ja.md).

On v1, a person stops the work three times. The only exception is a production that opts into `gates.gate_2.auto_pass: qc_ok_no_new_assets`. Footage check (Gate 2) may then pass without a person's OK only when credits, new assets, and QC issues are all 0.

v2 checks happen only on the confirmation page. There is no CLI approval flag.

## Learn more

- Versions: v2 is `2.0.0-alpha.6`. Formal 2.0.0 criteria are in the [migration decision](v2/docs/migration-plan.ja.md) and the [requirements](v2/docs/requirements.md).
- v2 command detail: [v2/README.md](v2/README.md) · [v2/README.ja.md](v2/README.ja.md)
- Pick a use: [see-and-choose](docs/onboarding/see-and-choose.ja.md)
- History: [CHANGELOG.md](CHANGELOG.md) · [v2/CHANGELOG.md](v2/CHANGELOG.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
