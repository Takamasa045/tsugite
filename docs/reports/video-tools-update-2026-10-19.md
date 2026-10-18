# Video tool update — 2026-10-19 (JST)

This update targets the repository's connected video tools. It does not upgrade
Adobe desktop applications, unrelated global agent CLIs, provider models or
accounts. The public alpha.4 release and tags are unchanged.

## Changes

See [the version and setup table](../video-tools.md) for exact versions. The
selected versions were read from official npm `latest` metadata and upstream
GitHub releases. FFmpeg 9.0.2 and MCP SDK 1.32.1 were already current. On this
Mac, whisper.cpp moved from 1.9.1 to 1.9.5; Homebrew also upgraded its ffmpeg-full
dependent from 8.1.2_2 to 9.0.2. Automatic cleanup was disabled. Tesseract 0.4.0
was installed with its official checksum-verified installer, retaining 0.2.0.

- Remotion's four runtime packages and both v2 peer manifests are aligned.
- HyperFrames is one version across the root and v2 labs adapter. Its split ZIP
  imports retain fail-closed upstream hash checks; v2 includes every runtime
  chunk in the plan identity. Chrome's object-input WebMCP contract is used.
- Editframe's upstream CLI moved to a native bridge. The existing HTML backend
  now uses current Elements, the official advanced Vite entry, an existing local
  Chrome and FFmpeg. It preserves source sound and Fast Edit's shared mixer.
  External browser requests, hosted selectors and hosted tokens are rejected.
  Its vulnerable transitive MCP 1.30.0 is overridden to 1.32.1.
- PixVerse, Kling and MiniMax use repository-pinned runtimes in the actual
  execution/preflight and Doctor paths. Explicit executable overrides remain
  respected; provider/account/workspace routing is not changed. MiniMax remains
  preflight-only.
- Hypit uses the new `--project` CLI flag, independent video SDK packages and
  local `media.local` / `html.local` starter endpoints. Existing Sources are not
  migrated. Its official Skill snapshot has 71 upstream files at commit
  `8efbac03ed10929b0f4a3c79fe2b3f77b6479daf`, verified against Git blob hashes,
  plus separate Tsugite pin metadata and the upstream modified Apache license.
  The reviewed official example is still bound to exact compiled JS hashes.

## Verification

- Root `npm run check`: **2,403 passed, 2 skipped**, 163 test files passed and
  one skipped. Coverage: statements 82.79%, branches 74.68%, functions 89.77%,
  lines 85.47%. The final platform-forwarding adjustment additionally passed
  its 26 provider/Doctor/lifecycle checks.
- v2 `npm --prefix v2 run check`: **76 passed, zero skipped**, with actual
  Remotion, HyperFrames and Whisper selected. External IP networking was denied
  by macOS; loopback and local Unix sockets were allowed for isolated browsers.
- v2 CLI offline sample and extended smoke completed with **zero credits**.
- Fast Edit: Remotion, HyperFrames and Editframe each rendered **16:9 and 9:16**
  synthetic 10.8-second videos with all 18 cards. All six outputs passed complete
  decode, metadata/audio checks, exact normalized OCR for all **108 captions**,
  pixel parity (maximum RGB MAE below the existing threshold of 12), and identical
  decoded PCM that differs from the source because of generated local SFX. Six
  contact sheets were visually inspected. No QA tolerance was relaxed.
- Editframe's real integration test and boundary/unit suite passed **36 tests**;
  its real integration test was repeated after the MCP override. This test uses
  real owned-process inspection, so it runs outside macOS's setuid-`ps`-blocking
  sandbox; the capture browser itself rejects external requests.
- HyperFrames 0.8.173 + Chrome 155 Studio: text/color save, reload, a second edit,
  decoded PNG colors (1,558 cyan and 1,646 orange pixels), and process cleanup
  passed using synthetic authoring copies.
- Tesseract 0.4.0: real, silent, blue 1-second H.264 1920×1080/30 output,
  editable `.tsrct` and report passed with all networking denied and a private
  telemetry-disabled test HOME. Other native formats/features are not certified.
- Hypit 0.3.1: official synthetic example compiled with TypeScript 5.9.3 and
  passed real check/plan. No Build, Worker start, credential setup or paid
  generation was executed. Version/help checks passed for the provider CLIs.
- npm audit reported **zero vulnerabilities** in root, PixVerse, Hypit, Editframe,
  Kling and MiniMax runtime dependency trees. A v2 pack dry-run from its actual
  directory contained 90 files and no projects, credentials, node_modules or
  local verification output; no archive was published.
- `verify-tsugite` completed its exact v1 Doctor/validate fixture with network
  denial, identical fixture read-back, no Gate/render operations and cleanup.

Local evidence lives under `dist/verification/video-tools-latest/` and the
ignored `verification/evidence/verify-tsugite/` directory. Private runtime/source
backups are excluded from the change. Media and host-specific logs are not
committed.

The primary checkout also contains durable project archives with historical test
files. Root normal/coverage discovery now excludes `projects/**` explicitly,
with a regression fixture; no archived production data was removed.

## Limits

Local macOS evidence does not certify Windows/Linux native runtimes, Adobe apps,
Hypit production Builds, paid provider behavior, credentials, license eligibility
or independent third-party acceptance. v2 remains alpha. Existing productions
and approvals were not migrated; changed runtime/plugin identities need a new
human-reviewed plan. The confirmation page remains the only approval surface
and does not isolate another agent with the same OS permissions.
