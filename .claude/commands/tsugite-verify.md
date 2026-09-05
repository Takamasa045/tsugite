---
description: Tsugiteの変更内容に応じ、文書の参照確認または関連テスト・型・coverage・差分で検証する
argument-hint: [optional path or test name]
allowed-tools:
  - Bash(npm run check)
  - Bash(npm run viewer:check)
  - Bash(npm run viewer:build)
  - Bash(git status *)
  - Bash(git diff *)
---

[開発・検証](../../docs/development-workflow.md#検証) を読み、引数 `$ARGUMENTS` を対象 path / test の補足として扱う。

誤字・表示用説明・リンクだけなら同文書の文書検証を行う。コード・設定・スクリプト・承認境界・実行手順・Skill の振る舞いを変更した場合は、差分確認 → 対象テスト → `npm run check` の順を守る。Viewer 変更時は `npm run viewer:check` と `npm run viewer:build` を追加する。失敗・実測結果・stage 対象の混入確認を同文書に従って報告する。

commit、push、PR作成は行わない。
