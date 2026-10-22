# Explicit service connections

Offline and mock mode require no account. `execution: live` is a separate,
explicit selection. Install a reviewed source package and enable the connection
in your private `~/.tsugite/config.json`. Isolate that private home with
`TSUGITE_HOME` (tests and local runs). v2 does not read `TSUGITE_PROJECTS_HOME`;
that variable belongs to the v1 launcher shelf. This file stores references
and scalar defaults, never a key or token value. No credential is created or
changed by Tsugite. Do not put credentials in YAML, notes or receipts.

PixVerse, Kling, and TopView follow the v1 subscription CLIs. That is the
connection for planning and `make`. It is not a finished real-machine
acceptance and it does not make this package 2.0.0. Tsugite does not register
its own login; a missing vendor session stops before generation. ElevenLabs
stays on HTTP, including the one recorded SFX charge, and is outside this CLI
policy. An enabled
connection with no HTTP fields uses `transport: cli`. The optional `command`
is an executable path, or an array of one to eight arguments, never a shell
line. PixVerse and Kling still accept an explicit HTTP connection when
`base_url`, `credential_env`, and `download_origins` are set and `transport` is
omitted or `http`. Mixing CLI and HTTP fields is rejected. ElevenLabs stays on
HTTP. TopView rejects an HTTP credential.

```json
{
  "version": 1,
  "plugins": {
    "pixverse": {
      "defaults": {"model": "v6", "quality": "360p"},
      "connection": {"enabled": true, "transport": "cli"}
    },
    "kling": {
      "connection": {"enabled": true, "transport": "cli"}
    },
    "topview": {
      "connection": {"enabled": true, "transport": "cli"}
    }
  }
}
```

Optional PixVerse HTTP, for an API key rather than the subscription login:

```json
{
  "version": 1,
  "plugins": {
    "pixverse": {
      "connection": {
        "enabled": true,
        "transport": "http",
        "base_url": "https://app-api.pixverse.ai",
        "credential_env": "MY_CHOSEN_PIXVERSE_KEY",
        "download_origins": ["https://your-verified-output-cdn.example"]
      }
    }
  }
}
```

The example download origin is a placeholder, not a vendor CDN recommendation.
Select the actual trusted origins for your account before planning an HTTP
connection. API and media requests reject redirects. Media requests omit
authentication headers. Do not allow arbitrary origins. Third-party plugin code
remains trusted local code, not an OS sandbox.

## CLI subscription connections

The CLI is invoked only after the confirmation page approves the plan. Login is
checked before any generation command. A missing executable or a failed login
stops there; no generation is submitted, and the failure does not invent a
refund. The batch is reserved first. A provider task id is saved before the
file is copied into the project. Tests replace the executable with a fake CLI
and do not call the real services.

Subscription CLIs often omit a numeric charge. v2 treats a finite nonnegative
number (`credits`, `credit`, `cost`, `cost_credits`, `costCredits`,
`creditsConsumed`, or `costCredit`) as the reported amount, including zero. An
explicit `null`, or CLI JSON with none of those numbers, is unknown: the
artifact can still succeed and the reservation stays uncertain until the page
reconciles it. That is not settled as zero. The HTTP receipt contract is
unchanged: an explicit `credits: null` is unknown, and a missing `credits`
field on that receipt is a contract failure. Account balance from a login
command is not a charge.

- PixVerse: `pixverse` (`PIXVERSE_CLI` overrides the path). Login is
  `pixverse auth status --json` with `authenticated: true`. Exit 3 or
  `authenticated: false` means logged out; run `pixverse auth login`. Generation
  is `pixverse create` with `--no-wait --json`, then `task wait` and
  `asset download`. Text and image-to-video both use `create video`;
  image-to-video adds `--image`. `create image` is not used for video.
  The other operations are `transition`, `extend`, `modify`, `upscale`, and
  `reference`. An extend result that still contains the source is trimmed to
  the new tail, the same as the HTTP path. The quote is the explicit positive `max_credits`, not the
  dated V6 rate table. The CLI model string is passed through when it matches
  a safe token; the HTTP transport still requires `v6`.
- Kling: `kling` (`KLING_CLI` overrides the path). Login is `kling who_am_i`
  with a `user.userId`; otherwise run `kling login`. v2 sends
  `text_to_video` only (`--model`, `--duration`, `--aspectRatio`,
  `--resolution`, `--poll`, `--quiet`, prompt last). Video bytes come from a
  public HTTPS URL with redirects rejected and no credential header, or, in
  tests, from one file already under the system temp directory. `max_credits`
  remains the reservation ceiling. CLI model names such as `kling-v3` are
  accepted; the HTTP payload contract stays on `kling-3.0`.
- TopView: the official skill `video_gen.py`, discovered under the user skill
  or Codex cache, or set with `command` / `TSUGITE_TOPVIEW_VIDEO_COMMAND`.
  Login is the neighboring `auth.py status` (exit 0). Its stdout can contain an
  account id and a masked key, so v2 discards it and does not read the
  credential file. Generation is one `run --type t2v|i2v --json` call. Text is
  `t2v`; one local image is `i2v`. The model name and positive `max_credits`
  are required. Omni, music, voice, and templates are outside this subset. If
  the process exits before it prints a task id, nothing is saved to resume.

The plan binds resolved model, quality/aspect defaults, plugin files and public
connection settings. The page displays LIVE and those settings. Changing them
invalidates approval. No credential value is read for quoting or planning; it is
resolved only when the approved `make` starts. A changed environment value is
outside the file-identity guarantee: keep the selected billing account stable.

All source requests reserve the whole batch first. POST requests are never
automatically retried after a timeout or ambiguous response. Async task IDs are
saved before polling. Polls are bounded; failed/unknown outcomes keep the full
reservation. The page's normalized receipt form resolves the final outcome.
The CLI/MCP cannot approve or settle a job.

## Implemented protocol subset

The credit rates in this list are the HTTP transport. A CLI connection reserves
only the explicit positive `max_credits` and does not apply these rate tables.

- PixVerse V6 text-to-video: default 360p, project aspect, 1–15 integer seconds,
  optional seed. The quote uses the documented V6 snapshot dated 2026-10-18
  (audio-off 5/7/9/18 credits/s, audio-on 7/9/12/23) and can reserve a larger
  explicit `max_credits`. `Resp.credits` is preliminary,
  so a received video still needs final ledger reconciliation. Each request has
  a new trace UUID; this is not a server idempotency guarantee.
- PixVerse V6 image-to-video and first/last-frame transition: the same duration
  and quality bounds. `options.mode` is `image` (one `make.inputs` still) or
  `transition` (first then last). Local PNG/JPEG/WebP files are hashed into the
  plan, uploaded to `/openapi/v2/image/upload`, then sent as `img_id` or
  `first_frame_img` / `last_frame_img`. Aspect is not sent; framing follows the
  stills. Optional `options.audio: true` sets `generate_audio_switch` and uses
  the dated V6 audio-on rates (7/9/12/23 credits/s). Audio-off remains
  5/7/9/18 credits/s. PNG/JPEG/WebP inputs over 20 MB fail at planning.
- PixVerse V6 video extend: one local MP4/MOV/WebM in `make.inputs`, uploaded
  through `/openapi/v2/media/upload`, then `/openapi/v2/video/extend/generate`
  with `video_media_id`. `seconds` is the 1–15s extension. Quote uses the same
  V6 generated-duration rates. Source up to 30s; source plus extension up to 40s.
  Audio is not sent on this endpoint. If the downloaded file is longer than the
  extension (source plus tail), only the last `seconds` are kept so the
  timeline slot matches the new part.
- PixVerse video upscale: one local video, no quality field. Quote is 5
  credits/s of source duration. Source up to 30s / 100 MB (planning still caps
  at 32 MB). `seconds` is an integer from 1 through 30 and cannot exceed the
  probed source. That bound is the source video, not the 1–15 second list used
  for newly generated clips. The upscale body does not send `duration`.
  Already-4K sources (`width >= 3840` or `height >= 2160`) are rejected at planning.
- PixVerse video modify (prompt-only): one local video and up to three optional
  stills. Quality is 360p/540p/720p (no 1080p). The HTTP quote is 8/10/12
  credits/s of source duration. Checked against the official Modify reference
  on 2026-10-22: `POST /openapi/v2/video/modify/generate` has no `duration`
  field, and the how-to-use guide limits the source video to 30 seconds (the
  same cap as the Modify upload rule). Generated modes stay on 1–15 integer
  seconds. Modify `seconds` is the timeline slot for that source: an integer
  from 1 through 30 that cannot exceed the probed source. The HTTP body still
  omits `duration`. Mask / swap / keyframe workflows are unimplemented.
- PixVerse V6 image reference (Fusion): 1–8 local stills become
  `image_references`. Quote uses standard V6 rates. Video-reference Fusion
  (`duration: 0`, 2× rates) is unimplemented.
  Motion-control, templates, voice and PixVerse music remain unimplemented.
- Kling 3.0 text-to-video: default 720p, project aspect, 3–15 integer seconds,
  audio off and single shot. Explicit positive `max_credits` is required. The
  selected endpoint for international API users is
  `https://api-singapore.klingai.com`. Existing external task IDs are queried
  before creation. Only video resource-unit billing can settle automatically;
  cash/currency billing is retained as unknown, never converted to credits.
- ElevenLabs timestamped text-to-speech: explicitly chosen voice, default
  `eleven_multilingual_v2`, optional `eleven_turbo_v2_5` / `eleven_flash_v2_5` /
  `eleven_v3`, MP3 response converted locally to PCM WAV. Official
  `voice_settings` (`speed` 0.7–1.2), `language_code` and
  `apply_text_normalization` may be set.
  Explicit positive `max_credits` is required. The synchronous endpoint does not
  document final credits or a durable task ID; neither is invented. Verify actual
  charged credits in the service and reconcile them in the page. The requested
  seconds describes the approved timeline slot; review actual narration length
  before accepting clips. v1 hosted-MCP Eleven v4 / Turbo is not this transport.
- ElevenLabs music: `options.mode: music`, default `music_v2_5` (`music_v2` /
  `music_v1` allowed). Prompt-only compose to `/v1/music`; `seconds` is 3–600
  and becomes `music_length_ms`. Optional `force_instrumental`. Seed is rejected
  with a prompt. Prompt text is capped at 4100 characters. The HTTP wait is
  `60s + 2s` per requested second, capped at 20 minutes (speech stays 30s).
  Composition plans and inpainting are unimplemented. Credits stay an explicit
  `max_credits`; none are invented from duration. Published figures disagree:
  the subscription FAQ lists about 900 credits/minute for Eleven Music, while
  ElevenAPI lists USD $0.15/minute and does not publish a credit unit. Treat
  `max_credits` as a reservation ceiling and reconcile the ledger charge on the
  page. A 2-second fixture cannot derive a reliable number from those tables.
- ElevenLabs sound effects: `options.mode: sfx`, model
  `eleven_text_to_sound_v2` only, `/v1/sound-generation`. `seconds` is 0.5–30;
  optional `prompt_influence` 0–1 and `loop`. Binary audio is converted locally
  to WAV. The same duration-based HTTP wait applies. Voice settings and
  `voice_id` are rejected. Published figures also disagree: the subscription
  FAQ lists 200 credits per generation, product docs mention 40 credits/s when
  duration is set, and ElevenAPI lists USD $0.12/minute. Do not invent
  `max_credits` from those rows; reserve at or above the account you will
  check, then settle the receipt on the page.
  The HTTP transport returns `credits: null` (explicit unknown amount). A
  received WAV is a successful artifact; the reservation stays uncertain until
  the confirmation page records the actual charge. A missing `credits` field is
  a contract failure, not an unknown receipt. Temporary `*.wav.mp3` conversion
  files are removed after success or conversion failure. ElevenLabs fills the
  generic make `track` (`narration` / `bgm` / `sfx`); core does not interpret
  vendor `mode` names.

The local budget bounds accepted reservations and future calls. It cannot force
a remote service to honor an estimate, refund a failure or charge no more than
the quote. Pricing/account changes require verification; unknown charges remain
reserved. Do not treat a configured ceiling as a vendor-enforced billing cap.

## Evidence and official references

The HTTP tests use synthetic schema fixtures and injected functions, with fake
keys and no real service calls. CLI tests use a fake executable and do not
install or log in to PixVerse, Kling, or TopView. They cover request
construction, business errors, identity recovery, callback ordering, unknown
billing, response limits, secret error redaction and credential-free downloads.
They do not establish actual provider acceptance, prices for your account,
subscription login on a machine, or paid execution reliability.

Reviewed 2026-10-18, with image/transition, speech settings, extend/upscale/
modify/reference and music/SFX fields checked again on 2026-10-21. Modify's
missing `duration` field and 30-second source cap, and the CLI login commands,
were checked again on 2026-10-22:
[PixVerse request](https://docs.platform.pixverse.ai/text-to-video-13016634e0),
[image upload](https://docs.platform.pixverse.ai/upload-image-13016631e0),
[media upload](https://docs.platform.pixverse.ai/upload-media-video-and-audio-43051206e0),
[image-to-video](https://docs.platform.pixverse.ai/image-to-video-generation-13016633e0),
[transition](https://docs.platform.pixverse.ai/first-and-last-frame-video-43051213e0),
[extend](https://docs.platform.pixverse.ai/video-extend-43051216e0),
[upscale](https://docs.platform.pixverse.ai/video-upscale-43051217e0),
[modify](https://docs.platform.pixverse.ai/video-edit-modify-43051223e0),
[reference/fusion](https://docs.platform.pixverse.ai/reference-to-video-fusion-43051214e0),
[status](https://docs.platform.pixverse.ai/query-task-status-43051212e0),
[pricing/ledger distinction](https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0),
[Modify how-to-use (30s source)](https://docs.platform.pixverse.ai/how-to-use-modify-2082369m0),
[Kling 3.0](https://kling.ai/document-api/api/video/3-0-omni/text-to-video),
[Kling authentication](https://kling.ai/document-api/api/get-started/authentication),
[TopView skill CLI](https://github.com/topviewai/skill),
[ElevenLabs timestamped speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
[ElevenLabs music](https://elevenlabs.io/docs/api-reference/music/compose),
[ElevenLabs sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).
