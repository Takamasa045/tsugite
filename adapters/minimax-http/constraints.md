# MiniMax HTTP adapter (Phase C)

- Connection id: `minimax-http` (separate from `minimax-direct` / `mmx` CLI).
- Initial scope: **MiniMax-H3 last-frame-only**.
- Forbidden: first-frame attachment, same-image duplication as first+last, T2V downgrade, silent mode guessing.
- No silent fallback to/from `minimax-direct`. No shared approval or credential auto-switch.
- Auth: environment variable name `MINIMAX_API_KEY` only; values never logged or stored.
- Pricing: unknown until a pricing authority is configured → preflight-only / blocked.
- API contract (documented only; live send unimplemented):
  - create: `POST /v2/video_generation`
  - query: `GET /v2/query/video_generation/{task_id}`
  - remote cancel: **DELETE not supported**
- Durable counters: poll max **120**, download max **3**.
- Artifact pin gate: MIME `video/mp4` or `video/quicktime`, SHA-256, ffprobe video stream, atomic pin; only `status=pinned` is a fixed deliverable.
- Transport: fixed HTTPS allowlist, redirect rejected, bounded timeout/poll/download, Content-Length + stream caps, SHA-256, atomic local pin.
- Scope limit: **fixture / preflight-only**. Live HTTP client, DNS resolver, provider real send, and pipeline manifest injection are **not implemented**.
- Future live send still requires **public-IP pinning and DNS-rebinding defense** before real traffic is allowed.
- No argv shell, no credential files.
