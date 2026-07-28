# はじめての継手

外部サービス、APIキー、課金を使わずに、Tsugiteの基本構造を確認するためのサンプル案件です。

- `project.yaml`: 案件名、実行ID、編集バックエンド
- `manifest.json`: 素材、尺、解像度、来歴
- `media/`: 同梱された2本の短いローカル動画
- `dist/`: `plan`、`review`、Viewerなどの成果物
- `state.json`: Gateを進めた場合の状態
- `run-log.md`: 実行した場合の制作ログ

Bootstrapはこのフォルダを`projects/my-first-tsugite/`へ一度だけコピーします。コピー後に編集した内容は、再実行しても上書きしません。

初回セットアップは`doctor`、`validate`、`plan`までです。`run`、`render`、Gate承認は行いません。
