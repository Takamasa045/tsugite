# Orchestrator-only Hypit author prompt (Phase 1)

Launch this in a **separate** coding-agent session that already has the
official Hypit Skill. Do not nest subagents under the implementation
session. Do not treat this as sandbox isolation.

Skill pin: GitHub `hypit-ai/hypit` tag `v0.2.13`
`skills/hypit/SKILL.md`. Official install: `npx skills add hypit-ai/hypit -g`.
Isolated snapshot: `adapters/hypit/skill/SKILL.md` (SKILL.md only).

Executable: repository-pinned `@hypit/hypit@0.2.13`.

```sh
npm run hypit:install
npm run --silent hypit -- --version   # expect 0.2.13
```

The gated launcher **unconditionally** refuses `build` and other
execution commands. `TSUGITE_HYPIT_GRANT` is ignored and is not approval.

Phase 1 `check` / `plan` only accept the pinned official
`examples/semantic-composition` copy. Arbitrary authored Sources are
not allowed until a package allowlist/sandbox exists. Hypit loads
project activation JS during check/plan.

## Prompt to paste

```text
Use the official Hypit Skill. Work in an independent Hypit workspace
directory that is not the Tsugite repo root.

No user reference video was supplied. Do not claim reference analysis.
If the requested piece needs a spoken or filmed reference, stop and
name that gap.

Create editable sources only:
- main.svml
- recipes.svs if needed
- build.svrun with <author source> and <target output>

Do not run hypit check/plan on untrusted Sources in Phase 1.
Do not run:
  hypit build
  hypit runtime up
  hypit programs up
  hypit auth login
  hypit transcribe
  hypit pricing
  hypit packages install
  hypit studio

Stop before build. Report files written, decisions, unknowns, and
that execution stopped before build.
```
