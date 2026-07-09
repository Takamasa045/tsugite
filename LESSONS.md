# LESSONS

Append-only format:

`YYYY-MM-DD / symptom / cause / rule / status`

2026-07-09 / mcp-agent adapter could not be handed off safely / adapter had no SKILL.md instructions / mcp-agent adapters must include SKILL.md / validate済
2026-07-09 / npm ls reports @emnapi/runtime as extraneous after npm ci / npm 11 keeps optional wasm child packages from platform-skipped lockfile entries / treat as non-blocking only when npm ci, npm audit, build, tests, validate, plan, and dry-run pass; do not add a direct dependency just to silence npm ls / documented
2026-07-10 / generation request id could escape the adapter output directory / request ids and adapter output paths were not enforced at the core boundary / require safe unique request and clip ids, matching request_id, and realpath containment inside runDir / validate済
2026-07-10 / an awaiting Gate 2 run could report success from manifest alone and lose credit counters / resume trusted state without cross-checking QC, run log, and assets / resume must validate all persisted artifacts and recover counters from verified outputs / validate済
2026-07-10 / Gate 3 could be approved from file existence alone / final output had no normalized QC report / write and inspect gate3-qc.json before approval / qa済
2026-07-10 / coverage configuration failed when the workspace path contained an asterisk / Vite config bundling treated the path as multiple inputs / enforce coverage thresholds through stable CLI options in this workspace / documented
2026-07-10 / render and gate silently accepted --dry-run while still performing side effects / CLI flags were parsed globally instead of per command / reject options outside each command allowlist and keep --dry-run run-only / validate済
2026-07-10 / provider CLI diagnostics could expose signed URLs or tokens through pipeline JSON / raw adapter stdout and stderr were used as public issue messages / emit fixed public adapter errors and keep provider output out of CLI responses / validate済
