---
name: after-effects-editing
description: After Effectsでコンポジション、文字レイヤー、キーフレームを編集するときに使う。Tsugite案件の任意の外部編集、または独立したローカル編集を、公式AppleScriptと画面確認で進める。After Effectsを指定しない一般制作やコード保守では発動しない。
---

# After Effects Editing

日本語で簡潔に進める。既存の依頼・好み・承認を引き継ぎ、編集方針の確認を繰り返さない。

## 入口と承認

- After Effectsが指定されたときの任意の編集入口。基本セットアップの必須依存にしない。
- Tsugite案件では [制作Skill](../tsugite/SKILL.md) を読み、対象の `project.yaml`、現在のrun、承認済みreview、素材・出力を一致させる。実編集はCoordinatorだけが対象編集への承認後に行う。Planner / Reviewer / Output QAは読み取り・提案まで。
- pipeline中の案件は現在のGateと承認済み計画の範囲を守る。After Effectsを経由してGate前の生成・組み立て・書き出しを代行しない。承認済み内容を変えるならreviewと該当Gateを取り直す。
- `edit.backend: after-effects` は未実装。After Effectsはエージェントが操作する外部エディタであり、`pipeline render` のbackendではない。
- 明示的な独立編集・接続テストには架空の `project.yaml` やGate stateを作らない。対象のコピーに限定し、その結果をTsugiteのGate承認・制作完了として報告しない。
- 書き出し、既存成果物の上書き、外部共有、生成機能の課金は編集指示だけから推定しない。

## 接続と対象の確定

1. [接続手順](../../../docs/after-effects.md) に従う。実行経路は macOS の公式 `DoScriptFile` と、このSkillの `scripts/ae-local-helper.mjs` に限定する。第三者MCP、汎用 `DoScript` 評価、CEPパネルの自動導入は使わない。
2. `probe` はアプリ検出だけ。接続ではない。このMacのAE 2026プロセス名は `After Effects` で、helperは 2026.app の path で照合する。
3. 接続は、固定JSXが専用 `result.json` に書いた内容をNodeが読めたときだけ。`get name` や空画面の観測だけでは足りない。
4. Preferences の **Allow Scripts to Write Files and Access Network** がオンであること。`result.json` と `.aep` 保存に必要。全スクリプトに効く。承認はこのMacの今回の設定変更に限る。同じ説明をこの環境で再質問しない。別の host / ユーザーではその環境の既存承認を確認し、無いときだけ説明する。毎回質問するルールにはしない。オフや未初期化では DoScriptFile が timeout し得る。そのときは再送しない。
5. 開いている無関係な案件を保存・破棄・切替しない。AEの起動は人間の明示承認があるときだけ。
6. 初回編集は保存済みコピー。Tsugite案件の `.aep` と記録はdurable projects homeの対象案件内 `after-effects/` に置く。
7. helper成功、`result.json`、実機の文字／キー読み戻し、保存ファイルの存在を別々に判断する。

## 編集の判断

[演出ガイド](references/editorial-guide.md) を必要な範囲で読む。helperが実装している操作は **文字レイヤー追加と Position / Opacity キーだけ**。エフェクト、マスク、カメラ、書き出しは未対応なので案内しない。

## 操作とフォールバック

1. `probe` → 起動済みなら `inspect`。空の隔離案件だけ `fixture`（`/tmp/tsugite-ae-`）。実案件は `add-title`（`--workdir` は案件の `after-effects/`、`--expected-project` 完全一致、dirty拒否、新規 `--output`）。
2. 比較対象はコンポジション寸法・尺、レイヤー名、`TextDocument.value.text`、Position/Opacityのkey timeとvalue。stdoutだけでは完了にしない。
3. 不一致・タイムアウト・`result.json` 欠落では止める。再送しない。JSXは消さない。
4. 無関係な `.aep` が開いていれば編集しない。
5. 書き込み拒否を観測したら `write_denied`。未承認で設定を変えない。**この環境の**既存書き込み許可承認があれば再利用する。他環境の承認は流用しない。

## 保存とQA

- `add-title` は source を変えず、`--workdir` 内の新規 output だけを作る。symlink と既存ファイルは拒否する。
- 実機では inspect / fixture / 日本語 add-title の `result.json` 読み戻しと別名保存まで確認済み。この隔離 fixture では画面の日本語タイトル、先頭の透明、再生時の表示と位置移動、停止も親CUAが観測済み。書き出しは未対応。Gate 3承認済み動画を変えた新版は未承認の別成果物。

## 参照

- Adobe Scripting Guide では macOS の DoScript 戻り値は `app.exitCode`。結果は `result.json` 経由。AE 2026 26.2.1 で書き込み許可 ON 後に inspect/fixture/add-title を実機確認。
- 第三者MCPは任意eval・CEP導入を含むため採用しない。
