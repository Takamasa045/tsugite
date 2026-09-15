# Hypit Phase 1 spike report

Session `7311a25e-1bf4-4a90-a511-497355f45788`. Worktree `codex/hypit-integration` from `origin/main` `e83e015`. **MVP 完了ではない。** Phase 1 のみ。commit / push / build / 有料生成はしていない。

検証（この修復後）: focused `test/hypit-spike.test.mjs` **22 passed**。`npm run check`: vendor ok、tsc ok、**137 files / 2097 tests passed**。coverage statements 82.86% / branches 74.63% / functions 89.77% / lines 85.55%。

## 実測した公式契約

- 実行ファイル: npm `@hypit/hypit@0.1.8`（https://registry.npmjs.org/@hypit/hypit/-/hypit-0.1.8.tgz）
- GitHub Release: https://github.com/hypit-ai/hypit/releases/tag/v0.1.8 commit `012562c73aa9865c53cb7d835e56ccfd837a4b34`
- Skill: https://github.com/hypit-ai/hypit/tree/v0.1.8/skills/hypit （`npx skills add hypit-ai/hypit -g`）。実行ファイルとは別ライフサイクル。
- 文書: https://hypit.ai/quickstart/ https://hypit.ai/quickstart/run/ https://hypit.ai/guide/runtime/ https://hypit.ai/guide/skill/

実 CLI（隔離 `npm run hypit`）:

```
npm run hypit:install
npm run --silent hypit -- --version          # 0.1.8
npm run --silent hypit -- --help
npm run --silent hypit -- help plan
npm run --silent hypit -- measure --text "Are we ready to launch?" --json
```

`check` / `plan` はピン済み公式 `examples/semantic-composition` の検証コピーだけ。ラベルは「ユーザー参照解析ではない」。spawn 前に公式 Source bytes と `expected-build.json` の activation bytes を照合する。`--package-root` は positional の後でも拒否。これは任意 Source 隔離ではない。

## 監査5件への対応

1. **build 無条件拒否。** `permissions.mjs` は grant 配列を無視して拒否する。`cli.mjs` は `TSUGITE_HYPIT_GRANT` が付いていても解除しない。
2. **部分ハッシュを承認にしない。** `observePlanFingerprint` は `role: observation-only` / `authorization: false`。import 閉包は省略と明記。
3. **raw bytes ハッシュ。** `sha256Bytes`。不正 UTF-8 が同じ置換文字になっても衝突しない。
4. **spike 終了コード。** version / measure / check / plan の失敗で非ゼロ。
5. **trusted official fixture + 安全な子環境。** 任意 workspace の `check`/`plan` を拒否。`NODE_OPTIONS` と資格情報を渡さない。Hypit は check/plan でも activation JS を import する。CLI 許可リストは OS 隔離ではない。
6. **path-only 信頼を廃止。** `check`/`plan` は固定ファイル名・固定 workspace・固定 argv。spawn 前に公式 bytes と activation bytes を照合。改ざん SVML と `--package-root`（positional の後も含む）を拒否。任意 Source 隔離とは呼ばない。

## 成立した観測

ログは `docs/reports/hypit-phase1-evidence/`。

- `--version` → `0.1.8`
- `measure` → `hypit.video-cli-measure@1`（ローカル、Runtime なし）
- `paths` → `HYPIT_STATE_HOME` は `.tsugite/tools/hypit-host-state`
- 公式 example の `chat.svml` / `chat.svrun` に対する `check` / `plan`（ローカル tsc した公式 `@example/chat-scene` と、runtime にピンした Inter）

`plan` JSON の `needs` は local HyperFrames / media-pipeline 能力。pricing フィールドは無い。cost reader は **unknown / amount null**。0 円にしていない。

## 残るゲート（次の具体手）

1. オーケストレータが `adapters/hypit/orchestrator-author-prompt.md` を **別セッション** で走らせ、参照または brief から editable Source を書く。このセッションは subagent をネストしない。
2. ユーザー参照動画がまだ無い。参照解析は主張しない。
3. 人間の scope/cost 承認は既存 Production Control に載せる。observation digest を承認に使わない。
4. 承認後だけ `build`。submit 意図を先に永続化し、不明な結果を自動再 submit しない。
5. `get` の realpath、Studio 編集後の source 無効化、captions-only の明示 reuse、UI は未着手。
6. 任意 Source を check/plan する前に package allowlist / sandbox が必要。

Phase 1 の次の実装単位: 公式 fixture の `plan` JSON を Production Control の unknown cost + 人間承認レコードへ、Hypit 固有コードを `adapters/hypit` に残したまま接続する。
