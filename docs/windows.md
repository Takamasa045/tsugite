# Windows native setup

Tsugite supports native Windows PowerShell. WSL and Git Bash are optional and are not required for the launcher or core CLI.

## Requirements

- Windows 11 or a currently supported Windows release
- Git
- Node.js 22.12 or newer in the 22.x LTS line; Node 23 or newer is not supported by this release
- npm 10 or newer
- FFmpeg with both `ffmpeg` and `ffprobe` on `PATH`

Install FFmpeg, then reopen PowerShell so the updated `PATH` is visible:

```powershell
winget install --id Gyan.FFmpeg -e
```

Verify the toolchain before installing repository dependencies:

```powershell
node --version
npm --version
ffmpeg -version
ffprobe -version
```

## Install and run the launcher

Run these commands from the Tsugite repository root:

```powershell
npm ci
npm --prefix apps/workflow-viewer ci
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
npm run viewer:open
```

The launcher listens only on `127.0.0.1` and opens in the default browser. Stop it with `Ctrl+C` in the PowerShell window that started it.

## Core CLI

Use `node bin/pipeline` as the shell-neutral direct entrypoint. `npm run --silent pipeline --` is the equivalent npm shortcut when stdout must remain machine-readable JSON.

```powershell
Copy-Item -Recurse examples/local-fixture projects/my-first-run
node bin/pipeline validate --config projects/my-first-run/project.yaml --json
node bin/pipeline plan --config projects/my-first-run/project.yaml --json
node bin/pipeline review --config projects/my-first-run/project.yaml --open --json
node bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
node bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
```

PowerShell uses the backtick for line continuation. Keeping each command on one line avoids shell-specific continuation rules.

## Optional adapters

Tsugite resolves Windows executable extensions from `PATHEXT` and can run `.cmd` shims used by npm-installed tools. Provider CLIs, credentials, entitlements, and billing still need to be installed and verified separately. A catalog entry does not prove that an optional provider is available.

TopView uses `python` by default on Windows and `python3` on macOS/Linux. Override it when needed:

```powershell
$env:TSUGITE_TOPVIEW_PYTHON = "C:\Path\To\python.exe"
```

Run `doctor` against the selected project after installing an optional adapter. Any unresolved blocking check keeps the overall result at `ok: false`.

## Troubleshooting

- Reopen PowerShell after installing Node.js or FFmpeg.
- Confirm that `node`, `npm`, `ffmpeg`, and `ffprobe` resolve in the same PowerShell window.
- Use `node bin/pipeline ...` instead of invoking the extensionless `bin/pipeline` file directly.
- Rerun `npm ci` without `--omit=dev`; HyperFrames is a development dependency.
