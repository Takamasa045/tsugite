# Extended local workflows

The eight workflow commands remain the entry point. These extensions do not
provide any CLI/MCP approval shortcut. Plan changes still invalidate checks.

## Sound, captions and timing

```yaml
version: 2
name: Local edit
format: '16:9'
length: 4s
fps: 24
use:
  - path: assets/intro.mp4
    start: 0.5
    seconds: 2
  - path: assets/ending.mp4
    start: 1
    seconds: 2
    audio: true
audio:
  - path: assets/music.wav
    kind: bgm
    start: 0.1
    seconds: 3.9
    loop: true
    volume: 0.2
captions: assets/subtitles.srt
caption_mode: soft
export: local
budget: {}
```

Clip source bounds, audio offsets, durations and caption times are validated
before approval. Fixed clip durations must fit the requested total; unspecified
local clip durations share remaining time. String-only sample inputs can loop.
The local renderer always writes a consistent audio stream; omitted sound is
silence. Audio tracks can be BGM, narration or SFX and are volume-limited in mix.

`soft` stores timed text in an MP4 subtitle track and serves WebVTT in the review
page. Player subtitle support varies; enable the track in your player. Local and
fixture-mock `burn` requires FFmpeg's libass filter and fails at planning if
missing. Live Remotion `burn` is drawn in the composition and does not use
libass. Set
`TSUGITE_FFMPEG`/`TSUGITE_FFPROBE` to existing compatible binaries if needed.
This task does not install or repair system media software. AAC/container timing
can include about one audio frame of padding; final duration is checked with a
small tolerance and reported as measured.

## Service contracts and synthetic mocks

```sh
tsugite plugin add pixverse
tsugite plugin add kling
tsugite plugin add elevenlabs
```

These copy bundled standalone packages into this project without npm/network
operations. Their explicit synthetic mode remains zero-cost. Official HTTP transports now have synthetic protocol tests; paid acceptance is unverified.
Set `execution: mock` explicitly to create test patterns or sine-wave audio:

```yaml
execution: mock
make:
  - id: shot
    with: pixverse
    prompt: Synthetic contract fixture
    seconds: 5
  - id: voice
    with: elevenlabs
    kind: audio
    prompt: Synthetic narration fixture
    seconds: 3
    options:
      voice_id: mock-voice
```

No key, account or live request is used. Mock quotes and settlements are zero;
the page says MOCK. Live mode requires an enabled private connection and reviewed plan; see [connections](connections.md).
Supported duration/options belong to each package, not core.
They are not a promise of current upstream model capabilities or pricing.
Real provider credit maxima must eventually be explicit in that service's own
unit; no exchange rate or pooled budget is inferred.

## Optional renderers

`plugin add remotion` installs the optional adapter. Install its exact tested
peer packages separately, review Remotion's licensing terms, and set
`TSUGITE_BROWSER` to an existing browser executable before planning. Its actual
package versions and browser identity are included in the plan. Real local
video, audio and caption output has been tested on this Mac, without cloud
rendering or browser download. This does not establish a user's license status.

`plugin add hyperframes` installs an optional local HTML adapter. Existing
0.8.173 CLI, GSAP and browser paths are selected explicitly (this is the v2
adapter pin in `v2/plugins/hyperframes`; the v1 root also pins 0.8.173).
Real Mac export through
the v2 checks passed with visible timed captions, looping BGM and SFX under
external-network denial. Telemetry/update checks are disabled; no install,
upgrade, auth, cloud or feedback command runs. Runtime/browser identities are
bound to the plan. See its constraints for host/version limits.

## Local analysis, editing and reusable packs

```sh
tsugite plugin add whisper
tsugite plugin analyze whisper assets/voice.wav --mock --output assets/captions.srt
tsugite plugin add fast-edit
tsugite plugin analyze fast-edit assets/selections.json
tsugite plugin knowledge story
tsugite plugin knowledge prompt-director
tsugite init --pack template.json
tsugite init new-video --template template.json
tsugite plugin skill --to /explicit/client/skills
```

Whisper's real mode uses an already installed whisper.cpp CLI selected with
`TSUGITE_WHISPER` and `--model /existing/model.bin`. No model is downloaded.
Real CPU transcription with an existing large-v3-turbo model has been verified on this Mac under network denial. Mock SRT is visibly
synthetic. Existing output files are not overwritten.

Fast Edit takes JSON `{version:1,format:"9:16",segments:[{path:"assets/a.mp4",
start:0.5,end:2,audio:false}]}`. It returns an explicit project proposal and never
applies or approves it. Full media bounds are checked when you use the proposal
in tsugite.yaml and plan it. Add a version-1 `fast_edit` decision object to select
the optional Fast Edit renderer: timed words/beats, 18 cards, emphasis, transitions,
text effects, zoom, SFX and global style/progress/color/energy become the explicit
`renderer_options` shown in the plan. It requires the Remotion peer packages and
an existing browser. Real 18-card output is verified locally. Use
`npm --prefix .tsugite/plugins/fast-edit install --ignore-scripts --package-lock=false`
to install its declared peers without modifying the approved plugin files, then
plan again. Review the [Remotion license guidance](plugins.md) first.

Template packs share timing slots/captions without embedding media, provider
requests or approvals. Import fills slots with sample media; replace those slots
with your own files before planning. Unknown path/provider fields are ignored,
so a template cannot silently start generation. Knowledge packs are local
Markdown snapshots and can be shared as files. Skills install into the exact
chosen client directory and refuse to overwrite existing Skills.

## Copying a complex v1 project

Normal `init new-video --from-v1 /existing/v1` copies supported editable fields.
v1 `edit.backend` (including Remotion) and `generation` / paid audio adapters
are not imported as v2 plugins or `make` tasks. The same warnings are written to
`.tsugite/migration.json` and returned in the `init --from-v1` JSON result.
Fast Edit decisions still migrate through the declared renderer hook. A
Remotion-backed v1 project therefore becomes a local-export copy of its clips
unless `--flatten` is used.
For an unsupported native/animated/character graph, explicitly select an existing
render instead: `init new-video --from-v1 /existing/v1 --flatten out/final.mp4`.
The chosen regular project-local MP4 is copied and verified, including source
audio and an existing plain subtitle track. The new project still requires fresh
plan, clips and final checks. This preserves the original; it cannot recover the
old editable native graph from its rendered video.

Add `--archive-v1` to either migration mode to preserve bounded project-local
media and native/character metadata in `assets/legacy-v1/`. Character snapshots
retain `character-lock.json` and its verified, co-located files. Traversal,
symlinks, remote references, oversized media and altered snapshot hashes fail.
Credential/approval fields are omitted, and original config/state/keys are never
copied. Structured credential-name filtering covers manifests/referenced JSON;
it is not a general detector for secrets embedded in arbitrary prose or media.
Select only reviewed production data for archiving. The archive is explicitly
non-executable; the active v2 project uses
supported editable fields or the selected rendered final. Raw native graphs
remain data for their corresponding experimental editor, never an implicit
runtime capability. Failed migrations leave partial new copies for inspection.

Experimental v1 components can be exported non-destructively into separate local
labs packages; see [labs source separation](https://github.com/Takamasa045/tsugite/tree/main/v2/labs). Those packages
advertise source inspection only until their runtime adapter is reviewed.

## Manual reconciliation

An uncertain job holds its reservation. After checking its actual outcome,
prepare a local normalized receipt and review it in the page:

```json
{
  "version": 1,
  "task_key": "the-current-task-key-from-state",
  "provider_job_id": "the-recorded-provider-job-id-if-present",
  "service": "the-reserved-service",
  "outcome": "failed",
  "credits": 0
}
```

Save it under `assets/receipt.json` and use the task's reconciliation form. The
page rejects another task/service/job, negative or excessive credits and repeat
settlement. A completed receipt also needs the assigned local media to exist and
pass inspection. A failed settled job can request a new attempt; the new plan
must be reviewed and must fit the remaining service budget. Receipts are human
assertions, not an automatic verification against a live provider. Never put
credentials in them. Unresolved crash locks require process inspection; the
program has no force-unlock switch.
