# MiniMax HTTP adapter (Phase C)

- Connection id: `minimax-http` (separate from `minimax-direct` / `mmx` CLI).
- Initial scope: **MiniMax-H3 last-frame-only**.
- Forbidden: first-frame attachment, same-image duplication as first+last, T2V downgrade, silent mode guessing.
- No silent fallback to/from `minimax-direct`. No shared approval or credential auto-switch.
- Auth: environment variable name `MINIMAX_API_KEY` only; values never logged or stored.
- Pricing: unknown until a pricing authority is configured → preflight-only / blocked.
- Transport: fixed HTTPS allowlist, redirect rejected, bounded timeout/poll/download, Content-Length + stream caps, SHA-256, atomic local pin.
- No argv shell, no credential files.
