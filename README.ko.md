<img src="docs/assets/hero.jpg" alt="DSH Control Bridge — Codex / Grok Bot → DeepSeek Harness" width="100%">

# DSH Control Bridge

[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-2563eb?style=flat-square)](README.md) [![English](https://img.shields.io/badge/English-2563eb?style=flat-square)](README.en.md) [![Français](https://img.shields.io/badge/Fran%C3%A7ais-2563eb?style=flat-square)](README.fr.md) [![日本語](https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-2563eb?style=flat-square)](README.ja.md) [![한국어](https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-2563eb?style=flat-square)](README.ko.md) [![Deutsch](https://img.shields.io/badge/Deutsch-2563eb?style=flat-square)](README.de.md)

Codex, Grok Bot 또는 직접 만든 조정 프로그램에서 지정한 DeepSeek Harness 작업 공간으로 작업을 보내고 실행 결과를 추적할 수 있습니다. **같은 컴퓨터에서 Codex와 Harness Desktop을 사용한다면 Codex skill과 Desktop Host부터 시작하세요.** 로컬 Host에 연결하며, 설치 후에는 Codex에서 자연어로 조작할 수 있습니다.

[Super Agent 조종석](plugins/dsh-superagent-cockpit/README.md) · [Codex skill v0.2.3](https://github.com/ft54482/dsh-control-bridge/releases/tag/skill-v0.2.3) · [Desktop Host v0.2.2](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2) · [문서 목록](docs/README.md) · [포트 설정 및 문제 해결](docs/ports.md) · [Windows 실제 환경 검증](docs/verified-scope.md)

상세 운영 안내는 현재 주로 중국어로 제공됩니다. 명령, 설정 키 및 기술 필드명은 원문 그대로 유지합니다.

## 사용 경로 선택

| 환경과 목적 | 설치하거나 실행할 항목 | 첫 확인 |
| --- | --- | --- |
| Codex 데스크톱에서 기존 대화를 이어가거나 새 작업을 위한 주 제어 대화를 만들기 | Codex에 **skill**, Harness의 desktop profile에 **Host 플러그인** 설치 | skill로 `health`와 `granted` 실행.[설치 및 페어링](docs/windows-delivery.md#codex-desktop-setup) |
| 자체 Bot이나 스크립트로 여러 인스턴스, 수신함, 작업 승인 및 감사 관리 | Python **조정 브리지**를 설치하고 `dsh-bridge` CLI 사용. 서명된 HTTP 이벤트를 받아야 할 때 `serve` 실행 | fake로 초안 작성, 전송, 결과 제출까지 실행.[조정 브리지 안내](docs/coordinator.md) |
| 기존 도구 클라이언트에서 MCP로 수신함을 읽거나 작업 초안 작성 | 클라이언트에서 같은 Python 조정 브리지의 `mcp` 하위 명령 실행. v0.2.2는 `Content-Length` 메시지 프레임을 사용하므로 클라이언트가 이 형식을 지원해야 함 | 호환 클라이언트로 `tools/list` 호출. 줄 단위 JSON만 지원하는 클라이언트는 우선 CLI 사용 가능.[MCP 설정 및 도구](docs/coordinator.md) |
| 터미널이나 CI에서 독립적인 Harness 일반 대화 실행 | Python 조정 브리지에 `headless_cli` 어댑터와 독립 headless profile 설정 | 기본값인 `spawn = false` 상태에서 설정 확인.[Headless CLI](docs/headless-cli.md) |
| Harness Desktop에서 작업 슬롯과 각 인스턴스의 티켓 확인 | 선택 사항인 **Super Agent 조종석** 설치. 여러 인스턴스를 사용하면 함께 제공되는 집계 서비스 실행 | 위쪽에는 주 제어 등록 정보를 기준으로 작업이 표시되고 옆에는 활성 대화 수, 각 인스턴스 카드에는 티켓 실행자 점유 상태 표시.[다운로드 및 설치](plugins/dsh-superagent-cockpit/README.md) |
| 배포된 SuperAgent에 Codex에서 작업을 보내고 추적하기 | skill에 포함된 `github_source.py`로 대상 인스턴스, GitHub 저장소 및 발신 계정 확인 | `precheck`부터 시작. 승인된 Issue나 댓글을 전송한 뒤 같은 계획으로 Ticket, Assignment 및 worker 결과 추적.[사용 안내](skills/deepseek-harness-bridge/references/superagent.md#github-source) |

디렉터리와 역할의 관계는 [구성 요소 및 실행 위치](docs/README.md#仓库里的几个名字)를 참고하세요.

## Codex 데스크톱 빠른 시작

1. **skill 설치.** 독립 skill ZIP을 개인 `~/.agents/skills/`에 압축 해제합니다. 이미 페어링했다면 기존 Host와 권한을 재사용할 수 있습니다. 처음 설치할 때는 호환되는 v0.2.2 Host TGZ와 Windows 설치 스크립트를 포함한 휴대용 소스 ZIP도 내려받으세요. 이미 체크아웃한 소스도 사용할 수 있습니다.[Skill ZIP](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip) · [Host, 휴대용 패키지 및 SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2)
2. **Host 설치 및 페어링.** Python 3.11+가 필요합니다. Windows 안내에 따라 실제 사용하는 desktop profile에 Host를 설치하고 대상 작업 공간에서 사용 중이지 않은 대화를 고른 뒤, 장기 인증 정보 파일의 경로를 skill에 설정합니다. 기록 조회에는 `read`, 작업 전송에는 `write`를 선택하세요.[설치 및 페어링](docs/windows-delivery.md#codex-desktop-setup)
3. **연결 확인.** Codex에 “`$deepseek-harness-bridge`로 로컬 연결을 확인하고 허용된 대화를 나열해 줘”라고 입력합니다. 주 제어 대화를 새로 만들려면 같은 profile에 `master-control` 프리셋이 설치되어 있고 Host의 대화 생성이 활성화되어 있으며 `health`가 `preset_create_verified=true`를 반환하는지 확인하세요. 사용자 지정 포트도 Codex에 알려 주세요.[기본값과 다른 포트 예시](docs/ports.md#desktop-host)
4. **작업에 맞게 대화 선택.** “지난번 내보내기 수정 대화를 찾아 실패한 사례를 계속 처리해 줘” 또는 “같은 작업 공간에 새 주 제어 대화를 만들고 이 독립 작업을 처리해 줘”라고 요청할 수 있습니다. 생성에 성공하면 skill이 실제 대화에서 프리셋을 다시 읽어 확인하고 작업을 보낸 뒤, 요청 ID로 공식 종료 상태를 추적합니다.[대화 명령 및 검증 필드](skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## 예시와 다른 포트 사용

| 접속할 서비스 | 기본 연결 | 변경할 설정 |
| --- | --- | --- |
| Harness Desktop Host | `127.0.0.1:8765` | Host 플러그인의 `port`, 페어링 시 `--url`, skill을 호출할 때마다 `--port` 지정 |
| Python 조정 브리지의 서명된 이벤트 수신 엔드포인트 | `127.0.0.1:8787` | `serve --port`로 실행하고 이벤트 발신 측의 `/v1/events` URL 갱신 |
| SuperAgent 관리 서비스 | helper 기본 접속 주소는 `127.0.0.1:3082` | 대상 profile이 실제 수신 중인 포트를 확인하고 `superagent.py --port PORT state`에 전달 |
| 조정 브리지 MCP | 로컬 하위 프로세스의 표준 입력·출력 | 실행 명령, 설정 파일 및 데이터 디렉터리 지정. TCP 포트 할당 불필요 |

선택한 경로에서 사용하는 서비스를 설정하세요. fake 예시의 `:9`와 `:10`은 자리 표시자입니다. 자세한 안내에서는 사용자 지정 포트로 페어링하는 방법과 서비스 연결 오류, 인증 정보 오류, 작업 공간 권한 부족을 확인하는 방법을 설명합니다.[포트 설정 및 문제 해결](docs/ports.md)

## Python 조정 브리지 빠른 시작

저장소 루트에서 Python 3.11+로 다음 명령을 실행합니다. fake 예시는 전체 흐름을 로컬에서 모의 실행하므로 Harness 인증 정보나 모델 사용 한도가 필요하지 않습니다.

```sh
python -m pip install -e .
python examples/e2e_fake.py
dsh-bridge --config examples/config.example.toml check
```

예시에서는 `local-desktop`과 `lab-server` 모두에 `broadcast-cs` 작업 공간을 둡니다. 작업을 보낼 때는 인스턴스와 작업 공간을 함께 지정합니다. 작업 기록은 일반 대화 `ordinary_session`과 장기 작업 `superagent`를 구분하며 기본값은 `draft`입니다. 전송하려면 운영자가 제공한 `mandate`가 필요합니다. fake가 생성하는 ticket/run은 시연용입니다. 실제 Assignment는 해당 SuperAgent 관리 서비스에서 추적합니다.[조정 브리지 명령 및 승인](docs/coordinator.md) · [어댑터 기능](docs/adapters.md)

[개발 및 기여](CONTRIBUTING.md) · [보안 안내](SECURITY.md) · [MIT 라이선스](LICENSE)
