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
- キャラ付き・複数ショット物語・一貫性を求める自然言語依頼では、正本スキルの **Identity Lock Protocol** を適用する。声・外見・仕草・場所の固定を平易な文で一度確認し、エージェントが `locked_blocks` / `scenes` / `lock-block` を書く。ユーザーに YAML や sha256 を書かせない。Gate / 課金は従来どおり人間承認後のみ。
- Gate 1を承認する前に `review` を実行し、`dist/<run-id>/review/index.html` と `review-data.json` を確認する。成果物がない、または対象projectと一致しない場合は承認しない。
- generationを計画するときは `guides` と `plan.prompt_guidance` を確認し、catalogの存在を実行能力とみなさない。
- Output QA は manifest と成果物検査のみ。編集や実行はしない。
- ユーザーが対象動画を明示的に「完成」と確定したら、正本path・QA・振り返りに加え、今回の失敗・改善点・次回への学びを終了記録として残す。失敗は案件の `feedback.jsonl` と、再利用できるルールなら追記専用の `LESSONS.md` に記録し、過去の同じ `feedback key` または `LESSONS.md` の症状・原因と照合して再発なら `recurring` として昇格候補かを確認する。昇格候補は反映先・変更内容・検証方法が揃う場合だけ pending proposal にし、人間承認なしに共有ルールを変更しない。記録結果（失敗なしを含む）を完了報告に示した後に `finalize` をpreviewする。completed / Gate 3 approved / 最終成果物を確認し、preview JSON の `plan_digest` と対象が一致する場合だけ `finalize --apply --actor coordinator --expected-plan-digest <plan_digest>` を実行する。
- `finalize` は最終runと最終manifest参照素材、設定・manifest・state・run logを残し、旧run・旧QA・未使用素材のメディアファイルだけを削除する。Gate 3承認だけを完成宣言の代わりにしない。`--state-dir` は `project.dist_dir` と同一値のみ許可し、project外や別ルートは lock 取得前に拒否する。
- 制作案件の正本置き場は durable projects home（通常は main worktree の `projects/`。`TSUGITE_PROJECTS_HOME` または git common dir で解決）。**制作前から**ここに置く。feature worktree だけで完結させない。
- `validate` / 以降の pipeline は、案件が durable home の外にあれば shelf へディレクトリリンクしてランチャーに即表示する。`finalize --apply` は完成コピーを durable home へ昇格し、worktree 削除後も残す。
- ランチャーは durable home・指定 projectsDir・他 worktree の `projects/` をまとめて読む（テスト隔離時のみ link を切る）。
- `git worktree remove` 前に、完成品・QA・completion-record が durable `projects/` にあることを確認する。worktree 内だけに正本がある状態で remove しない。
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
- 完了時は、統合状態・未コミット変更・使用中プロセスを確認する。mainへ統合済みでクリーンなworktreeだけを削除し、未統合コミットはブランチに残す。dirtyな変更は破棄せず、削除対象から外す。
- ユーザーが対象タスクを明示的に「完成」「完了」と確定した発言は、当該タスクの worktree cleanup 実行承認として扱う。Coordinatorは差分確認と `node bin/pipeline worktrees --json` のpreviewで対象path一致を確認したうえで、追加の二重承認なしに安全条件を満たす対象だけ `node bin/pipeline worktrees --apply --actor coordinator --path <worktree>` で非force削除する。primary/current・main未統合・dirty・locked・missing・保護対象（ignore済みの `projects/` / `media/` / `output/` / `tmp/` / `templates/` / env 類）は拒否する。branch削除、stash、rebase、reset、`git clean`、force remove、projects/media/output の削除、repo外やsymlink先の削除はしない。
- 完成承認済みworktreeがmainのdirty状態だけで統合待ちになった場合は、Coordinatorがpreview後に `node bin/pipeline worktrees --defer --apply --actor coordinator --path <worktree> --json` でexact path・branch・HEADをgit common dirのbounded queueへ固定できる。定期hostはprimary local mainから `--reconcile --apply --actor coordinator` を呼び、mainがcleanな時だけ隔離マージ、固定build/test、mainとtargetの再監査、unchanged mainへのfast-forward、非force削除を行う。競合、検証失敗、identity変化、保護対象、mainの再dirty化は無変更で停止する。キューは完成承認を拡張せず、fetch、push、branch削除、stash、rebase、reset、`git clean`、force操作を許可しない。
- `node bin/pipeline worktrees --json` の `worktree_warning.active` がtrueなら、clean・main統合済み・非lock・保護対象なしの削除可能候補が3件以上あることを報告する。件数警告は削除承認ではなく、active/dirty/unmerged/protectedなworktreeを数に入れたり自動削除したりしない。定期監査はfalse時に `DONT_NOTIFY` としてよいが、true時も対象確認と明示的な完成承認なしにcleanupへ進めない。
- push・PR・公開・課金・Gate実行の既存承認境界は維持する。worktreeの作成・削除はGit上の作業場所だけを対象とし、durable `projects/` や生成メディアの正本整理へ広げない。

## 初回セットアップ後の学び自動化

- ローカル初回セットアップと `doctor` が完了したら、次の実質的な提案に入る前に一度だけ、次を確認する。`初回設定が完了しました。任意で、ローカルの「好み・学び」を定期レビューし、Codex または Claude の標準通知で承認待ちを知らせる自動化も設定しますか？（設定する／今回はしない）`
- 「設定する」の場合だけ、Codex / Claude Desktop・Cowork / Claude Code のどれを主系にするかと実行頻度を確認し、`docs/automations/learning-promotion-review.md` の登録手順に従う。常設scheduleは1つだけにする。
- 通知は選んだhostの標準通知だけを使う。Browser・OS通知の権限要求、独自Desktop通知、Slack、メールなどは設定しない。
- 「今回はしない」の場合は同じ初回セットアップ中に再度たずねない。自動化の登録・通知設定は、明示承認なしに実行しない。
