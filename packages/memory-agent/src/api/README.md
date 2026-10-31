# api

## Overview

이 디렉터리는 채팅 HTTP API 계약 `ChatApi`와 그 구현, 그리고 채팅 밖의 앱 API 계약 `AppApi`(`docs/httpapi-migration.md`)를 담는다. 페이지의 Effect 클라이언트와 서버가 이 계약을 함께 쓴다. `AppApi`의 핸들러는 앱(`apps/agent/app/.server/api/`)에 있다. 계약은 `effect/http-api`로 한 번만 선언한다(`docs/effect-ai-migration.md` step 6). 서버 쪽 `chat-api-live.ts`는 `AgentChat`·`BtwChat` 서비스 위에 핸들러를 구현하고, run의 AG-UI 이벤트를 SSE로 스트리밍한다. 클라이언트 쪽 `chat-session.ts`·`btw-thread.ts`·`chat-view.ts`는 서버 코드를 import하지 않는다. 이 파일들은 세션과 BTW 스레드의 Atom 묶음을 id별로 노출하고, 페이지는 이 Atom을 `@effect/atom-react`로 읽는다. 묶음은 `keptAtomGroups`가 페이지 수명 동안 강하게 쥔다. `Atom.family`는 만든 값을 약하게만 쥐어서, 아무도 쥐지 않는 묶음은 GC 뒤 새 Atom(빈 화면, 처음부터 다시 읽는 `open`)으로 바뀐다.

## Interface

- `ChatApi` — `chat` 그룹과 `btw` 그룹을 묶은 HttpApi 계약(서버·브라우저 공용)
- `ChatGroup` — `snapshot` GET /api/sessions/:session/messages, `run` POST /api/sessions/:session/runs(SameSite, x-session-holder 헤더), `join` GET /api/sessions/:session/runs/:run/events?after
- `BtwGroup` — `messages` GET /api/btw/:thread/messages, `ask` POST /api/btw/:thread/runs(SameSite)
- `SameSite` — 다른 사이트가 보낸 변경 요청을 403(`cross_site_request`/`invalid_origin`)으로 거부하는 HttpApiMiddleware 서비스 태그(PRD R14). `refusal.ts`에 있고 `chat-api.ts`가 다시 내보낸다
- `refusalWith(fields)(status, codes)` / `refusalStatusIn(refusals)` / `appRefusalFields` — 거부 스키마(`{ error, ...fields }` + `httpApiStatus`)를 만드는 함수, 거부 값에 맞는 스키마의 상태를 찾는 함수(못 찾으면 500), 앱 API 거부가 싣는 `reason?`(`refusal.ts`)
- `Refusal` / `refusalStatus` — 채팅 API의 400~503 상태별 거부 코드 리터럴 union 스키마와 그 상태 함수
- `AppApi` — 채팅 밖의 앱 API 계약(`app-api.ts`). group은 `app-api/<group>.ts`에 있다
- `SettingsGroup` — `conversation`/`setConversation`, `recall`/`setRecall`, `kanban`/`setKanban`, `kagi`/`kagiAction`, `embedding`/`embeddingAction`, `image`/`imageAction`, `imports`/`importAction`, `improvements`/`improvementScan`(GET·POST /api/settings/*, 모두 SameSite). 계약 타입 `ConversationSettings`, `RecallSettings`, `KanbanSettings`, `KanbanSettingsCommand`, `KagiCommand`, `EmbeddingCommand`, `ImageSettings`, `ImageSettingsCommand`, `ImportCommand`, `ImprovementStatus`, `ScanCommand`. 거부를 선언하지 않은 embedding·image·imports의 실패는 지금처럼 500이다
- `ProjectsGroup` — `list` GET /api/projects(`?hidden=1`은 보관한 프로젝트), `add` POST /api/projects(201, 422 `project_rejected`+`reason`), `pick` POST /api/projects/pick(`FolderPick`), `update` POST /api/projects/:project, `agents`/`agentAction`, `mcp`/`mcpAction`, `skills`, `kanban`/`kanbanAction`, `boards`, `decisions`(/api/projects/:project/*, 404 `project_not_found`, 모두 SameSite). 칸반 endpoint는 지금 라우트의 칸반 실패 표 그대로 거부한다(404 `session_not_found`, 400 `invalid_kanban_settings`, 409 Goal 순서 거부 reason, 500 저장소 실패 code). 계약 타입 `ProjectSettings`, `ExternalAgentCommand`, `McpCommand`, `ProjectKanbanSettings`, `ProjectKanbanCommand`, 그리고 `FolderPick`을 다시 내보낸다
- `AuthGroup` — `status` GET /api/auth?provider(`ProviderAuthState`, 404 `provider_unavailable`, 502 `auth_failed`, 10초가 지나면 504 `auth_failed`+`reason: auth_status_timeout`), `action` POST /api/auth `{ intent: login|cancel|logout, provider }`(구독 공급자만). 모두 SameSite
- `AccountsGroup` — `list` GET /api/accounts?provider(구독은 `SubscriptionAccountsView`, `openai-compatible`은 `CompatibleAccountsView`; 503 `account_list_unavailable`), `action` POST /api/accounts(`SubscriptionAccountCommand` 또는 `CompatibleAccountCommand`; 답은 그 provider의 계정 view, 호환 `test`는 `CompatibleTestResult`, `discover`는 `CompatibleModelList`), `quota` GET /api/accounts/quota?provider(`SubscriptionQuotaReport`, 503 `quota_status_unavailable`). 모두 SameSite와 `NoStore`
- `ModelsGroup` — `list` GET /api/models?provider(`ModelCatalogView`, 로그인하지 않았으면 401 `login_required`+`auth`, 404 `provider_unavailable`, 502 `model_list_failed`), `select` POST /api/models/:model `{ provider, reasoningEffort? }`(`ModelSelection`, 404 `model_unavailable`+provider·model·reasoningEffort). 모두 SameSite
- `SessionsGroup` — `list` GET /api/sessions?project(`?archived=1`은 보관한 대화만), `create` POST /api/sessions `{ projectId, title?, agent? }`(201 `Session`, 404 `project_not_found`, 409 `external_agent_unavailable`), `decisions` GET /api/sessions/:session/decisions(404 `session_not_found`), `answerDecision` POST /api/sessions/:session/decisions/:decision(x-session-holder 헤더, 423 `session_in_use`, 결정 거부 reason을 404·400·409로), `board` GET /api/sessions/:session/board(`BoardView`), `editBoard` POST 같은 경로(`BoardEdit`; 200 `Applied`, 실행 중 카드는 202 `Requested`, 409 보드 거부 reason, 422 `plan_dependencies_rejected`+`issues`), `kanban` GET /api/sessions/:session/kanban(`KanbanView`: `{ active: false }` 또는 `{ active: true, ...KanbanBoardView }`), `kanbanAction` POST 같은 경로(`KanbanCommand` 또는 `BoardIntent`; 409 칸반 동작·시작·의존 거부 reason, `queue_item_changed`, `worktree_in_use`). `queue` GET /api/sessions/:session/queue(`QueueSnapshot`), `enqueue` POST 같은 경로(`QueueRequest`; 201 `QueuedMessage`, 400 `empty_message`·`unknown_attachment`, 409 `not_running`), `editQueued` POST /api/sessions/:session/queue/:message(`QueueEditRequest`; 지운 메시지는 null, 409 `queue_not_found`·`queue_delivered`·`queue_not_held`·`queue_reserved`), `subagents` GET /api/sessions/:session/subagents, `subagentTranscript` GET /api/sessions/:session/subagents/:subagent(`SubagentTranscript`, 404 `subagent_not_found`), `approvals` GET /api/sessions/:session/approvals, `answerApproval` POST /api/sessions/:session/approvals/:approval(`{ approved }`; 남은 대기 목록, 404 `approval_not_pending`). 저장소 실패는 500 `storage_failed`·`kanban_storage_failed`·`workflow_storage_failed`. 모두 SameSite. 계약 타입 `CreateSession`, `DecisionAnswerInput`, `KanbanCommand`, `KanbanView`, `SubagentTranscript`
- `sessionHolderHeaders` — 세션을 바꾸는 endpoint의 `headers` 스키마(`x-session-holder`, 선택). `chat-api.ts`에 있고 `ChatGroup.run`과 `SessionsGroup`이 같이 쓴다
- `NoStore` — group의 모든 답(거부 포함)에 `Cache-Control: no-store`를 붙이는 HttpApiMiddleware 서비스 태그(`no-store.ts`). 서버 구현은 pre-response handler로 붙인다
- `appRefusalStatus` — 앱 API 거부 값의 HTTP 상태. 페이지가 `ApiError.status`를 채울 때 쓴다
- `RunInput` — AG-UI `RunAgentInput` 필드 이름을 쓰는 run 요청(`runId`, `parentRunId`, 새 user `messages`, `resume`, `forwardedProps.queuedNext`/`imageIntent`)
- `ResumeEntry` — interrupt 하나에 대한 페이지의 답(`resolved`/`cancelled`, payload, metadata)
- `RunEvent` / `RunEventsLost` — SSE 이벤트(id=run 로그 offset, data=JSON 문자열 `AgUiEvent`)와 로그를 읽지 못했을 때의 `run_events_unavailable` 오류
- `ChatSnapshot` / `ChatMessage` / `MessagePart` / `PendingInterrupts` — 세션 페이지 스냅샷(messages, older 커서, activeRun, interrupts)과 메시지 파트 tagged union(text/thinking/image/tool-call/tool-result)
- `BtwQuestion` — BTW 사이드 질문 payload(`runId`, user `message`)
- `maxPageSize` — 한 페이지 메시지 상한 500(`limit` 쿼리 검증에 씀)
- `ChatApiHandlers` — `AgentChat` 위의 `chat` 그룹 HttpApiBuilder 핸들러 레이어
- `BtwApiHandlers` — `BtwChat` 위의 `btw` 그룹 HttpApiBuilder 핸들러 레이어
- `ChatApiClient` — `HttpApiClient.make(ChatApi)` 클라이언트 Context.Service와 `ChatApiClient.layer`
- `chatSessions` — 세션 id별 Atom 묶음(`keptAtomGroups`). `state`, `custom`(마지막 CUSTOM 이벤트), `open`, `send`, `answer`, `loadOlder` 제공
- `btwThreads` — BTW 스레드 id별 Atom 묶음(`keptAtomGroups`). `view`, `open`, `ask` 제공
- `pageSize` — 클라이언트가 한 번에 읽는 메시지 수 20
- `partsOf` — user 메시지 content(문자열 또는 파트 배열)를 표시용 `MessagePart` 배열로 변환
- `OpenSession` / `Send` / `Answer` / `CustomEvent` / `UserContent` — 클라이언트 세션 상태, 보낼 turn, 승인 답변, CUSTOM 이벤트, user content 타입
- `ChatView` / `RunFailure` / `viewOf` / `caughtUp` / `streamStarted` / `applyEvent` — 스냅샷과 AG-UI 이벤트로 화면 상태를 만드는 순수 리듀서(`caughtUp`·`applyEvent`는 dual)
- `app-api/` — `AppApi`의 group 모듈(`settings.ts`, `projects.ts`, `providers.ts`: auth·accounts·models, `sessions.ts`)

## Invariants

- `chat-api.ts`, `app-api.ts`, `app-api/*`, `refusal.ts`, `no-store.ts`, `chat-session.ts`, `btw-thread.ts`, `chat-view.ts`는 서버 코드를 import하지 않는다. 브라우저 번들이 쓰기 때문이다. 계약이 쓰는 도메인 Schema는 각 폴더의 `contracts.ts`(예: `config/contracts.ts`, `kagi/contracts.ts`, `memory/embedding/contracts.ts`, `imports/contracts.ts`, `improve/contracts.ts`, `providers/contracts.ts`, `providers/openai-compatible-config.ts`, `oauth/contracts.ts`, `projects/contracts.ts`, `sessions/contracts.ts`, `mcp/contracts.ts`, `external-agents/contracts.ts`, `skills/contracts.ts`, `kanban/contracts.ts`, `workflow/contracts.ts`)에서 가져온다. `chat-api.ts`는 `sessionHolderHeader`를 `import type`으로만 가져온다.
- 앱 API의 거부 code는 group이 달라도 상태가 하나다. 페이지는 `appRefusalStatus`로 거부 값만 보고 상태를 찾는다. `auth_failed`만 예외로 502와 504(`reason: auth_status_timeout`)가 있고, reason이 정해진 504를 먼저 선언해 둘을 가른다. 새 group의 거부 목록은 `app-api.ts`의 `appRefusalStatus`에 더한다.
- holder 헤더 이름은 `x-session-holder`다. `satisfies Lowercase<typeof sessionHolderHeader>`로 `sessions/lease-state.ts`의 헤더 상수와 맞춘다.
- 세션을 바꾸는 엔드포인트(`run`, `ask`)에는 `SameSite` 미들웨어를 붙인다. 403 cross-site 거부는 `refusals` 목록이 아니라 `SameSite`의 error에 둔다.
- 거부 코드와 HTTP 상태는 `refusalWith(fields)(status, codes)`로 묶는다. 이 상태는 `refusalStatusIn`이 `httpApiStatus` 어노테이션에서 읽고, 어느 스키마에도 맞지 않으면 500을 쓴다.
- 핸들러에서 어떤 refusal 코드에도 매핑되지 않은 실패는 `orDefect`가 `logDefect("route_defect")`로 남긴다. 그다음 `Effect.die`로 500 defect를 낸다.
- run SSE 이벤트의 `id`는 run 로그의 offset이다. `join`은 `after` 다음부터 이어 읽고, `after`가 없으면 `"-1"`부터 읽는다. BTW run 이벤트 id는 스트림 시작부터 0,1,2… 인덱스다.
- run 로그 읽기 오류는 경고 로그를 남긴다. 그 뒤 `{ error: "run_events_unavailable" }`로 바꿔 스트림을 끝낸다.
- 서버는 대화를 보관한다. 그래서 `RunInput.messages`에는 페이지의 새 user turn만 담는다. 서버는 클라이언트 tool·context·state를 실행하거나 읽지 않는다.
- BTW 패널을 닫으면 스트림만 멈추고 run은 계속된다. 답은 run이 끝날 때 스레드에 저장된다. BTW run에는 승인이 없어서 resume하지 않는다.
- Atom 상태는 레지스트리가 아니라 호출 자신의 `get.set`으로 쓴다. 새 호출이 이전 호출을 대체하면 이전 호출의 늦은 쓰기가 버려져, 새 run의 view를 덮어쓰지 않는다.
- `following`은 스트림이 끝나면 최신 페이지 snapshot을 다시 읽어 `caughtUp`을 적용한다. 그 페이지가 들어올 때까지 `reading`을 유지해 run 메시지가 깜빡이지 않게 한다. `Effect.ensuring`으로 `reading`을 항상 null로 되돌린다.
- 보낸 user 메시지는 낙관적으로 먼저 표시한다. run 요청이 거부되면(`tapError`) 그 메시지를 view에서 지운다.
- `ChatView.streamed`에 이번 스트림이 처음 이름을 부르는 assistant 메시지가 없으면 그 메시지를 빈 파트부터 다시 쓴다. 재접속 스트림은 run을 처음부터 다시 읽기 때문이다. 새 스트림을 시작할 때 `streamStarted`로 이 집합을 비운다.
- `caughtUp`은 새 snapshot의 첫 메시지보다 앞서 읽은 오래된 메시지를 유지한다. 단, 새 페이지가 그 메시지에 더는 닿지 않으면 버린다. `failure`도 유지한다.
- `TOOL_CALL_RESULT`는 해당 tool-call을 `complete`로 바꾼다. 같은 `toolCallId`의 이전 tool-result는 하나로 교체한다. 알 수 없는 call에 대한 이벤트는 view를 바꾸지 않는다.
- `limit` 쿼리는 1..`maxPageSize`(500) 범위의 정수여야 한다.
- run id와 메시지 id는 `Crypto.randomUUIDv7`로 만든다.

## Side Effects

- `chat-api-live.ts`: `AgentChat.snapshot`/`start`/`follow`와 `BtwChat.messages`/`ask`를 호출한다. 실제 세션·run·스레드 저장소 읽기와 쓰기는 그 서비스가 한다.
- `chat-api-live.ts`: `RunLog.read(after)`로 run 로그를 스트림으로 읽는다. 로그를 읽지 못하면 `Effect.logWarning`을 남긴다.
- `chat-api-live.ts`: 매핑되지 않은 실패를 `logDefect("route_defect")`로 로그에 남긴다.
- `chat-session.ts`, `btw-thread.ts`: `HttpApiClient`로 `/api/sessions/...`와 `/api/btw/...`에 네트워크 요청을 보낸다. SSE 스트림 구독도 포함한다.
- `chat-session.ts`, `btw-thread.ts`: `Crypto.randomUUIDv7`로 무작위 id를 만든다.
- `chat-session.ts`, `btw-thread.ts`: `effect/reactivity` Atom 상태(`state`, `custom`, `view`)를 바꾼다. 이 Atom들은 `Atom.keepAlive`로 유지된다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
