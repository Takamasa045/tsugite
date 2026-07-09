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
