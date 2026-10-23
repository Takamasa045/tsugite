# Tsugite Desktop

Tsugite DesktopのElectronソース、内蔵AIターミナル、専用ビルド・配布CIは削除しました。macOS／Windows向けインストーラーの配布・更新も終了しています。

通常利用はリポジトリをCodex / Claude Codeで開き、ブラウザ版ランチャー／Viewerを使います。セットアップ後にリポジトリのルートで次を実行してください。

```sh
npm run viewer:open
```

以前のDesktopが使っていた制作フォルダ、`projects/`、`templates/`、アプリのユーザーデータはこの変更では削除・移動しません。既存の制作フォルダは[導入案内](onboarding/first-video.ja.md)のprojects homeとして引き継いでください。PCにインストール済みのアプリをアンインストールする処理も含みません。

過去の設計書・試験記録にあるDesktopのコマンドは当時の記録です。現在の対応環境・検証手順は[Node方針](node-runtime.md)と[開発手順](development-workflow.md)を参照してください。
