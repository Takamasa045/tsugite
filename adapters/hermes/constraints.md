# Hermes Analysis Adapter

This adapter is optional. Base Tsugite installs do not require Hermes.

Use it only when a project explicitly declares `analysis.adapter: hermes`.
This adapter is an `mcp-agent` handoff: Tsugite validates and plans the handoff,
but the agent follows this `SKILL.md` outside direct `run` execution.

Hermes analysis should be read-only around source media and manifests unless a
Coordinator explicitly approves a write-back path. Do not store secrets, auth
links, raw prompts, or private external content in repo files or usage history.
