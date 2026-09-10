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
