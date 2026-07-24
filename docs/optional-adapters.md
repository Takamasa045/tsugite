# Optional Hermes Adapter

Hermes is a distribution-time opt-in. A base Tsugite install does not require
Hermes, its CLI, local services, MCP servers, credentials, or model/provider
configuration.

Use Hermes only when a copied `project.yaml` selects it through
`analysis.adapter`. Projects that use local media, PixVerse, Kling, TopView,
or another installed adapter do not need Hermes setup.

## Opt-In Setup

Before selecting Hermes in `project.yaml`, install and verify its runtime or
MCP surface outside the Tsugite core. Configure model/provider access and
confirm the agent can reach it. The included Hermes adapter is an `mcp-agent`
analysis handoff only; it is not a direct `bin/pipeline run` executor.

Keep adapter-specific commands, constraints, and secrets outside the core.
`bin/pipeline doctor --config <project.yaml> --json` checks only the setup
contract declared by the selected adapter. TopView uses a repo-local MCP
bridge: doctor lists the official MCP tools without submitting a task, while
login, credits, and provider connectivity remain manual checks. Hermes remains
a manual agent handoff. Follow each reported `remediation` before approving
Gate 1.

## Execution Gate

Selecting Hermes does not loosen the pipeline gates. `validate`, `plan`, and
`run --dry-run` can be used for review, but real `run` and `render` remain
gated operations. They require the Coordinator role, the relevant Gate
approval, and explicit human approval before any non-dry-run generation,
analysis side effect, or rendering work is executed.
