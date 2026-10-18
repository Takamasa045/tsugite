# Explicit service connections

Offline and mock mode require no account. `execution: live` is a separate,
explicit selection. Install a reviewed source package, choose the API origin,
credential environment-variable name and download origins in your private
`~/.tsugite/config.json` (`TSUGITE_HOME` for tests). This file stores references
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
  optional seed. The quote uses the documented rate snapshot dated 2026-10-18
  and can reserve a larger explicit `max_credits`. `Resp.credits` is preliminary,
  so a received video still needs final ledger reconciliation. Each request has
  a new trace UUID; this is not a server idempotency guarantee.
- Kling 3.0 text-to-video: default 720p, project aspect, 3–15 integer seconds,
  audio off and single shot. Explicit positive `max_credits` is required. The
  selected endpoint for international API users is
  `https://api-singapore.klingai.com`. Existing external task IDs are queried
  before creation. Only video resource-unit billing can settle automatically;
  cash/currency billing is retained as unknown, never converted to credits.
- ElevenLabs timestamped text-to-speech: explicitly chosen voice, default
  `eleven_multilingual_v2`, MP3 response converted locally to PCM WAV. Explicit
  positive `max_credits` is required. The synchronous endpoint does not document
  final credits or a durable task ID; neither is invented. Verify actual charged
  credits in the service and reconcile them in the page. The requested seconds
  describes the approved timeline slot; review actual narration length before
  accepting clips.

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

Reviewed 2026-10-18:
[PixVerse request](https://docs.platform.pixverse.ai/text-to-video-13016634e0),
[status](https://docs.platform.pixverse.ai/query-task-status-43051212e0),
[pricing/ledger distinction](https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0),
[Kling 3.0](https://kling.ai/document-api/api/video/3-0-omni/text-to-video),
[Kling authentication](https://kling.ai/document-api/api/get-started/authentication),
[ElevenLabs timestamped speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).
