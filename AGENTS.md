# AGENTS.md

日本語で簡潔に進める。最初にゴールと完了条件を一文で置く。

## 適用範囲と入口

Tsugite は `project.yaml` を入口とする、承認付き動画制作パイプライン。対象ディレクトリの追加指示も確認する。

- **コード・文書の変更**：編集前と完了時は [開発・検証と作業場所](docs/development-workflow.md) を読む。`git status --short --branch` / `git worktree list` で作業場所を選ぶ。既存の未コミット変更を保持する。
- **動画の計画・制作・レビュー・QA・完成整理**：[制作 Skill](.agents/skills/tsugite/SKILL.md) を完全に読み、その作業に該当する参照先へ進む。コード修正や誤字修正だけを理由に制作フローを始めない。
- **CLI の実動作検証**：[verify-tsugite](.agents/skills/verify-tsugite/SKILL.md)。[Cursor 版](.cursor/skills/verify-tsugite-manual/SKILL.md) は別の手動 feature 手順で、対象範囲・隔離・証拠形式が異なる。自動検証は `verify-tsugite`、手動検証は `verify-tsugite-manual` として選ぶ。
- **初回セットアップと doctor 成功後**：次の実質的な提案の前に [学び自動化の初回確認](docs/automations/learning-promotion-review.md#初回セットアップ後の確認) を一度行う。登録は明示的な選択後のみ、常設 schedule は一つ、通知は選んだ host 標準のみ。辞退後は同じ初回設定中に再質問しない。
- **Claude Code**：固有の入口・permission・hook は [CLAUDE.md](CLAUDE.md)。root の [SKILL.md](SKILL.md) は旧ツール向け参照として残す。

## 安全境界とプロジェクト制約

- `run` / `render` は Coordinator だけが明示承認後に実行できる。Planner / Reviewer は `validate`、`plan`、`review`、`run --dry-run` まで。Output QA は manifest と成果物検査のみで、編集・実行しない。
- Gate 1 / Gate 3 は人間判断。Gate 1 前に対象 project と一致する `dist/<run-id>/review/index.html` と `review-data.json` が必要。Gate 2 は人の `approve_all` / `revise` / `abort` が原則で、唯一の例外は案件が `gates.gate_2.auto_pass: qc_ok_no_new_assets` を選び、credits 0・新規 asset 0・QC issue 0 の場合。`retry_specific` は未実装、revise で全再計画する。
- 構成・カット案の前に `story-guides`、キャラ・複数ショット物語・一貫性が必要な自然言語依頼では制作 Skill の **Identity Lock Protocol** を適用する。声・外見・仕草・場所を平易な文で確認し、YAML や sha256 はエージェントが扱う。生成計画では `guides` と `plan.prompt_guidance` を確認し、catalog を実行能力とみなさない。
- 秘密情報・認証情報をチャットや project・repo・履歴へ書き出さない。接続先・課金先を勝手に選択しない。push・PR・公開・外部送信・課金・破壊的変更には明示依頼または既存承認が必要。検証や Skill の選択は承認を拡張しない。[CONTRIBUTING.md](CONTRIBUTING.md) のデータ保全と [SECURITY.md](SECURITY.md) の非公開報告を守る。
- core はエンジン中立。固有コードは adapter / backend に置く。Shitate は任意の承認済み snapshot コピーだけで、生成・Gate 更新・外部送信を行わない。manifest から外部 path / symlink を直接参照せず、`character-lock.json` 付き project 内 snapshot を使う。
- 制作案件は **制作前から** durable projects home（main worktree の `projects/`、または `TSUGITE_PROJECTS_HOME`）へ置く。最初の `validate` 後に launcher 可視性を確認する。pipeline の shelf link と launcher の複数 worktree 集約を考慮し、検証時だけ隔離する。

## 完了条件

- コード・文書変更は [対象別の検証と差分確認](docs/development-workflow.md#検証) を満たし、未検証と既存失敗を明示する。失敗から再利用できるルールが生まれたら `LESSONS.md` に追記する。
- **動画の完成宣言を受けたときだけ**、制作 Skill の終了記録・再発照合・昇格候補判断・QA 確認を行い、報告後に `finalize` を preview する。completed / Gate 3 approved / 最終成果物と対象を照合し、同じ `plan_digest` を `--expected-plan-digest` に渡して Coordinator が apply する。`--state-dir` は `project.dist_dir` と同じ値のみ。Gate 3 承認だけを完成宣言にしない。
- `finalize` は最終 run・最終 manifest 参照素材・設定・manifest・state・run log を残し、旧 run・旧 QA・未使用素材のメディアだけを整理する。正本・QA・completion-record を durable home に残す。共有ルールへの昇格は人間承認後のみ。
- **タスクの完成・完了承認後の worktree 整理**は [作業場所の自動選択](docs/development-workflow.md#作業場所の自動選択) の preview・対象一致・保護条件に従う。dirty / 未統合や、制作案件の唯一のコピーを持つ worktree を削除しない。件数警告を削除承認と扱わない。
