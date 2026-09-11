# Editframe official examples

Optional local reference gallery from [editframe/examples](https://github.com/editframe/examples).
The source is pinned to `8f0e63b28b85efe268e7ae26969a09e3cc575dcd` (27 examples).
It is a standalone React workbench, separate from Tsugite's pipeline backend.

## Install and open

On macOS with Node.js 22.12+ (22.x), npm 10+, and Git, run from the Tsugite root:

```sh
npm run editframe:examples:install
npm run editframe:examples
```

Open <http://127.0.0.1:5184/>. Select a sample from the top-left picker;
search, preview, and scrub its timeline. Stop the server with Ctrl+C.
Port 5184 is loopback-only; an occupied port causes an error rather than switching URLs.

The explicit install command downloads source/media from GitHub and dependencies from npm.
It uses the upstream lockfile (`@editframe/*` 0.59.44), with dependency lifecycle scripts
disabled. Native FFmpeg/Playwright installers are not run. The normal Tsugite `npm ci`
does not install these examples. No credentials or paid generation are required.

Source, media, dependencies, and preview caches live under the current checkout's
ignored `.tsugite/tools/editframe-examples/`; they are not committed or uploaded to Tsugite.
Running the installer again reinstalls dependencies only when the source checkout is clean
and still matches the pinned origin and revision. It refuses modified, mismatched, symlinked,
or incomplete installation directories without deleting them. If a network interruption leaves
an incomplete directory, move it aside manually before retrying. Existing local installations
at the same revision are reused.

`start` permits local sample edits. It invokes the installed Vite directly and never installs
missing dependencies. Both commands disable Editframe telemetry and remove inherited
Editframe service credentials/hosts and directory/render overrides from child environments.

## Scope and verification

Verified locally: dependency installation, the 27-example picker, search, switching to
OpenAI Codex, and timeline seeking. Full playback/audio and MP4 export are not verified.
Keep the upstream README and each example's CREDITS.md when using its material.

These references are not automatically registered as pipeline templates. Preview does not
update a production manifest, run generation, or approve a Gate. Create actual production
projects in the durable projects home and follow the normal production approval flow.
