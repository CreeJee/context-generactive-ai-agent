# memory-agent

세션과 프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 에이전트의 서버 로직입니다.
Node 전용이며 `apps/agent`의 `.server` 모듈과 API 라우트에서만 가져다 씁니다.
브라우저에서 필요한 도구 정의만 `memory-agent/definitions`로 따로 내보냅니다.

설계 배경과 확정한 결정은 [결정 기록](../../docs/decisions.md)에 있습니다.

## 구조

```
src/
  db/           node:sqlite 연결, 마이그레이션(PRAGMA user_version), atomic()
  config/       저장 루트(~/.context-generactive-agent), 전역 설정(config.json), OS 키체인(SecretStore)
  kagi/         선택 Kagi Search·Extract 클라이언트와 켜기/끄기·키 등록
  mcp/          MCP 설정 파일(공통·프로젝트) 읽기, 신뢰, 연결, 도구 변환
  skills/       기본(이 패키지의 skills/)·~/.agents/skills·<project>/.agents/skills의 SKILL.md 목록과 읽기
  subagents/    run_subagent(일회성·이름 있는 helper): 자식 chat 실행, 병렬 시작, 승인 중계, 기록
  acp/          ACP 에이전트 다리(에디터 ↔ 실행 중인 앱 HTTP API)
  external-agents/  외부 ACP 에이전트(Codex 등) 설정·신뢰·연결·재연결 정책
  approvals/    run을 멈추지 못하는 승인 요청 중계(서브에이전트·외부 에이전트)
  runtime/      실행 시점 자원: 네이티브·임베딩 패키지를 require로 불러올 위치(실행 파일이 푼 폴더 또는 이 패키지)
  projects/     프로젝트 등록·경로 검사·교차 회상 제외·권한 모드(ask/auto)
  sessions/     프로젝트에 속한 대화
  imports/      Claude Code·Codex CLI 기록 이관: 줄 읽기 어댑터, 대량 노드 쓰기, 커서와 따라붙기
  secrets/      비밀 가리기(secretlint)와 저장된 텍스트의 소급 정리(탐지는 worker thread)
  memory/       기억: 노드·구조 edge·그래프 탐색·근거 추적·검색·기록 middleware
    embedding/  로컬 임베딩 모델(worker thread) + turbovec 벡터 인덱스 + 인덱서(벡터와 lexical 색인)
  oauth/        provider 구독 계정의 OAuth 로그인·토큰 갱신
  providers/    provider별 모델 목록·Effect AI 모델·실행 중 모델 선택
  files/        경로·자격 증명 검사, 텍스트 파일 읽기/쓰기, 목록, 줄 검색
  attachments/  업로드 이미지 저장(sha256, 바이트 서명 검사)과 메시지 연결, 첨부 URL 규칙
  shell/        호스트 셸 실행(프로세스 그룹, timeout, 출력 앞뒤 보존)
  permissions/  auto 모드: 분류 모델, 판정 기록, 게이트 middleware
  tools/        모델이 쓰는 도구 정의와 구현
  agent/        채팅 run(`AgentChat`: 실행, 복원, 취소), 노드에서 예전 대화 다시 만들기
  api/          채팅 API(Effect `HttpApi`) 정의와 페이지가 세션을 읽는 방법
  loop/         Effect AI 모델 위의 run loop: 도구 실행, 승인 interrupt, 대화·run 저장(`RunStore`)
  chat-state/   저장된 대화의 화면 메시지(페이지 읽기)와 시작할 때 run·interrupt 정리
  testing/      테스트용 어댑터·임베더
  layers.ts     모든 서비스를 저장 루트 하나로 조립하는 Effect Layer
bin/
  context-agent-acp.ts   저장소에서 쓰는 ACP 에이전트(실행 파일에서는 `context-agent acp`)
  context-agent-cli.ts   앱 없이 기억을 읽는 CLI(find-memory·read-evidence·trace-evidence)
skills/
  draw/SKILL.md          앱 기본 skill: SVG로 다이어그램·차트·와이어프레임·아이콘 그리기
```

앱 기본 skill은 `SKILL.md` 하나로 완결해야 합니다. 실행 파일에서는 저장 루트 아래에 풀리고 파일 도구가 저장 루트를 읽지 않아서, 옆에 둔 파일은 모델이 읽을 수 없습니다. 같은 이름의 공통 및 프로젝트 skill이 기본 skill을 덮어씁니다.

네이티브 패키지(turbovec, `@napi-rs/keyring`, sharp)는 정적 import하지 않고 `runtime/resources.ts`의 `requireRuntime`으로 불러옵니다. 실행 파일(Node SEA)은 디스크 파일을 `import()`하지 못하고, 이 패키지들을 `CONTEXT_AGENT_RUNTIME` 폴더에 풀어 두기 때문입니다. 임베딩 모델과 reranker(`@huggingface/transformers`)는 worker thread에서 돌고, worker 스크립트(`embed-worker.ts`, `rerank-worker.ts`)가 옆의 패키지를 직접 불러옵니다. 가져오기(`imports/worker.ts`)와 비밀 소급 정리의 탐지(`secrets/redact-worker.ts`)도 worker thread에서 돕니다. worker는 TypeScript라 저장소에서는 그대로 돌고, 실행 파일에는 worker마다 한 파일로 묶여 들어갑니다. 임베딩·rerank worker는 자기 모듈만 묶고 패키지는 runtime 폴더의 것을 씁니다. 스크립트 위치는 `runtimeWorker`가 정합니다(저장소에서는 package exports, 실행 파일에서는 runtime 폴더).

서비스는 Effect `Context.Tag` + `Layer`로 만들고, 앱은 `ManagedRuntime` 하나로 씁니다.
도구 입력 스키마는 Effect Schema이며 provider에는 `tools/schema.ts`가 만든 draft-07 JSON Schema로 보냅니다.

## 기억 모델

- 사용자, assistant, tool call, tool result를 모두 원문 그대로 `nodes`에 저장합니다(수정 불가).
- 저장할 때 구조 edge를 만듭니다: `next`(세션 순서), `reply`, `calls`, `returns`, `touches`(같은 파일/URL).
- 검색(`find_memory`)은 임베딩 벡터 순위, lexical 색인의 trigram 순위와 형태소(명사와 어간) BM25 순위를 RRF로 합친 뒤 그래프를 탐색해 결과를 확장합니다. lexical 색인은 native 검색 worker 안의 Tantivy 색인이고, 형태소는 Lindera ko-dic 분석에서 Kiwi 규칙으로 고릅니다. 노드 변경은 `lexical_changes`에 기록되고 실행이 끝날 때 반영되므로, 실행 중에 쓴 노드는 그 뒤에 글자·형태소로 찾을 수 있습니다. 임베딩은 사용자, assistant 발언과 주제 노드만 합니다(`embeddedKinds`). 도구 호출과 결과는 trigram, 형태소 순위로 찾고, 발언에서 `calls`, `returns` edge를 따라 닿습니다. 검색어가 에러 코드, 경로, 식별자처럼 무언가를 정확히 가리키면(`namesSomethingExactly`) trigram 순위를 앞에 두고 두 배로 칩니다. 벡터 순위는 관련이 없어도 늘 차 있어서, 그대로 합치면 정확히 맞은 도구 출력을 가까운 발언이 밀어냅니다.

  임베딩은 worker thread에서 처리합니다. 모델은 `src/memory/embedding/models.ts`의 모델 표에서 고르며, 지금은 EmbeddingGemma 2입니다. 긴 노드는 512토큰 창으로 나눠 임베딩하고, 토큰 길이에 따라 배치를 나눕니다. CPU 모드는 q8 모델을 CPU에서, GPU 모드는 fp16 모델을 WebGPU에서(안 되면 CPU에서) 돌리고, 자동은 GPU 모드입니다(`EmbeddingSetup`, 설정의 "기억" 탭). onnxruntime-node는 추론을 동기로 돌려서, 메인 스레드에서 돌리면 밀린 노드를 임베딩하는 동안 서버의 모든 요청이 기다립니다. 메모리 측정은 `node --expose-gc --no-warnings eval/memory.ts`. 품질 평가는 `vp run eval:recall`(두 모델이 `~/.context-generactive-agent/models`에 있어야 함).

- `read_evidence`는 원문을 페이지로 읽고, `trace_evidence`는 tool result → call → assistant → user 발언까지 거슬러 갑니다.
- 교차 프로젝트 회상은 기본 포함이며, 프로젝트별로 제외할 수 있습니다. 결과에는 출처 프로젝트 이름(`projectName`)이 붙습니다.
- `Interpreter`(llm-interpret)가 답변이 끝난 뒤 사용자, assistant 발언을 해석해 주제(`topic` 노드 + `about`), `corrects`, `retracts`, `related` edge를 붙입니다. 후보는 코드가 고르고, 정정과 취소는 사용자 발언에서만, 대상이 분명할 때만 edge가 됩니다. 모호하면 `interpretations`에 `unconfirmed`로 남아 확인 질문이 됩니다.
- 검색 결과의 `supersededBy`는 그 발언을 정정과 취소한 나중 발언, `unconfirmedChallenges`는 확인이 필요한 후보 수, `uninterpreted`는 아직 해석되지 않은 발언 수입니다. 테스트는 `tests/interpret.test.ts`.
- 인덱싱과 해석 대기열은 보낸 날짜 내림차순입니다. 이관한 노드는 `seq`가 크고 시각이 옛날이라, `seq` 순으로 두면 방금 나눈 대화를 밀어냅니다. run 뒤 뒷정리는 예산(`indexUpTo(200)`)만큼만 하고, 남은 backlog는 `Importer`의 전용 fiber가 비웁니다.

## 다른 에이전트 대화 이관 (imports/)

Claude Code(`~/.claude/projects/**/*.jsonl`)와 Codex CLI(`~/.codex/sessions/**/rollout-*.jsonl`)의 로컬 기록을 노드로 옮깁니다. 원본은 읽기만 합니다.

- 줄 하나를 `TranscriptItem`(리터럴 태그 유니온: `session`, `message`, `tool_call`, `tool_result`, `ignored`)으로 읽습니다. 새 출처는 어댑터 파일 하나 + `ImportSourceName` 태그 하나입니다.
- `BulkNodes`가 대화 하나를 한 트랜잭션에 직접 INSERT하며, 줄의 원래 `timestamp`를 `created_at`에 씁니다. 구조 edge와 `interpret_jobs`는 라이브와 같은 규칙입니다. `Nodes.append`는 라이브 전용으로 그대로 둡니다.
- `Importer`가 `import_cursors`의 byte offset부터 읽고, 마지막 개행까지만 소비합니다(실행 중인 에이전트가 쓰는 중인 꼬리 줄을 반으로 읽지 않기 위해). 중복은 `imported_nodes`가 막습니다.
- 기록의 `cwd`를 프로젝트로 자동 등록합니다. 숨긴 프로젝트에도 기록을 연결하므로 같은 폴더가 두 번 등록되지 않습니다. 등록할 수 없는 폴더는 `import_cursors.skipped`에 이유와 함께 남습니다. 앱 저장 루트 아래 기록은 읽지 않습니다.
- 프로젝트는 목록에서 뺄 수 있습니다(`Projects.setHidden`, `projects.hidden_at`). `list`는 보이는 프로젝트만 반환하고, `listAll`은 숨긴 프로젝트까지 반환합니다. 기억, 검색은 숨겨도 그대로입니다.
- 설정 화면의 "가져오기" 탭에서 켜면 5분마다 새 기록을 가져옵니다(`config.json`의 `importsEnabled`). 이관은 모델 도구가 아닙니다. 테스트는 `tests/import-readers.test.ts`, `tests/imports.test.ts`.

## 도구와 권한

| 도구                                                             | 승인 | 비고                                                                        |
| ---------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `find_memory`, `read_evidence`, `trace_evidence`                 | 없음 | 보이지 않는 프로젝트의 노드는 숨김                                          |
| `list_files`, `search_files`, `read_file`                        | 없음 | 프로젝트 상대 경로, Git 프로젝트는 ignore 반영                              |
| `write_file`, `edit_file`, `delete_file`                         | 없음 | 읽을 때 받은 sha256이 같을 때만 변경                                        |
| `list_outside_files`, `read_outside_file`, `search_outside_file` | 없음 | 프로젝트 밖 절대 경로, 읽기 전용                                            |
| `save_code_skill`, `write_outside_file`, `delete_outside_file`   | 필요 | 권한 모드에 따라 승인                                                       |
| `run_skill`                                                      | 없음 | 승인된 프로그램만. ts는 코드 샌드박스에서, sh는 샌드박스·승인 호스트 안에서 |
| `run_code`                                                       | 없음 | 모델이 쓴 TS 프로그램, 묻지 않는 도구만 함수로 부름                         |
| `kagi_search`, `kagi_extract`                                    | 없음 | Kagi 키 등록 후 켰을 때만 보임, 호출마다 과금                               |
| `mcp_<서버>__<도구>`                                             | 필요 | 신뢰한 MCP 서버의 도구, 호출마다 게이트                                     |
| `read_skill`                                                     | 없음 | skill이 있을 때만, 본문은 지침이지 권한 아님                                |
| `run_subagent`                                                   | 없음 | 자식의 승인 필요 호출은 페이지에서 따로 승인                                |
| `delegate_to_agent`                                              | 필요 | 신뢰한 외부 ACP 에이전트에 작업 위임                                        |

권한 모드는 프로젝트마다 고릅니다.

- `ask`(기본): 승인이 필요한 호출마다 run이 멈추고 사용자가 답합니다(`needsApproval`).
- `auto`: `PermissionGate` middleware가 실행 직전 호출을 `PermissionClassifier`에 보냅니다.
  분류 모델(선택한 모델의 가장 낮은 추론 강도, 도구 없는 일회용 스레드)이 `allow`/`ask`/`block`을 판정합니다.
  - 입력은 호출 내용, DB에 저장된 실제 사용자 발언, 프로젝트 경로뿐입니다. 도구 결과, 파일 내용은 넣지 않습니다.
  - `ask`면 `permission-review` interrupt로 사용자에게 묻고, 답은 재개할 때 기록합니다.
  - 분류 실패, timeout, 읽을 수 없는 답은 `ask`로 처리합니다.
  - 판정과 사용자 답은 `permission_reviews`에 쌓이고, tool result 노드 `detail.permission`에 근거로 남습니다.

MCP 도구는 실행 중에 생기므로 브라우저가 정의를 모릅니다. 그래서 `ask` 모드에서도 `PermissionGate`(decider `user`)가 호출마다 `permission-review` interrupt로 묻고, `auto` 모드에서는 내장 승인 도구와 함께 분류 모델이 판정합니다.
`McpServers`는 `<storage>/mcp.json`과 `<project>/.mcp.json`을 읽고, 사용자가 신뢰한 설정(fingerprint)만 시작합니다. 테스트는 `tests/mcp.test.ts`(가짜 stdio MCP 서버 `tests/support/fake-mcp-server.ts`).

`Subagents`는 자식을 부모와 같은 모델, 도구(서브에이전트 도구 제외)로 실행합니다. 자식의 승인 필요 호출은 부모 run을 멈추지 않고 `onBeforeToolCall`에서 기다리며, 페이지가 `AgentChat.approvals`/`answerApproval`(`RelayedApprovals`)로 보고 답합니다. 테스트는 `tests/subagents.test.ts`.

승인으로 모델 호출이 멈추면 durable run에 저장된 대화와 interrupt로 재개합니다.

## 대화 상태와 새로고침

- 대화 threadId는 항상 세션 id입니다(클라이언트가 보낸 값은 무시).
- `RunStore`(`loop/store.ts`)가 run마다 대화(`StoredMessage`), run 상태, interrupt, metadata, 턴 요약을 SQLite(`chat_threads`, 메시지 한 개당 한 행인 `chat_thread_messages`, `chat_runs`, `chat_interrupts`, `chat_metadata`, `turn_summary_blocks`)에 저장합니다.
- 새로고침한 페이지는 `GET /api/sessions/:session/messages`(채팅 API의 `snapshot`)로 최근 대화 페이지와 진행 중인 run, 대기 중인 승인을 되살립니다. 다른 세션의 thread는 읽을 수 없습니다.
- 이 저장소는 화면 복원용이고 기억의 원본은 여전히 `nodes`입니다. chat state가 없는 예전 세션은 노드에서 대화를 다시 만들어 엽니다.
- 테스트는 `tests/loop/store.test.ts`, `tests/chat/history.test.ts`.

## 실행 중 새로고침, 취소, 재시작

- run은 HTTP 요청과 독립적으로 실행됩니다. run 이벤트는 run 로그(`workflow/durable-stream.ts`)에 먼저 쓰이고, 새로고침한 페이지는 `GET /api/sessions/:session/runs/:run/events`로 처음부터 다시 읽으며 따라갑니다. 모델을 다시 호출하지 않습니다.
- `LiveRuns`가 세션마다 진행 중인 run 하나를 들고 있습니다. 같은 세션의 두 번째 run은 409이고, 취소(`AgentChat.cancel`)는 여기서 run을 찾아 `requestRunCancel` 후 `RUN_CANCEL_REASON`으로 abort합니다. provider 어댑터가 abort 신호를 처리합니다.
- `AgentChat.status`는 진행 중인 run과 마지막 run의 상태, 오류를 돌려줍니다(`SessionRunState`).
- `ChatState`가 만들어질 때 `running`으로 남은 run은 `failed`/`server_restarted`로 바뀝니다. 다시 실행하지 않습니다.
- 작성 중인 답변은 1초마다 스냅샷으로 저장하며, 취소하거나 실패하면 즉시 저장합니다.
- `SessionLeases`는 세션마다 쓰기 가능한 페이지(holder) 하나를 메모리에 둡니다(`claim`, `release`, `permits`, `view`). `AgentChat.handle`, `cancel`은 `X-Session-Holder`가 소유자가 아니면 423을 돌려주고, `AgentChat.lease`가 claim/release를, `status`가 요청한 페이지 기준 `LeaseView`(`mine`, `other`, `free`)를 돌려줍니다. 테스트는 `tests/leases.test.ts`.
- `MessageQueue`는 답변 중에 보낸 메시지를 순서대로 둡니다(`waiting`, `editing`, `held`, `delivered`, `failed`). `deliverable`은 앞에서부터 `waiting`만 돌려주고 편집 중이거나 확인이 필요한 메시지에서 멈춥니다. 새 프로세스는 남은 `waiting`/`editing`을 `held`로 바꿉니다.
- `QueueDelivery.forRun` middleware는 도구 결과 뒤(`beforeModel`) 대기 메시지를 provider의 live-turn steering과 대화에 함께 넣고 사용자 노드로 기록합니다. `steer`를 지원하지 않는 provider에서는 다음 모델 요청의 대화로 전달합니다.
- `AgentChat.enqueue`, `editQueued`, `queued`가 대기열 API입니다. 조회는 `{ items, nextDelivery }`를 돌려줍니다. 답변이 정상으로 끝나면 서버가 대기열의 첫 메시지를 선택·예약해 다음 턴으로 보냅니다. 편집 저장·제거·확인 뒤에도 도는 run이 없으면 서버가 다시 봅니다. 전달 가능한 묶음은 도구 경계에서만 계산합니다. run이 취소·실패로 끝나면 남은 메시지를 `held`로 둡니다. 테스트는 `tests/queue.test.ts`, `tests/queue-next-turn.test.ts`.
- 테스트(`tests/chat/`)는 채팅 API를 쓰는 탭(`tests/support/chat-client.ts`)으로 중간 새로고침 후 이어 읽기, 취소, 동시 run 거절, 재시작 후 실패 기록, 재시작을 넘긴 승인을 확인합니다.

## 이미지

- 앱이 올린 이미지는 `Attachments`가 `<storage>/attachments/<sha256>`에 저장하고, 사용자 노드에 순서대로 연결합니다(`node_attachments`).
- 채팅 요청의 이미지 파트는 `/api/attachments/<id>` URL로만 받습니다. 모르는 첨부는 400, 이미지를 못 읽는 모델은 422입니다.
- provider에는 이번 턴 이미지의 파일 경로와 이전 턴 이미지의 `data:` URL을 어댑터가 지원하는 형식으로 넘깁니다.
- 본문의 `#1`은 첫 번째 첨부 이미지를 뜻한다고 모델 지침에 적어 둡니다. 대화 기록 API는 사용자 메시지에 이미지 파트를 다시 붙입니다.

## 보안 경계

- 자격 증명으로 보이는 경로(`.ssh`, `.env`, `*.pem`, `~/.codex`, 앱 저장 루트 등)와 `.git` 내부는 어떤 승인으로도 파일 도구가 건드리지 않습니다. 이름 기반 판정이라 일반 파일 안의 비밀은 아래 탐지기가 맡습니다.
- 출력에 찍힌 비밀은 `SecretRedactor`(`secrets/redactor.ts`, secretlint + 비밀처럼 보이는 이름 옆의 값)가 `[redacted:<종류>]`로 가립니다. 모든 도구 결과와 에러 메시지는 모델, 페이지, 노드에 닿기 전에, assistant 글, 도구 인자, 참조, 사용자 발언, 이관 기록은 기억에 남기 전에 가립니다. 모델은 사용자가 보낸 메시지를 그대로 읽습니다.
- 이미 저장된 텍스트는 `SecretSweep`(`secrets/sweep.ts`)이 시작할 때마다 백그라운드에서 훑습니다. 노드는 `secret_sweep_permits` 허가가 있을 때만 `text`가 바뀌고(트리거가 나머지 변경은 계속 거부), lexical 색인과 벡터도 새 텍스트로 다시 만듭니다. secretlint 검사는 사이사이 이벤트 루프에 차례를 주지 않아서, 탐지는 스윕마다 띄우는 redaction worker가 배치 단위로 하고 DB 읽기와 쓰기와 벡터 정리는 메인에 남습니다. 테스트는 `tests/secret-redactor.test.ts`, `tests/secret-redaction.test.ts`, `tests/secret-sweep.test.ts`.
- 프로젝트 파일 도구는 경로를 한 칸씩 `lstat`해 symlink, hard link를 거부합니다. 밖 도구는 링크가 가리키는 실제 대상으로 판단합니다. OS 샌드박스는 아닙니다.
- 셸은 호스트에서 격리 없이 실행됩니다. `TOKEN`, `API_KEY`처럼 비밀로 보이는 환경 변수는 명령에 넘기지 않습니다.
- provider OAuth 자격 증명은 인증 서비스가 관리하며 파일 도구에 노출하지 않습니다.
- Kagi API 키는 `SecretStore`(OS 키체인)에만 저장하고 요청 직전에 읽습니다. 키체인이 실패해도 다른 곳에 저장하지 않습니다. 테스트는 `SecretStore.memory`를 씁니다.

## 에디터에서 쓰기 (ACP)

앱을 실행한 채로, 에디터가 `bin/context-agent-acp.ts`를 ACP 에이전트로 실행하게 합니다. Node 24가 TypeScript를 바로 실행합니다.
Zed 예시(`settings.json`):

```json
{
  "agent_servers": {
    "Context Agent": {
      "command": "node",
      "args": [
        "/절대/경로/context-generactive-agent/packages/memory-agent/bin/context-agent-acp.ts"
      ],
      "env": { "CONTEXT_AGENT_URL": "http://127.0.0.1:5173" }
    }
  }
}
```

- 에디터에서 연 폴더가 앱에 등록된 프로젝트여야 합니다.
- 대화는 앱의 대화 목록에도 보이고, 기억, 승인, 취소가 앱과 같습니다. 승인은 에디터의 권한 질문으로 뜹니다.
- 테스트는 `tests/acp-agent.test.ts`(SDK 클라이언트 ↔ 다리 ↔ 앱 핸들러를 한 프로세스에서 연결).

## 터미널에서 기억 읽기 (CLI)

앱이 떠 있든 아니든 저장소를 **읽기 전용**으로 직접 열어 기억을 읽습니다. 마이그레이션도, 쓰기도, 앱이 쥔 잠금 선점도 하지 않습니다. 진입은 둘이고 명령 정의는 `src/cli/commands.ts` 하나를 같이 씁니다.

```sh
# 실행 파일에서
context-agent memory find-memory "메모리 검색 결정" --limit 5
context-agent memory projects

# 저장소에서 (개발 중)
node packages/memory-agent/bin/context-agent-cli.ts read-evidence <노드-id> --offset 0
node packages/memory-agent/bin/context-agent-cli.ts trace-evidence <노드-id>
```

| 명령             | 하는 일                                   | 대응 도구        |
| ---------------- | ----------------------------------------- | ---------------- |
| `find-memory`    | 저장된 기억 검색                          | `find_memory`    |
| `read-evidence`  | 노드 원문 페이지와 출처·정정 이력         | `read_evidence`  |
| `trace-evidence` | 발언을 일으킨 사용자 턴까지 거슬러 올라감 | `trace_evidence` |
| `projects`       | 저장소의 프로젝트 목록(id·이름·root·숨김) | (발견용)         |

### 프로젝트 고르기

다른 에이전트는 프로젝트 id를 모르므로, 이 순서로 해석합니다.

1. `--project-id <id>` — 정확히 그 id
2. `--project <경로|이름>` — 경로꼴이면 `realPath`로 정규화해 등록된 root와 맞춰 보고, 정확히 같은 root가 없으면 **그 경로를 품는 가장 깊은** 등록 root를 씁니다. 경로꼴이 아니면 이름으로 찾습니다.
3. 아무것도 없으면 **현재 작업 디렉터리에서 부모로 올라가며** 등록된 root 중 가장 깊은 것
4. 그래도 없으면 거부합니다: `{"error":{"code":"project_not_found","detail":{"cwd":…,"hint":…}}}`. 전역 검색으로 넘어가지 않습니다. 어떤 프로젝트가 있는지는 `projects`로 봅니다.

숨긴 프로젝트도 해석 대상입니다(기억은 숨겨도 남아 있습니다).

### 플래그와 출력

- `--storage <경로>`: 읽을 저장소 폴더. 없으면 `$CONTEXT_AGENT_HOME`, 그것도 없으면 `~/.context-generactive-agent`.
- `--this-project-only`: 해석된 프로젝트 안에서만 읽습니다. 기본은 교차 프로젝트(앱의 `find_memory`와 같은 기본값).
- `--limit`(find-memory), `--offset`(read-evidence).
- 성공은 stdout에 JSON 한 줄, 종료 코드 0입니다. 거부는 stderr에 `{"error":{"code":…,"detail":…}}` 한 줄과 종료 코드 2이고, 코드는 `storage_not_found`, `storage_schema_unsupported`, `project_not_found`, `node_not_found`, `unexpected`입니다.

`context-agent`의 첫 인자는 열 폴더 경로라서, `acp`와 `memory`는 그 자리에서 예약어입니다. 그 이름의 폴더를 열려면 `./memory`처럼 적으세요.

### 앱과 동시에 읽기

앱이 같은 저장소를 열어 둔 채여도 읽을 수 있습니다. SQLite는 WAL이라 읽기 전용 연결이 동시에 열리고, 벡터 색인은 쓰기 lease 없이 적재합니다. 다만 lexical 색인(Tantivy)은 앱이 writer lock을 쥐고 있어 열 수 없으므로, 그때는 글자·형태소 채널을 끄고 벡터 채널만으로 검색합니다. 임베딩 모델이 없으면 벡터 채널도 빠집니다(기존 `degraded` 계약).

조립은 `src/cli/read-only-storage.ts`, 프로젝트 해석은 `src/cli/project-reference.ts`, 테스트는 `tests/cli/`입니다.

## 터미널에서 대화 가져오기 (CLI import)

앱을 한 번도 안 띄운 사람도 다른 에이전트(Claude Code·Codex)의 대화를 기억으로 가져올 수 있습니다. 조회 명령과 달리 이쪽은 **쓰기**라서, 앱이 쓰는 `<저장소>/backend.lock`을 같이 잡습니다.

```sh
# 가져오고 색인까지 (저장소가 없으면 만들고 마이그레이션합니다)
context-agent memory import

# 가져오기만 하고 색인은 나중에
context-agent memory import --no-index

# 지금까지 뭐가 들어왔는지 (잠금 없이, 앱이 떠 있어도 됩니다)
context-agent memory import-status
```

| 명령            | 하는 일                                                   | 잠금            |
| --------------- | --------------------------------------------------------- | --------------- |
| `import`        | 트랜스크립트를 기억으로 옮기고, 임베딩·색인까지 돌립니다  | `backend.lock`  |
| `import-status` | 소스별 트랜스크립트·가져온 수·실패·미색인 백로그를 봅니다 | 없음(읽기 전용) |

- `--interpret`: 가져온 대화를 **해석**(LLM 호출) 대상으로 둡니다. 기본은 꺼져 있습니다 — CLI에는 프로바이더 로그인이 없기 때문입니다. 이 플래그는 이번 실행에만 설정을 바꾸고, 끝나면 원래 값으로 되돌립니다.
- `--no-index`: 색인을 건너뜁니다. 결과의 `indexed.skipped`가 `true`가 되고, `unindexed`에 남은 수가 보입니다.
- `--imports-home <경로>`: `.claude`·`.codex`를 찾을 홈 폴더. 기본은 사용자 홈입니다.
- `--storage <경로>`: 조회 명령과 같습니다(`$CONTEXT_AGENT_HOME` → `~/.context-generactive-agent`).
- 진행은 stderr에 사람이 읽는 줄로, 결과는 stdout에 JSON 한 줄로 나옵니다: `{"storage":…,"pass":{"checked":…,"total":…,"written":…,"failed":…},"interpret":false,"indexed":{"skipped":false,"reason":null,"unindexed":0},"sources":[…],"unplaced":[…],"failures":[…]}`.
- 임베딩 모델이 없으면 받아서 색인합니다. 받지 못하면 **가져오기는 이미 끝났으므로** 거부하지 않고 종료 코드 0으로 끝내되, `indexed.reason`과 `unindexed`에 남은 백로그를 적습니다.
- 거부 코드가 하나 늘었습니다: 앱(또는 다른 CLI)이 저장소를 쥐고 있으면 `storage_locked`(detail에 그쪽 `port`·`instanceId`·`pid`)로 거부하고 종료 코드 2입니다. 저장소를 빼앗지 않습니다. 앱이 켜져 있다면 앱이 알아서 가져오므로, 앱을 닫고 다시 실행하면 됩니다. 그 밖에 `storage_lock_failed`, `storage_open_failed`, `import_failed`가 있습니다.

조립은 `src/cli/writable-storage.ts`(잠금 → 마이그레이션 → 임포트·색인에 필요한 레이어만), 패스 실행은 `src/cli/import-run.ts`, 읽기 전용 현황은 `src/cli/import-status.ts`, 잠금 자체는 `src/runtime/storage-lock.ts`(앱 서버도 같은 것을 씁니다)입니다.

## 외부 에이전트 부르기 (ACP 클라이언트)

`<프로젝트>/.agents/agents.json`(또는 `~/.context-generactive-agent/agents.json`):

```json
{
  "agents": {
    "codex": { "command": "npx", "args": ["-y", "@zed-industries/codex-acp@0.16.0"] }
  }
}
```

설정 화면 "에이전트" 탭에서 신뢰하면 모델이 `delegate_to_agent`로 작업을 맡길 수 있고, `agent`를 지정해 만든 대화는 `ExternalAgentAdapter`로 그 에이전트와 직접 나눕니다(관련 기억 머리말, 답 노드에 `detail.externalAgent`). 에이전트는 자기 로그인(`codex login`)을 씁니다. 테스트는 `tests/external-agents.test.ts`(가짜 ACP 에이전트 `tests/support/fake-acp-agent.ts`).

## 개발

```bash
vp test          # 이 패키지 테스트
vp test bench --dir bench   # 도구 지연 측정(합성 저장소 3,000 파일)
vp check         # 루트에서: 포맷·lint·타입 검사
```

테스트는 임시 디렉터리의 실제 SQLite, turbovec, 파일 시스템을 씁니다.
승인, auto 모드 테스트는 채팅 API를 쓰는 탭(`tests/support/chat-client.ts`)으로 요청과 재개를 끝까지 주고받습니다.

추가 지침은 `AGENT.md`에 있습니다.

## Interface
