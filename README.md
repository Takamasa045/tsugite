# Tsugite

[日本語](README.ja.md) | [English](README.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Ask an AI agent, then walk through plan → footage → finished video together on your own PC. What you fix on one film carries into the next.

Previous command lists and developer notes are in [docs/reference.md](docs/reference.md).

## Who it's for

Use Tsugite when you:

- Do not want to retype the same brief from scratch every time.
- Want generation-service billing only after you have reviewed the plan.
- Do not want last time's fixes (opening length, caption amount) to vanish on the next film.

It is for people who ask Codex or Claude Code, in their own language, to make a video. You do not need to learn Git or the terminal first.

## Get started

You do not type commands yourself.

1. Open an empty folder in Codex or start Claude Code in that folder.
2. Paste the setup request below.
3. Read the report and say OK only when a change is actually required.

```text
Safely set up the official Tsugite repository
https://github.com/Takamasa045/tsugite
inside this empty folder.
Start with read-only environment checks and wait for my approval before any system installation.
After cloning, use the official setup:check and setup commands through doctor, validate, and plan for the zero-credit sample.
Do not overwrite existing files, log in, configure secrets, spend credits, run generation, render, approve Gates, commit, or push.
At the end of your report, ask exactly one question: "Open the launcher?"
Run setup:open only if I answer yes. If I say no or do not answer, do not open the launcher.
```

The canonical copy-ready Japanese request is [Codex・Claude Codeなどで使う Tsugiteセットアップ依頼文](docs/onboarding/codex-setup-prompt.ja.md).

## What you'll see

![Local launcher after setup, with the sample production はじめての継手 in the list](docs/guide/assets/launcher-my-first-tsugite.webp)

Official setup copies the zero-credit sample production 「はじめての継手」 into `projects/my-first-tsugite/`, then runs environment check (`doctor`), validation (`validate`), and planning (`plan`). At that point there is no billing, login, or generation. The launcher stays closed until you answer yes to the final question.

“Open the launcher?” → yes runs the existing `setup:open` and shows 「はじめての継手」 in the production list. Opening it does not generate, export, or change a waiting check.

## Quick start

Stable **v1** (`0.18.0`). If you already have this repository and want to type commands yourself: install once, then walk the bundled storyboard sample through validation (`validate`) → planning (`plan`) → the confirmation page (`review` HTML). No billing, no external API, no export (`render`). The browser does not open by itself.

```sh
npm ci
export TSUGITE_PROJECTS_HOME=/tmp/tsugite-quickstart
mkdir -p "$TSUGITE_PROJECTS_HOME"
cp -R examples/storyboard-local "$TSUGITE_PROJECTS_HOME/storyboard-local"
node bin/pipeline validate --config "$TSUGITE_PROJECTS_HOME/storyboard-local/project.yaml"
node bin/pipeline plan --config "$TSUGITE_PROJECTS_HOME/storyboard-local/project.yaml"
node bin/pipeline review --config "$TSUGITE_PROJECTS_HOME/storyboard-local/project.yaml"
```

The last command prints `確認画面: …（開くには --open）`. Open that path yourself. Add `--open` only if you want the browser opened. `TSUGITE_PROJECTS_HOME` keeps this copy off the real `projects/` shelf.

Need Node.js 22.12 or newer in the 22.x line, npm 10 or newer, and FFmpeg including `ffprobe`. Longer walkthrough: [first video](docs/onboarding/first-video.ja.md). v2 is alpha; try it from [v2/README](v2/README.md) only if you want the in-progress path.

## Ways to ask

Short examples. The full catalog is [Ways to ask](docs/guide/requests.md).

- A **structure** for a 30-second vertical ad (no generation).
- Chapter and summarize a local seminar video without sending it out.
- A character-led intro. Confirm look and voice in plain language first.
- Keep last time's “music in the first 0.5 seconds”.
- Open Premiere Pro and fix a cut (macOS).

## Nothing proceeds without you

A person stops the work three times. Nothing continues until you say OK. Generation and export follow the same rule. The only exception is a production that opts into `gates.gate_2.auto_pass: qc_ok_no_new_assets`. Footage check (Gate 2) may then pass without a person's OK only when credits, new assets, and QC issues are all 0. Billing or new footage always stops it.

1. **Plan check (Gate 1)** — May we follow this plan? The launcher offers “Open Gate 1 review”.
2. **Footage check (Gate 2)** — Are these assets acceptable?
3. **Final check (Gate 3)** — Is this the finished video?

Official setup never installs system packages, logs in, sets API keys, spends credits, runs `run` or `render`, decides a Gate, commits, or pushes. The boundary is in the [Japanese setup contract](docs/onboarding/setup-contract.ja.md).

## It becomes your workshop

If the first film's opening is too long, record it under Preferences & Learnings. Repeated notes become candidates. Only approved items may later land in templates or rules.

Approval is permission to do that later work. It does not rewrite prompts, templates, or rules by itself. The stages are observed → recurring → promoted → verified.

## Words you'll see

The full list is the [glossary](docs/guide/glossary.md). First use is “plain wording (official name)”.

| What you see | Meaning |
| --- | --- |
| Production (`project.yaml`) | One video's folder and settings |
| Plan check (Gate 1) / footage check (Gate 2) / final check (Gate 3) | Human stops. The launcher shows Waiting |
| Footage list (manifest) | The clips, audio, and captions in use |
| Generate (`run`) / export (`render`) | Generation may bill a service. Export is local and unpaid but can take time. Both only after approval |
| Preferences & Learnings (feedback) | Recorded fixes. Approval does not apply them automatically |

## Learn more

- Previous README material: [technical reference](docs/reference.md)
- Integrated CLI and video engine versions: [video tools](docs/video-tools.md)
- Windows: [native Windows and PowerShell guide](docs/windows.md)
- Version: repository source `0.18.0`. [Changelog](CHANGELOG.md)
- v2 alpha (in development): [overview](v2/README.md) · [six-second environment check](docs/onboarding/first-video.ja.md) · [pick a use](docs/onboarding/see-and-choose.ja.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
