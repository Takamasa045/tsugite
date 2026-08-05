# H3 Prompt Director 例

現行 project schema で parse でき、H3 Creative IR v1 を決定的に compile できる最小 text-to-video 例です。

この example は **`validate` / `plan` / `review` / `run --dry-run` が通る契約**です（`generation.connection: pixverse` を明示）。actual run / render / Gate 更新 / 外部 API は含みません。

## 含まれるもの

- `project.yaml` — adapter / connection `pixverse`、`prompt_guide.catalog: pixverse`、model `minimax-h3`、空の手書き `prompt`、明示的 `h3` IR v1（T2V / 2 shots / dialogue lock / voiceover lips closed / music disabled → `N/A`）
- `manifest.json` — 目標尺 10 秒（H3 target と一致）。ローカル placeholder clip は 1 秒のみ
- `media/clip-001.mp4` — 既存 8KB 相当の bundled fixture copy（外部 URL asset なし）

## やること / やらないこと

この example 自体は次を **しません**。

- PixVerse 実生成
- actual `run` / `render`
- Gate 承認・更新
- 外部 API・課金

確認は次までに留めてください。

```sh
node bin/pipeline validate --config examples/h3-prompt-director/project.yaml --json
node bin/pipeline plan --config examples/h3-prompt-director/project.yaml --json
node bin/pipeline review --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --json
node bin/pipeline run --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --dry-run --json
```

## 尺の区別

| 値 | 意味 |
| --- | --- |
| H3 `target.duration` / generation `duration` | **10 秒** — 生成したい動画の目標尺 |
| `manifest.meta.target_duration_seconds` | **10 秒** — project の目標尺（H3 target と整合） |
| placeholder `clip-001` | **1 秒** — dry-run / ローカル検証用の bundled fixture。生成済み 10 秒素材ではない |

manifest validation は clip 合計と target の一致を強制しません。placeholder を 10 秒に伸ばしたり、target を 1 に偽る必要はありません。

## 他 mode の参照

この例は **text-to-video のみ**です。

- first-frame / first-last / reference / voiceover の IR 形 → `test/fixtures/h3/`
- 利用契約の正本 → [`docs/h3-prompt-director.md`](../../docs/h3-prompt-director.md)

## 設計メモ

- duration `10` / aspect `16:9` / quality `768p` は現行 PixVerse route 制約内
- T2V のため `h3.assets` は空（H3 実行 asset なし）
- dialogue 原文は日本語のまま lock。voiceover 時は lips closed 指示が compiler から付く
- music `enabled: false` → rendered `non_diegetic_music` は `N/A`
