---
description: Tsugiteの好み・学びから昇格承認待ち候補だけを安全に準備する
argument-hint: [optional run id]
allowed-tools:
  - Bash(git status *)
---

`docs/automations/learning-promotion-review.md` を完全に読み、同文書の入力安全境界、候補条件、重複防止、禁止事項に従う。

Claude Codeを実行元として、専用workflow `tsugite-learning-promotion-review` の候補を最大3件だけ準備する。候補追記のCLIには必ず `--proposal-workflow tsugite-learning-promotion-review --proposal-source claude-code --json` を付ける。引数 `$ARGUMENTS` がsafe idなら `--proposal-run-id` に使ってよい。

書き込みは対象projectの `feedback.jsonl` へ既存CLIで追記する場合だけに限定する。prompt、template、rule、check、Gate、state、コード、文書を変更せず、commit、push、PR、生成、render、ネットワーク、Browser、独自のDesktop Notification、Slack・メール等の外部通知を使わない。

最後に `scanned_projects`、`eligible_candidates`、`duplicates_skipped`、`appended_pending`、`failed` を報告する。Claude Code Remote Controlが有効な場合は、レビュー完了をClaude標準のpush通知で知らせるよう依頼されたものとして扱う。追加の通知コマンドや外部送信は行わない。
