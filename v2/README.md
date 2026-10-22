# 継手 / Tsugite v2

Let an agent prepare your video, review the plan before it runs, and keep your
preferences for the next one. The offline sample needs no account or API key.

[日本語の入口](README.ja.md) · [Install and try locally](docs/install.md) · [Local example workflows](docs/gallery.md)

Start with an edit you can finish:

- Shorten a talking clip using a chosen source interval and verified captions.
- Arrange a few local clips into one video with explicit trims and sound.
- Revise caption/music choices and keep preference notes for the next plan.

The [production guide](docs/production-guidance.md) connects actual source
inspection, three advisory choices, a separate opening preview and output QA.
Explicit no-caption/no-added-music instructions win. Guides do not automatically
decorate footage. Existing [synthetic samples](docs/gallery.md) show functions;
quality or time gains over a normal AI request have not been established.
The six-second sample below checks installation.

**Local alpha:** sound, captions, local editing, optional Remotion rendering and
source-plugin mocks work. Documented HTTP transports have synthetic fixture tests.
ElevenLabs SFX has one recorded paid acceptance. PixVerse, Kling, and TopView
are used through each service's CLI while that subscription is already logged
in. Support arrives in order. An API key in settings is not that connection.
The real-machine check and the broader v1 feature set are tracked in
[requirements](docs/requirements.md). This
package is not published to the npm registry. Existing v1 productions continue unchanged.
The repository entry for new work is the [root README](../README.md).

Download the alpha tarball and SHA256SUMS from the [source-only alpha release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5). This release uploads no demo videos or images.
Install without cloning or replacing your global tools:

```sh
npm install --prefix ./tsugite-local --ignore-scripts ./tsugite-2.0.0-alpha.5.tgz
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs init ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs plan --project ./my-video
```

Keep that plan process open, approve in its page, then use the same binary with
`make --project ./my-video` and `export --project ./my-video`. This release remains
an alpha; [readiness](docs/local-readiness.md) separates local evidence from
external acceptance.

## Try the offline sample

Requires Node.js 22.12+ and FFmpeg/FFprobe with libx264 on PATH. From a checkout:

```sh
npm --prefix /path/to/tsugite/v2 ci --ignore-scripts
node /path/to/tsugite/v2/bin/tsugite.mjs init ./my-video
cd my-video
node /path/to/tsugite/v2/bin/tsugite.mjs check
node /path/to/tsugite/v2/bin/tsugite.mjs plan
```

Keep the plan process running; it prints the local confirmation URL and does
not open a browser unless you add `--open`. Open that URL, review the
storyboard, duration, renderer and service-specific credit limits, then click
**Approve plan**. In a second terminal in `my-video`:

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
Offline mode rejects declared network plugins. Live mode requires an explicitly enabled private connection and page-approved plan; see [connections](docs/connections.md). Install only trusted local code.

Everything stays in the video folder: `assets/`, `taste/`, `out/`, and generated
plans, approvals, jobs and budget history in `.tsugite/`. Common preferences can
live in `~/.tsugite/taste/` (`TSUGITE_HOME` overrides that private home).
v2 does not read `TSUGITE_PROJECTS_HOME`.
`note --global` stores a global observation. Rule text in the global rules file
is included in every plan. Nothing is uploaded by the core.

## Commands and integrations

`init`, `check`, `plan`, `make`, `export`, `note`, `clean`, `plugin` are the eight
workflow commands. All operation results are JSON; `--json` is accepted for
agent compatibility. `check --status` reads current checks, jobs and budget.
`plugin story consult` can discuss structure before any media exists. It reads
the catalog shipped in this package (`knowledge/story-frameworks/catalog.yaml`)
and the MIT license and source list in `knowledge/story-frameworks/NOTICE.md`.
It does not generate, send, spend, or approve. Binding a story plan later
invalidates an old plan approval and does not regenerate media. See
[story consult](docs/story-consult.ja.md).
`clean` only previews; confirmation is in the page and moves old generated media
into project trash. It never irreversibly deletes originals.

`note --pack taste.json` creates a shareable pack; `note --import taste.json`
imports suggestions without automatically approving rules. `note --group "same
idea" "similar wording"` lets you group related observations explicitly. Three
matching observations become a habit. Common English wording is grouped locally
without sending preferences to a model; explicit groups handle other paraphrases. After final approval, the page offers one
promotion decision; accepted rules go into `taste/rules.md`. Global habits are
promoted into the common taste folder. After final review you can record whether
a rule helped or missed; two consecutive misses offer explicit retirement.

Optional `taste/checks.json` conditions such as
`[{"kind":"max_duration","value":6},{"kind":"min_width","value":360}]`
automatically inspect final video metadata. These are advisory preference checks,
displayed in the page and saved with final approval. `max_bgm_start` checks the approved timeline schedule separately from measured
media metadata; it is not an acoustic classifier of the final mix.

Use `tsugite mcp` as an MCP stdio server with cwd set to a video folder, or install
the short [Agent Skill](skills/tsugite/SKILL.md) in your client's normal skills
directory. MCP tools use the same dispatcher as the CLI and have no approval tool.
Use `tsugite plugin skill --to /your/client/skills` for either Claude Code or
Codex. It installs one Skill and refuses to overwrite an existing one.

`init ./copy --from-v1 /path/to/legacy-project` copies local clips (including
unequal trims and requested source sound), existing audio and plain timed
captions. Native/animated/character constructs are rejected with a conversion
explanation. The original files stay in place; approvals and keys are never
imported. See [extended workflows](docs/phase-two.md).

## Safety, extensions and verification

The page prevents accidental approval; it does not isolate an agent with the
same OS privileges. There is no CLI approval flag. Changed settings, plan bytes,
assets, plugin content or preference context invalidate approvals. Uncertain jobs
retain their entire credit reservation and cannot be retried automatically.
The page can reconcile a local normalized receipt after you verify the outcome;
failed settled jobs require a new reviewed plan before retry. Existing untracked
or modified `out/final.mp4` files are preserved instead of overwritten.

See [architecture](docs/architecture.md) for recovery and trust limits,
[plugin SDK and license guidance](docs/plugins.md), the exhaustive
[requirement tracker](docs/requirements.md) for remaining work, and the
owner-facing [v1→v2 migration decision record](docs/migration-plan.ja.md)
(2026-10-19: recommended split adopted; paid acceptance last.
2026-10-22: PixVerse formal acceptance is a subscription-CLI real-machine check,
not an API-key paid call). English copy: [migration-plan.md](docs/migration-plan.md).

```sh
cd /path/to/tsugite/v2
npm test                 # isolated fixtures + loopback HTTP + real FFmpeg
npm run test:offline      # real CLI workflow; retains evidence and MP4 in temp
npm pack --dry-run        # inspect the independent distribution boundary
```

The test harness programmatically submits confirmation forms only in its own
fixtures. These are software tests, not human production approvals. macOS,
Windows and Linux CI, plus a separate Ubuntu real Remotion lane, passed for the
alpha. See [verification](docs/verification.md) for exact test counts, optional
runtime skips and the separate local all-runtime evidence.
