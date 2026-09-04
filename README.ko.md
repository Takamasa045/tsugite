# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

Tsugite는 로컬 영상 공방입니다. 각 AI 영상을 일회성 결과로 두지 않고, 소재·제작 로그·판단·취향을 다음 제작으로 이어갑니다.

전체 진입점, 안전 경계, 명령은 [English README](README.md)와 [日本語 README](README.ja.md)가 정본입니다. 이 페이지는 현재 제품 위치의 요약만 둡니다.

## 가장 쉬운 시작

1. Codex에서 빈 폴더를 열거나, 그 폴더에서 Claude Code를 시작합니다.
2. [공식 setup 요청문](docs/onboarding/codex-setup-prompt.ja.md)을 에이전트에 붙여넣습니다.
3. 읽기 전용 환경 확인부터 하고, 시스템 설치 전에는 승인을 기다립니다.
4. 실제로 필요한 시스템 변경만 승인합니다.

`git clone`이나 npm 명령을 직접 입력할 필요는 없습니다. 공식 Bootstrap은 저장소 의존성, 무과금 샘플, `doctor`, `validate`, `plan`만 자동화합니다. 시스템 패키지, PATH, 외부 로그인, secret, 과금, `run` / `render`, Gate, commit, push, 공개는 하지 않습니다.

이미 클론한 저장소에서는:

```sh
npm run setup:check
npm run setup
npm run setup:open  # launcher도 열 때
```

## 안전한 흐름

각 영상 작업은 자체 `project.yaml`을 가집니다. 복사 가능한 예제는 `examples/`, 사용자 작업은 git에서 무시되는 `projects/`입니다.

1. project와 manifest를 검증합니다.
2. 계획을 만듭니다.
3. Gate 1에서 사람 승인을 기다립니다.
4. Coordinator 승인 후에만 생성 또는 조립을 실행합니다.
5. Gate 2에서 출력 QA를 합니다.
6. Gate 2 승인 후에만 render합니다.
7. Gate 3에서 최종 영상 QA를 합니다.

명시적 사람 승인 없이 non-dry-run `run` / `render`를 실행하지 마세요. Gate 3는 `re-render`를 지원하며 Gate 1 / 2 승인을 유지합니다. Gate 2 `retry_specific`은 **미구현이며 1.0에도 넣지 않습니다**. 전체 재계획은 `revise`를 쓰세요. MiniMax direct / MiniMax HTTP는 preflight-only이며 전송 가능으로 표시하지 않습니다.

## 현재 범위

- manifest 검증과 로컬 소재 검사.
- 생성 `connections`와 분리된 공개 read-only Remote MCP **Agent Service Registry**.
- PixVerse / Kling CLI, TopView skill CLI, 선택적 Hermes 분석 핸드오프.
- 출처가 있는 PixVerse / Kling / Seedance prompt catalog (존재 ≠ 실행 가능).
- 34개 이야기 틀과 35개 영상 문법 story guides.
- API-free `analyze`, 선택적 로컬 Whisper, 다중 소스 `compose`.
- Gate에 묶인 EDL, Gate 2 / Gate 3 QC (검은 화면·긴 무음 포함).
- Remotion / HyperFrames, Gate에 묶인 오디오 adapter.
- Coordinator와 Gate 승인이 필요한 `run` / `render`.
- `127.0.0.1`만 바인드하는 브라우저 launcher와 읽기 전용 3D Viewer.

Desktop 앱의 일반 배포는 종료되었습니다. 일상 진입점은 GitHub 소스 + Codex / Claude Code + 로컬 브라우저 launcher입니다. Electron 소스는 개발·회귀 검증용으로만 남습니다. 저장소 소프트웨어 버전은 **0.10.0**입니다.

```sh
npm --prefix apps/workflow-viewer ci
npm run viewer:open
```

## 설치

Git, Node.js 22.12 이상의 22.x LTS, npm 10 이상, `ffprobe`를 포함한 FFmpeg가 필요합니다. Windows PowerShell 진입점은 [`docs/windows.md`](docs/windows.md)를 보세요. `npm ci`는 Remotion과 HyperFrames를 저장소 안에 설치합니다. `npm ci --omit=dev`는 쓰지 마세요.

```sh
npm ci
npm run check
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
```

`npm run check`는 `src/` statements / functions / lines ≥ 80%, branches ≥ **74.4%**를 강제합니다 (Production Orchestration 이후 유지값. 75% 복원은 남은 빚). `npm run security:audit`는 production dependency tree와 전체 development tree를 각각 검사하고, moderate 이상의 advisory가 있으면 실패합니다.

## 성장 루프와 저장소 규칙

일회성 취향은 `projects/<job>/notes.md`에 둡니다. 재사용 스타일은 `examples/` 또는 `templates/`로, 기계 검사 가능한 문제는 constraints / validate / doctor로 올립니다. 판단형 규칙은 `LESSONS.md`에 먼저 쓰고, 사람 승인 후에 skill / AGENTS.md / CLAUDE.md로 승격합니다. core는 벤더 중립을 유지합니다.

공개 계약 변경은 README, `manifest/schema.md`, `docs/requirements.md`에 남깁니다. 현재 소프트웨어 버전은 **0.10.0**입니다. 1.0은 여전히 live provider/billing 증거와 packaged Desktop UAT가 필요하고, Windows smoke는 GitHub Actions에서 확인했습니다.
