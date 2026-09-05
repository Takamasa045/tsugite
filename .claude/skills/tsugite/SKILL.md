---
name: tsugite
description: Tsugiteの動画projectを構成・制作・Gateレビュー・QA・完成整理するときに使う。project.yamlと人間承認に基づき、キャラ一貫性や任意のShitate連携も扱う。コード保守、文書だけの修正、Tsugiteへの単なる言及は対象外。
---

# Tsugite for Claude Code

作業に入る前に、共通の正本 `../../../.agents/skills/tsugite/SKILL.md` を完全に読み込み、その手順と承認境界に従う。

引数がある場合は対象project、creative brief、または依頼の補足として扱う。

Claude Code固有のpermissionとhookは `CLAUDE.md` および `.claude/settings.json` を併用する。既存の `/tsugite-plan`、`/tsugite-verify`、`/tsugite-finalize`、`/tsugite-learning-review`、`/shitate-import` も目的別の短縮入口として利用できる。
