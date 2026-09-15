# memory-agent

세션·프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 에이전트의 서버 로직입니다.
Node 전용이며 `apps/agent`의 `.server` 모듈과 API 라우트에서만 가져다 씁니다.
브라우저에서 필요한 도구 정의만 `memory-agent/definitions`로 따로 내보냅니다.

설계 배경과 확정 결정은 [결정 기록](../../docs/decisions.md)을 보세요.

## 구조

```
src/
  db/           node:sqlite 연결, 마이그레이션(PRAGMA user_version), atomic()
  config/       저장 루트(~/.context-generactive-agent), 전역 설정(config.json), OS 키체인(SecretStore)
  kagi/         선택 Kagi Search·Extract 클라이언트와 켜기/끄기·키 등록
  mcp/          MCP 설정 파일(공통·프로젝트) 읽기, 신뢰, 연결, 도구 변환
  projects/     프로젝트 등록·경로 검사·교차 회상 제외·권한 모드(ask/auto)
  sessions/     프로젝트에 속한 대화
  memory/       기억: 노드·구조 edge·그래프 탐색·근거 추적·검색·기록 middleware
    embedding/  로컬 임베딩 모델 + turbovec 벡터 인덱스 + 인덱서
  codex/        ChatGPT 계정(codex app-server): 로그인·모델·TanStack 어댑터
  files/        경로·자격 증명 검사, 텍스트 파일 읽기/쓰기, 목록, 줄 검색
  attachments/  업로드 이미지 저장(sha256, 바이트 서명 검사)과 메시지 연결, 첨부 URL 규칙
  shell/        호스트 셸 실행(프로세스 그룹, timeout, 출력 앞뒤 보존)
  permissions/  auto 모드: 분류 모델, 판정 기록, 게이트 middleware
  tools/        모델이 쓰는 도구 정의와 구현
  agent/        /api/chat 핸들러(POST 실행, GET 복원), 저장된 대화를 UIMessage로 변환
  chat-state/   TanStack AI persistence의 SQLite 저장소(대화·run·interrupt·metadata)
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
- 교차 프로젝트 회상은 기본 포함이며, 프로젝트별로 제외할 수 있습니다. 결과에는 출처 프로젝트 이름(`projectName`)이 붙습니다.
- `Interpreter`(llm-interpret)가 답변이 끝난 뒤 사용자·assistant 발언을 해석해 주제(`topic` 노드 + `about`), `corrects`·`retracts`·`related` edge를 붙입니다. 후보는 코드가 고르고, 정정·취소는 사용자 발언에서만, 대상이 분명할 때만 edge가 됩니다. 모호하면 `interpretations`에 `unconfirmed`로 남아 확인 질문이 됩니다.
- 검색 결과의 `supersededBy`는 그 발언을 정정·취소한 나중 발언, `unconfirmedChallenges`는 확인이 필요한 후보 수, `uninterpreted`는 아직 해석되지 않은 발언 수입니다. 테스트는 `tests/interpret.test.ts`(가짜 codex가 표식으로 해석 결과를 흉내 냄).

## 도구와 권한

| 도구                                                             | 승인 | 비고                                           |
| ---------------------------------------------------------------- | ---- | ---------------------------------------------- |
| `find_memory`, `read_evidence`, `trace_evidence`                 | 없음 | 보이지 않는 프로젝트의 노드는 숨김             |
| `list_files`, `search_files`, `read_file`                        | 없음 | 프로젝트 상대 경로, Git 프로젝트는 ignore 반영 |
| `write_file`, `edit_file`, `delete_file`                         | 없음 | 읽을 때 받은 sha256이 같을 때만 변경           |
| `list_outside_files`, `read_outside_file`, `search_outside_file` | 없음 | 프로젝트 밖 절대 경로, 읽기 전용               |
| `run_shell`, `write_outside_file`, `delete_outside_file`         | 필요 | 권한 모드에 따라 승인                          |
| `kagi_search`, `kagi_extract`                                    | 없음 | Kagi 키 등록 후 켰을 때만 보임, 호출마다 과금  |
| `mcp_<서버>__<도구>`                                             | 필요 | 신뢰한 MCP 서버의 도구, 호출마다 게이트        |

권한 모드는 프로젝트마다 고릅니다.

- `ask`(기본): 승인이 필요한 호출마다 TanStack이 멈추고 사용자가 답합니다(`needsApproval`).
- `auto`: `PermissionGate` middleware가 실행 직전 호출을 `PermissionClassifier`에 보냅니다.
  분류 모델(선택한 모델의 가장 낮은 추론 강도, 도구 없는 일회용 스레드)이 `allow`/`ask`/`block`을 판정합니다.
  - 입력은 호출 내용, DB에 저장된 실제 사용자 발언, 프로젝트 경로뿐입니다. 도구 결과·파일 내용은 넣지 않습니다.
  - `ask`면 `permission-review` interrupt로 사용자에게 묻고, 답은 재개할 때 기록합니다.
  - 분류 실패·timeout·읽을 수 없는 답은 `ask`로 처리합니다.
  - 판정과 사용자 답은 `permission_reviews`에 쌓이고, tool result 노드 `detail.permission`에 근거로 남습니다.

MCP 도구는 실행 중에 생기므로 브라우저가 정의를 모릅니다. 그래서 `ask` 모드에서도 `PermissionGate`(decider `user`)가 호출마다 `permission-review` interrupt로 묻고, `auto` 모드에서는 내장 승인 도구와 함께 분류 모델이 판정합니다.
`McpServers`는 `<storage>/mcp.json`과 `<project>/.mcp.json`을 읽고, 사용자가 신뢰한 설정(fingerprint)만 시작합니다. 테스트는 `tests/mcp.test.ts`(가짜 stdio MCP 서버 `tests/support/fake-mcp-server.mjs`).

승인 대기로 HTTP 요청이 끝나도 codex 턴은 `TurnParking`에 threadId로 보관되어, 재개 요청이 같은 턴을 이어갑니다.

## 대화 상태와 새로고침

- TanStack 대화 threadId는 항상 세션 id입니다(클라이언트가 보낸 값은 무시).
- `ChatState`가 `@tanstack/ai-persistence`의 `withPersistence` middleware로 run마다 대화(ModelMessage)·run 상태·interrupt를 SQLite(`chat_threads`, `chat_runs`, `chat_interrupts`, `chat_metadata`)에 저장합니다.
- 새로고침한 페이지는 `useChat({ persistence: true })`가 `GET /api/chat`으로 `reconstructChat` 결과를 받아 대화와 대기 중인 승인을 되살립니다. 다른 세션의 thread는 읽을 수 없습니다.
- 이 저장소는 화면 복원용이고 기억의 원본은 여전히 `nodes`입니다. chat state가 없는 예전 세션은 노드에서 대화를 다시 만들어 엽니다.
- 저장소 계약은 `@tanstack/ai-persistence/testkit`의 conformance 테스트로 확인합니다.

## 실행 중 새로고침·취소·재시작

- run은 요청과 떨어져 돕니다. 답변 chunk는 delivery durability 로그(`memoryStream`)에 먼저 쓰이고, 새로고침한 페이지는 `GET /api/chat?runId=&offset=-1`로 처음부터 다시 읽으며 따라갑니다. codex를 다시 부르지 않습니다.
- `LiveRuns`가 세션마다 진행 중인 run 하나를 들고 있습니다. 같은 세션의 두 번째 run은 409이고, 취소(`AgentChat.cancel`)는 여기서 run을 찾아 `requestRunCancel` 후 `RUN_CANCEL_REASON`으로 abort합니다. codex 어댑터는 abort 신호에 `turn/interrupt`로 답합니다.
- `AgentChat.status`는 진행 중인 run과 마지막 run의 상태·오류를 돌려줍니다(`SessionRunState`).
- `ChatState`가 만들어질 때 `running`으로 남은 run은 `failed`/`server_restarted`로 바뀝니다. 다시 실행하지 않습니다.
- 쓰던 답변은 1초마다 스냅샷되고, 취소·실패 때 바로 저장됩니다.
- `SessionLeases`는 세션마다 쓰기 가능한 페이지(holder) 하나를 메모리에 둡니다(`claim`·`release`·`permits`·`view`). `AgentChat.handle`·`cancel`은 `X-Session-Holder`가 소유자가 아니면 423을 돌려주고, `AgentChat.lease`가 claim/release를, `status`가 요청한 페이지 기준 `LeaseView`(`mine`·`other`·`free`)를 돌려줍니다. 테스트는 `tests/leases.test.ts`.
- `MessageQueue`는 답변 중에 보낸 메시지를 순서대로 둡니다(`waiting`·`editing`·`held`·`delivered`·`failed`). `deliverable`은 앞에서부터 `waiting`만 돌려주고 편집 중이거나 확인이 필요한 메시지에서 멈춥니다. 새 프로세스는 남은 `waiting`/`editing`을 `held`로 바꿉니다.
- `QueueDelivery.forRun` middleware는 도구 결과 뒤(`beforeModel`) 대기 메시지를 codex `turn/steer`와 대화에 함께 넣고 사용자 노드로 기록합니다. `steer`는 답변 중인 턴에 바로 넣습니다(`CodexChat.steer`, `ActiveTurns`).
- `AgentChat.enqueue`·`editQueued`·`queued`가 대기열 API이고, 소유 페이지가 `forwardedProps.queuedMessageId`로 다음 턴을 보내면 `handle`이 그 메시지를 전달됨으로 표시합니다. run이 끝날 때(`LiveRuns` onEnded) 취소·실패·소유 페이지 없음이면 `held`로 둡니다. 테스트는 `tests/queue.test.ts`.
- 테스트(`tests/runs.test.ts`)는 실제 `ChatClient`로 중간 새로고침 후 이어 읽기, 취소, 동시 run 거절, 재시작 후 실패 기록, 재시작을 넘긴 승인을 확인합니다.

## 이미지

- 앱이 올린 이미지는 `Attachments`가 `<storage>/attachments/<sha256>`에 저장하고, 사용자 노드에 순서대로 연결합니다(`node_attachments`).
- 채팅 요청의 이미지 파트는 `/api/attachments/<id>` URL로만 받습니다. 모르는 첨부는 400, 이미지를 못 읽는 모델은 422입니다.
- codex에는 이번 턴 이미지를 `localImage`(파일 경로), 이전 턴 이미지를 `input_image`(data URL)로 넘깁니다.
- 본문의 `#1`은 첫 번째 첨부 이미지를 뜻한다고 모델 지침에 적어 둡니다. 대화 기록 API는 사용자 메시지에 이미지 파트를 다시 붙입니다.

## 보안 경계

- 자격 증명으로 보이는 경로(`.ssh`, `.env`, `*.pem`, `~/.codex`, 앱 저장 루트 등)와 `.git` 내부는 어떤 승인으로도 파일 도구가 건드리지 않습니다. 이름 기반 판정이라 일반 파일 안의 비밀까지 찾지는 못합니다.
- 프로젝트 파일 도구는 경로를 한 칸씩 `lstat`해 symlink·hard link를 거부합니다. 밖 도구는 링크가 가리키는 실제 대상으로 판단합니다. OS 샌드박스는 아닙니다.
- 셸은 호스트에서 격리 없이 실행됩니다. `TOKEN`·`API_KEY`처럼 비밀로 보이는 환경 변수는 명령에 넘기지 않습니다.
- ChatGPT 토큰은 codex가 관리하며 이 패키지는 읽지 않습니다.
- Kagi API 키는 `SecretStore`(OS 키체인)에만 저장하고 요청 직전에 읽습니다. 키체인이 실패해도 다른 곳에 저장하지 않습니다. 테스트는 `SecretStore.memory`를 씁니다.

## 개발

```bash
vp test          # 이 패키지 테스트
vp check         # 루트에서: 포맷·lint·타입 검사
```

테스트는 임시 디렉터리의 실제 SQLite·turbovec·파일 시스템과 가짜 codex app-server(`tests/support/fake-codex.mjs`)를 씁니다.
승인·auto 모드 테스트는 실제 `@tanstack/ai-client` `ChatClient`로 요청과 재개를 끝까지 주고받습니다.

`AGENT.md`도 함께 읽어 주세요.
