# Hypit 制作

Tsugite は Production（brief、references、assets、tasks、engineRuns、builds、artifacts、reviews、decisions、costApprovals、deliverables）を持つ。Hypit は案件ごとの独立 workspace と公式 `@hypit/hypit` 実行ファイルを使う。pipeline backend や Tsugite Gate 1/3 の代替ではない。制作 UI の承認は Production Control の authoringEngine 人間ゲートである。

core（`src/`）には Hypit 固有コードを置かない。実装は `adapters/hypit/` と中立な `src/productionControl/authoringEngine.ts`。

ソース版は **0.13.0**。git タグ、CI、完成メディア、人間承認、MP4 受け入れはここでは主張しない。

Tsugite 本体は Node.js **22.12 以上 23 未満**。Hypit runtime（`npm run hypit:install` と `runtime init` / `runtime up`）は追加で **Node.js 22.15 以上**（22.x）が必要。22.12〜22.14 では engine 警告、または準備前検査 `HYPIT_NODE_UNSUPPORTED` で停止する。本体の最低版は上げない。

## 公式ソース（2026-09-25 更新確認）

| 対象 | URL |
| --- | --- |
| サイト | https://hypit.ai |
| Agent Quickstart | https://hypit.ai/quickstart/ |
| Run / Build | https://hypit.ai/quickstart/run/ |
| Runtime | https://hypit.ai/guide/runtime/ |
| Skill ガイド | https://hypit.ai/guide/skill/ |
| Studio | https://hypit.ai/quickstart/preview/ |
| GitHub | https://github.com/hypit-ai/hypit |
| Release | https://github.com/hypit-ai/hypit/releases/tag/v0.2.13 |

実行ファイルは **`@hypit/hypit@0.2.13`**（GitHub commit `238fe97fcea37b7cc95e37ee6023f4a02c60bb0a`）。Skill は `npx skills add hypit-ai/hypit -g`。隔離コピーは `adapters/hypit/skill/`。

## 本番ワークフロー

入口は制作 UI（通常のランチャーから開く）。`npm run hypit:production` は任意の CLI 入口であり、計画時のローカル Runtime 準備にユーザーの CLI 操作は不要。

```sh
npm run hypit:install
npm run hypit:production -- intake --from <local.mp4> --production <durable-project>
npm run hypit:production -- author --production <durable-project>
npm run hypit:production -- plan --production <durable-project>
npm run hypit:production -- review --production <durable-project>
npm run hypit:production -- ui --production <durable-project>
```

流れ: 参照取り込み → ソース作成 → ローカル Runtime 準備（`prepareLocalRuntime`、`media.local` / `hyperframes.local` のみ）→ `check`/`plan` → 費用と接続の表示 → 人間の承認 → 永続 intent → `build` → status/inspect → 受け取り → 必要なら書き出し。準備は `productionRoot/.tsugite/hypit-host-state` を使う。準備が失敗したときは plan-ready にせず、残っていた承認も無効化する。revision は approval を無効化する。running の pending と unknown は残し、自動では再 submit しない。complete/failed/accepted だけ履歴へ退避して次の承認済み計画を許す。

`author` の既定は親プロセス PATH の**絶対エントリ**にある `codex`（macOS / Linux）または `codex.exe`（Windows）。相対パスと空エントリは使わない。workspace-write、network_access=false、`--ignore-user-config` / `--ignore-rules`、hooks/plugins/MCP 無効。sync / async は同じ絶対実行ファイルを `shell:false` で起動する。Windows の `codex.cmd` / `codex.bat` は shell が必要なため未対応（`AUTHOR_AGENT_UNSUPPORTED`）。ブラウザから argv は渡せない。HTTP の author は非同期。CLI の author は完了まで待つ。

有料 build は known cost + `approve-plan` + `confirm_paid` + 永続 pending intent + 計画時閉包との一致。local-only は検証済み plan と `approve-local-render` + `confirm_local_render` だけ。unknown は 0 円にしない。submitted は complete ではない。complete は accepted ではない。

制作 UI 承認は Tsugite Gate 1 の代替ではない。Gate 1 には `dist/<run-id>/review/index.html` と `review-data.json` が要る。

## いま確認できていること / まだ確認していないこと

確認済み（親の実案件と実装、2026-09-15）:

- 実参照動画フレームから Codex + 公式 Hypit Skill でソース作成
- 実 Hypit `check` / `plan` 成功（親が既存 host-state で手動セットアップ済みの案件）
- 要求 3 件すべて local（`media.local` / `hyperframes.local`）、preflight 成功、provider 要求 0
- 通常ランチャーから本番制作 UI を開ける
- 計画前にローカル Runtime 準備を接続（固定 local endpoint、host-state は `productionRoot/.tsugite/hypit-host-state`）
- 2026-09-25に0.2.13の隔離runtime導入、公式例のコンパイル、`check` / `plan` が成功

未確認 / 未実施:

- 人間の承認（Gate / approve-plan / approve-local-render）
- 実 `hypit build`、MP4、成果物の受け取り
- 0.2.13での本番Runtime起動・Build

build 成功、完成動画、CI、git タグ、受け入れは主張しない。

## Phase 1 スパイク（本番とは別コマンド）

`npm run hypit` は公式 example 固定の観測用。本番 CLI ではない。**build は無条件拒否**。`TSUGITE_HYPIT_GRANT` では解除できない。

許可: `--version`、`--help`、固定プロファイルの `check` / `plan`、`measure`、`paths`、`doctor`、`builds` / `history` / `inspect` / `logs` / `status`（`--watch` なし）、`vocabulary`、`auth status`、`runtime status|logs`、`packages status`。

`check` / `plan` の許可 argv は公式 example の `chat.svml` / `chat.svrun` と固定 workspace だけ。spawn 前に公式 bytes と `expected-build.json` を照合する。

証拠: `docs/reports/hypit-phase1-spike.md`、`docs/reports/hypit-phase1-evidence/`。
