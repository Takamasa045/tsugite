# tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Tsugite는 생성 어댑터와 편집 백엔드를 하나의 manifest 계약으로 연결하는 벤더 중립 비디오 파이프라인입니다.

각 비디오 작업은 자체 `project.yaml`을 가집니다. 배포용 repo에서는 복사 가능한 예제를 `examples/`에 두고, 사용자 작업은 git에서 무시되는 `projects/` 아래에 둡니다. 안전한 흐름은 다음과 같습니다.

1. project와 manifest를 검증합니다.
2. 실행 계획을 만듭니다.
3. Gate 1에서 사람의 승인을 기다립니다.
4. Coordinator 승인 후에만 생성 또는 조립을 실행합니다.
5. Gate 2에서 출력 QA를 수행합니다.
6. Gate 2 승인 후에만 render를 실행합니다.
7. Gate 3에서 최종 비디오 QA를 수행합니다.

## 현재 범위

- manifest 검증과 로컬 asset 검사.
- `cli`, `mcp-agent`, `mcp-client` 스타일의 adapter registry.
- PixVerse / Kling용 CLI generation adapter wrapper.
- 공식 출처와 갱신 날짜를 포함한 PixVerse / Kling / Seedance T2V / I2V prompt knowledge catalog.
- TopView skill CLI를 사용하는 T2V 및 단일 이미지 I2V generation adapter.
- local-media / generated-media를 `dist/<run-id>/`로 조립.
- manifest와 media probe를 기반으로 Gate 2 QC report 생성.
- 최종 길이, 해상도, fps, 비디오/오디오 stream을 검사하는 Gate 3 QC report 생성.
- first-class 이미지 asset, 화자/pose metadata, 보호된 presentation preset.
- 글을 60초 16:9 2인 대화로 바꾸는 Remotion 템플릿.
- Remotion / HyperFrames backend 계약.
- Coordinator role과 Gate 승인을 요구하는 guarded `run` / `render`.

## 설정

Git, Node.js 22.12 이상의 22.x LTS, npm 10 이상, `ffprobe`를 포함한 FFmpeg가 필요합니다. macOS는 `brew install ffmpeg`, Debian/Ubuntu는 `sudo apt-get update && sudo apt-get install -y ffmpeg`, Windows는 `winget install --id Gyan.FFmpeg -e`를 실행한 뒤 terminal을 다시 여세요. Windows PowerShell 진입점은 [`docs/windows.md`](docs/windows.md)를 참조하세요.

`npm ci`는 Remotion과 HyperFrames를 repo 내부에 설치하므로 global 설치가 필요하지 않습니다. HyperFrames는 devDependency이므로 `npm ci --omit=dev`를 사용하지 마세요. PixVerse/Kling 같은 provider CLI, TopView/OpenClaw/Hermes 외부 runtime, credential과 billing 설정은 자동 설치되지 않습니다. TopView의 `doctor`는 과금 없는 `list-models` 검사만 수행하고 생성 task를 제출하지 않습니다. 인증과 credits는 수동 확인이며, 해결되지 않은 blocking check가 있으면 전체 `ok`는 `false`입니다.

## 명령

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

`run`과 `render`는 의도적으로 Gate로 보호됩니다.

```sh
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
node bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
node bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

명시적인 사람의 승인 없이 non-dry-run `run` 또는 `render`를 실행하지 마세요.
Gate 3는 `re-render`도 지원하며 Gate 1 / 2 승인을 유지합니다. Gate 2의 `retry_specific`은 아직 구현되지 않았으므로 전체 재계획에는 `revise`를 사용하세요.

## Project 파일

`examples/local-fixture/project.yaml`에서 사용하는 최소 local-media project:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

생성 작업이 있는 project는 `generation` section을 추가합니다.

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

## 파이프라인을 성장시키는 방법

Tsugite는 영상을 많이 생성한다고 자동으로 개인 취향에 맞게 좋아지지는 않습니다. 출력 리뷰, 다시 시도한 이유, 반복되는 선호를 repo의 규칙, 템플릿, 체크로 되돌릴 때 성장합니다.

권장 루프:

1. `projects/` 아래에 project를 만듭니다.
2. Gate 승인 후에만 생성 또는 조립을 실행합니다.
3. 출력을 보고 무엇이 좋았는지, 무엇이 실패했는지, 왜 다시 시도했는지 기록합니다.
4. 한 번만 쓰는 메모는 해당 project 안에 둡니다.
5. 반복해서 쓰이는 교훈만 reusable examples, templates, adapter/backend constraints, validation/doctor checks, tests/fixtures, 운영 규칙, 공개 계약으로 승격합니다.

승격 기준:

```text
일회성 선호            -> projects/<job>/notes.md
재사용 가능한 스타일   -> examples/ or templates/
기계적으로 막을 문제   -> constraints.yaml / validate / doctor + tests/fixtures
판단이 필요한 운영 규칙 -> LESSONS.md -> .agents/skills/tsugite/SKILL.md / CLAUDE.md / AGENTS.md
QA 판단 규칙           -> Gate 2 / Gate 3 checks + report schema/tests
공개 계약 변경         -> README / manifest/schema.md / docs/requirements.md
```

승격할 때는 재현 fixture와 테스트, 또는 사람이 읽을 수 있는 운영 규칙 중 하나를 반드시 남깁니다. Gate 2 / Gate 3 판단을 추가할 때는 report 형태와 테스트도 함께 갱신합니다.

이 루프를 통해 배포용 repo의 안전성을 유지하면서도 제작 파이프라인을 자신의 취향에 맞게 키울 수 있습니다. 로컬 프로젝트는 git에서 무시되는 `projects/` 아래에 두고, 재사용 가능한 개선만 소스에 commit합니다.

## Repo 규칙

- core code는 벤더 중립으로 유지합니다. 벤더별 동작은 `adapters/` 또는 `backends/` 안에 둡니다.
- adapter directory에는 반드시 `constraints.md`가 있어야 합니다.
- `mcp-agent` adapter에는 반드시 `SKILL.md`가 있어야 합니다.
- 사용자 작업은 `projects/`에 두고, `examples/`는 복사 가능하고 재설정하기 쉬운 상태로 유지합니다.
- 재사용 가능한 규칙을 만드는 실패는 `LESSONS.md`에 기록합니다.

## 프로덕션 메모

- `examples/local-fixture/project.yaml`은 fixture style의 로컬 검증 config입니다. 편집하기 전에 `projects/`로 복사하세요.
- `projects/*`는 git에서 무시되므로 로컬 prompt, media, manifest, `dist/`, run state가 배포 commit에 섞이지 않습니다.
- npm 11에서는 platform-specific parent가 건너뛰어져도 optional wasm child package가 lockfile에 남아 `npm ci` 후 `npm ls`가 `@emnapi/runtime`을 extraneous로 표시할 수 있습니다. `npm ci`, `npm audit`, build, tests, `validate`, `plan`, `run --dry-run`이 모두 통과할 때만 non-blocking으로 봅니다.
- `npm run check`는 vendor boundary, TypeScript build, 전체 테스트와 함께 `src/`의 statements, functions, lines는 80% 이상, branches는 75% 이상인지 강제합니다. 높은 core 환경과 CI runner에서도 process-heavy fixture를 안정적으로 실행하도록 coverage는 Vitest worker를 최대 4개 사용합니다.
- `npm run security:audit`는 production dependency tree와 전체 development tree를 각각 검사하고, moderate 이상의 advisory가 있으면 실패합니다.
- 현재 workspace path에는 `*`가 포함되어 있어 Vite가 warning을 낼 수 있습니다. 이 path에서도 tests는 통과하지만, 운영상 거슬리면 `*`가 없는 path로 repo를 옮기세요.
