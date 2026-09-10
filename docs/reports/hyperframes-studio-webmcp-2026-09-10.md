# Studio WebMCP接続検証（2026-09-10）

## 現在の判定

パッチ済み HyperFrames **0.8.24**、macOS native Chrome **152** で、通常の `renderIndexHtml` authoring copy に対する初回 inspect → 文字/色編集 → 保存 → reload → 再 inspect/select → 別色の再編集 → 更新 PNG 2枚が、tracked smoke 3回連続で成功した。lifecycle（iframe 差し替えが `instanceof` 失敗を起こす過程）は未証明。motion、他ホスト、他OS、複数 composition は未検証で、入口は実験的扱いを続ける。制作正本の直接編集はしない。

ローカル `npm run check` は 135 files / **2070 tests passed**。root `security:audit` は production 0 / 全依存 0。download-site 必須 `--omit=dev` と全依存 `--audit-level=moderate` はいずれも 0（js-yaml 4.3.2、fflate 0.7.5）。本文はローカル検証を記録する。GitHub CI の現状は [PR #160 Checks](https://github.com/Takamasa045/tsugite/pull/160/checks) を参照。

証拠: `dist/verification/hyperframes-webmcp-fixes/2026-09-10T02-30-52-088Z/`、`2026-09-10T02-31-04-760Z/`、`2026-09-10T02-31-15-913Z/`。

パッチ前の初回/reload inspect 失敗と個別成功は下記の履歴。入口全体の無条件保証ではない。

## 個別runの成功記録

HyperFrames **0.8.24**、macOS、Chrome **152.0.7977.83**、Node **22.23.2**、npm **12.0.2**で成功。新規ブラウザプロファイルに`--enable-features=WebMCP`を渡し、Studio読み込み前からnative `document.modelContext`が存在することを観測した。ツール登録・実行callbackの差し替えなし。

- 12ツールの登録・schemaを取得。
- Tsugiteの実HTML生成関数による5秒字幕fixtureをinspect/select。
- `WebMCP before`を`WebMCP verified`へ変更し、文字色を`#67e8f9`へ変更。
- ファイル内容とsha256変更、inspectの文字・computed colorを照合。
- playhead 2秒を読み戻し、`studio_frame`のURLから実PNGを取得。画像を目視し、黒背景・下部の水色字幕を確認。
- Studioをreloadし、同じ文字・色が再取得できることを確認。再読み込み後のStudio画面も目視。
- smokeが起動したStudio・Chromeは終了。既存制作project、manifest、Gateは未変更。

## 再現コマンド・証拠

```sh
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run hyperframes:studio:verify
npm test -- test/hyperframes-document.test.ts test/hyperframes-timeline.test.ts test/hyperframes-catalog.test.ts test/hyperframes-media-adapter.test.ts test/render.test.ts
npm run check
```

ローカル証拠（ignored、Gitへ成果物を混ぜない）:

- `dist/verification/hyperframes-webmcp/2026-09-10T00-15-58-775Z/report.json`（ok: true）
- 同ディレクトリの`frame.png`、`studio.png`、`server.log`、`webmcp-1788999358776/index.html`
- `dist/verification/hyperframes-webmcp/focused.log`: 5 files / **67 tests passed**
- `dist/verification/hyperframes-webmcp/check-0.8.24.log`: vendor boundary / build成功、133 files / **2058 tests passed**
- root coverage: statements **82.85%**、branches **74.63%**、functions **89.74%**、lines **85.54%**。設定閾値をすべて満たした。

fixture source sha256（StudioによるID割当後をbeforeとする）:

```text
before 58b214406439620a35cf6109c611ba451fe9106f218e2d8732b8ac206d4f1748
after  0fee20304383583205929f35d7e6430e6ad8ecc054632c80f63d72402dec8f30
```

## 失敗からの修正と採用理由

0.8.33は発見・read/select/seek/frameが成立したが、set_textはnative APIで`UnknownError`、公式polyfillで`Cannot destructure property 'signal' of 'undefined'`を返した。`executeTool`へAbortSignalを明示してもnativeでは失敗。上流登録コードの`execute: (input, { signal })`は0.8.25〜0.8.33に存在する。0.8.24にはこの必須引数がなく、実編集が成立したので互換版として固定した。

初回のsmokeではsource側の要素発見後にpreview側のhandleが解決できなかった。専用server・初回reload等を試して成功例を得たが、後続検証では再発した。現在のsmokeはツール登録とShadow DOM内の実プレビューを待つ方式であり、初回reloadやinspectのポーリングを解決策として採用していない。

0.8.24の書き込みは共有選択を使う。単独セッションでselectとinspectを別呼び出しにし、選択一致を確認する。[接続手順](../hyperframes-studio-webmcp.md)に現行APIとの違い、コピー使用、manifestへの自動反映なしを記載した。

## 未検証

motion authoring、複数/入れ子composition、他OS・他ブラウザ、ホストのWebMCP許可UI、pipeline render・生成・Gate遷移、動画品質、CI。上記2058テストはローカルroot checkであり、Viewer/desktopの実機検証やproduction releaseを意味しない。

## main統合時の追加検証

main側の初回smoke（`2026-09-10T00-24-40-798Z`）は保存/reloadが成功したが、PNGの目視で編集前の白い`WebMCP before`を検出した。このrunの旧`report.json`の`ok: true`は**画像更新の証明として無効**。証拠はそのまま残す。PNG形式検査だけでは古いrender cacheを見逃していたため、公式`settleMs`を用いて画像取得のみを有期限で再試行し、編集後の水色画素の存在を確認するようsmokeを修正した。即時reloadでも古いpreviewが返る例を確認したので、画像更新確認後にreload/readbackする。

保存済みの旧画像は水色画素0、新しい画像は1566画素で区別できる。修正後のfresh fixture `2026-09-10T00-28-21-804Z`は成功。以降はPNG寸法1920×1080と水色画素100以上を必須にし、1000/3000/5000msで最大3回取得しても更新されなければ失敗する。閾値はこの黒背景＋字幕fixture専用で、一般の映像QCへ流用しない。

初期化の再実行で、プレビュー準備前のinspectをポーリングする方法も安定しなかった。ID事前付与だけでは解消せず、通常DOMからのiframe探索もShadow DOM内のプレビューを見逃した。最終的にツール登録と実プレビューDOMの準備を待ち、look/inspectを別callで実行する方式へ変更。追加のID加工をせず、既存HTML生成関数の出力そのままを使った`2026-09-10T00-42-28-347Z`で編集・保存・更新画像・reload readbackが成功した。初期化問題をID加工だけで解決したとは扱わない。

### 最終的なmain側の制約

上記の成功をmain側で再実行した`2026-09-10T00-44-34-413Z`は、プレビューDOMとツール登録の確認後、最初の`studio_inspect`で`no element matches handle hf:hf-ddr2`となり失敗した。公式`settleMs`による初回待機を足した別の検証も同じ拒否を返したため、その追加待機を解決策として採用していない。既存生成HTMLに対する安定した初期化条件は未確立。成功例だけから実用上の安定性を主張しない。

main側の検証記録は`dist/verification/hyperframes-webmcp/integration/verified-smoke.log`と当該runの`report.json`に残す。root checkの2058 tests成功はこのブラウザ失敗を代替しない。現在の入口は実験的扱いで、正式な実編集運用の完了判断は保留する。動画生成・render・Gate変更は未実施。

## GitHub反映前の精査

- READMEと本記録の冒頭に残っていた包括的な「編集可能・成功」という表現を修正し、個別成功と全体の未達を区別した。
- `2026-09-10T00-58-52-328Z`は編集・保存・更新PNG取得まで成功したが、reload後のinspectが失敗した。失敗時にもプレビューDOMには同じ`data-hf-id=hf-ddr2`と更新後の文字・色があった。問題は初回ID生成だけでは説明できない。上流の`studio_inspect`はプレビュー参照からDOMを解決するため、参照先/登録寿命の不一致が調査候補だが、原因確定や上流修正は未実施。
- smokeに失敗phase・プレビューDOMの証拠・失敗スクリーンショットを追加した。書き込み前の編集可否と文字readbackも確認する。ツール/IDの差し替えや失敗した編集の再送はしない。
- 旧cleanupは親processのcloseだけで終了とみなし、子孫を残す可能性があった。既存のテスト済みprocess-tree停止処理を再利用し、子孫の生存と停止結果も記録する。
- GitHubと同じ依存監査で、既存Hono・Sharp・Vitest依存の脆弱性が見つかった。Hono 4.13.7、Sharp 0.35.4、Vitest/coverage 4.1.11へ互換範囲内で更新。HyperFramesは0.8.24固定を維持した。
- production依存監査は0件。全依存監査の`adm-zip`は、npm override `adm-zip: npm:fflate@0.8.3` で実体を fflate 0.8.3 に差し替えた。lockfileは alias の resolved URL を記録し、`node_modules/adm-zip/package.json` の `name` は `fflate`。HyperFrames 公開 `package.json` の `adm-zip` 依存宣言は消さない。ZIP操作の実行は `backends/hyperframes/in-memory-zip`（fflate 0.8.3）へ CLI import をパッチする。監査の無効化・例外化はしない。

追加検証ログは`dist/verification/hyperframes-webmcp/review/`の`focused.log`、`check.log`、`smoke-final.log`、`security-audit-final.log`。ignored evidenceはGitHub配布物に含めない。

最新smoke `2026-09-10T01-02-57-318Z`は`phase: initial-read`で失敗したが、failure DOMには対象IDがあり、`element instanceof doc.defaultView.HTMLElement`はfalseだった。上流0.8.24の`asHtmlElement`（配信バンドルでは `ZD`）はこの判定を必須とするため、IDがあるだけではinspect成功にならない。これは観測された症状である。iframe の default execution context が複数回作られた記録はあるが、それだけで失敗原因と断定しない。後続のベースライン1回は initial inspect に成功しており、間欠の失敗そのものはその1回では再現していない。採用した修正は、配信 `/assets/index-Bq3M0sjr.js` の `ZD` を HTML 名前空間・同一 document・接続中ノードの受け入れへ置き換えること。単体テストは合成オブジェクトでガード契約（constructor mismatch / SVG / 切り離し）を見るものであり、実 DOM realm の失敗再現ではない。実失敗の根拠は過去の initial/reload smoke である。終了記録は`cleanup: { stopped: true, alive: false }`で、今回追加した診断と子孫終了確認は動作した。

最終の依存固定後の検証は、対象6ファイル **72 tests passed**、`npm run check`は133ファイル **2058 tests passed**、vendor/build成功。coverageはstatements 82.85%、branches 74.62%、functions 89.74%、lines 85.53%。ログは`review/focused-locked.log`と`review/check-locked.log`。最終smoke `2026-09-10T01-08-23-135Z`は編集・保存・更新画像取得後のreload-readで失敗、process-treeの停止は確認できた。`review/security-audit-locked.log`にはproduction 0件と全依存のadm-zip指摘を記録。これらは当時のローカル検証であり、当時の GitHub CI 成功とは区別する。履歴の GitHub 失敗は [run 34424347067](https://github.com/Takamasa045/tsugite/actions/runs/34424347067)（head `b1d12f1`、root 全依存 adm-zip と download-site prod audit）。

## 配信パッチ後のローカル再検証

Chrome が読む `/assets/index-Bq3M0sjr.js` の `ZD` を HTML 名前空間・同一 document・`isConnected` に差し替え、tracked `npm run hyperframes:studio:verify` を3回新規実行した。いずれも `ok: true`、cleanup `{stopped:true, alive:false}`。1巡目は `WebMCP verified` / `#67e8f9`（水色 1566画素、橙 0）、reload 後の2巡目は `WebMCP cycle two` / `#f97316`（橙 1652画素、水色 0）。配信 JS の sha256 はパッチ後 `1a3f3682468569d16b856852e3985b1abf7c18b3f0d7c61e3eb4df22595be0ef`。この3回はパッチ後の成功であり、パッチ前の間欠失敗の再現試行ではない。本文はローカル検証を記録する。GitHub CI の現状は [PR #160 Checks](https://github.com/Takamasa045/tsugite/pull/160/checks) を参照。
