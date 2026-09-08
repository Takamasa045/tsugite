# After Effectsを任意の外部エディタとして使う

`$after-effects-editing`（Claude Codeでは `/after-effects-editing`）でコンポジション、文字レイヤー、Position / Opacity キーと実機確認を行う。正本は [After Effects編集Skill](../.agents/skills/after-effects-editing/SKILL.md)、演出の選び方は [編集ガイド](../.agents/skills/after-effects-editing/references/editorial-guide.md)。

After Effectsは任意のローカル連携。通常のTsugiteセットアップ、doctor、Remotion / HyperFramesには不要。エージェント向け編集入口であり、`project.yaml` の新backendや `pipeline render` の実装ではない。

## 実装済み / 実機確認 / 未対応

|区分|内容|
|---|---|
|実装済み（helper コマンド）|`probe`、`inspect`、隔離 `fixture`、`add-title`。結果は `result.json`。`openInViewer` は helper コマンドではない|
|実機・読み戻し（2026-09-08、AE 2026 26.2.1）|書き込み許可 ON 後、DoScriptFile で inspect → fixture → 日本語 add-title → 別名保存 → `result.json` と source hash 不変まで成立|
|実機・見た目／再生（この隔離 fixture のみ）|親CUAが画面で日本語「継手のテスト」と fixture 文字、先頭では透明、再生中の表示と位置移動、停止を観測。赤い更新無効バナーは後の画面では消えていた。消えた原因は未確定。音声・書き出し・他環境は未確認|
|未対応|エフェクト、マスク、3Dカメラ、aerender、書き出し、第三者MCP、任意 ExtendScript、`edit.backend: after-effects`|

成功根拠: `result.json` の file/saved/request_id/文字/キーと、保存済み `.aep` の存在。`probe`、osascript の数値 exit、stdout JSON、ファイル存在だけでは足りない。

固定版は **After Effects 2026 26.2.1**。2024.app はない。helper は 2026 のみ。

## 必要なAE設定

Preferences > Scripting & Expressions の **Allow Scripts to Write Files and Access Network**（日本語: スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可）がオンであること。helper の `result.json` 書き込みと `.aep` 保存に使う。全 AE スクリプトに適用される。

承認はこのMacの今回の設定変更への回答に限る。同じ説明をこの環境で再質問しない。別の host / ユーザー / 再インストールでは、その環境の既存承認を確認する。毎回必ず質問するルールにはしない。未承認の環境では設定を変えない。OS の Automation / デバッガ設定は変えない。

未初期化やこの設定がオフだと DoScriptFile は timeout し `result.json` が無いことがある。その場合は再送しない。

## 実行経路

helper は mode `0700` の一意 request dir に固定 `command.jsx` と新規 `result.json` を置く。JSXが結果を書き、Nodeがそのファイルだけを読む。AppleScript の戻り値は `app.exitCode` であり、stdout JSON は使わない。`override` は使わない。

第三者MCPは不採用。aerender はこのSkillの経路ではない。

## ローカルセットアップ

1. 既存のAE案件を確認する。未保存作業を保存・破棄しない。
2. 上記のスクリプト書き込み許可がオンか確認する。この環境に既存承認があれば再利用する。無ければ説明して承認を取る。他環境の承認を流用しない。
3. helperはrepo内Skillスクリプト。coreの `package.json` には加えない。

```sh
node .agents/skills/after-effects-editing/scripts/ae-local-helper.mjs probe --json
node .agents/skills/after-effects-editing/scripts/ae-local-helper.mjs inspect --json
node .agents/skills/after-effects-editing/scripts/ae-local-helper.mjs fixture --workdir /tmp/tsugite-ae-fixture --json
WORKDIR="/absolute/path/to/projects/job/after-effects"
node .agents/skills/after-effects-editing/scripts/ae-local-helper.mjs add-title \
  --workdir "$WORKDIR" \
  --expected-project "$WORKDIR/source.aep" \
  --output "$WORKDIR/titled.aep" \
  --comp Main \
  --title "Tsugite Title" \
  --json
```

4. `fixture` の `--workdir` は `/tmp/tsugite-ae-` のみ。`add-title` は明示 `--workdir` の配下だけ。
5. プロセス名はこのMacでは `After Effects`。helper は 2026.app の path で照合する。
6. 無関係な `.aep` が開いていれば inspect まで。

## Tsugite案件での利用

対象はdurableな案件フォルダの `after-effects/`。source は変えず新規 output に別名保存する。Gate迂回や manifest 手編集による完成扱いはしない。

## 実測ログ

2026-09-08、macOS、AE 2026 26.2.1。スクリプト書き込み許可 ON 後。

|操作|結果|
|---|---|
|inspect（空の名称未設定）|成功。file 空、dirty false、numItems 0、request_id 照合|
|fixture `/tmp/tsugite-ae-live-20260908-414b2d/`|成功。1920x1080 30fps 5s、comp `tsugite-ae-fixture`。AEP 73340 bytes、sha256 `38a57ee07b08fe005b32e3f576797b615cb0b45e89aed6b8179870d8ac694d64`|
|add-title タイトル「継手のテスト」|成功。output `titled.aep` 95914 bytes、sha256 `47a86dee452b87fe3b35718bb3c07b5df913b560f91ce754c656550a3c0782fd`。Position 0s/1s、Opacity 0s=0 / 0.5s=100。source hash 不変|
|診断 JSX（helper コマンド外）で `openInViewer` と `time = 0.5`|DoScriptFile 成功。helper の `COMMANDS` には含めない|
|見た目／再生（この隔離 `titled.aep` のみ、親CUA）|バナー無しの画面で日本語タイトルと fixture 文字を確認。先頭 0:00:00:00 はタイトル不可視・Opacity 0%・Position 960,194.4。再生で 0:00:00:09 に現れ 0:00:02:25 で完全表示と位置移動。停止後 0:00:01:03 で Opacity 100%・Position 960,237.6。保存・export なし。バナーが消えた原因は未確定|
|書き出し・エフェクト|未対応|

証拠: `/tmp/tsugite-ae-grok-approved-evidence/`。AEP は `/tmp/tsugite-ae-live-20260908-414b2d/` に残置。

許可 ON 前の DoScript timeout は `/tmp/tsugite-ae-grok-ready-evidence/`。接続失敗と画面到達は別。

## 出典

- [Adobe: Scripts](https://helpx.adobe.com/after-effects/using/scripts.html)
- [After Effects Scripting Guide: Application](https://ae-scripting.docsforadobe.dev/general/application/)（`app.exitCode`）
- [Adobe: Automated rendering](https://helpx.adobe.com/after-effects/using/automated-rendering-network-rendering.html)（書き出し参考。実行経路ではない）
