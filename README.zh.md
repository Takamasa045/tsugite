# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Tsugite 是本地影像工房：它把素材、制作日志、判断和偏好接到下一次制作，而不是把每次 AI 视频当成一次性结果。

完整入口、安全边界和命令以 [English README](README.md) 与 [日本語 README](README.ja.md) 为正本。本页只保留当前产品位置的摘要。

## 最简单的开始方式

1. 在 Codex 打开空文件夹，或在该文件夹启动 Claude Code。
2. 把[官方 setup 请求](docs/onboarding/codex-setup-prompt.ja.md)贴给代理。
3. 先做只读环境检查，系统安装前等待你的批准。
4. 只批准实际需要的系统变更。

你不必自己输入 `git clone` 或 npm 命令。官方 Bootstrap 只做仓库内依赖、零额度示例、`doctor`、`validate`、`plan`。它不会安装系统软件、改 PATH、登录外部服务、配置密钥、消耗额度、执行 `run` / `render`、改 Gate、commit、push 或发布。

已克隆仓库时：

```sh
npm run setup:check
npm run setup
npm run setup:open  # 同时打开本地 launcher 时
```

## 安全流程

每个视频任务有自己的 `project.yaml`。复制用示例在 `examples/`，用户工作在 git 忽略的 `projects/`。

1. 验证 project 和 manifest。
2. 创建计划。
3. 在 Gate 1 等待人工审批。
4. 只有 Coordinator 审批后才生成或组装。
5. 在 Gate 2 做输出 QA。
6. 只有 Gate 2 审批后才 render。
7. 在 Gate 3 做最终视频 QA。

没有明确的人工审批时，不要执行非 dry-run 的 `run` 或 `render`。Gate 3 支持 `re-render`，并保留 Gate 1 / 2 审批。Gate 2 的 `retry_specific` **未实现，也不纳入 1.0**；完整重规划请用 `revise`。MiniMax direct / MiniMax HTTP 保持 preflight-only，不得显示为可发送。

## 当前范围

- manifest 验证和本地素材检查。
- 与生成 `connections` 分离的公开 read-only Remote MCP **Agent Service Registry**。
- PixVerse / Kling CLI、TopView skill CLI、可选 Hermes 分析交接。
- PixVerse / Kling / Seedance 的带出处 prompt catalog（存在 ≠ 可执行）。
- 34 种故事框架与 35 条影像文法的 story guides。
- API-free 的 `analyze`、可选本地 Whisper、多源 `compose`。
- Gate 约束的 EDL、Gate 2 / Gate 3 QC（含黑场与长静音）。
- Remotion / HyperFrames、Gate 约束的音频 adapter。
- 需要 Coordinator 与 Gate 审批的 `run` / `render`。
- 仅绑定 `127.0.0.1` 的浏览器 launcher 与只读 3D Viewer。

Desktop 应用的一般分发已结束。日常入口是 GitHub 源码 + Codex / Claude Code + 本地浏览器 launcher。Electron 源码仅用于开发与回归测试。仓库软件版本是 **0.10.0**。

```sh
npm --prefix apps/workflow-viewer ci
npm run viewer:open
```

## 安装

需要 Git、Node.js 22.12 以上的 22.x LTS、npm 10 以上，以及包含 `ffprobe` 的 FFmpeg。Windows PowerShell 入口见 [`docs/windows.md`](docs/windows.md)。`npm ci` 会在仓库内安装 Remotion 和 HyperFrames；不要使用 `npm ci --omit=dev`。

```sh
npm ci
npm run check
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
```

`npm run check` 强制 `src/` 的 statements / functions / lines ≥ 80%，branches ≥ **74.4%**（Production Orchestration 后的保持值；恢复 75% 仍是债务）。`npm run security:audit` 会分别检查 production 依赖树和完整开发依赖树，发现 moderate 或更高 advisory 即失败。

## 成长循环与仓库规则

一次性偏好留在 `projects/<job>/notes.md`。可复用风格进入 `examples/` 或 `templates/`。可机器检查的问题进入 constraints / validate / doctor。判断型规则先写入 `LESSONS.md`，经人批准后再升到 skill / AGENTS.md / CLAUDE.md。core 必须保持厂商中立。

公开契约变更写入 README、`manifest/schema.md`、`docs/requirements.md`。当前软件版本是 **0.10.0**。1.0 仍要求 live provider/billing 证据与 packaged Desktop UAT；Windows smoke 已在 GitHub Actions 上验证。
