# Explicit service connections

PixVerse, Kling, and TopView are not connected by writing an API key into
project settings. The intended use is each service's CLI while that
subscription is already logged in. Support arrives in order. Another change is
implementing that path. This page does not add a login command, and the JSON
below is the current HTTP transport used by synthetic tests. It is not the
formal 2.0.0 acceptance method. That method is the subscription-CLI
real-machine check in [requirements](requirements.md). ElevenLabs is outside
this CLI policy.

Offline and mock mode require no account. `execution: live` is a separate,
explicit selection. Install a reviewed source package, choose the API origin,
credential environment-variable name and download origins in your private
`~/.tsugite/config.json`. Isolate that private home with `TSUGITE_HOME` (tests
and local runs). v2 does not read `TSUGITE_PROJECTS_HOME`; that variable belongs
to the v1 launcher shelf. This file stores references
and scalar defaults, never a key or token value. No credential is created or
changed by Tsugite. Do not put credentials in YAML, notes or receipts.

```json
{
  "version": 1,
  "plugins": {
    "pixverse": {
      "defaults": {"model": "v6", "quality": "360p"},
      "connection": {
        "enabled": true,
        "base_url": "https://app-api.pixverse.ai",
        "credential_env": "MY_CHOSEN_PIXVERSE_KEY",
        "download_origins": ["https://your-verified-output-cdn.example"]
      }
    }
  }
}
```

The example download origin is a placeholder, not a vendor CDN recommendation.
Select the actual trusted origins for your account before planning. API and media
requests reject redirects. Media requests omit authentication headers. Do not
allow arbitrary origins. Third-party plugin code remains trusted local code,
not an OS sandbox.

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
  at 32 MB). `seconds` cannot exceed the probed source duration. Already-4K
  sources (`width >= 3840` or `height >= 2160`) are rejected at planning.
- PixVerse video modify (prompt-only): one local video and up to three optional
  stills. Quality is 360p/540p/720p (no 1080p). Quote is 8/10/12 credits/s of
  source duration. `seconds` cannot exceed the probed source duration.
  Mask / swap / keyframe workflows are unimplemented.
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
keys and no real service calls. They cover request construction, business errors,
identity recovery, callback ordering, unknown billing, response limits, secret
error redaction and credential-free downloads. They do not establish actual
provider acceptance, prices for your account or paid execution reliability.

Reviewed 2026-10-18, with image/transition, speech settings, extend/upscale/
modify/reference and music/SFX fields checked again on 2026-10-21:
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
[Kling 3.0](https://kling.ai/document-api/api/video/3-0-omni/text-to-video),
[Kling authentication](https://kling.ai/document-api/api/get-started/authentication),
[ElevenLabs timestamped speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
[ElevenLabs music](https://elevenlabs.io/docs/api-reference/music/compose),
[ElevenLabs sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).
