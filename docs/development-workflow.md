# 開発・検証と作業場所

リポジトリのコード・文書変更では「検証」を読み、編集前と完了時には「作業場所の自動選択」を読む。制作の Gate・完成メディア整理は [制作 Skill](../.agents/skills/tsugite/SKILL.md) に従う。

## 検証

- 環境と導入手順は [CONTRIBUTING.md](../CONTRIBUTING.md)。コマンドの正本は [package.json](../package.json)。Node.js は 22.12 以上の 22.x、npm は 10 以上。
- `git status --short` と対象差分を確認する。コード変更では対象テストを先に実行してから `npm run check`（vendor 境界・build・root coverage）を実行する。
- **誤字・表示用説明・リンクだけの変更**では、差分・参照先・記載コマンドを確認する。Skill を触る場合はメタデータと発動条件も確認する。この条件に限り `/tsugite-verify` でも全体チェックは不要。
- **承認境界・実行手順・Skill の振る舞い・設定・スクリプトに影響する変更**は、拡張子が Markdown でも関連テスト → `npm run check` を実行する。分類に迷う変更やユーザーが全体検証を指定した場合も全体チェックを行う。
- Viewer 変更がある場合は `npm run viewer:check` と `npm run viewer:build` を追加する。root のテストは `apps/**` を除外するため、各 app の検証を root の成功で代用しない。
- CI の必須チェックは [.github/workflows/ci.yml](../.github/workflows/ci.yml) と [desktop.yml](../.github/workflows/desktop.yml) を参照する。ローカルの対象別検証と CI の実行結果は区別する。
- CLI / project 契約の実動作証拠には [verify-tsugite](../.agents/skills/verify-tsugite/SKILL.md) を使う。macOS の network-deny helper が自動実行するのは Doctor と validate の一本だけ。plan・review・Viewer・生成の検証済みとは扱わない。
- 依存導入や `security:audit` はネットワークを使う。コマンド名だけで安全と判断せず、実装・実行環境・既存承認を確認する。検証用の project は隔離し、durable `projects/` を書き換えない。
- 失敗は原因と対象 path、成功は実際のテスト件数・coverage・証拠を報告する。想定点検、未実施、実行失敗を成功と混同しない。
- 最後に差分を確認し、`projects/`、`tmp/`、作品固有 composition が stage 対象に混ざっていないか確認する。検証の依頼だけで commit・push・PR 作成は行わない。

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

詳細な運用を行うときだけ、[統合待ち reconcile](automations/worktree-reconcile.md) または [残存件数の通知](automations/worktree-cleanup-alert.md) を読む。
