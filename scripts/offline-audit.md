# Dependency checks without inventory uploads

`.npmrc` and workflow `NPM_CONFIG_AUDIT=false` prevent npm install/ci from submitting dependency inventories to npm audit. Existing required audit commands use `scripts/offline-audit.mjs` instead.

The helper downloads the official Google OSV Scanner 2.7.0 binary (fixed SHA-256) and the public npm ecosystem advisory ZIP using fixed GET URLs. It then runs `--offline --no-resolve --all-packages`; package names, versions and source files remain local. A verified database is cached for at most 24 hours. Missing packages, an unavailable database, scanner errors and unknown severities fail closed. The summary records the database hash.

Run `node --test scripts/offline-audit.node.mjs` and `node scripts/offline-audit.mjs package-lock.json`. Add `--omit=dev` for production dependencies, `--audit-level=moderate` (or the repository's existing threshold), or `--informational` only for an already informational development report. Informational reports still fail on tooling or incomplete-inventory errors. This matches published OSV advisories locally; npm-specific meta-advisory counts can differ and are not represented as a fresh npm audit result. Existing test, coverage and deployment gates remain required.

References: https://google.github.io/osv-scanner/usage/offline-mode/ and https://github.com/google/osv-scanner/releases/tag/v2.7.0.
