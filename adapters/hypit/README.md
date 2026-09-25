# Hypit Phase 1 adapter

Isolated pin of official `@hypit/hypit@0.2.13`. Not a pipeline backend.

Hypit runtime needs Node.js >=22.15.0 on the 22.x line. Tsugite core remains >=22.12 <23. Author resolves `codex` from parent absolute PATH entries only (`codex.exe` on Windows). `.cmd` / `.bat` wrappers are unsupported (`AUTHOR_AGENT_UNSUPPORTED`); launch is `shell:false`.

- `npm run hypit:install` then `npm run --silent hypit -- --version`
- `npm run hypit:spike` runs version/help/measure/check/plan on the pinned
  official `examples/semantic-composition` copy only
- `build` cannot be unlocked in this phase
- See `docs/hypit.md`
