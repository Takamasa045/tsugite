# 継手 / Tsugite v2

Let an agent prepare your video, review the plan before it runs, and keep your
preferences for the next one. The offline sample needs no account or API key.

**Local alpha:** the sample and safety tests work; paid providers and the broader
v1 feature set are still tracked in [requirements](docs/requirements.md). This
package has not been published. Existing v1 productions continue unchanged.

## Try the offline sample

Requires Node.js 22.12+ and FFmpeg/FFprobe with libx264 on PATH. From a checkout:

```sh
npm --prefix /path/to/tsugite/v2 ci --ignore-scripts
node /path/to/tsugite/v2/bin/tsugite.mjs init ./my-video
cd my-video
node /path/to/tsugite/v2/bin/tsugite.mjs check
node /path/to/tsugite/v2/bin/tsugite.mjs plan
```

Keep the plan process running; it prints and opens a local confirmation page.
Review the storyboard, duration, renderer and service-specific credit limits,
then click **Approve plan**. In a second terminal in `my-video`:

```sh
node /path/to/tsugite/v2/bin/tsugite.mjs make
node /path/to/tsugite/v2/bin/tsugite.mjs export
```

The synthetic six-second sample is written to `out/final.mp4`. Refresh the page,
watch the final preview, and click **Approve final**. The sample explicitly opts
into automatic clips review because it creates no new assets. Projects that
generate clips or omit that setting need **Approve clips** before export.

```sh
node /path/to/tsugite/v2/bin/tsugite.mjs note "Opening could be shorter"
node /path/to/tsugite/v2/bin/tsugite.mjs check --status --json
```

Adding a note changes the next plan context. Run `plan` again before executing
the revised project. Current rules are context for an agent/planner; the local
renderer does not infer edits from arbitrary prose. Use `--no-review --json` for
unattended planning, and report the pending human plan check.

The future published command is `npx tsugite init my-video`; do not use that to
fetch this unpublished alpha. A local `npm pack` creates an installable tarball;
installation exposes the `tsugite` binary without cloning a production folder.
`npm ci --omit=optional` installs only the core YAML dependency; MCP then requires
the optional official SDK to be installed separately.

## Project file

```yaml
version: 2
name: My video
format: '9:16'
length: 6s
use:
  - assets/intro.mp4
export: local
budget: {}
checks:
  auto_clips: true
```

The `local` source plugin can also make synthetic fixture footage. Installed
source plugins add `make` entries with id, with, prompt and seconds. Budgets are
maps such as `budget: {service-a: 20, service-b: 100}`. These are separate credit
limits; there is no cross-service total, exchange rate or inferred billing account.
The alpha rejects declared network plugins. Install only trusted local code.

Everything stays in the video folder: `assets/`, `taste/`, `out/`, and generated
plans, approvals, jobs and budget history in `.tsugite/`. Common preferences can
live in `~/.tsugite/taste/` (`TSUGITE_HOME` overrides it for isolated tests).
`note --global` stores a global observation. Rule text in the global rules file
is included in every plan. Nothing is uploaded by the core.

## Commands and integrations

`init`, `check`, `plan`, `make`, `export`, `note`, `clean`, `plugin` are the eight
workflow commands. All operation results are JSON; `--json` is accepted for
agent compatibility. `check --status` reads current checks, jobs and budget.
`clean` only previews; confirmation is in the page and moves old generated media
into project trash. It never irreversibly deletes originals.

`note --pack taste.json` creates a shareable pack; `note --import taste.json`
imports suggestions without automatically approving rules. `note --group "same
idea" "similar wording"` lets you group related observations explicitly. Three
matching observations become a habit. After final approval, the page offers one
promotion decision; accepted rules go into `taste/rules.md`. Global habits are
promoted into the common taste folder. After final review you can record whether
a rule helped or missed; two consecutive misses offer explicit retirement.

Optional `taste/checks.json` conditions such as
`[{"kind":"max_duration","value":6},{"kind":"min_width","value":360}]`
automatically inspect final video metadata. These are advisory preference checks,
displayed in the page and saved with final approval. Audio/BGM conditions need
an audio-capable plugin and are not implemented in the silent sample renderer.

Use `tsugite mcp` as an MCP stdio server with cwd set to a video folder, or install
the short [Agent Skill](skills/tsugite/SKILL.md) in your client's normal skills
directory. MCP tools use the same dispatcher as the CLI and have no approval tool.
For Claude Code/Codex, a one-command distribution package is still a follow-up;
copying this one Skill is supported now.

`init ./copy --from-v1 /path/to/legacy-project` conservatively copies silent,
untrimmed local clips. Audio, captions, trims and generated v1 projects are
rejected with a conversion explanation. The original files, approvals and keys
are never moved or imported.

## Safety, extensions and verification

The page prevents accidental approval; it does not isolate an agent with the
same OS privileges. There is no CLI approval flag. Changed settings, plan bytes,
assets, plugin content or preference context invalidate approvals. Uncertain jobs
retain their entire credit reservation and cannot be retried automatically.

See [architecture](docs/architecture.md) for recovery and trust limits,
[plugin SDK and license guidance](docs/plugins.md), and the exhaustive
[requirement tracker](docs/requirements.md) for remaining work.

```sh
cd /path/to/tsugite/v2
npm test                 # isolated fixtures + loopback HTTP + real FFmpeg
npm run test:offline      # real CLI workflow; retains evidence and MP4 in temp
npm pack --dry-run        # inspect the independent distribution boundary
```

The test harness programmatically submits confirmation forms only in its own
fixtures. These are software tests, not human production approvals. macOS,
Windows and Linux CI is defined separately; a local macOS pass is not evidence
that the other operating systems have passed.
