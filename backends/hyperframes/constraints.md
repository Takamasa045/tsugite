# HyperFrames backend constraints

- Run `npx --no-install hyperframes lint --json` before rendering.
- The runner must probe HyperFrames with `npx --no-install` so it never auto-installs packages during preflight.
- When HyperFrames is unavailable, return a structured `hyperframes.dependency_missing` result and exit with code 30.
- Full render integration is scheduled after the Remotion path is stable.
