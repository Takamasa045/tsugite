# Node.js runtime policy

The default stays **Node.js 22.23.4 / npm 10.9.8**. This change prepares a gradual move to 26; it does not switch existing users or declare every provider certified on 26.

| Release line | Minimum patched version admitted by source | Role |
| --- | --- | --- |
| 22 | 22.23.4 | Existing default and rollback |
| 24 | 24.22.1 | Compatibility candidate and fallback if 26 has blockers |
| 26 | 26.12.1 | Compatibility candidate until LTS and acceptance gates pass |

Only these even major lines are admitted. Old security patches, odd majors, prereleases and unknown future majors are rejected by Doctor/setup/v2 environment checks. Existing 22 users update within 22.x; project formats and approvals are unchanged. `engines` describes the allowed installation range, not certification of optional integrations.

`v2/src/node-runtime.mjs` is the shared, dependency-free policy. Root Doctor and bootstrap import it; the standalone v2 package includes it through its existing `src` package rule. Manifest/lock metadata and CI pins are checked against this policy. Keep `.nvmrc` on 22 until promotion. No user shell configuration or installed runtime is changed automatically.

## CI and installation

- Root: Linux build/unit/coverage/Viewer checks on 22, 24 and 26. Windows and macOS run native build/Viewer/CLI smoke on all three.
- v2: Linux/macOS/Windows checks, offline smoke, extended smoke and package dry-run on all three. Remotion fixture smoke runs on Linux for all three.
- Existing Node 22 check names are retained. Review required-check rules before publication: remove retired Desktop checks if configured and add the candidate lanes before default promotion; this source change does not edit GitHub branch protection.
- Each matrix job installs **npm 10.9.8** before `npm ci`. npm 11 adoption is a separate change. Do not regenerate dependency graphs with each Node/npm combination.
- Preserve lockfile v3. In this change only runtime metadata and removal of Viewer's two Desktop-only xterm dependencies change. Root/v2 dependency versions stay fixed. `npm ci --no-audit` must work without changing tracked locks; never reuse native `node_modules` across CI matrix jobs.
- `.npmrc`/CI disable npm audit submission. Existing `security:audit` uses the repository's offline lockfile scanner, not an external dependency inventory upload.

Known blocker: optional Hypit runtime setup explicitly rejects Node 24/26 (`HYPIT_NODE_UNSUPPORTED`). Its guard is preserved pending separate validation. If Hypit is required, keep Node 22. Download-site is a separate Cloudflare app and retains its Node 22 CI pin.

Viewer tests disable Node’s process-global Web Storage only in Vitest workers (`execArgv`). This keeps jsdom’s per-window localStorage available on 26; browser product storage is unchanged. Sources: [Node globals](https://nodejs.org/api/globals.html#localstorage), [Vitest execArgv](https://vitest.dev/config/execargv).

## Promotion gates

As of 2026-10-22, Node 26 is Current. Its scheduled LTS start is 2026-10-28. The official release schedule lists EOL as 2027-04-30 (22), 2028-04-30 (24) and 2029-04-30 (26). Confirm the actual LTS release before promotion. Sources: [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [October security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Node 26.12.1](https://nodejs.org/en/blog/release/v26.12.1).

Promote only after all of the following are recorded at the same final revision:

1. All configured CI matrix lanes pass, including clean installs, root coverage, Viewer build, native dependencies (Sharp/esbuild/Rollup), MCP transport and v2 distribution tests.
2. The packaged v2 CLI installs and runs outside the checkout. CLI adapters retain timeout, abort, error, path quoting, stdout JSON and Windows executable behavior. Fixture success does not certify real vendor authentication or billing.
3. Optional PixVerse/Kling/TopView/MiniMax/Hypit/Editframe and renderer paths actually used by the release have explicit compatibility evidence. Do not infer this from `engines` alone. Real service/paid acceptance needs separate authorization.
4. Browser launcher/Viewer and approval flows pass without Desktop. No project migration or generated-data change is required.
5. Actual Node 26 LTS status, release patch, npm pin and rollout note are reviewed. Change `.nvmrc` and default policy together in a separate small change; keep tested 22/24 ranges during a documented compatibility period, ending 22 support no later than its security EOL.

If 26 install, native binary, loader, provider, distribution or platform behavior fails, retain 22 as default and block promotion. Fix narrowly or use verified 24 as an interim target. Do not lower checks/coverage, silently skip a required lane, change provider semantics, or bypass approval to make 26 green.

Rollback is a runtime selection: select the previously verified 22 patch and npm 10.9.8 in the user's existing version manager, then reinstall from the same lockfile in the target checkout. Rebuild the Viewer. Preserve `projects`, state, approval records, media and configuration. Published v2 packages need a new version to deliver this change; existing alpha.5 downloads are unchanged.

Desktop source, Electron/node-pty packaging and embedded terminal bridges are removed. See [Desktop retirement](desktop.md). Historic evidence remains for auditability; no installed app or user data is deleted by this source change.
