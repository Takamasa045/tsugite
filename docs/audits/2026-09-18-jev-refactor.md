# JevMCP リファクタリング調査（2026-09-18）

基点: `origin/main` = `dfe4ddc`。専用ブランチ: `codex/jev-refactor`。
ローカル main 固有の13コミットと既存の LESSONS.md 編集は対象外。変更した2ファイルは調査時のローカル main と同一だった。

## 調査方法と限界

- 追跡済み `src/`, `adapters/`, `backends/`, `apps/`, `scripts/` の TS/TSX/JS/MJS 551ファイルをTypeScript ASTで走査。testsを含む。依存・生成物・非公開制作案件は対象外。
- `tsc --noEmit --noUnusedLocals --noUnusedParameters` で root `src/**/*.ts` の未使用宣言を調査。変更前27件、変更後26件。exportの外部利用やアプリ側の未使用コードを網羅する解析ではない。
- 関数本体180文字超を空白正規化して比較。候補は引数・自由変数・依存元まで確認して判断する。近似重複や短い関数は網羅しない。
- 複雑さは1＋if/三項/case/for/for-of/while/catchの個数。入れ子関数を除外。論理演算子等を数えないため正式な循環的複雑度ではなく、調査優先順位用の指標。
- JevMCP `jev_ask`（jev-1.13.0）へ静的解析結果と関連ソースを渡し、候補の安全性を判定。Jev自身がリポジトリを走査したわけではない。判定はテストの代替ではない。

## 改善候補と対応

行番号は変更前の基点コミットを指す。

| 優先 | 候補・根拠 | 対応 |
| --- | --- | --- |
| 1 | `src/videoPromptDirector/compile.ts:462` の `applyAssetBinding` は `assetBinding.ts:53` と94行の関数本体が一致 | 実施。既存exportをimportし、重複本体と不要になった定数importを削除。定数は同じadapterRoute、issueは同じvalidation/typesから解決される。追加モジュールに副作用やcompileへの循環依存はない |
| 1 | `src/videoPromptDirector/render/h3GrammarV3.ts:218` の `replaceOutsideExactText` は非公開、全参照検索が宣言1件のみ、TS6133でも検出 | 実施。未使用関数のみ削除。実際に使われるneutralize処理は維持 |
| 2 | `src/orchestrator/gate2Qc.ts:358` と `gate3Qc.ts:388` の `frameRate` 本体が一致 | 次回候補。入力の選び方は異なるので呼出側を維持し、純粋な数値変換だけを共通化する |
| 2 | compose/render/review/run/durableGateEvidence/generationAssets/artifactsに同じ7行のストリームハッシュcallback | 次回候補。外側の契約は必ずしも同一でない。I/O失敗伝播・ストリーム所有権を確認してから共通化 |
| 2 | `MediaFinalizePanel.tsx:66` と `WorktreeCleanupPanel.tsx:53` に52行の同一effect | 次回候補。フォーカス捕捉・解除の共通hook化。キーボード操作とアンマウントのアプリ側検証が必要 |
| 3 | `src/cli.ts:208` main: 2,062行/分岐指標245 | 段階分割候補。コマンドごとの引数・終了コード・承認制約を固定してから分離 |
| 3 | `src/viewer/launcher.ts:1131` handleLauncherRoute: 1,445行/193 | 段階分割候補。HTTP応答・認可・副作用順序を確認して分離 |
| 3 | `releaseReadiness.ts:181` buildReleaseReadinessReport: 455行/92、`validateProject.ts:87`: 588行/88 | 純粋な判定・診断生成の抽出候補。診断順序も契約として維持する |

その他の未使用候補にはCLI/review等のimport、schema.tsのcandidateIds、releaseReadiness.tsのh1h3Missing、複数の未使用引数がある。一律削除せず、初期化副作用・モジュール副作用・公開シグネチャを確認する。検出一覧は [unused-before.txt](2026-09-18-jev/unused-before.txt)、位置と測定値は [static.json](2026-09-18-jev/static.json) に保存。

## Jevの判定

初回の生レスポンス: [2026-09-18-jev-result.json](2026-09-18-jev-result.json)。checkの戻り値はツール実装上 `type: noul` / `noul` なので、確定的な安全性証明やテスト成功率として扱わない。

- 重複統合の肯定値 0.78、未使用関数削除 0.90。
- 大規模分割はdeferを選択（confidence 1.0）。未使用診断だけで一括削除してよい、への肯定値は0.19。
- 実差分と依存元、変更前後の138テスト結果を添えた再レビュー: 挙動維持の肯定値0.82、限定した変更範囲の肯定値0.89。

## 検証

- 変更前後: `npm test -- test/h3-director.test.ts test/video-prompt-director-p1-p4.test.ts test/video-prompt-director-p0-golden.test.ts` → 各3ファイル/138テスト成功。
- ソース差分: 2ファイル、1行追加・109行削除（純減108行）。公開シグネチャ・生成実行・Gate処理の変更なし。
- `npm run check`: 終了コード0。vendor boundary / TypeScript build / 151ファイル・2,210テスト成功。Statements 82.76%、Branches 74.58%、Functions 89.83%、Lines 85.47%で全必須閾値を達成。[検証要約](2026-09-18-jev/verification.txt)。
- `git diff --check`: 成功。
- Node v22.23.2。root package-lockはローカルmainと同一。依存は既存mainのnode_modulesをsymlinkで参照。独立したクリーンインストールの検証ではない。
- Viewer UIの変更なし。CI・実ブラウザ・動画生成は実行していない。commit/push/main統合は未実施。
