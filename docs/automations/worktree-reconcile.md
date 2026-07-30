# 統合待ちworktreeのreconcile

完成承認済みの実装タスクが、ローカルmainの別作業だけを理由に統合・削除できない場合に使う。案件ごとのscheduleは作らず、repoごとに1つのhost定期タスクがbounded queueを処理する。

## 登録

最初にpreviewでexact path、branch、HEAD、dirty/protected状態を確認する。

```sh
node bin/pipeline worktrees --defer --path /absolute/path/to/worktree --json
```

完成承認を受けたCoordinatorだけが登録をapplyできる。

```sh
node bin/pipeline worktrees --defer --apply --actor coordinator --path /absolute/path/to/worktree --json
```

キューはgit common dir内のTsugite stateへ保存する。最大128件・1MiBで、regular fileとreal directoryだけを許可し、同じpath/branch/HEADは冪等に扱う。登録後にidentityが変わった対象を自動更新しない。

## reconcile

previewは最古のpending entryと現在の待機理由を返す。

```sh
node bin/pipeline worktrees --reconcile --json
```

定期hostが実行できる変更コマンドは次だけとする。

```sh
node bin/pipeline worktrees --reconcile --apply --actor coordinator --json
```

処理順は固定する。

1. primary local mainからの実行か確認する。
2. mainにtracked/untracked変更があれば`status: waiting`で終了する。
3. queued path・branch・HEAD・repo境界・lock・protected contentを確認する。
4. temporary detached worktreeで非forceのmergeを作る。
5. primary worktreeの既存依存だけを一時参照し、`tsc --noEmit`と全Vitestを実行する。installやnetwork accessは行わない。
6. main HEADとclean状態、queued worktreeのidentityとprotected contentを再検査する。
7. 検証済みmerge commitへlocal mainを`--ff-only`で進める。
8. queued commitがmainのancestorになったことを既存worktree lifecycleで確認し、対象worktreeだけを非force削除する。
9. 成功entryをqueueから除く。すでにmainへ統合・削除済みのentryは冪等に解消する。

競合、検証失敗、identity変化、mainの再dirty化、queue破損、symlink、protected contentではmainを変更しない。branch削除、fetch、pull、push、stash、rebase、reset、`git clean`、force remove、repo外削除は行わない。

## host定期タスク

CodexまたはClaudeのどちらか1つだけを主系にする。promptはこのrepoのprimary mainで上記reconcileコマンドを1回実行し、JSONの`status`が変わった時、`blocked`になった時、またはworktreeを統合・削除した時だけ結果を報告する。`empty`と同じ`waiting_reason`の反復では追加操作を行わない。

host定期タスクはキューにないworktreeを推測して登録しない。完成承認、外部送信、push、PR、公開、課金、生成、renderの権限を新たに得たものとして扱わない。
