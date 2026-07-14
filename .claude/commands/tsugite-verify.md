---
description: Tsugiteのコード変更をテスト、型、coverage、差分で検証する
argument-hint: [optional path or test name]
allowed-tools:
  - Bash(npm run check)
  - Bash(npm run viewer:check)
  - Bash(npm run viewer:build)
  - Bash(git status *)
  - Bash(git diff *)
---

引数 `$ARGUMENTS` を検証対象の補足として扱う。

1. `git status --short` と対象差分を確認する。
2. 対象テストを先に実行し、最後に `npm run check` を実行する。
3. Viewer変更が含まれる場合だけ `npm run viewer:check` と `npm run viewer:build` を追加する。
4. 失敗があれば原因と対象pathを示し、成功時はテスト件数とcoverageを報告する。
5. `projects/`、`tmp/`、作品固有compositionがstage対象に混ざっていないか確認する。

commit、push、PR作成は行わない。
