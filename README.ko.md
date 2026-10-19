# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

계획 → 소재 → 완성 영상을 사람과 함께 확인하면서 진행하고, 이번에 고친 점을 다음 영상에 이어 갑니다. Tsugite는 내 PC에서 도는 영상 공방입니다.

전체 진입점은 [日本語 README](README.ja.md)와 [English README](README.md)가 정본입니다. 이전 README의 기술 설명은 [docs/reference.ja.md](docs/reference.ja.md)와 [docs/reference.md](docs/reference.md)에 있습니다. 저장소 소프트웨어 버전은 **0.17.0**입니다.

## 누구에게

이런 때에 씁니다.

- 같은 설명을 매번 처음부터 다시 쓰고 싶지 않을 때.
- 생성 서비스 과금은 내용을 본 뒤에 결정하고 싶을 때.
- 지난번에 고친 점(도입 길이, 자막 양)이 다음 영상에서 사라지고 싶지 않을 때.

Codex나 Claude Code에 자기 언어로 부탁해 영상을 만드는 사람을 위한 도구입니다. Git이나 터미널을 먼저 배울 필요는 없습니다.

## 시작하기

명령을 직접 입력할 필요는 없습니다.

1. Codex에서 빈 폴더를 열거나, 그 폴더에서 Claude Code를 시작합니다.
2. [공식 setup 요청문](docs/onboarding/codex-setup-prompt.ja.md)을 에이전트에 붙여넣습니다. 정본은 일본어입니다.
3. 보고를 읽고, 실제로 변경이 필요할 때만 「OK」라고 합니다.

공식 Bootstrap은 저장소 의존성, 무과금 샘플, `doctor`, `validate`, `plan`만 합니다. 시스템 소프트웨어 설치, 외부 로그인, 키 설정, 과금, `run` / `render`, Gate 변경, commit, push는 하지 않습니다.

보고 마지막에 「런처를 열까요?」를 한 가지만 묻습니다. 「예」라고 답할 때만 기존 `setup:open`을 실행합니다. 답이 없거나 「아니요」이면 열지 않습니다.

## 끝나면 보이는 것

![로컬 런처. 목록에 샘플 제작 「はじめての継手」가 보인다](docs/guide/assets/launcher-my-first-tsugite.webp)

공식 setup은 무과금 샘플 「はじめての継手」를 `projects/my-first-tsugite/`에 두고, 환경 확인(`doctor`), 내용 검증(`validate`), 계획(`plan`)까지 진행합니다. 이 시점에는 과금·로그인·생성이 없습니다. 런처는 마지막 질문에 「예」라고 답할 때까지 열리지 않습니다.

런처를 여는 것만으로는 생성도 내보내기도, 확인 대기 중인 내용 변경도 하지 않습니다.

## 이렇게 부탁할 수 있습니다

짧은 예입니다. 전체 목록은 일본어 [頼み方カタログ](docs/guide/requests.ja.md)와 영어 [Ways to ask](docs/guide/requests.md)입니다.

- 30초 세로형 SNS 광고의 **구성만** 원한다(생성은 하지 않는다).
- 가지고 있는 세미나 영상을 밖으로 보내지 않고 장 나누기와 요약만 원한다.
- 같은 캐릭터로 소개 영상을 만든다. 모습과 목소리를 먼저 쉬운 글로 확인한다.
- 지난번에 고친 「도입 0.5초에 BGM」을 다음에도 지킨다.
- Premiere Pro로 열어 컷만 고친다(macOS).

## 당신이 멈추기 전에는 나아가지 않습니다

앞으로 가기 전에 사람이 세 번 멈출 수 있습니다. OK할 때까지 다음으로 가지 않습니다. 생성과 내보내기도 같습니다. 유일한 예외는 안건이 `gates.gate_2.auto_pass: qc_ok_no_new_assets`를 고른 때입니다. 과금·새 소재·품질 지적이 모두 0이면 소재 확인(Gate 2)은 사람 OK 없이 통과합니다. 과금이나 새 소재가 나오면 반드시 멈춥니다.

1. **계획 확인(Gate 1)** — 이 계획으로 진행해도 되는가. 런처에는 「Gate 1 確認画面を開く」가 나옵니다.
2. **소재 확인(Gate 2)** — 이 소재로 괜찮은가.
3. **완성 확인(Gate 3)** — 이 완성 영상으로 괜찮은가.

공식 setup은 부족한 소프트웨어 설치, 로그인, API 키, 과금, `run`, `render`, Gate 판단, commit, push를 자동으로 하지 않습니다. 경계는 [초회 셋업 계약](docs/onboarding/setup-contract.ja.md)입니다.

## 쓸수록 「내 공방」이 됩니다

첫 영상에서 「도입이 길다」고 고친 점은 취향·배움으로 기록할 수 있습니다. 같은 지적이 이어지면 학습 중이 되고, 승인한 항목만 템플릿이나 규칙 후보가 됩니다.

승인은 반영 작업을 해도 된다는 허가입니다. prompt·템플릿·규칙을 자동으로 바꾸지는 않습니다. 상태는 기록(observed) → 학습 중(recurring) → 반영됨(promoted) → 효과 확인됨(verified)입니다.

## 자주 나오는 말

전체는 일본어 [用語集](docs/guide/glossary.ja.md)와 영어 [glossary](docs/guide/glossary.md)입니다. 처음 나올 때는 「쉬운 말(정식 이름)」입니다.

| 화면이나 대화에서 보는 말 | 뜻 |
| --- | --- |
| 제작 안건(`project.yaml`) | 영상 한 편의 폴더와 설정 |
| 계획 확인(Gate 1) / 소재 확인(Gate 2) / 완성 확인(Gate 3) | 사람이 OK할 때까지 다음으로 가지 않는 확인. 런처에는 「確認待ち」가 나옵니다 |
| 소재 목록(manifest) | 쓰는 영상·소리·자막 일람 |
| 생성(`run`) / 내보내기(`render`) | 생성은 서비스에 따라 과금. 내보내기는 로컬·무과금이지만 시간이 걸릴 수 있다. 둘 다 승인 후에만 |
| 취향·배움(feedback) | 고친 점의 기록. 승인해도 자동 반영하지 않는다 |

## 더 알아보기

- 이전 README의 기술 설명: [docs/reference.ja.md](docs/reference.ja.md) · [docs/reference.md](docs/reference.md)
- Windows: [Windows 네이티브 가이드](docs/windows.md)
- 버전: 저장소 본체 `0.17.0`. [변경 기록](CHANGELOG.md)
- v2 alpha(개발 중): [개요](v2/README.md) · [6초 환경 확인](docs/onboarding/first-video.ja.md) · [용도로 고르기](docs/onboarding/see-and-choose.ja.md)
- 개발: [CONTRIBUTING.md](CONTRIBUTING.md)
- `npm run check`는 `src/` statements / functions / lines ≥ 80%, branches ≥ **74.4%**를 강제합니다 (Production Orchestration 이후 유지값. 75% 복원은 남은 빚). `npm run security:audit`는 production dependency tree와 전체 development tree를 각각 검사하고, moderate 이상의 advisory가 있으면 실패합니다.
