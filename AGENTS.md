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
- ユーザーが対象動画を明示的に「完成」と確定したら、正本path・QA・振り返りに加え、今回の失敗・改善点・次回への学びを終了記録として残す。失敗は案件の `feedback.jsonl` と、再利用できるルールなら追記専用の `LESSONS.md` に記録し、過去の同じ `feedback key` または `LESSONS.md` の症状・原因と照合して再発なら `recurring` として昇格候補かを確認する。昇格候補は反映先・変更内容・検証方法が揃う場合だけ pending proposal にし、人間承認なしに共有ルールを変更しない。記録結果（失敗なしを含む）を完了報告に示した後に `finalize` をpreviewする。completed / Gate 3 approved / 最終成果物を確認し、対象が一致する場合だけapplyする。
- `finalize` は最終runと最終manifest参照素材、設定・manifest・state・run logを残し、旧run・旧QA・未使用素材のメディアファイルだけを削除する。Gate 3承認だけを完成宣言の代わりにしない。
- 任意の `shitate-import` はShitateの選定済みrunをproject内へコピーするだけで、生成・Gate更新・外部送信を行わない。
- Shitateの外部pathやsymlinkをmanifestから直接参照せず、`character-lock.json` 付きsnapshotを使う。
- core にはエンジン固有名や固有コードを入れない。
- 失敗から再利用できるルールが生まれたら `LESSONS.md` に追記する。

## 作業場所の自動選択

- 新しい依頼では、編集前に `git status --short --branch` と `git worktree list` を確認し、現在の変更・使用ブランチ・並行作業の有無を把握する。
- `main` がクリーンで、ほかの作業と競合しない単独の小規模作業は、原則として現在の `main` で進める。タスクごとに機械的にworktreeを増やさない。
- 次のいずれかに当てはまる場合は、編集前に `origin/main` を基点とする専用worktreeへ分離する。
  - 現在の作業ツリーに未コミット変更がある。
  - 別タスクと並行して実装・検証する。
  - 大規模変更、実験、長時間作業、または独立PRとして扱う。
  - 同じファイルや機能領域へ別作業が触れる可能性がある。
- worktreeは1タスクにつき1つを基本とし、`codex/<短いタスク名>` のように目的が分かるブランチ名を使う。作成時にpath・branch・基点を短く報告する。
- Codexアプリでローカル環境として開始されたタスクでも、上記条件に該当する場合は編集前にworktreeへ分離する。既存タスクをアプリ上で自動移動できるとは扱わない。
- 完了時は、統合状態・未コミット変更・使用中プロセスを確認する。mainへ統合済みでクリーンなworktreeだけを削除し、未統合コミットはブランチに、未コミット変更は名前付きstash等へ復元可能に退避する。
- worktreeの作成・削除はGit上の作業場所だけを対象とし、`projects/`、生成メディア、共有素材、repo外pathを整理対象へ広げない。commit・push・PR・公開・課金・Gate実行の既存承認境界も維持する。

## 初回セットアップ後の学び自動化

- ローカル初回セットアップと `doctor` が完了したら、次の実質的な提案に入る前に一度だけ、次を確認する。`初回設定が完了しました。任意で、ローカルの「好み・学び」を定期レビューし、Codex または Claude の標準通知で承認待ちを知らせる自動化も設定しますか？（設定する／今回はしない）`
- 「設定する」の場合だけ、Codex / Claude Desktop・Cowork / Claude Code のどれを主系にするかと実行頻度を確認し、`docs/automations/learning-promotion-review.md` の登録手順に従う。常設scheduleは1つだけにする。
- 通知は選んだhostの標準通知だけを使う。Browser・OS通知の権限要求、独自Desktop通知、Slack、メールなどは設定しない。
- 「今回はしない」の場合は同じ初回セットアップ中に再度たずねない。自動化の登録・通知設定は、明示承認なしに実行しない。
