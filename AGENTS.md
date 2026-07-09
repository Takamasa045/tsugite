# AGENTS.md

日本語で簡潔に進める。

## Goal

`project.yaml` を入口に、validate / plan / gated execution / QA を安全に進める。

## Rules

- 最初にゴールと完了条件を一文で置く。
- `run` / `render` は Coordinator だけが、明示承認後に実行できる。
- Planner / Reviewer は `validate`、`plan`、`run --dry-run` まで。
- Output QA は manifest と成果物検査のみ。編集や実行はしない。
- core にはエンジン固有名や固有コードを入れない。
- 失敗から再利用できるルールが生まれたら `LESSONS.md` に追記する。
