# Optional OpenClaw and Hermes Adapters

OpenClaw and Hermes adapters are distribution-time opt-ins. A base Tsugite
install does not require OpenClaw, Hermes, their CLIs, local services, MCP
servers, credentials, or model/provider configuration.

Use these adapters only when a copied `project.yaml` selects them, for example
through `generation.adapter` or `analysis.adapter`. Projects that use local
media, PixVerse, Kling, Topview, or another installed adapter do not need any
OpenClaw/Hermes setup.

## Opt-In Setup

Before selecting an optional adapter in `project.yaml`, install and verify that
adapter's own runtime outside the Tsugite core:

- OpenClaw: install the OpenClaw runtime or gateway expected by your bridge,
  configure credentials/providers, and set `TSUGITE_OPENCLAW_GENERATE_COMMAND`.
  Use a JSON array command such as `["node","path/to/bridge.mjs"]`. The command
  receives Tsugite generation JSON on stdin and must return
  `{ request_id, credits, clips[], metadata }` JSON on stdout.
- Hermes: install the Hermes runtime or MCP surface expected by the handoff,
  configure model/provider access, and confirm the agent can reach it. The
  included Hermes adapter is `mcp-agent` analysis handoff only; it is not a
  direct `bin/pipeline run` executor.
- Add the adapter package or directory only for distributions that intend to use
  it. Keep adapter-specific code, commands, constraints, and secrets outside
  core.

Each optional adapter should still follow the normal Tsugite adapter contract:
`adapter.yaml`, `constraints.md`, normalized exit/status handling, and local
artifact outputs or manifest metadata as appropriate for its class.

`bin/pipeline doctor --config <project.yaml> --json` checks only the setup
contract declared by the selected adapter. OpenClaw validates that
`TSUGITE_OPENCLAW_GENERATE_COMMAND` is a JSON command array and that its first
executable is available, but it never executes the bridge. Topview and Hermes
remain `status: manual` because this repository cannot safely prove their
external skill/MCP runtime, credentials, or provider access. Follow each
reported `remediation` before approving Gate 1.

## Execution Gate

Selecting an OpenClaw or Hermes adapter does not loosen the pipeline gates.
`validate`, `plan`, and `run --dry-run` can be used for review, but real
`run` and `render` remain gated operations. They require the Coordinator role,
the relevant Gate approval, and explicit human approval before any non-dry-run
generation, analysis side effect, or rendering work is executed.
