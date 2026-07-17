# tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Tsugite 是一个厂商中立的视频流水线。它通过单一的 manifest 契约，把生成适配器和编辑后端连接起来。

每个视频任务都有自己的 `project.yaml`。作为可分发的 repo，复制用示例放在 `examples/`，用户自己的工作放在被 git 忽略的 `projects/`。安全流程如下：

1. 验证 project 和 manifest。
2. 创建执行计划。
3. 在 Gate 1 等待人工审批。
4. 只有 Coordinator 审批后，才执行生成或组装。
5. 在 Gate 2 做输出 QA。
6. 只有 Gate 2 审批后，才执行 render。
7. 在 Gate 3 做最终视频 QA。

## 当前范围

- manifest 验证和本地素材检查。
- 支持 `cli`、`mcp-agent`、`mcp-client` 风格的适配器 registry。
- PixVerse / Kling 的 CLI generation adapter wrapper。
- 带官方来源和更新日期的 PixVerse / Kling / Seedance T2V / I2V prompt knowledge catalog。
- 使用TopView skill CLI的T2V和单图I2V generation adapter。
- 将 local-media / generated-media 组装到 `dist/<run-id>/`。
- 基于 manifest 和 media probe 生成 Gate 2 QC report。
- 生成检查最终时长、分辨率、fps 和音视频流的 Gate 3 QC report。
- manifest 支持一等图片素材、说话人/姿势 metadata 和受保护的 presentation preset。
- 提供把文章转换为60秒、16:9双人对话的Remotion模板。
- Remotion / HyperFrames 后端契约。
- 需要 Coordinator role 和 Gate 审批的 guarded `run` / `render`。

## 安装

需要 Git、Node.js 22.12以上的22.x LTS、npm 10以上，以及包含`ffprobe`的FFmpeg。macOS可运行`brew install ffmpeg`，Debian/Ubuntu可运行`sudo apt-get update && sudo apt-get install -y ffmpeg`，Windows可运行`winget install --id Gyan.FFmpeg -e`并重新打开终端。Windows PowerShell入口请参阅[`docs/windows.md`](docs/windows.md)。

`npm ci`会在repo内安装Remotion和HyperFrames，无需global安装。HyperFrames属于devDependency，请勿使用`npm ci --omit=dev`。PixVerse/Kling等provider CLI、TopView/OpenClaw/Hermes外部runtime、凭据和计费配置不会自动安装。TopView的`doctor`只执行不计费的`list-models`检查，不提交生成任务；认证和余额仍需人工确认。未解决的blocking check会使整体`ok`为`false`。

## 命令

```sh
npm ci
npm run check
node bin/pipeline guides --json
cp -R examples/local-fixture projects/my-first-run
node bin/pipeline doctor --config projects/my-first-run/project.yaml --json
node bin/pipeline validate --config projects/my-first-run/project.yaml --json
node bin/pipeline plan --config projects/my-first-run/project.yaml --json
node bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
```

`run` 和 `render` 会被 Gate 保护：

```sh
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
node bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
node bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

没有明确的人工审批时，不要执行非 dry-run 的 `run` 或 `render`。
Gate 3 也支持 `re-render`，并保留 Gate 1 / 2 的审批。Gate 2 的 `retry_specific` 尚未实现；需要完整重新规划时使用 `revise`。

## Project 文件

`examples/local-fixture/project.yaml` 使用的最小 local-media project：

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

包含生成任务的 project 会增加 `generation` section：

```yaml
generation:
  adapter: pixverse
  requests:
    - id: shot-001
      prompt: short prompt
      model: v6
      duration: 5
      aspect: "16:9"
      input_mode: text-to-video
      params: {}
```

## 如何让流水线成长

Tsugite 不会因为你生成很多视频就自动变得更符合你的偏好。它会在你把 review note、重试原因和反复出现的偏好反馈回 repo 时成长。

推荐循环：

1. 在 `projects/` 下创建 project。
2. 只在 Gate 审批后执行生成或组装。
3. 查看输出，记录哪里好、哪里失败、为什么重试。
4. 一次性的笔记保留在该 project 内。
5. 反复出现的经验再提升为 reusable examples、templates、adapter/backend constraints、validation/doctor checks、tests/fixtures、运行规则或公开契约。

提升规则：

```text
一次性偏好             -> projects/<job>/notes.md
可复用的风格选择       -> examples/ or templates/
可机器检查的问题       -> constraints.yaml / validate / doctor + tests/fixtures
需要判断的运行规则     -> LESSONS.md -> .agents/skills/tsugite/SKILL.md / CLAUDE.md / AGENTS.md
QA 判断规则            -> Gate 2 / Gate 3 checks + report schema/tests
公开契约变更           -> README / manifest/schema.md / docs/requirements.md
```

每次提升都应留下可复现的 fixture 和测试，或留下人能阅读的运行规则。新增 Gate 2 / Gate 3 判断时，也要同步更新 report 结构和测试。

这样可以在保持 repo 可分发、安全的同时，让制作流程逐步接近你的偏好。本地项目留在被忽略的 `projects/` 下，只有可复用的改进才提交回源码。

## Repo 规则

- core code 必须保持厂商中立。厂商相关行为应放在 `adapters/` 或 `backends/`。
- adapter directory 必须包含 `constraints.md`。
- `mcp-agent` adapter 必须包含 `SKILL.md`。
- 用户工作应放在 `projects/`；`examples/` 应保持可复制、可重置。
- 产生可复用规则的失败应记录到 `LESSONS.md`。

## 生产使用备注

- `examples/local-fixture/project.yaml` 是 fixture style 的本地验证 config。编辑前请先复制到 `projects/`。
- `projects/*` 会被 git 忽略，因此本地 prompt、media、manifest、`dist/` 和 run state 不会混入可分发 commit。
- npm 11 中，platform-specific parent 被跳过时，optional wasm child package 仍可能留在 lockfile，导致 `npm ci` 后 `npm ls` 报告 `@emnapi/runtime` 为 extraneous。只有当 `npm ci`、`npm audit`、build、tests、`validate`、`plan`、`run --dry-run` 全部通过时，才把它当作 non-blocking。
- `npm run check` 会执行vendor boundary、TypeScript build、完整测试，并强制`src/`的statements、branches、functions和lines均达到80%以上。
- 当前 workspace path 包含 `*`，Vite 可能会提示 warning。测试目前可以通过；如果该 warning 影响运行，请把 repo 移到不含 `*` 的路径。
