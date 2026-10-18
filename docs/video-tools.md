# Video tools and updates

Tsugite pins compatible tool versions instead of silently upgrading while a
production is running. The following versions were checked against the official
npm `latest` tags or upstream releases on 2026-10-19 (JST).

| Tool | Selected version | Scope |
| --- | --- | --- |
| Remotion, Bundler, Renderer, Media | 4.0.536 | Repository, v2 Remotion and Fast Edit peers |
| HyperFrames | 0.8.173 | Repository renderer/Studio and v2 labs renderer |
| GSAP | 3.15.0 | Local development/runtime fixture |
| PixVerse CLI | 1.4.9 | Opt-in runtime; Canvas and pipeline use the same pin |
| Kling CLI (`@klingai/cli-global`) | 0.2.3 | Opt-in runtime; explicit `KLING_CLI` remains respected |
| MiniMax CLI (`mmx-cli`) | 1.0.28 | Opt-in, preflight-only runtime |
| Editframe CLI/Elements/Vite/API/Assets/dev-server | 0.60.34 | Opt-in local runtime |
| Hypit | 0.3.1 | Opt-in runtime and separately licensed Skill snapshot |
| MCP TypeScript SDK | 1.32.1 | Root/v2 and Editframe security override |
| Tesseract CLI | 0.4.0 | Official platform-specific installer |
| whisper.cpp | 1.9.5 | This Mac's existing Homebrew installation |
| FFmpeg / FFprobe | 9.0.2 | This Mac; other hosts supply their own compatible tools |

The independent v2 package has no mandatory video SDK dependency. Install its
optional plugins and their matching peers deliberately. Existing project
settings, provider accounts, credentials and service budgets are not migrated.
Changes to plugins/runtimes require a new reviewed plan.

## Install and inspect

From the repository root:

```sh
npm ci
npm run pixverse:install
npm run kling:install
npm run minimax:install
npm run editframe:install
npm run hypit:install
npm run --silent pixverse -- --version
npm run --silent kling -- --version
npm run --silent minimax -- --version
npm run --silent editframe -- --version
npm run --silent hypit -- --version
```

These are explicit dependency installations, not part of Doctor or rendering.
They require access to their official package sources. For Tesseract, read its
terms and [platform installation instructions](tesseract.md) before running
`npm run tesseract:install`. Models and browsers are not installed by rendering.
For local v2 HyperFrames, explicitly select the installed CLI, GSAP and browser
through `TSUGITE_HYPERFRAMES`, `TSUGITE_GSAP` and `TSUGITE_BROWSER`.

PixVerse and Kling keep explicitly selected executable overrides. They never
silently switch the provider connection, account or workspace. The MiniMax
adapter remains preflight-only; upgrading its CLI does not enable generation.
TopView uses the remote MCP service rather than a locally pinned CLI; installing
an unrelated npm package named after the service would not update that bridge.

## Compatibility changes

- HyperFrames now splits runtime code into chunks. The ZIP compatibility patch
  is checked against exact upstream hashes, and v2 binds the entire runtime
  directory to the plan. Studio uses the current Chrome WebMCP object-input API.
- Editframe's current CLI uses a separately installed native bridge. Tsugite's
  HTML backend uses the current Elements SDK, the official advanced Vite plugin,
  an existing local Chrome and FFmpeg instead. It keeps deterministic frame
  seeks, timed captions and source/Fast Edit audio. It blocks external browser
  requests and hosted CLI selectors, and strips hosted credentials. No native
  bridge or cloud service is installed automatically.
- Hypit uses `--project` and independent video SDK packages. Its local starter
  selects only `media.local` and `html.local`; the remote Hypihub endpoint is
  never started by Tsugite's local preparation. Existing project Sources are not
  rewritten. Read the [official migration guide](https://github.com/hypit-ai/hypit/blob/v0.3.1/migrations/0.3.1.md)
  before converting an older production. The Phase 1 fixture remains byte-bound
  and cannot execute a Build.

## Licenses and verification limits

Tool updates do not change license eligibility. Remotion eligibility depends on
its organization/team and use case, not only the number of operators. Editframe
has its own SDK license. Tesseract's bundled terms include revenue eligibility
and restrictions on competing products. Hypit's modified Apache license applies
to its runtime and the vendored Skill; see
[`adapters/hypit/skill/LICENSE`](../adapters/hypit/skill/LICENSE).
Forking does not remove upstream conditions. This repository does not redistribute
the native binaries, purchased licenses, models or user media.

Real local fixture results are separate from paid-service acceptance. Version
and help checks for PixVerse/Kling/MiniMax do not verify authentication, credits
or live generation. Hypit check/plan does not verify a production Build. v2 remains
alpha; paid-provider and independent third-party acceptance are still open.
