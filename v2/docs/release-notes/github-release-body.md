継手 / Tsugite **v2.0.0-alpha.7** は Node.js 22・24・26 の互換対応リリースです。正式版 2.0.0 ではありません。npm レジストリには公開しません。

## 変更

- Node.js **22.23.4以上の22系 / 24.22.1以上の24系 / 26.12.1以上の26系**を共通の環境検査で受け入れ、Linux・macOS・WindowsのCIで確認します。
- 推奨・既定は **Node 22.23.4 / npm 10.9.8**。Node 26はLTS化と必要な外部連携の受入後に既定化します。任意のHypitセットアップは引き続きNode 22が必要です。
- リポジトリのElectron Desktopと内蔵AIターミナルを削除しました。Codex / Claude Codeとブラウザ版ランチャー／Viewerを使います。既存の制作フォルダ、承認記録、ユーザーデータは移動・削除しません。
- Node 26でViewer試験のlocalStorageが衝突する問題を修正しました。実ブラウザの保存機能は維持します。

添付の `tsugite-2.0.0-alpha.7.tgz` を `SHA256SUMS` と照合して導入してください。[導入手順](https://github.com/Takamasa045/tsugite/blob/v2.0.0-alpha.7/v2/docs/install.md)と[Node移行方針](https://github.com/Takamasa045/tsugite/blob/v2.0.0-alpha.7/docs/node-runtime.md)を参照できます。以前の配布物は変更しません。

## 受入範囲

このリリースはプログラムとチェックサムだけです。実サービスの生成・課金は行っていません。alpha.6の機能と受入状況を引き継ぎ、PixVerse・Kling・TopViewのログイン済みCLIによる実生成、ElevenLabs音声/music、第三者初回試用などを完了扱いにはしません。[alpha.6記録](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.6)と[正式版の判定条件](https://github.com/Takamasa045/tsugite/blob/v2.0.0-alpha.7/v2/docs/migration-plan.ja.md)を参照してください。

## English

This alpha adds a shared runtime policy for patched Node 22.23.4+, 24.22.1+, and 26.12.1+ within each major, with Linux/macOS/Windows CI. Node 22.23.4 and npm 10.9.8 remain the default until Node 26 reaches LTS and required provider acceptance is complete. Optional Hypit setup still requires Node 22.

The repository's Electron Desktop and embedded terminal are retired; use Codex / Claude Code with the browser launcher/Viewer. Projects, approvals and user data are preserved. Viewer tests now use jsdom storage on Node 26 without changing browser product storage.

Verify the attached tarball against SHA256SUMS before installation. This is not stable 2.0.0 and is not published to the npm registry. No live generation or billing was performed; alpha.6's documented service-acceptance limitations remain.
