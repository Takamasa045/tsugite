# Tsugite verification feature map

The maintained primary surface is the public `node bin/pipeline` CLI with a copied local project. Baseline prerequisites are Node.js 22.12 or newer within the 22.x line, npm 10 or newer, ffmpeg/ffprobe, already-installed repository dependencies, and a run-owned `TSUGITE_PROJECTS_HOME`. The helper in `../scripts/verify.mjs` uses macOS `sandbox-exec` to deny network access and preserves proof under `verification/evidence/verify-tsugite/{run-id}/`.

Drive only one surface at a time. Record expanded argv, stdout, stderr, exit code, immediate result state, and a second read for local mutations. Report unexecuted entries as uncovered and failed entries as `blocked`; do not convert a product failure into a documentation change.

The bootstrap slice exercised `VAL-CLI-01` only. The loopback browser launcher, generated 3D Viewer, and development-only Electron shell are secondary uncovered surfaces; CLI evidence does not verify them.

## Index

- [Project readiness](project-readiness.md) — runtime and copied-project preflight.
- [Project validation](project-validation.md) — the exercised real CLI slice.
- [Story guidance](story-guidance.md) — advisory framework selection before shot design.
- [Planning and dry-run](planning-and-dry-run.md) — deterministic plan and no-execution run preview.
- [Gate 1 creative review](gate-1-creative-review.md) — local review artifact generation without Gate mutation.
