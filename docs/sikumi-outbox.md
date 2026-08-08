# tsugite × sikumi Live Outbox

Optional observation bridge: tsugite writes sikumi Event Protocol files under
`<project>/.sikumi/events/` so the sikumi village can show LIVE craftsman state.

## Principles

1. **Default OFF** — omit `sikumi` or set `sikumi.enabled: false`
2. **tsugite alone always works** — no hard dependency on sikumi packages
3. **Fail-soft** — write errors never fail the pipeline
4. **No Supabase / HTTP** — Outbox files only; Local Agent Server collects them

## Enable

In `project.yaml`:

```yaml
slug: my-case
name: デモ案件
# ...
sikumi:
  enabled: true
```

Also register the same project directory in sikumi and run Local Agent Server.

## Lifecycle → events

| tsugite state / action | Outbox events (representative) |
| --- | --- |
| first state observe | `run.started` |
| awaiting_gate_1 | `gate.waiting` (`gate_id: gate_1`) |
| gate approved | `gate.approved` (+ `qa.passed` for gate_2/3) |
| gate revise/abort | `gate.rejected` (+ `qa.failed` for gate_2/3) |
| running / generation | `task.started`, `agent.working`, `artifact.created` |
| awaiting_gate_2 | `qa.started`, `gate.waiting` |
| rendering | `task.progress`, `agent.working`, `artifact.created` |
| awaiting_gate_3 | `qa.started`, `gate.waiting` |
| gate_3 approved (state completed) | `gate.approved` (+ `qa.passed`) — **not** `run.completed` |
| finalize --apply success | `run.completed` once (product 完成) |

## Implementation

- Adapter: `src/integrations/sikumiOutbox.ts`
- Hooks: gate `writeState` (CLI), assemble/render success, finalize apply
- Runtime data: `.sikumi/` is gitignored

## Verify

```bash
npm test -- test/sikumi-outbox.test.ts
# With sikumi.enabled: true on a real project, run gate/run steps and check:
#   <project>/.sikumi/events/*.json
# sikumi Local Agent Server polls registered projects and shows LIVE craftsman.
```
