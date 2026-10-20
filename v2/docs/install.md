# Install and try the source-only alpha

Tsugite v2 is an alpha. Paid-provider acceptance and independent novice trials
remain unperformed. The release contains the program and checksum only; no demo
videos or images are uploaded. Existing v1 projects keep their `project.yaml`.
New v2 projects use `tsugite.yaml`; do not overwrite an existing production.

## Requirements

- Node.js 22.12 or newer and npm 10 or newer.
- FFmpeg and FFprobe on PATH, including the libx264 encoder.
- No service account, API key or paid provider for the sample.

Check `node --version`, `npm --version`, `ffmpeg -version` and `ffprobe -version`.
If FFmpeg is missing, install it through your normal approved system setup; this
package does not change your system or buy/install a service automatically.

## Download and verify

Open the [alpha.5 release](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5)
and download `tsugite-2.0.0-alpha.5.tgz` and `SHA256SUMS` into a new working folder.
On macOS, run `shasum -a 256 -c SHA256SUMS` in that folder; on Linux,
use `sha256sum -c SHA256SUMS`. On Windows, run
`Get-FileHash .\tsugite-2.0.0-alpha.5.tgz -Algorithm SHA256` and compare it with the
line in `SHA256SUMS`. Stop if the digest does not match.

```sh
npm install --prefix ./tsugite-local --ignore-scripts ./tsugite-2.0.0-alpha.5.tgz
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs init ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs check --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs plan --project ./my-video
```

Keep the plan process running. It prints the confirmation URL and does not open a browser unless you add `--open`. Open that URL, review the local page, then click **Approve plan**.
In another terminal in the same working folder:

```sh
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs make --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs export --project ./my-video
```

Refresh the confirmation page, watch `my-video/out/final.mp4`, and click
**Approve final** after reviewing it. The offline sample creates no new assets
and explicitly enables automatic clips review. Other projects require a human
clips check. No CLI/MCP command can approve a check. Another process with the
same OS file permissions is not isolated by this page-only operation guard.

## From an existing repository

Use the normal checkout without installing a global package:

```sh
npm run --silent v2 -- init ./projects/my-new-v2-video
npm run --silent v2 -- plan --project ./projects/my-new-v2-video
```

After approving in the page, use the same entry with `make` and `export` and the
same `--project` directory. Codex/Claude Code should read root `AGENTS.md` and
`v2/skills/tsugite/SKILL.md`. Give the agent the input files and your intent;
the agent prepares the work and you approve in the confirmation page.

Service credits are tracked separately and are never summed across providers.
Live calls, provider choices, credentials and optional tools require explicit
setup and authorization; installing this alpha does not authorize them.
See [readiness](local-readiness.md), [requirements](requirements.md) and
[plugin/license guidance](plugins.md) before using optional renderers.
