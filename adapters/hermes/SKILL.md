# Hermes Analysis Adapter

Use this optional adapter when `project.yaml` declares `analysis.adapter: hermes`.

## Responsibilities

1. Read the validated project manifest and requested analysis outputs.
2. Use the installed Hermes runtime or MCP surface outside Tsugite core.
3. Keep source media and manifests read-only unless Coordinator approval says otherwise.
4. Return or write only the requested analysis metadata, such as captions, chapters, or cut point proposals.
5. Keep credentials, auth links, raw prompts, and private external content out of repo files and usage history.

## Operational Boundary

- Base Tsugite installs do not require Hermes.
- Planner and Reviewer roles may run `validate`, `plan`, and `run --dry-run` only.
- Coordinator approval is still required before any non-dry-run side effect.
- This `mcp-agent` adapter is a handoff contract, not a direct `bin/pipeline run` executor.
