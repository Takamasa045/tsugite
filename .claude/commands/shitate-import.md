---
description: 任意のShitate snapshotをTsugite projectへ安全に取り込む
argument-hint: <project.yaml> <shitate-root> <character> <run-id> [anchor] [request-id]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(bin/pipeline validate *)
  - Bash(bin/pipeline plan *)
  - Bash(bin/pipeline review *)
  - Bash(bin/pipeline run * --dry-run *)
---

Shitate連携は任意機能。引数 `$ARGUMENTS` からsourceとdestinationを整理する。

1. `docs/shitate.md` を読み、Shitate root、character、run ID、anchor、対象projectを確認する。
2. source manifestとanchorがShitate root内にあること、destinationがproject内の `media/shitate/` であることを示す。
3. コピー内容とmanifest/request更新内容をユーザーに提示し、明示承認を得る。
4. 承認後のみ `bin/pipeline shitate-import ... --json` を実行する。このコマンドは権限確認対象のままとする。
5. `validate`、`plan`、`review`、`run --dry-run` で確認する。

生成、Gate更新、非dry-run実行、外部送信は行わない。
