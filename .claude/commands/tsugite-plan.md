---
description: Tsugite projectを安全に構成確認、検証、計画、Gate 1レビューまで進める
argument-hint: <project.yaml> | <creative brief> | <duration-seconds>
allowed-tools:
  - Bash(bin/pipeline story-guides *)
  - Bash(bin/pipeline guides *)
  - Bash(bin/pipeline validate *)
  - Bash(bin/pipeline plan *)
  - Bash(bin/pipeline review *)
  - Bash(bin/pipeline run * --dry-run *)
---

`.claude/skills/tsugite/SKILL.md` から共通の正本を読み、Required Flow に従って引数 `$ARGUMENTS` のprojectとcreative briefを扱う。

1. 対象 `project.yaml` と完了条件を一文で確認する。
2. 構成やカットを提案する前に `story-guides` を実行する。
3. generationがあれば `guides`、続いて `validate` と `plan` を実行する。
4. `review` を実行し、`review/index.html` と `review-data.json` を確認する。
5. 必要なら `run --dry-run` まで実行する。
6. 第一候補、補助候補、不採用理由、尺配分、映像文法、Gate状態を日本語で簡潔に報告する。

非dry-runの `run`、`render`、Gate承認は実行せず、Gate 1で停止する。
