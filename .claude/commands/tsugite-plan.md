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

人間は自然言語で頼む。YAML / sha256 / IR フィールド名をユーザーに書かせない。

1. 対象 `project.yaml`（または brief から durable `projects/` に新規）と完了条件を一文で確認する。
2. **Identity Lock Triggers** に当たるなら、カット案の前に Identity Lock Protocol を実行する。
   - 声・外見・仕草の固定文、共有する場所の固定を、読みやすい文章で一度だけ確認する。
   - エージェントが IR に `locked_blocks` / `scenes` / `cast` を書き、`lock-block` で hash を入れる。
   - ユーザーに schema を説明しない。確認は「この固定で進めてよいか」だけ。
3. 構成やカットを提案する前に `story-guides` を実行する（identity lock 時は continuity / scene-master-blocking を意識）。
4. generationがあれば `guides`、続いて `validate` と `plan` を実行する。`LOCK-E001` は Gate 1 前に解消。`identity.subject_unlocked` は平易な日本語でリスクを伝える。
5. `review` を実行し、`review/index.html` と `review-data.json` を確認する。
6. 必要なら `run --dry-run` まで実行する。
7. 第一候補、補助候補、不採用理由、尺配分、映像文法、identity 固定の有無、Gate状態を日本語で簡潔に報告する。
8. 修正依頼では **1回に1変更**（1ショットの動き、または lock-block 1フィールド）。固定文の言い換えをショット本文に散らさない。

非dry-runの `run`、`render`、Gate承認は実行せず、Gate 1で停止する。
