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
page. Player subtitle support varies; enable the track in your player. `burn`
requires FFmpeg's libass filter and fails at planning if missing. Set
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
operations. They are labs contracts, not verified upstream API transports.
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
the page says MOCK. A real service entry is disabled even when called directly.
Supported fixture duration/options belong to each package's contract, not core.
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

`plugin add hyperframes` installs a labs HTML adapter. Only `execution: mock` is
enabled by core; real 0.8.24 CLI behavior and telemetry remain unverified for v2.
Its real entry requires explicitly selected existing CLI, GSAP and browser paths
and never runs npx/install/upgrade/auth/cloud. No feedback or publication command
is sent. The framework's composition/CLI Skills informed the HTML contract;
they do not replace Tsugite's confirmation checks.

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
Real model transcription has not been verified on this host. Mock SRT is visibly
synthetic. Existing output files are not overwritten.

Fast Edit takes JSON `{version:1,format:"9:16",segments:[{path:"assets/a.mp4",
start:0.5,end:2,audio:false}]}`. It returns an explicit project proposal and never
applies it, renders or approves. Full media bounds are checked when you use the
proposal in tsugite.yaml and plan it.

Template packs share timing slots/captions without embedding media, provider
requests or approvals. Import fills slots with sample media; replace those slots
with your own files before planning. Unknown path/provider fields are ignored,
so a template cannot silently start generation. Knowledge packs are local
Markdown snapshots and can be shared as files. Skills install into the exact
chosen client directory and refuse to overwrite existing Skills.

## Copying a complex v1 project

Normal `init new-video --from-v1 /existing/v1` copies supported editable fields.
For an unsupported native/animated/character graph, explicitly select an existing
render instead: `init new-video --from-v1 /existing/v1 --flatten out/final.mp4`.
The chosen regular project-local MP4 is copied and verified, including source
audio and an existing plain subtitle track. The new project still requires fresh
plan, clips and final checks. This preserves the original; it cannot recover the
old editable native graph from its rendered video.

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
