# MiniMax direct adapter constraints (Phase A)

- Transport: official MiniMax CLI `mmx` (`https://github.com/MiniMax-AI/cli`).
- Required CLI version: `>= 1.0.19`.
- IR model id: `minimax-h3` (Tsugite Creative IR).
- Provider model id: `MiniMax-H3` (explicit mapping only; never guess-convert).
- Phase A supports **preflight / dry-run argv construction only**. Actual generation is not integrated.
- Official MCP (`MiniMax-MCP`) is Hailuo-02 era and is **not** an H3 / last-only execution source.
- Secret: declare environment variable name `MINIMAX_API_KEY` only; never log or persist values.
- last-frame-only dry-run concept (official help 2026-08-08):

```text
mmx video generate --model MiniMax-H3 --last-frame <safe-local-path> --prompt "..." --dry-run
```

Do not attach `--image` / first-frame for last-frame-only.
Do not shell-concatenate argv; pass string arrays only.
Pinned media must be regular files under the run directory (symlink / path escape rejected).
