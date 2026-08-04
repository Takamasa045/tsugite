# Worktree cleanup warning

Git worktreeの残存監査を定期実行し、安全に削除可能な候補が3件以上ある場合だけhost標準通知へ出す。通知はcleanup承認ではなく、自動削除もしない。

## 判定

primary repositoryで次を読み取り専用実行する。

```sh
node bin/pipeline worktrees --json
```

正本はJSONの`worktree_warning`とする。

- `active: false`: `DONT_NOTIFY`を返し、利用者向け通知を出さない。
- `active: true`: `removable_count`、`threshold`、`removable_paths`を短く報告する。
- CLIが失敗、JSONが不正、または`worktree_warning`がない旧版では、勝手に削除せず監査失敗として報告する。旧版互換が必要な既存host設定だけは、`worktrees[].removable === true`の件数を同じ閾値3で数えてよい。

判定対象はCLIが`removable: true`としたworktreeだけである。作業中、dirty、unmerged、locked、missing、`projects/`・`media/`・`output/`・`tmp/`・`templates/`・env類を含む保護対象は警告件数へ入れない。

## 通知内容

通知には次だけを含める。

- 安全に削除可能と判定された件数と閾値。
- 候補path。
- `node bin/pipeline worktrees --json`で再確認できること。
- 自動削除していないこと。

secret、env値、worktree内ファイル本文、他automationの状態は読まない。Browser、独自Desktop通知、Slack、メールなどの外部送信先は使わず、CodexまたはClaudeのどちらか1つのhost標準通知だけを使う。

## 安全境界

定期監査は`worktrees --apply`、`--defer --apply`、`--reconcile --apply`を実行しない。commit、push、PR、branch削除、stash、rebase、reset、`git clean`、force removeも行わない。

削除は、対象タスクが明示的に完成承認され、Coordinatorがexact pathをpreviewし、既存のworktree lifecycle条件を満たした場合だけ別操作として行う。
