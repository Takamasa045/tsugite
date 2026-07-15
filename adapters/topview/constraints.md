# Topview adapter constraints

- Use the Topview skill/tooling only after Gate 1 approval.
- Dry-run planning must estimate credits without submitting a Topview task.
- Generated videos must be downloaded to local files under `dist/<run-id>/` before success.
- Do not persist API keys, auth links, prompts, or user-provided private material in adapter history.
- Normalize external failures to the shared exit-code contract.
- `mode: image-to-video` requires one repo-local regular file in `first_frame`.
- Reject absolute paths, missing files, paths outside the project asset root, and every symbolic-link path before provider execution.
- Copy the accepted image into `dist/<run-id>/assets/generation-inputs/` and pass only that pinned copy to TopView.
- End-frame and omni reference modes are not part of this first i2v contract.
