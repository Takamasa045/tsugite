# Contributing to Tsugite

Thank you for helping improve Tsugite. This project is a local, human-gated AI video-production pipeline; changes must preserve its safety boundaries as well as its technical behavior.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Use an issue to discuss larger changes before investing in an implementation.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Local checks

Use Node.js 22.x and install the repository dependencies before making code changes:

```sh
npm ci
npm --prefix apps/workflow-viewer ci
npm run check
```

Run the focused check for the area you change as well. Update documentation, examples, and tests whenever the public behavior changes.

## Safety boundaries

- Do not run non-dry-run `run` or `render`, approve a Gate, spend provider credits, publish, or change provider credentials without explicit maintainer approval.
- Keep provider-specific behavior in adapters or backends; core pipeline behavior remains vendor-neutral.
- Do not commit private `projects/` data, generated media, credentials, or user-specific logs.

## Pull requests

Keep each pull request focused. Explain the user-facing change, the reason for it, and the checks you ran. If a change affects the pipeline contract, Gate behavior, or generated media, call that out explicitly so reviewers can assess its impact.
