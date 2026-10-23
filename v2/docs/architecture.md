# Architecture and trust boundaries

This alpha is an independent npm package under `v2/`. It imports no v1 code and
never selects a v1 project implicitly. The existing pipeline, apps, provider
adapters and in-progress productions remain on v1 until a separate migration.
No v1 branch rename, data move or deletion is performed by this implementation.

The small core manages the project, timeline, checks, budget, preferences,
confirmation page and plugin contract. The built-in offline media implementation
lives in `plugins/local/`. Vendor integrations must use the same contract and
remain outside the core. Knowledge packs are Markdown context, not executable
capabilities. Planning is deterministic rather than an LLM integration.

## File authority

`tsugite.yaml` describes a project. `.tsugite/plan.json` is the current proposed
plan; `.tsugite/plans/<hash>.json` preserves prior plans. The raw plan bytes are
hashed, and its contents are recomputed from the exact YAML bytes, asset hashes,
plugin package content and preference/knowledge snapshot before execution.
Approvals bind both this digest and the stage's current material snapshot.
Whitespace changes to a plan therefore invalidate an existing approval too.
Replanning to different content archives and supersedes existing approval
records; returning to an older plan does not revive those records.
`out/final.mp4` and the immutable recorded export must both match for final review.

`.tsugite/state.json` atomically stores jobs, credit reservations, settlements,
render records and timestamped events. There is one durable document for these
related facts, avoiding a ledger/log dual-write transaction. Atomic file rename
and file fsync are used; directory fsync/power-loss durability across every OS
is not claimed. A crash can leave the exclusive lock or an uncertain operation.

## Checks and page

The only approval endpoint is the loopback confirmation-page form. It requires
an exact Host and Origin, an HttpOnly SameSite=Strict session cookie, a page CSRF
token and current plan/stage hashes. GET never approves. CSP disables scripts,
frames and remote resources. Media access is session-bound and indexes only the
current plan's files. There is no arbitrary file-serving route.

The three checks are plan, clips, final. Export requires plan and clips approval;
final approval marks the inspected result, it does not happen automatically.
Only explicit `checks.auto_clips: true` with zero new tasks permits the clips
exception after inputs have been inspected. Remaking one completed clip from
the page changes that task's attempt identity and creates a new plan. Other
completed tasks can be reused; the new plan still needs a new plan approval.

These are safeguards against accidents and ordinary browser cross-site requests.
They do **not** separate a human from an agent with the same OS privileges. Such
an agent can open the page, submit requests or edit files. Plugins are trusted
executable code; a `network: false` declaration is a contract, not a sandbox.
No general guarantee against a malicious same-account process is possible here.

## Budget and failures

Limits and quotes use service-specific credits with fixed-point microcredit
arithmetic (six decimal places). Services are displayed separately. All tasks
are reserved in one locked transaction before the first task runs. A second
process fails closed while the project lock exists. Completed task identities
are reused rather than charged or executed again. A plugin must settle at or
below its reserved maximum. Errors, invalid results or an interrupted execution
retain the entire reservation as uncertain; automatic retries/refunds are denied.

Inspect `operation.lock`'s PID, job and provider evidence before any manual crash
recovery. There is intentionally no `--force` or silent stale-lock takeover.
The confirmation page can apply a normalized local receipt after a human checks
the actual outcome. It verifies the task/service/job identity and maximum,
records the receipt hash and settles once. Failed settled jobs can request a new
attempt and plan; uncertain jobs cannot retry. This is a manual ledger correction,
not proof of a live provider response. Crash locks still require owned-process
inspection; no forced stale-lock takeover is offered. Do not edit state casually.
Live source entry points require an explicitly enabled private connection and
a plan approved in the page. Credential values are resolved only at execution.
Only zero-credit renderers are accepted. Transport tests use synthetic HTTP and
local mock credits. ElevenLabs SFX has one recorded paid acceptance; other live acceptance is not claimed here. PixVerse, Kling, and TopView formal checks use a logged-in subscription CLI rather than an API key in settings, and that check is open. Explicit mock mode
loads synthetic zero-cost implementations and is labeled in the page. Remote
billing is not forced by a local quote: unknown charges remain reserved pending
page reconciliation. See [connections](connections.md) for the exact protocol
subset, recovery and credit-unit limits.

## Clean

`tsugite clean` previews only recorded, older successful generated media, after
final approval. The page rechecks the preview and moves those files into project
trash, recording each move's intent first. No irreversible delete command exists.
Original assets, current final, plans, approvals, taste and history remain.
Interrupted trash intents remain available for manual recovery.
