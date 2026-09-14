# memory-agent

세션·프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 에이전트의 서버 로직입니다.
Node 전용이며 `apps/agent`의 `.server` 모듈과 API 라우트에서만 가져다 씁니다.
브라우저에서 필요한 도구 정의만 `memory-agent/definitions`로 따로 내보냅니다.

설계 배경과 확정 결정은 [결정 기록](../../docs/decisions.md)을 보세요.

## 구조

```
src/
  db/           node:sqlite 연결, 마이그레이션(PRAGMA user_version), atomic()
  config/       저장 루트(~/.context-generactive-agent), 전역 설정(config.json)
  projects/     프로젝트 등록·경로 검사·교차 회상 제외·권한 모드(ask/auto)
  sessions/     프로젝트에 속한 대화
  memory/       기억: 노드·구조 edge·그래프 탐색·근거 추적·검색·기록 middleware
    embedding/  로컬 임베딩 모델 + turbovec 벡터 인덱스 + 인덱서
  codex/        ChatGPT 계정(codex app-server): 로그인·모델·TanStack 어댑터
  files/        경로·자격 증명 검사, 텍스트 파일 읽기/쓰기, 목록, 줄 검색
  shell/        호스트 셸 실행(프로세스 그룹, timeout, 출력 앞뒤 보존)
  permissions/  auto 모드: 분류 모델, 판정 기록, 게이트 middleware
  tools/        모델이 쓰는 도구 정의와 구현
  agent/        POST /api/chat 핸들러, 저장된 대화를 UIMessage로 변환
  testing/      테스트용 어댑터·임베더
  layers.ts     모든 서비스를 저장 루트 하나로 조립하는 Effect Layer
```

서비스는 Effect `Context.Tag` + `Layer`로 만들고, 앱은 `ManagedRuntime` 하나로 씁니다.
도구 입력 스키마는 Effect Schema이며 `toToolSchema`로 TanStack이 요구하는 Standard JSON Schema로 바꿉니다.

## 기억 모델

- 사용자·assistant·tool call·tool result를 모두 원문 그대로 `nodes`에 저장합니다(수정 불가).
- 저장할 때 구조 edge를 만듭니다: `next`(세션 순서), `reply`, `calls`, `returns`, `touches`(같은 파일/URL).
- 검색(`find_memory`)은 임베딩 벡터 순위와 FTS trigram 순위를 RRF로 합친 뒤 그래프를 따라 넓힙니다.
- `read_evidence`는 원문을 페이지로 읽고, `trace_evidence`는 tool result → call → assistant → user 발언까지 거슬러 갑니다.
- 교차 프로젝트 회상은 기본 포함이며, 프로젝트별로 제외할 수 있습니다.

## 도구와 권한

| 도구                                                             | 승인 | 비고                                           |
| ---------------------------------------------------------------- | ---- | ---------------------------------------------- |
| `find_memory`, `read_evidence`, `trace_evidence`                 | 없음 | 보이지 않는 프로젝트의 노드는 숨김             |
| `list_files`, `search_files`, `read_file`                        | 없음 | 프로젝트 상대 경로, Git 프로젝트는 ignore 반영 |
| `write_file`, `edit_file`, `delete_file`                         | 없음 | 읽을 때 받은 sha256이 같을 때만 변경           |
| `list_outside_files`, `read_outside_file`, `search_outside_file` | 없음 | 프로젝트 밖 절대 경로, 읽기 전용               |
| `run_shell`, `write_outside_file`, `delete_outside_file`         | 필요 | 권한 모드에 따라 승인                          |

권한 모드는 프로젝트마다 고릅니다.

- `ask`(기본): 승인이 필요한 호출마다 TanStack이 멈추고 사용자가 답합니다(`needsApproval`).
- `auto`: `PermissionGate` middleware가 실행 직전 호출을 `PermissionClassifier`에 보냅니다.
  분류 모델(선택한 모델의 가장 낮은 추론 강도, 도구 없는 일회용 스레드)이 `allow`/`ask`/`block`을 판정합니다.
  - 입력은 호출 내용, DB에 저장된 실제 사용자 발언, 프로젝트 경로뿐입니다. 도구 결과·파일 내용은 넣지 않습니다.
  - `ask`면 `permission-review` interrupt로 사용자에게 묻고, 답은 재개할 때 기록합니다.
  - 분류 실패·timeout·읽을 수 없는 답은 `ask`로 처리합니다.
  - 판정과 사용자 답은 `permission_reviews`에 쌓이고, tool result 노드 `detail.permission`에 근거로 남습니다.

승인 대기로 HTTP 요청이 끝나도 codex 턴은 `TurnParking`에 threadId로 보관되어, 재개 요청이 같은 턴을 이어갑니다.

## 보안 경계

- 자격 증명으로 보이는 경로(`.ssh`, `.env`, `*.pem`, `~/.codex`, 앱 저장 루트 등)와 `.git` 내부는 어떤 승인으로도 파일 도구가 건드리지 않습니다. 이름 기반 판정이라 일반 파일 안의 비밀까지 찾지는 못합니다.
- 프로젝트 파일 도구는 경로를 한 칸씩 `lstat`해 symlink·hard link를 거부합니다. 밖 도구는 링크가 가리키는 실제 대상으로 판단합니다. OS 샌드박스는 아닙니다.
- 셸은 호스트에서 격리 없이 실행됩니다. `TOKEN`·`API_KEY`처럼 비밀로 보이는 환경 변수는 명령에 넘기지 않습니다.
- ChatGPT 토큰은 codex가 관리하며 이 패키지는 읽지 않습니다.

## 개발

```bash
vp test          # 이 패키지 테스트
vp check         # 루트에서: 포맷·lint·타입 검사
```

테스트는 임시 디렉터리의 실제 SQLite·turbovec·파일 시스템과 가짜 codex app-server(`tests/support/fake-codex.mjs`)를 씁니다.
승인·auto 모드 테스트는 실제 `@tanstack/ai-client` `ChatClient`로 요청과 재개를 끝까지 주고받습니다.

`AGENT.md`도 함께 읽어 주세요.
