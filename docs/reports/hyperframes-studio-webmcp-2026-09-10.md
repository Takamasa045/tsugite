# Studio WebMCP接続検証（2026-09-10）

## 結果

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

初回のsmokeではsource側の要素発見後にpreview側のhandleがまだ解決できなかった。StudioがsourceへIDを割り当てる初回処理を考慮し、ユニークなfixture名・専用server・初回reload・inspect準備完了の確認を追加した。変更後のfresh fixtureで成功。

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
