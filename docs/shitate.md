# Optional Shitate Integration

TsugiteがShitateのキャラ同一性を、project内の不変snapshotとして任意に取り込む契約。
Shitateは別リポジトリであり、通常の `validate / plan / review / run --dry-run` には不要。

## 責務境界

- Shitate: キャラ設定、base/variant、compile prompt、選定済みanchorの正本
- Tsugite: `project.yaml`、shot prompt、generation、Gate、編集、QAの正本
- 依存方向はTsugiteからShitateへのread-only import
- importはローカルコピーのみ。生成、Gate更新、外部送信、課金を行わない

## コマンド

```sh
node bin/pipeline shitate-import \
  --config projects/<project>/project.yaml \
  --shitate-root /absolute/path/to/shitate \
  --character <character-id> \
  --run-id <run-id> \
  --anchor references/images/main-anchor.png \
  --request-id <request-id> \
  --speaker-id <speaker-id> \
  --display-name "<表示名>" \
  --side left \
  --accent '#6B7A5A' \
  --json
```

必須は `--config`、`--character`、`--run-id` と、
`--shitate-root` または `SHITATE_ROOT`。
manifestまたは `references/images/` からanchorが1枚に決まる場合、`--anchor` は省略できる。

## 更新内容

1. `media/shitate/<character>/<run-id>/` に `prompt.txt`、`negative.txt`、
   `shitate-manifest.json`、`anchor.<ext>`、`character-lock.json` をatomicに作る。
2. manifestの `images[]` にanchorを追加する。
3. manifestの `speakers[]` にneutral poseとsource provenanceを持つキャラを追加する。
4. `--request-id` 指定時だけ対象requestをI2Vへ変更し、`params.image` をsnapshot anchorへ向ける。

shot promptは変更しない。Shitateのcompile promptは静止画の同一性資料としてsnapshotへ保存し、
動画requestには短い動作・カメラ指示を維持する。

## 冪等性と安全性

- safe IDとroot-bound realpathを検査する
- anchorはJPEG / PNG / WebPに限定する
- symlink/path traversalでcharacter root外へ出る入力を拒否する
- sourceとdestinationのSHA-256がlockと一致する同一importだけno-opにする
- 既存snapshot、manifest image/speaker、request imageが異なる場合は上書きしない
- project/manifest更新は一時ファイルからrenameし、途中失敗時はmanifestを復元する

## Negative prompt

`negative.txt` はsnapshotへ必ず保存する。現行PixVerse video CLIにnegative prompt引数がないため、
requestへ自動適用せず `shitate_import.negative_prompt_not_applied` を警告として返す。
将来adapterが明示対応した場合のみ、adapter境界で扱う。

## Import後の確認

```sh
node bin/pipeline guides --catalog pixverse --model v6 --input-mode image-to-video --json
node bin/pipeline validate --config projects/<project>/project.yaml --json
node bin/pipeline plan --config projects/<project>/project.yaml --json
node bin/pipeline review --config projects/<project>/project.yaml --json
node bin/pipeline run --config projects/<project>/project.yaml --dry-run --json
```

`review` のキャラクターシートでanchor、表示名、poseを確認してからGate 1を判断する。
