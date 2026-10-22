# 継手 / Tsugite v2

手元の動画をエージェントと準備し、計画・素材・できあがりを人が確認する道具です。**2.0.0-alpha.5は開発途中の配布版**です。ElevenLabs の SFX は実課金 1 件を記録済みです。PixVerse、Kling、TopView は API キーではなく、各サービスの CLI にログインした状態で使います。経路は同梱済みで、実機確認と第三者試用は完了していません。リポジトリの入口は [ルートの README](../README.ja.md) です。

## はじめての方はこちら

| やりたいこと | 最初に渡すもの |
| --- | --- |
| 話し動画を短くする | 動画、使いたい区間、確認済みのSRT、完成尺 |
| 数本の素材を1本にまとめる | 素材、順序、長さ、音の希望 |
| 字幕やBGMを控えめに直す | 今の案件と今回の具体的な変更指示 |

[用途と既存の公開デモ](docs/onboarding/see-and-choose.ja.md) → [導入から最初の動画まで](docs/onboarding/first-video.ja.md)。6秒サンプルは環境と確認手順の練習用です。作品品質や作業時間の優位性を証明するものではありません。

## 目的別の案内

- 初回導入：[日本語のはじめてガイド](docs/onboarding/first-video.ja.md)。Node.js 22.12以上、npm 10以上、libx264対応FFmpeg・FFprobeが必要です。最初のサンプルにはAPIキーも生成クレジットも不要です。
- 自分の素材：[素材確認・方針選択・冒頭試写・品質レビュー](docs/production-guidance.md)。素材を実際に確認し、今回の希望を優先します。装飾の自動生成ではありません。
- コマンドと設定：[English README](README.md)・[対応範囲](docs/requirements.md)・[プラグインとライセンス](docs/plugins.md)。

[alpha.5の配布ページ](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5)からtarballとSHA256SUMSを取得し、照合後に新しいフォルダへローカル導入してください。npmレジストリには公開していません。

```sh
npm install --prefix ./tsugite-local --ignore-scripts ./tsugite-2.0.0-alpha.5.tgz
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs init ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs check --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs plan --project ./my-video
```

planを動かしたまま、表示された確認ページのURLを自分で開いて計画を承認します。ブラウザは自動では開きません。開く場合は`--open`を付けます。その後、同じ作業フォルダの別ターミナルでmakeとexportを実行します。動画はmy-video/out/final.mp4です。

```sh
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs make --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs export --project ./my-video
```

素材・完成の確認も同じページで行います。エージェントへ承認操作を任せないでください。同じOS権限のプロセスから完全に隔離する仕組みではありません。サービスごとのクレジットは合算しません。設定・素材の変更後は再計画と再承認が必要です。既存v1のproject.yaml案件をこの手順で置き換えないでください。

配布tarballは独立したv2だけを含みます。GitHubの自動生成Source code一式には任意v1 Editframeの未解決High依存アラート#131も含まれます。[配布範囲と注意](docs/release-alpha5.md)を確認してください。

## 詳しい文書

- [対応範囲](docs/requirements.md)
- [v1からv2への移行判断](docs/migration-plan.ja.md)
- [第三者試用キット](docs/onboarding/trial-kit.ja.md)
- [プラグインとライセンス](docs/plugins.md)
- [alpha.5の配布範囲](docs/release-alpha5.md)
- [物語・構成の相談](docs/story-consult.ja.md)。`plugin story consult` は git の作業ツリーでも npm の配布物でも動きます。読むのは同梱の `knowledge/story-frameworks/catalog.yaml` だけです。
