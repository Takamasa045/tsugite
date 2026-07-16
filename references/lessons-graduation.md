# Lessons Graduation

1. Capture a failure in `LESSONS.md` with date, symptom, cause, and rule.
2. Classify the lesson before editing shared source:
   - One-off preference: keep it in `projects/<job>/notes.md`.
   - Reusable style choice: promote it into `examples/` or `templates/`.
   - Machine-checkable issue: add it to `constraints.yaml`, `validate`, or `doctor`.
   - Judgment-based operating rule: move it into `.agents/skills/tsugite/SKILL.md`, `CLAUDE.md`, or `AGENTS.md`.
   - QA decision rule: add it to Gate 2 / Gate 3 checks with report schema coverage.
   - Public contract change: update `README*`, `manifest/schema.md`, or `docs/requirements.md`.
3. For machine-checkable and QA rules, add or update a fixture plus a test that proves the failure is rejected before execution or reported at the right Gate.
4. Mark the lesson line with `validate済`, `doctor済`, `qa済`, or `documented`.
5. Keep `LESSONS.md` append-only; do not delete old lessons after promotion.
