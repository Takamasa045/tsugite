# AGENTS.md

日本語で簡潔に進める。

## Goal

`project.yaml` を入口に、validate / plan / gated execution / QA を安全に進める。

## Rules

- 制作ワークフローの正本は `.agents/skills/tsugite/SKILL.md`。該当作業では完全に読んでから進める。
- 最初にゴールと完了条件を一文で置く。
- `run` / `render` は Coordinator だけが、明示承認後に実行できる。
- Planner / Reviewer は `validate`、`plan`、`review`、`run --dry-run` まで。
- 構成やカットを提案する前に `story-guides` を実行し、第一候補、補助候補、不採用理由、尺配分、映像文法を確認する。
- Gate 1を承認する前に `review` を実行し、`dist/<run-id>/review/index.html` と `review-data.json` を確認する。成果物がない、または対象projectと一致しない場合は承認しない。
- generationを計画するときは `guides` と `plan.prompt_guidance` を確認し、catalogの存在を実行能力とみなさない。
- Output QA は manifest と成果物検査のみ。編集や実行はしない。
- ユーザーが対象動画を明示的に「完成」と確定したら、正本path・QA・振り返りを記録した後に `finalize` をpreviewする。completed / Gate 3 approved / 最終成果物を確認し、対象が一致する場合だけapplyする。
- `finalize` は最終runと最終manifest参照素材、設定・manifest・state・run logを残し、旧run・旧QA・未使用素材のメディアファイルだけを削除する。Gate 3承認だけを完成宣言の代わりにしない。
- 任意の `shitate-import` はShitateの選定済みrunをproject内へコピーするだけで、生成・Gate更新・外部送信を行わない。
- Shitateの外部pathやsymlinkをmanifestから直接参照せず、`character-lock.json` 付きsnapshotを使う。
- core にはエンジン固有名や固有コードを入れない。
- 失敗から再利用できるルールが生まれたら `LESSONS.md` に追記する。
