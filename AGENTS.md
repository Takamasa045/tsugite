# AGENTS.md

日本語で簡潔に進める。

## Goal

`project.yaml` を入口に、validate / plan / gated execution / QA を安全に進める。

## Rules

- 最初にゴールと完了条件を一文で置く。
- `run` / `render` は Coordinator だけが、明示承認後に実行できる。
- Planner / Reviewer は `validate`、`plan`、`run --dry-run` まで。
- 構成やカットを提案する前に `story-guides` を実行し、第一候補、補助候補、不採用理由、尺配分、映像文法を確認する。
- generationを計画するときは `guides` と `plan.prompt_guidance` を確認し、catalogの存在を実行能力とみなさない。
- Output QA は manifest と成果物検査のみ。編集や実行はしない。
- core にはエンジン固有名や固有コードを入れない。
- 失敗から再利用できるルールが生まれたら `LESSONS.md` に追記する。
- 完成時は `projects/<job>/` に良かった点・悪かった点・再試行理由を残し、再利用できる知見だけを本体へ昇格する。
- ユーザー固有の画像・音声・完成動画・生成済みmanifestは `projects/*` に留め、`examples/` や配布commitへ移さない。
- staging前に、追加ファイルを「案件固有の成果物」と「再利用可能なルール・template・test」に分類する。
