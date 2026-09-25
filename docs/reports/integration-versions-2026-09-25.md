# 動画連携の更新確認（2026-09-25）

対象はTsugiteリポジトリで版を固定する動画制作のCLI・backend・Skill。npmの公開版を当日照合し、制作runや外部アカウントは操作していない。

| 連携 | 旧版 | 更新版 | 確認 |
| --- | --- | --- | --- |
| [HyperFrames](https://www.npmjs.com/package/hyperframes) | 0.8.24 | 0.8.75 | CLI ZIP置換を新バンドルのハッシュに合わせた。Chrome 153 / native WebMCPで隔離fixtureの2回の文字・色編集、保存、reload、PNG画素とプロセス停止を確認 |
| [Remotion](https://www.npmjs.com/package/remotion) | 4.0.512 | 4.0.528 | 4パッケージを同版に揃え、関連テストとroot checkが成功 |
| [PixVerse CLI](https://www.npmjs.com/package/pixverse) | 1.4.4 | 1.4.6 | 実CLIのversion / ローカルcapabilities / 関連テストを確認。Canvasのremote操作と生成は未実施 |
| [Editframe](https://www.npmjs.com/package/@editframe/cli) | 0.59.47 | 0.60.11 | cli/elements/vite-pluginを同版に揃え、Viteを8.3.1へ更新。隔離素材の実レンダリングテストが成功 |
| [Hypit](https://github.com/hypit-ai/hypit/releases/tag/v0.2.13) | 0.1.8 | 0.2.13 | 公式Skillをtag `v0.2.13` の73ファイルに更新。公式例のコンパイル、`check`、`plan` が成功。本番Runtime起動とBuildは未実施 |

必須の `npm run check` は158 files / 2359 tests成功、coverageはstatements 82.71%、branches 74.59%、functions 89.76%、lines 85.41%。rootと3つの隔離runtimeの `npm ci` は成功した。root、PixVerse、Editframeのnpm監査は0件。Hypitは上流が`tsx@4.21.0`を固定するため、開発サーバーをWindowsで動かす場合の低深刻度`esbuild@0.27.7`警告が1件残る。

Mac全体に置かれたCLIも読み取り専用で確認した。[Kling CLI](https://www.npmjs.com/package/@klingai/cli-global) は導入済み0.1.1、npm最新版0.2.0で、最新版の基本生成コマンド引数を隔離導入で確認した。[MiniMax CLI](https://www.npmjs.com/package/mmx-cli) は導入済み1.0.25、公開版1.0.26。MiniMax直結はcatalog上は `available-to-add` であり本番接続ではない。これらのグローバル導入版は別案件にも影響するため、Mac全体を更新対象とするかの回答待ちで変更していない。[TopView公式Skill](https://github.com/topviewai/skill) は現在の公開構成が従来のローカル `topview-skill` と異なり、一対一の版置換として扱えない。

指定された [session-story](https://github.com/heygen-com/hyperframes-community-skills/tree/master/skills/session-story) は community repository の `ba7a0bb6d3567d124c51f6074625043bfe0b32eb` を確認した。Tsugiteには未導入の独立した制作Skillで、内部で `hyperframes@0.8.71` を固定し、利用時にローカル会話履歴を読む。隔離コピーで同梱のサンプル生成とスケジュール作成を実行し、欠けているscore.wavに検査用の短い無音ファイルを置いてHyperFrames 0.8.75の `check` が成功した。WebGL・画面端・無音ファイルの長さに関する警告は残り、実音源と完成レンダリングの互換性は未確認。今回の既存連携の版更新には含めない。導入する場合は履歴参照とTsugiteの制作Gateを両立する専用手順が必要。

履歴の検証レポートと制作済みprojectは変更していない。今回の更新は隔離worktree上のローカル検証であり、push・PR・公開・課金・外部生成は行っていない。
