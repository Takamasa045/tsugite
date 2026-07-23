# Lessons Graduation

1. Capture a failure in `LESSONS.md` with date, symptom, cause, and rule.
2. Classify the lesson before editing shared source:
   - One-off preference: keep it in `projects/<job>/notes.md`.
   - Reusable style choice: promote it into `examples/` or `templates/`.
   - Machine-checkable issue: add it to `constraints.yaml`, `validate`, or `doctor`.
   - Judgment-based operating rule: move it into `.agents/skills/tsugite/SKILL.md`, `CLAUDE.md`, or `AGENTS.md`.
   - QA decision rule: add it to Gate 2 / Gate 3 checks with report schema coverage.
   - Public contract change: update `README*`, `manifest/schema.md`, or `docs/requirements.md`.
3. When recurring evidence has a concrete target, change summary, and verification plan, record a pending promotion proposal. Show it as awaiting approval and do not edit shared source until a human approves it.
4. Treat approval as permission to implement the proposal, not as proof that implementation occurred. A rejected proposal stays recurring; an approved proposal stays pending implementation until a separate promoted record identifies the actual target.
5. For machine-checkable and QA rules, add or update a fixture plus a test that proves the failure is rejected before execution or reported at the right Gate.
6. Mark the lesson line with `validate済`, `doctor済`, `qa済`, or `documented`.
7. Keep `LESSONS.md` append-only; do not delete old lessons after promotion.
8. At explicit project completion, record the closeout's failures, improvements, and next-run lessons, including an explicit no-failure result when applicable. Search prior feedback by failure key and lessons by matching symptom and cause. Record a repeated failure as `recurring` and state whether it is a promotion candidate; create a pending proposal only when its target, change summary, and verification plan are ready for human review.
