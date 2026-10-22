# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

把计划、素材、完成视频的确认交给人，并把这一次改过的点接到下一支片子。Tsugite 是在自己电脑上跑的影像工房。

新的片子从 v2（`2.0.0-alpha.6`，不是正式版 2.0.0）开始。已有的 `project.yaml` 留在 v1 **0.18.0** 维护。PixVerse、Kling、TopView 不把 API 密钥写进设置，而是在各自 CLI 已用订阅登录时使用。路径已在包内，真机确认仍未完成。正本是 [日本語 README](README.ja.md) 与 [English README](README.md)。以前 README 中的技术说明见 [docs/reference.ja.md](docs/reference.ja.md) 与 [docs/reference.md](docs/reference.md)。

## 适合谁

在这些时候用：

- 不想每次都把同一份说明从头再说一遍。
- 生成服务的计费，想先看过内容再决定。
- 不想让上次改过的点（片头长度、字幕多少）在下一支片子里消失。

面向用 Codex 或 Claude Code、用自己的语言拜托做视频的人。不必先学会 Git 或终端。

## 开始方式

不必自己输入命令。

1. 在 Codex 打开空文件夹，或在该文件夹启动 Claude Code。
2. 把[官方 setup 请求](docs/onboarding/codex-setup-prompt.ja.md)贴给代理。正本是日文。
3. 阅读报告，只在真正需要变更时说「OK」。

官方 Bootstrap 只做仓库内依赖、零额度示例、`doctor`、`validate`、`plan`。它不会安装系统软件、登录外部服务、配置密钥、消耗额度、执行 `run` / `render`、改 Gate、commit 或 push。

报告最后会问一句「要打开 launcher 吗？」。只有回答「是」才运行已有的 `setup:open`。没回答或说「否」时不要打开。

## 完成后会看到什么

![本地 launcher。列表里是示例制作「はじめての継手」](docs/guide/assets/launcher-my-first-tsugite.webp)

官方 setup 会把零额度示例「はじめての継手」放到 `projects/my-first-tsugite/`，然后做环境确认（`doctor`）、内容验证（`validate`）、计划（`plan`）。此时没有计费、登录或生成。launcher 在最后一问得到「是」之前不会打开。

打开 launcher 本身不会生成、导出，也不会改动确认等待中的内容。

## 可以这样拜托

短例。完整目录见日文 [頼み方カタログ](docs/guide/requests.ja.md) 与英文 [Ways to ask](docs/guide/requests.md)。

- 只要 30 秒竖屏广告的**结构**（先不生成）。
- 手头的讲座视频不外传，只要章节和摘要。
- 同一角色做介绍片。先用平常的话确认外观和声音。
- 上次改过的「片头 0.5 秒就出 BGM」下一支也要守住。
- 用 Premiere Pro 打开，只改一刀（macOS）。

## 没有你点头就不会继续

往前走之前，人可以停三次。你 OK 之前不会继续。生成和导出也一样。唯一例外是案件选择了 `gates.gate_2.auto_pass: qc_ok_no_new_assets`。计费、新素材、质量指摘都是 0 时，素材确认（Gate 2）可以不经人的 OK 通过。计费或出现新素材时一定会停。

1. **计划确认（Gate 1）** — 可以按这个计划走吗？launcher 上会看到「Gate 1 確認画面を開く」。
2. **素材确认（Gate 2）** — 这些素材可以吗？
3. **完成确认（Gate 3）** — 这支完成视频可以吗？

官方 setup 不会自行安装系统软件、登录、设置 API 密钥、消耗额度、执行 `run` / `render`、替你做 Gate 判断、commit 或 push。边界见 [初回セットアップ契約](docs/onboarding/setup-contract.ja.md)。

## 用得越久越像自己的工房

第一支片子里「片头太长」这类修改，可以记成偏好与学习。同样的话反复出现会进入学习中，只有你批准的项目才可能成为模板或规则的候选。

批准只是允许之后去做反映工作。它不会自动改写 prompt、模板或规则。状态是记录（observed）→ 学习中（recurring）→ 已反映（promoted）→ 已确认效果（verified）。

## 常看到的词

完整列表见日文 [用語集](docs/guide/glossary.ja.md) 与英文 [glossary](docs/guide/glossary.md)。第一次出现用「平常的说法（正式名）」。

| 画面或对话里看到的词 | 意思 |
| --- | --- |
| 制作案件（`project.yaml`） | 一支视频的文件夹和设定 |
| 计划确认（Gate 1） / 素材确认（Gate 2） / 完成确认（Gate 3） | 人 OK 之前不会继续。launcher 上会看到「確認待ち」 |
| 素材列表（manifest） | 用到的影像、声音、字幕一览 |
| 生成（`run`） / 导出（`render`） | 生成可能向服务计费。导出在本地、不计费但可能较久。两者都只在批准之后 |
| 偏好与学习（feedback） | 改过的点的记录。批准也不会自动反映 |

## 了解更多

- 以前 README 的技术说明：[docs/reference.ja.md](docs/reference.ja.md) · [docs/reference.md](docs/reference.md)
- Windows：[Windows 原生指南](docs/windows.md)
- 版本：仓库本体 `0.18.0`。[变更记录](CHANGELOG.md)
- v2 alpha（开发中）：[概要](v2/README.md) · [6 秒环境确认](docs/onboarding/first-video.ja.md) · [按用途选择](docs/onboarding/see-and-choose.ja.md)
- 开发：[CONTRIBUTING.md](CONTRIBUTING.md)
- `npm run check` 强制 `src/` 的 statements / functions / lines ≥ 80%，branches ≥ **74.4%**（Production Orchestration 后的保持值；恢复 75% 仍是债务）。`npm run security:audit` 会分别检查 production 依赖树和完整开发依赖树，发现 moderate 或更高 advisory 即失败。
