# HyperFrames Studio WebMCP

TsugiteのローカルHyperFrames Studioを、ブラウザ内のWebMCPツールで操作する任意の編集入口。依存は **0.8.24固定**。既存のmanifest・backend・Gateは維持する。

**現時点では実験的な入口。** 2026-09-10のmain側再検証で、ツール登録とプレビュー表示後にも`studio_inspect`が`no element matches handle`を返す初期化不安定を確認した。編集・保存・更新画像までの成功例もあるが、既存HTMLを常に編集できる準備条件は確立できていない。下記smokeが実環境で通るまで、制作正本の操作や実編集の安定動作を保証しない。失敗を無視した書き込みや、ツール実装の差し替えで回避しない。

## 対応版と境界

- WebMCP導入は公式 [v0.8.21](https://github.com/heygen-com/hyperframes/releases/tag/v0.8.21)。[公式ガイド](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/webmcp.mdx) の現行APIには、0.8.24以降の変更も含まれる。操作時はページが返すschemaを正本にする。
- 2026-09-10に0.8.33を実Chrome 152で調査したところ、読み取りは成功したが、書き込みcallbackが未提供の第2引数から`signal`を取り出して例外になった。native WebMCPと公式polyfillの両方で再現。公式ソースでは0.8.25〜0.8.33に同じ必須引数があり、直前の0.8.24を互換版として採用した（[0.8.33の登録コード](https://github.com/heygen-com/hyperframes/blob/v0.8.33/packages/studio/src/webmcp/useStudioAgentTools.ts)、[0.8.24](https://github.com/heygen-com/hyperframes/blob/v0.8.24/packages/studio/src/webmcp/useStudioAgentTools.ts)）。上流forkや登録APIの差し替えは行わない。
- **0.8.24の書き込み対象は現在の選択**。`studio_select`の後、別呼び出しの`studio_inspect`で`isCurrentSelection`を確認してから書く。書き込みに`handle`は渡さない。選択と書き込みの間に人や別エージェントが操作しない単独編集セッションで使う。複数ファイルに同じIDがある入れ子compositionは今回の検証対象外。
- 現行ガイドの`refused / dispatched / saved / verified` receiptと明示handle書き込みは、この固定版の契約ではない。`ok: true`だけで保存完了とせず、実ファイル・inspect・再読み込み・画像を照合する。
- HeyGen hosted cloud MCP（チャットから生成・renderするサービス）への接続設定は不要。ページ内ツールはStudioを開いたブラウザの機能。stdio/HTTP MCP serverのURLとして登録するものではない。
- `run` / `render`、課金、Gate承認、公開はこの入口で許可されない。Studioのツール登録とホスト側のツール実行許可も別。

## 起動

Tsugite repoで依存を導入し、編集用compositionのコピーを開く。

```sh
npm ci
npm run hyperframes:studio -- /absolute/path/to/authoring-copy --foreground --no-open --no-proxy
```

表示されたStudio URLをWebMCP対応ブラウザで開く。`--port 3097`等でポートを指定できる。終了はそのターミナルでCtrl+C。専用npmコマンドはrepo内の固定CLIだけを起動し、グローバルCLIや`npx`の自動ダウンロードに依存しない。`--help`で公式previewオプションを確認できる。`--no-proxy`はpreview用の自動メディア変換を無効にする。

ChromeのローカルWebMCPは [公式手順](https://developer.chrome.com/docs/ai/webmcp) の`chrome://flags/#enable-webmcp-testing`を有効にして再起動する。検証用の独立Chromeでは`--enable-features=WebMCP`を使用した。ブラウザの許可UIやブリッジ対応状況はホストごとに確認し、ツールが見えなければ未接続と扱う。

**制作runの`index.html`を直接編集しない。** `backends/hyperframes/render.mjs`はrender時にmanifestからHTMLとローカルtimelineを再生成する。Studioによる編集はmanifestへ自動反映されず、次のrenderで消える。制作のauthoring copyはdurable projects home内に置き、承認済みの変更をmanifestやcomposition生成元へ戻し、既存のreview・Gateを経て反映する。Studioで保存したHTMLの直接renderや承認済み成果物の置換は、この接続手順に含まれない。

## 発見と最小編集

Studioのトップページコンテキストで`document.modelContext`を使う。登録は非同期なので、`toolchange`後または有期限の待機で12ツールの登録を確認する。登録後も`studio_look`の要素が返るまでcompositionの読み込みを待つ。

初回はStudioが`data-hf-id`をHTMLへ保存するため、開くだけでもauthoring copyに変更が生じうる。プレビューが表示され、実DOMにIDが反映されてから`look`と`inspect`を別々に呼ぶ。登録確認のポーリング中にinspectを繰り返さない。`hyperframes-player`のプレビューiframeはShadow DOM内にあり、通常の`document.querySelector("iframe")`では取得できない。handle不一致が残る場合は保存されたIDを確認し、一度再読み込みして`look`から取り直す。それでも不一致なら書き込まず原因を調べる。IDの事前加工は本手順の必須条件にしない。

```javascript
const mc = document.modelContext;
const tools = await mc.getTools();
console.table(tools.map(({ name, inputSchema }) => ({ name, inputSchema })));

async function call(name, input = {}) {
  const tool = (await mc.getTools()).find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool unavailable: ${name}`);
  const result = JSON.parse(await mc.executeTool(tool, JSON.stringify(input)));
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
const scene = await call("studio_look");
// sceneのlabel/handleを見て対象を選び、値をコピーする。
```

以下は対象と変更内容が確認できた後、**一つずつ別呼び出し**で行う。`handle`を推測したりCSS selectorで代用しない。

```javascript
await call("studio_select", { handle });
const target = await call("studio_inspect", { handle });
// isCurrentSelection、can.editText、textFieldsを確認する。
await call("studio_set_text", { text: "変更後の文字" });
await call("studio_inspect", { handle });
// 別のstyle編集前にも選択・can.editStylesを確認する。
await call("studio_set_style", { styles: { color: "#67e8f9" } });
const frame = await call("studio_frame", { time: 2, settleMs: 1000 });
// frame.urlのPNGを実際に開く。返されたURLだけでは画像確認にならない。
```

`executeTool`の引数は**発見したRegisteredToolとJSON文字列**。`(name, object)`ではない。ホスト専用WebMCPツールを使う場合は、そのホストのschemaに従う。

| 範囲 | ツール |
| --- | --- |
| 観察 | `studio_look`, `studio_inspect`, `studio_frame` |
| 選択・時刻 | `studio_select`, `studio_seek` |
| 文字・見た目 | `studio_set_text`, `studio_set_style`, `studio_transform` |
| motion | `studio_add_animation`, `studio_update_animation`, `studio_add_keyframe`, `studio_delete_animation` |

styleの`rejected`やツールの拒否理由を確認し、保存停止・外部変更競合のbannerを解消するまで再送しない。motionは`studio_inspect`の`animationEditingBlocked`と実compositionのGSAP対応を確認する。TsugiteのローカルGSAP互換runtimeを公式GSAPの全編集対応とみなさない。

0.8.24の画像は保存直後に古いrender cacheから返る場合がある。`settleMs`を1000〜5000msに増やして**画像取得だけ**を再試行し、実際の文字・色を確認してからreloadする。編集を再送しない。ファイル保存・PNG形式が正常でも、画像の内容が古ければ検証失敗とする。

## 再現検証

macOSの例（既存Chromeを使い、ブラウザをダウンロードしない）:

```sh
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run hyperframes:studio:verify
```

`backends/hyperframes/verify-studio.mjs`は`dist/verification/hyperframes-webmcp/<timestamp>/webmcp-<id>`に、既存backendのHTML生成関数から5秒の字幕fixtureを作る。fixture専用のID加工はしない。自分のStudio・新規Chromeプロファイルを起動し、ツール登録とShadow DOM内の実プレビューの準備完了を待つ。その後native WebMCPの発見 → inspect → select → text/style編集 → 実ファイルhash/内容 → seek → PNG取得 → reload後のreadbackを検査する。PNGは固定fixtureの寸法と編集後の水色画素100以上を確認し、1000/3000/5000msの待機で最大3回の画像取得までに更新されなければ失敗する。試行画像と画素数も残し、古い画像の成功判定を防ぐ。実ツールを差し替えず、API mockや直接の編集handler呼び出しを使わない。自分で起動したprocessを終了し、report.json、server.log、frame.png、studio.pngを残す。成功はexit 0、失敗はexit 1と理由。外部通信を遮断する検証ではなく、Studio自身のフォント解決等は発生しうる。

これはStudio接続の独立smokeで、`verify-tsugite`のDoctor/validate fixtureとは別。動画render・生成・Gate変更・既存制作データの編集は行わない。motion authoring、複数composition、ホストの許可UI、動画完成品質はこの検証で成功扱いにしない。依存更新時はこのsmokeと関連テスト、`npm run check`を再実行する。

2026-09-10の検証結果は[実機検証記録](reports/hyperframes-studio-webmcp-2026-09-10.md)を参照。
