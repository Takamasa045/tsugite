# Local tools and Managed Programs

Read this when assessing local preparation, selecting local WhisperX, or preparing and repairing a
local Endpoint's executable or Managed Program.

## Assess local preparation

Use `hypit paths` to locate the selected Profile and machine state. Inspect relevant service
configuration, the Provider's documented installation locations, and executables such as `ffmpeg`
and `uv`. Hypit's managed WhisperX has its own Python environment; a missing global `whisperx`
command leaves that installation's state unknown. The installed `@hypit/provider-whisperx-local`
README owns its preparation and service locations.

Establish what already works, what needs starting or repair, and what needs downloads. Use those
findings in [environment selection](profile.md#choose-the-practical-capability-path-with-the-user),
then prepare the chosen setup using its Provider instructions and the evidence from its logs.
Consider hardware and actual network reachability alongside installed files. A cached environment
can still need speech-model weights or a language's alignment model before its first useful request.
Existing weights can make local preparation attractive; report that fact while offering the local
and hosted choice. Starting a newly configured large-model service is preparation even when all
weights are cached. A previously chosen, working service can be carried forward directly.

## Diagnose the selected local capability

Choose the observation that answers the current question:

| Question | Tool |
| --- | --- |
| Which Profile and machine locations apply? | `hypit paths` |
| Is the Worker running, and is work active? | `hypit runtime status` |
| What has the Worker reported? | `hypit runtime logs` |
| Which selected local helpers answer, and where are their logs? | `hypit programs status --verbose` |
| Does the selected Profile's broader configuration and service access work? | `hypit doctor` |

Read the failing Endpoint's message and package README before changing the machine. The Profile says
which local implementation was selected; another project's working service is not evidence that this
Profile selects it.

## Supply host executables at machine scope

The installed Hypit Distribution requires its supported Node.js version. Local media processing needs
both `ffmpeg` and `ffprobe` on `PATH`, or explicit compatible paths accepted by its Provider. Local
Python Programs use `uv` to create their locked environments in Hypit's machine Program Home.

Prepare the missing executables needed by the chosen work using the host's ordinary package manager.
For example, these commands install FFmpeg for media work and uv for managed Python tools; select
the relevant command and verify its executable in the environment that will run Hypit:

```bash
# macOS
brew install ffmpeg
brew install uv
ffmpeg -version
ffprobe -version
uv --version
```

```powershell
# Windows
winget install --id Gyan.FFmpeg.Shared -e
winget install --id astral-sh.uv -e
ffmpeg -version
ffprobe -version
uv --version
```

On Linux, use the distribution package manager or the current official installation method for the
same executables. Keep these machine tools outside the video project. `hypit paths` reports the shared
Program and npm package homes used by selected Runtime adapters.

## Let the selected Endpoint own its Program

An Endpoint may contribute one Managed Program: for example, a warm WhisperX service or the browser
needed by local HyperFrames. Its Provider owns the prepare command, start command, probe, expected
identity, and configuration. The Runtime operates those declarations:

```bash
hypit programs up --endpoint whisperx.local
hypit programs status --endpoint whisperx.local
```

Name the chosen Profile instance with `--endpoint`; repeat it for several services. This scopes
package preparation and Program operations together. `runtime up --endpoint <instance>` also starts
the Worker. Omitting the flag deliberately covers the whole Profile. A binding selects which Endpoint
fulfills a request; `plan` checks the Endpoints resolved for its actual requests, so an unused local
service or hosted credential does not become a prerequisite for that Build.
Program commands leave the Worker lifecycle alone:

| Intention | Command |
| --- | --- |
| Prepare and start the selected helpers | `hypit programs up --endpoint <instance>` |
| Inspect their current state | `hypit programs status --endpoint <instance>` |
| Stop helpers managed by Hypit | `hypit programs down --endpoint <instance>` |

`runtime down` stops the Worker and its execution processes while leaving separately managed Programs available. This lets a later
Build reuse an already warm local model. Use scoped `programs down` when a helper itself should stop.
A healthy service stays warm across repeated `up` calls. Local WhisperX reconciles its packaged Python
environment before a cold start; uv reuses cached dependencies and weights. This is separate from
loading project component code for a new Build.

Ordinary projects use these declarations instead of running a service's internal `uv sync` or Python
entry point by hand. Contributor/operator commands in a service README are for diagnosing that
packaged service, not for creating a second project-local installation.

## Select local WhisperX explicitly

Local and hosted WhisperX implement the same alignment capability. When local execution is chosen,
merge this fragment into the Profile, retaining the other services the production uses:

```json
{
  "endpoints": {
    "whisperx.local": {
      "use": "@hypit/provider-whisperx-local"
    }
  },
  "bindings": {
    "@hypit/whisperx@1#whisperx-alignment": "whisperx.local"
  }
}
```

The binding is needed when another selected Endpoint, such as HypiHub, also offers alignment. The
Provider README owns optional model, device, compute, batch-size, timeout, and concurrency settings.
Its loopback service accepts canonical speech evidence and returns measured alignment; it does not
interpret Script, Caption Cues, or Semantic Segments.

Choose the ASR model deliberately for the language, hardware and work. For quality-oriented
multilingual work, a multilingual large model is a useful starting preference when hardware and
preparation are practical. A ready smaller model can serve straightforward reference understanding
on a modest CPU machine; its availability is more informative than the ability to begin a larger
download. Weigh accuracy needs against setup and inference time, including the hosted option.
The Provider README owns exact settings, compute choices and the distinction between transcription
and language-specific alignment. Configure the chosen model before preparing it.

With the Endpoint and model selected, run `hypit runtime up --endpoint whisperx.local`. The first preparation may install Python
and download model weights, while later projects reuse the machine Program. Success means the configured
service identity answers its health probe; `hypit doctor --endpoint whisperx.local` then checks that
selected service.

## Make network preparation practical

Treat preparation as part of delivering the video. Read the current command and its progress:
which dependency or weight file, which download host, how much data has arrived, and whether the
process is downloading, unpacking or loading a model. Managed Program preparation reports `install.log`;
service startup reports `program.log`. On Windows, service stderr is in the adjacent `program.err.log`,
where Python logging and download errors may appear. Read the relevant recent output while a long
command runs. Logs expose the subprocess's output; some downloaders suppress progress outside a terminal.
Use available transfer progress, cache growth and process activity to judge whether waiting remains
reasonable for this commission; a quiet log alone does not establish a stalled download.
A longer timeout helps a healthy slow transfer finish; it does not improve an unusable route.

Mainland China and other restricted networks can make particular hosts slow or unreachable. Use the
user's network context and actual transfer evidence to choose a reachable source, rather than
inferring connectivity from the language they speak. Preserve useful downloads and caches while
changing the part that is actually blocked. Explain the changed outlook promptly and recommend
a practical alternative when local preparation would dominate the production time. HypiHub can
remove local speech-model preparation and also supply later generation; the account choice remains
with the user. Continue independent reference and component work meanwhile.

Mirrors address particular download clients and hosts:

| Download | Relevant controls and limits |
| --- | --- |
| npm packages | A command's `--registry` or `npm_config_registry`; a registry mirror may lag a newly published version. Check the requested package version. |
| Python packages | pip uses `--index-url` / `PIP_INDEX_URL`; uv uses `--default-index` / `UV_DEFAULT_INDEX`. They are different clients. Hypit's managed service uses frozen uv dependencies; consult its Provider README before expecting an index change to redirect locked artifact URLs. |
| Python runtime | uv's `UV_PYTHON_INSTALL_MIRROR` selects a compatible Python-distribution mirror. A PyPI mirror does not supply Python itself. An already compatible installed Python may avoid this download. |
| Hugging Face weights | `HF_ENDPOINT` selects a compatible Hub endpoint; `HF_HOME` / `HF_HUB_CACHE` select reusable cache locations. A model's redirected weight host and its language-alignment download must also be reachable. |
| FFmpeg, browser and other binaries | Use the selected package manager's binary-download settings or a compatible official prebuilt installation. An npm/PyPI mirror does not generally redirect these downloads. Homebrew bottles, browser archives and GitHub release assets have their own sources. |

Use a mirror the user or organization trusts, with settings scoped to the preparing command or
session. Explain persistent machine-wide changes when those are useful. Keep the selected package
versions and record the effective preparation choices for the next session. Read the actual download
host afterward to establish that the intended route was used.

Useful source documentation includes [uv settings](https://docs.astral.sh/uv/reference/environment/),
[TUNA's PyPI mirror](https://mirrors.tuna.tsinghua.edu.cn/help/pypi/),
[TUNA's Homebrew guidance](https://mirrors.tuna.tsinghua.edu.cn/help/homebrew/),
[npmmirror](https://npmmirror.com/) and [HF-Mirror](https://hf-mirror.com/).
These are available choices to assess, not automatic machine defaults. A mirror that returns model
metadata successfully may still redirect large files to another host; diagnose the transfer itself.

## Repair from the narrowest evidence

- A missing executable belongs to host installation and `PATH`.
- A package dependency named by an adapter can be prepared by `runtime up`; a separately reported
  exact optional npm dependency uses `hypit packages install <package@version>`.
- A down or mismatched Managed Program belongs to its Provider configuration, Program status, and
  service log.
- A healthy local Program with a rejected request belongs to the Provider's support or request error,
  not to reinstallation.
- A remote authentication, account, quota, or model-catalogue error belongs to the remote Endpoint and
  `profile.md`, even when the Worker happens to run locally.

Project component and Profile edits apply to the next Build through its fresh execution context.
For a Distribution or inherited shell-environment change, read
[Build execution](../production/builds.md#build-with-the-current-project-implementation) before
restarting the coordinator so active work is preserved.
