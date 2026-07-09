# Kling adapter constraints

- Keep generated assets local under `dist/<run-id>/` before returning success.
- Normalize transient CLI failures to the shared exit-code contract.
- Use dry-run estimates before any command that can consume credits.
