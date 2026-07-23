---
description: 完成版を記録し、旧版のメディアだけを安全に整理する
argument-hint: <project.yaml>
allowed-tools:
  - Bash(bin/pipeline finalize * --json)
  - Bash(bin/pipeline finalize * --apply *)
---

対象 `$ARGUMENTS` は、ユーザーが明示的に「完成」と確定したprojectだけに使う。

1. `state.json` が completed、Gate 3 が approved で、`final.mp4`、`render-report.json`、`gate3-qc.json` が揃っていることを確認する。
2. 正本path・QA証跡と、失敗・改善点・次回への学びを終了記録に残す。失敗は案件の `feedback.jsonl`、再利用できるルールは `LESSONS.md` に追記し、同じfailure keyまたは症状・原因が一致する過去の記録を照合して、再発なら `recurring` と昇格候補の可否を記録する。失敗がなかった場合も明記する。
3. `bin/pipeline finalize --config <project.yaml> --json` でpreviewし、保持する最終run・最終manifest参照素材と、削除予定の旧メディア件数・容量を確認する。
4. 対象projectが一致しない、保持対象が不足する、終了記録がない、またはユーザーが完成を明示していない場合は停止する。
5. 明示された完成判断を承認根拠として、`bin/pipeline finalize --config <project.yaml> --apply --actor coordinator --json` を実行する。
6. `dist/<run-id>/completion-record.json`、終了記録、正本path、削除件数、削減容量を報告する。

旧版の設定、manifest、state、run logなどのテキスト記録は削除しない。外部送信、Drive変更、commit、pushは行わない。
