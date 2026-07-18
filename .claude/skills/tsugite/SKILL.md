---
name: tsugite
description: Tsugiteの動画制作をproject.yamlから構成、検証、Gateレビュー、実行、QA、完成整理まで安全に進める。Tsugite、動画制作、story-guides、Gate、render、finalizeに関する依頼で使う。
---

# Tsugite for Claude Code

作業に入る前に、共通の正本 `../../../.agents/skills/tsugite/SKILL.md` を完全に読み込み、その手順と承認境界に従う。

引数がある場合は対象project、creative brief、または依頼の補足として扱う。

Claude Code固有のpermissionとhookは `CLAUDE.md` および `.claude/settings.json` を併用する。既存の `/tsugite-plan`、`/tsugite-verify`、`/tsugite-finalize`、`/tsugite-learning-review`、`/shitate-import` も目的別の短縮入口として利用できる。
