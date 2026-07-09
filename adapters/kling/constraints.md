# Kling adapter constraints

- Generation duration must be 5 or 10 seconds.
- Generation aspect must be 16:9 or 9:16.
- If a seed is supplied, it must be between 0 and 2147483647.
- Keep generated assets local under `dist/<run-id>/` before returning success.
- Normalize transient CLI failures to the shared exit-code contract.
- Use dry-run estimates before any command that can consume credits.
