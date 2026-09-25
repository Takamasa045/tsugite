# 動画連携の更新確認（2026-09-25）

対象はTsugiteリポジトリで版を固定する動画制作のCLI・backend・Skillと、Mac全体で使う動画・音声関連のSkill・CLI。公開版を当日照合し、制作runや外部アカウントは操作していない。

| 連携 | 旧版 | 更新版 | 確認 |
| --- | --- | --- | --- |
| [HyperFrames](https://www.npmjs.com/package/hyperframes) | 0.8.24 | 0.8.75 | CLI ZIP置換を新バンドルのハッシュに合わせた。Chrome 153 / native WebMCPで隔離fixtureの2回の文字・色編集、保存、reload、PNG画素とプロセス停止を確認 |
| [Remotion](https://www.npmjs.com/package/remotion) | 4.0.512 | 4.0.528 | 4パッケージを同版に揃え、関連テストとroot checkが成功 |
| [PixVerse CLI](https://www.npmjs.com/package/pixverse) | 1.4.4 | 1.4.6 | 実CLIのversion / ローカルcapabilities / 関連テストを確認。Canvasのremote操作と生成は未実施 |
| [Editframe](https://www.npmjs.com/package/@editframe/cli) | 0.59.47 | 0.60.11 | cli/elements/vite-pluginを同版に揃え、Viteを8.3.1へ更新。隔離素材の実レンダリングテストが成功 |
| [Hypit](https://github.com/hypit-ai/hypit/releases/tag/v0.2.13) | 0.1.8 | 0.2.13 | 公式Skillをtag `v0.2.13` の73ファイルに更新。公式例のコンパイル、`check`、`plan` が成功。本番Runtime起動とBuildは未実施 |

必須の `npm run check` は158 files / 2359 tests成功、coverageはstatements 82.71%、branches 74.59%、functions 89.76%、lines 85.41%。FFmpegなどのグローバル更新後にも同じ全体チェックが成功した。rootと3つの隔離runtimeの `npm ci` は成功した。root、PixVerse、Editframeのnpm監査は0件。Hypitは上流が`tsx@4.21.0`を固定するため、開発サーバーをWindowsで動かす場合の低深刻度`esbuild@0.27.7`警告が1件残る。

## Mac全体の更新

| CLI | 旧版 → 更新版 | 確認・配置 |
| --- | --- | --- |
| [PixVerse](https://www.npmjs.com/package/pixverse) | 1.4.5 → 1.4.6 | nvmとHermesの2つのNode導入先を更新し、両方で `--version` を確認 |
| [Kling](https://www.npmjs.com/package/@klingai/cli-global) | 0.1.1 → 0.2.0 | HermesのCLIを更新。`--version` と生成コマンドのローカルhelpを確認。サーバー宣言と認証は未確認 |
| [MiniMax mmx](https://www.npmjs.com/package/mmx-cli) | 1.0.25 → 1.0.26 | nvmのCLIを更新。`--version` と `video generate --help` を確認。Tsugiteの直結はcatalog上 `available-to-add` のまま |
| [ElevenLabs](https://www.npmjs.com/package/@elevenlabs/cli) | 1.1.0 → 1.3.2 | nvmのCLIを更新。`--version` とローカルhelpを確認 |
| [FFmpeg](https://formulae.brew.sh/formula/ffmpeg) | 8.1.2 → 9.0.2 | Homebrewで更新。`ffprobe`、H.264/AACの1秒隔離エンコード、関連71テスト成功。Homebrewが必要な依存とfreerdp・ocrmypdfも更新 |
| [yt-dlp](https://pypi.org/project/yt-dlp/) | 2026.03.03 → 2026.08.19 | pipxへ最新版を隔離導入し、通常PATHの `yt-dlp --version` を確認。Homebrew Pythonに残る旧版実行ファイルは通常PATHでは後順位 |

[HyperFrames公式Skill](https://github.com/heygen-com/hyperframes/tree/main/skills) は循環していた参照リンクを修復し、現在公開される21件を `~/.agents/skills` に導入。`hyperframes skills check --json --dir=~/.agents/skills` は21件current、missing/outdated/removed各0件。公開終了した8件の壊れたリンクは退避し、lockfileから削除した。`~/.claude/skills` と `~/.codex/skills` は同じ共有ディレクトリを参照する。公式source commitは `278bc712d7b40d03cd3bfa6a705cf64e2f709c34`。

[Remotion公式Skill](https://github.com/remotion-dev/skills) 12件をグローバルへ導入（commit `41b22eec767aa77eb31df62ccb3bacf52ed771fb`）。既存の別配布 [remotion-video-toolkit](https://github.com/shreefentsar/remotion-video-toolkit) も最新commit `81a412e7872f21f4989e4c07f48cc5b494c294a9` の29ルール付き版へ更新。Codexアプリ管理のPlugin cacheは手動変更していない。

[PixVerse公式Skill](https://github.com/PixVerseAI/skills) は1.28.0（commit `ccb7689fc516bcc637e622e60526b01f56c67452`）へ更新。[Editframe公式Skill](https://github.com/editframe/skills) は既存6件が配布内容と一致することを確認し、古い `editframe-create` だけ3.0へ更新（commit `6541ed20c198352913e8724d0999635a67c847ad`）。[ElevenLabs公式Skill](https://github.com/elevenlabs/skills) は利用中のmusicとsound-effectsを最新commit `9edcbd4b80ed57b8e07a3f86ea520333969fbc3c` に更新し、日本語の発動語を保持。無効化済みのElevenLabs Skillは有効化していない。共有Skillリポジトリの既存dirty変更は触っていない。

[Topview公式Skill](https://github.com/topviewai/skill) は旧REST方式の `topview-skill` を退避し、現行 `topview-generate` 0.2.0（commit `5e0fa64642cd732ad18382e91195171f2957453d`）を導入した。導入内容は公式sourceと一致する。現セッションには新Skillが要求するhost `topview-mcp` が露出していないため、Skill経由の外部生成は未検証。Tsugiteのrepo-local Topview bridgeは別経路。

指定された [session-story](https://github.com/heygen-com/hyperframes-community-skills/tree/master/skills/session-story) は community repository の `ba7a0bb6d3567d124c51f6074625043bfe0b32eb` からグローバルへ導入し、lockfileのScript依存も導入した。上流が固定する `hyperframes@0.8.71` の7箇所は、隔離サンプルで `check` に通った0.8.75へローカルで更新。導入版からサンプル生成・スケジュール作成と生成された `package.json` のpinを確認した。サンプルの `check` は短い検査用無音ファイルを補って成功したが、WebGL・画面端・音声長の警告がある。実スコアのbuildはMacのSwift 5.8.1とCommandLineTools SDKの5.8不一致で失敗し、完成レンダリングは未確認。Skillが読む実際の会話履歴にはアクセスしていない。Tsugiteの制作Gateとこの独立Skillの運用を同一視しない。

Mac全体の元配置は `/private/tmp/tsugite-global-integration-backup-20260925/` に退避した。履歴の検証レポートと制作済みprojectは変更していない。外部生成・課金は行っていない。
