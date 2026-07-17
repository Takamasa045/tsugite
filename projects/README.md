# Local Projects

This directory is reserved for user-created Tsugite projects.

Copy an example here and work inside the copied directory:

```sh
cp -R examples/local-fixture projects/my-first-run
bin/pipeline validate --config projects/my-first-run/project.yaml --json
bin/pipeline plan --config projects/my-first-run/project.yaml --json
bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
```

Everything under `projects/*` is ignored by git, so local prompts, media, manifests, `dist/`, and run state do not mix with the distributable source.

Structured preferences and review findings also stay local as `projects/<job>/feedback.jsonl`. Reuse the same stable `key` for the same preference across projects; generation count alone is not learning. Records progress from `observed` to `recurring`, then only with human-approved promotion to `promoted`, and finally to `verified` after later output confirms the improvement.

```sh
node bin/pipeline feedback --config projects/my-first-run/project.yaml \
  --key opening-audio --category audio --signal prefer --stage observed \
  --summary "Start music within the first 0.5 seconds" --json
```

The launcher's **Preferences & Learnings** shelf reads these files across local projects. It is read-only and never changes prompts, templates, checks, or operating rules automatically.
