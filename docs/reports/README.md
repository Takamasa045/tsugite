# Release evidence reports

`po8-rc-release-readiness.json` and `po8-rc-evidence/` are **historical PO-8 RC provenance**. They record a 0.9.0-era **GO-WITH-CAVEATS** envelope.

They are not current product copy. Software **0.10.0** shipped Production Orchestration T00–T09. Do not treat `package_version: "0.9.0"` in these files as the live `package.json` version.

Keep the digest-bound JSON and browser PNG evidence. Command logs under `po8-rc-evidence/commands/` are session artifacts; regenerate via `scripts/po8-rc-readiness.mjs` rather than editing by hand.
