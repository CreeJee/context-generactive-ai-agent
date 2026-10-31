# 앱 API를 Effect HttpApi로 옮기는 계획 (2026-10-31)

## 목표

- 브라우저가 서버 응답 타입을 다시 선언하지 않는다. 서버와 브라우저는 Schema로 선언한 계약 하나를 함께 import한다.
- 첫 화면이 hydration 뒤의 요청 waterfall을 기다리지 않는다. React Router loader가 react-query 캐시를 미리 채운다.
- 큰 GET 응답은 바뀌지 않았으면 다시 받지 않는다(ETag, 측정한 뒤에 정한다).

## 지금 상태

- `apps/agent/app/routes/api/`에 React Router 리소스 라우트가 약 60개 있다. 각 파일의 `loader`/`action`이 `agent.runPromise`로 Effect를 돌리고 `Response.json`으로 답한다. 요청 본문만 `readJson(request, Schema)`로 검사하고, 응답은 검사하지 않는다.
- `HttpApi`로 선언한 것은 채팅 API(`memory-agent/chat-api`의 `ChatApi`, 2026-10-27)뿐이다. 앱은 RR 라우트 다섯 개에서 `serveChatApi`(`HttpRouter.toWebHandler`)로 넘긴다. 브라우저는 `HttpApiClient.make(ChatApi)`로 부른다.
- 브라우저의 `app/entry/api.ts`(약 1200줄)는 응답 타입을 손으로 다시 선언한다(`KanbanSettings`, `RecallSettings`, `SessionSnapshot` 등). `call<T>`는 `response.json()`을 검사 없이 `T`로 캐스팅한다. 오류 코드 목록(`ApiErrorCode`)도 서버와 따로 관리한다.
- memory-agent의 응답 타입은 일부만 Schema다(`Project`, `Session`, `ProviderModel`, `WorkflowState`, `BtwThread` 등). 나머지는 TS interface다(`BoardView`, `McpOverview`, `EmbeddingOverview`, `SessionRunState`, `QueueSnapshot` 등). 브라우저는 이 타입을 `import type`으로만 쓴다.
- 페이지 라우트는 `_index.tsx`와 `report.tsx` 둘이다. `_index`는 `App` 전체를 그리고, 프로젝트·세션 선택은 nuqs 쿼리(`?project=&session=`)에 있다. 데이터는 hydration 뒤 react-query가 읽고, `AppEvents` SSE가 무효화한다.

## 정한 방향

### 계약

- 앱 API 계약 `AppApi`는 memory-agent `src/api/app-api.ts`(크면 `src/api/app-api/<group>.ts`)에 두고 subpath `memory-agent/app-api`로 내보낸다. `ChatApi`처럼 서버 코드를 import하지 않아 브라우저가 쓸 수 있다.
  - memory-agent 테스트 helper(`tests/agents/app-fetch.ts`)와 ACP bridge도 같은 계약을 쓸 수 있다.
- 응답 타입이 TS interface인 도메인은 Schema로 바꾸고 타입은 `typeof X.Type`으로 만든다. 선언은 한 번만 한다. 도메인 모듈이 서버 코드와 섞여 있으면 Schema를 그 폴더의 `contracts.ts`로 옮긴다(`btw/contracts.ts`, `providers/contracts.ts`가 선례다).
- 거절은 지금 JSON 모양 그대로 `{ error, reason?, ...details }`와 status다. `chat-api.ts`의 `refusal(status, codes)`를 공용 모듈(`src/api/refusal.ts`)로 옮겨 두 API가 같이 쓴다. endpoint마다 낼 수 있는 code만 선언한다.
- 세션을 바꾸는 요청의 `x-session-holder`는 endpoint의 `headers` Schema로 선언한다.

### 서버

- handler는 `apps/agent/app/.server/api/<group>.ts`에 `HttpApiBuilder.group(AppApi, ...)`으로 둔다. 지금 라우트가 쓰는 앱 전용 helper(`folder-picker`, `account-failures`, `kanban-failures`, `report-evidence` 등)는 그대로 쓴다.
- `ChatApi`와 `AppApi`를 web handler 하나로 연다(`app/.server/chat-api.ts`를 `api.ts`로 넓힌다). RR에는 splat 라우트 `app/routes/api/$.tsx` 하나가 `loader`/`action`으로 넘긴다. RR은 정적 경로를 splat보다 먼저 고르므로, group을 옮길 때마다 해당 라우트 파일을 지우면 splat이 이어받는다.
- `rejectCrossSite`는 `SameSite` middleware로 바꾼다. 상태를 바꾸는 endpoint 전부와, 지금 cross-site 검사를 하는 첨부 GET에 건다.
- `Cache-Control: no-store`(계정·quota·보고서)는 그 group의 middleware가 붙인다.
- 개발용 `Server-Timing`은 handler 전체 시간을 재는 middleware 하나로 바꾼다. 지금 `projects._index`·`models._index`에만 있는 service/query 세부 구간은 span으로 이미 볼 수 있으므로 옮기지 않는다.

### 브라우저

- `AppApiClient`(`HttpApiClient.make(AppApi)`)를 `chatRuntime`처럼 `FetchHttpClient.Fetch`=`appFetch`로 만든다. backend 재시작 감지와 build id 헤더는 `appFetch`에 있으므로 그대로 동작한다.
- `api.ts`의 메서드 이름과 Promise 시그니처는 처음에는 유지하고 안쪽만 `AppApiClient` 호출로 바꾼다. 그래야 화면 코드를 함께 고치지 않고 group 단위로 옮길 수 있다. 타입 있는 실패는 지금의 `ApiError`(`status`, `code`, `reason`)로 바꿔 던진다.
- 다 옮긴 뒤 `call<T>`, 손으로 쓴 응답 타입, `ApiErrorCode` 목록을 지운다. `ApiErrorCode`는 계약의 refusal code와 브라우저 전용 code(`request_failed`, `upload_failed`, `backend_restart_*`)의 합으로 만든다.

### React Router loader (2단계)

- `_index.tsx`의 loader가 쿼리(`?project=&session=`)를 읽어 첫 화면이 쓰는 query를 채운다. react-query가 계속 유일한 캐시이고, loader는 waterfall만 없앤다. SSE 무효화는 지금처럼 react-query에 건다.
- 서버 loader는 같은 `AppApiClient`를 네트워크 없이 web handler에 붙여(in-process `HttpClient`) 부르고 `dehydrate`한 상태를 돌려준다. 페이지는 `HydrationBoundary`로 받는다. query 함수와 loader가 같은 client를 쓰므로 key와 데이터 모양이 같다.
- RR turbo-stream은 Schema class의 prototype을 보존하지 않는다. loader는 계약 Schema로 encode한 값을 넘기고, 받는 쪽이 decode한다.
- 라우트를 경로로 나누는 일(`/projects/:project/sessions/:session`)은 이 단계에 넣지 않는다. 쿼리 기반 loader로 충분한지 먼저 본다.

### ETag (3단계)

- Effect의 `Etag` 모듈은 파일 전용(`Generator.fromFileInfo`/`fromFileWeb`)이고, 304 처리는 `HttpStaticServer`에만 있다. JSON 응답용은 middleware를 직접 쓴다.
- 먼저 잰다: 큰 GET(`/messages` snapshot, trace tree, board)의 크기와, 포커스 복귀·interval로 생기는 재요청 빈도. 이득이 작으면 하지 않는다.
- 한다면 body 해시보다 `AppEvents` topic별 revision을 ETag로 쓴다. handler를 돌리기 전에 304로 끊어 DB 조회까지 아낀다. 응답은 `Cache-Control: no-cache`로 바꿔 브라우저가 `If-None-Match`를 알아서 보내게 한다.
- `no-store` 응답(계정·quota·보고서)과 content-addressed 첨부는 대상이 아니다.

## 단계

각 단계는 따로 빌드되는 commit 하나 이상이다. group을 옮기는 commit은 그 group의 RR 라우트 삭제, handler, 계약, `api.ts` 안쪽 교체를 함께 담는다.

### 1-0. 기반

- `src/api/refusal.ts`, 빈 `AppApi`와 subpath, 합친 web handler와 `api.$.tsx` splat, 브라우저 `AppApiClient`와 실패 변환.
- 첫 group으로 설정(`settings.*`)을 옮긴다. 구조를 끝까지 확인한다.
- 결과 (2026-10-31): `settings.{conversation,recall,kanban,kagi}`를 옮겼다. 채팅 API로 넘기던 RR 라우트 다섯 개도 splat이 받으므로 이 단계에서 지웠다.
  - client 메서드 타입은 union payload(`KagiCommand` 등)를 case별 요청으로 나눠 받는다. union 값을 그대로 넘길 수 없어서 facade가 `$match`로 case마다 부른다.
  - handler는 서비스를 group을 만들 때 꺼낸다(`Effect.fn(function* (handlers) { ... })`). 요청 handler 안에서 꺼내면 그 서비스가 web handler의 요청별 context 요구로 남는다.
  - export한 다인자 함수는 Effect LSP의 pipeable 경고를 받는다. 거부 스키마는 `refusalWith(fields)(status, codes)`로 만들고, group마다 `const appRefusal = refusalWith(appRefusalFields)`를 둔다.

### 1-1 ~ 1-6. group 이전

| 단계 | group                         | RR 라우트                                                                                          |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| 1-1  | settings 나머지               | `settings.*` 중 1-0에서 남은 것                                                                    |
| 1-2  | projects                      | `projects.*`(events·trace 제외)                                                                    |
| 1-3  | auth·accounts·models          | `auth`, `accounts`, `accounts.quota`, `models.*`                                                   |
| 1-4  | sessions                      | `sessions.*`(채팅 API·SSE 제외), `projects.$project.trace*`                                        |
| 1-5  | reports·media·attachments·btw | `reports.*`, `media.image`, `attachments.*`, `btw.$thread._index`                                  |
| 1-6  | SSE                           | `events`, `projects.$project.events`, `sessions.$session.events`, `sessions.$session.trace.stream` |

- 1-1 결과 (2026-10-31): `settings.{embedding,image,imports,improvements}`를 옮겼다. 자체 fetch를 쓰던 프로젝트 개선 페이지도 `api.improvements`/`api.improvementScan`을 쓴다.
  - 계약 Schema는 `config/contracts.ts`(`EmbeddingChoice`, `GpuCheck`, `CrossProviderMediaConsent*`), `memory/embedding/contracts.ts`, `imports/contracts.ts`, `providers/contracts.ts`(`ImageFeatureStatus`)에 둔다.
  - `Data.taggedEnum` 생성자(`EmbedderRuntime`, `GpuState`, `ImportActivity`)는 그대로 두고 타입만 계약에서 꺼낸다(`EmbeddingOverview["running"]` 등). 생성자를 쓰는 테스트·eval이 많아서다.
  - 숫자는 `Schema.Finite`다. Effect LSP가 `Schema.Number`를 막고, JSON은 NaN·Infinity를 싣지 못하므로 응답은 같다.
  - 일부 서비스 메서드는 호출마다 서비스를 요구한다(`Importer`의 start·overview·restartWatch·setEnabled는 `SqlClient`, `EmbeddingSetup`의 choose·recheck는 `Path`). handler는 group을 만들 때 꺼낸 값을 `Effect.provideService`로 넣는다.
  - 거부를 선언하지 않았던 embedding·image·imports의 실패는 `Effect.orDie`로 지금처럼 500이다. `HttpEffect`가 cause를 보고하므로 로그도 남는다.
- 1-2a 결과 (2026-10-31): `projects`(목록·추가·폴더 선택·설정)와 `projects.$project.{agents,mcp,skills}`를 옮겼다. 칸반·보드·결정(1-2b)과 trace(1-2c)는 남았다.
  - 계약 Schema는 `projects/contracts.ts`(`Project`, `PermissionMode`, 앱에서 옮긴 `FolderPick`), `mcp/contracts.ts`, `external-agents/contracts.ts`, `skills/contracts.ts`에 둔다. 도메인 모듈은 이름을 다시 내보내거나 타입을 계약에서 꺼내므로 import하는 쪽은 그대로다.
  - `ShownFailure`의 Schema는 `shownFailure(code)`(`runtime/shown-failure.ts`)로 만든다.
  - 개발용 `Server-Timing`은 `serveApi`의 global `HttpRouter.middleware` 하나(`handler;dur=`)다. `projects._index`의 service/query 구간은 없앴다.
  - 프로젝트를 찾지 못하면 404 `project_not_found`, 그 밖의 실패는 지금처럼 500이다. 두 갈래는 `Effect.catchIf`/`catchTag`의 `orElse`로 나눈다. `catchTag`의 `orElse`에 `Effect.die`를 그대로 넘기면 `unknown` 인자가 에러 타입 추론을 덮어 tag를 찾지 못한다. `(failure) => Effect.die(failure)`로 넘긴다.
  - 응답 배열은 `ReadonlyArray`다. 받는 쪽 prop 타입을 `ReadonlyArray`로 바꾼다.
- 1-2b 결과 (2026-10-31): `projects.$project.{kanban,boards,decisions}`를 옮겼다.
  - 계약 Schema는 `kanban/contracts.ts`(`ProtectedBranches`, `DecisionAnswer`, `DecisionCloseReason`, `DecisionState`, `HumanDecisionRequest`, `DecisionInboxItem`)와 `workflow/contracts.ts`(`PlanStatus`, `PlanSummary`, `ProjectBoard`)에 둔다. 1-4의 세션 결정·보드도 이것을 쓴다.
  - 칸반 실패는 `kanban-failures.ts`의 `kanbanRefusal` 표(tag별 refusal)로 답한다. handler가 낼 수 있는 tag만 `Effect.catchTags`에 넘겨 endpoint마다 선언한 code와 맞춘다. RR 라우트용 `kanbanFailureResponse`는 1-4에서 지웠다.
- 프로젝트 trace(`projects.$project.trace`, `trace.tasks.$task`)는 1-4로 넘긴다 (2026-10-31). `AgentChat`의 trace 메서드가 HTTP `Response`를 직접 만들고, 세션 trace와 같은 메서드·타입(`TraceTreeSnapshot`, `TraceTaskDetail`)을 쓴다. 메서드가 값과 tagged 실패를 돌려주게 바꾸는 일은 두 쪽을 한 번에 한다.
- 1-3 결과 (2026-10-31): `auth`, `accounts`, `accounts.quota`, `models.*`를 `app-api/providers.ts`의 `AuthGroup`·`AccountsGroup`·`ModelsGroup`으로 옮겼다.
  - 계약 Schema는 `oauth/contracts.ts`(`OAuthProfile`, `AccountLoginState`, `SubscriptionAccountsView`, 쿼터 Schema)와 `providers/contracts.ts`의 `ProviderAuthState`에 둔다. 서버의 `AuthConnectionState`도 같은 필드의 비공개 TaggedUnion에서 타입을 꺼낸다.
  - `/api/accounts`는 지금처럼 provider마다 연결 종류로 tag한 view를 답하는 endpoint 하나다. facade는 구독 view만 받는다(`Schema.is(SubscriptionAccountsView)`). 호환 엔드포인트 client(`compatible-client.ts`)는 자체 fetch와 실패 분류를 그대로 쓰고, 명령과 결과 Schema만 계약에서 가져온다.
  - `no-store`는 `NoStore` middleware다. HttpApi middleware는 거부를 encode하기 전에 돌므로 응답을 map하면 거부에는 붙지 않는다. 그래서 `HttpEffect.withPreResponseHandler`로 붙인다.
  - 응답이 바뀐 곳: 호환 엔드포인트의 502 `provider_unavailable`은 `endpoint_unavailable`이다. auth·models의 404 `provider_unavailable`과 code 하나에 status 하나라는 규칙이 부딪쳤고, 페이지는 이 본문을 읽지 않는다. models `list`의 401 `auth`는 `/api/auth`처럼 `authUrl`을 쓴다. `auth_failed`는 502와 504(`reason: auth_status_timeout`) 둘이라, reason이 정해진 504를 먼저 선언한다.
  - 계약에 맞지 않는 query·payload(전에는 `invalid_provider`, `invalid_intent`, `invalid_selection`, `invalid_account_action`)는 HttpApi의 빈 400이다. facade는 같은 code를 `appCall`의 invalid code로 준다.
  - client 메서드는 union payload를 case별로 받으므로 facade가 `Match.discriminatorsExhaustive("intent")`로 나눠 부른다. 계약의 명령 union은 member마다 intent가 하나다.
  - 찾은 문제: ACP bridge(`acp/app-api.ts`의 `auth`)는 `/api/auth`를 provider 없이 부른다. 옛 라우트도 400 `invalid_provider`로 답했으므로 실제 앱에서는 `session/new`가 늘 실패한다. 테스트용 앱(`tests/agents/app-fetch.ts`)은 첫 provider로 답해 이것을 가린다. 어느 provider를 볼지 정해야 고칠 수 있어 남겼다. → 2026-10-31에 고쳤다. provider 없는 `/api/auth`는 앱의 현재 provider로 답한다(`docs/decisions.md` 'ACP 브리지의 로그인 확인은 앱의 현재 provider로 한다').
- 1-4a 결과 (2026-10-31): 세션 목록·생성(`sessions._index`)과 세션 결정(`sessions.$session.decisions*`)을 `app-api/sessions.ts`의 `SessionsGroup`으로 옮겼다. 보드·칸반, `AgentChat` 기반 라우트, trace는 남았다.
  - `Session` Schema는 `sessions/contracts.ts`에 둔다. 세션을 바꾸는 endpoint의 holder 헤더는 `chat-api.ts`의 `sessionHolderHeaders`를 같이 쓰고, client에는 `x-session-holder` 이름 그대로 넘긴다.
  - 계약에 맞지 않는 query·payload(전에는 `project_required`, `invalid_session`, `invalid_decision_answer`)는 HttpApi의 빈 400이다. facade는 같은 code를 `appCall`의 invalid code로 준다.
  - 결정 답변의 거부는 `kanbanRefusal.HumanDecisionRefused`로 reason을 code로 답한다. 상태(404·400·409)는 옛 `humanDecisionStatus` 표와 같다.
- 1-4a 보드·칸반 결과 (2026-10-31): `sessions.$session.{board,kanban}`을 `SessionsGroup`의 `board`·`editBoard`·`kanban`·`kanbanAction`으로 옮겼다. RR 라우트용 `kanbanFailureResponse`·`answerKanbanFailures`는 지웠다.
  - 응답 Schema는 `workflow/contracts.ts`(`WorkflowState`와 Goal·Plan·카드·완료 근거, 보드 편집 명령, `BoardView`, `BoardEditApplied`·`BoardEditRequested`)와 `kanban/contracts.ts`(`KanbanBoardView`와 그 안의 view, `AssignmentHold`, `KanbanMode`, `GoalMergeState`, `KanbanStarted`)에 둔다. 서버 코드가 없는 `kanban/failures.ts`, `runtime/loop-health.ts`, `workflow/plan-schedule.ts`의 Schema는 그대로 가져온다.
  - 보드 변경은 저장(200 `Applied`)과 실행 중 카드에 대한 요청(202 `Requested`)을 success 두 개로 선언한다. HttpApi는 값에 맞는 첫 success의 상태로 답한다. `kanbanAction`은 한 경로가 명령 여러 개를 받으므로 success가 `KanbanStarted`, `{ restarted }`, `{ dependsOn }`, 보드 변경 결과의 union이다.
  - `request_missing`은 결정(404)과 칸반 동작(409) 둘에 있다. 칸반 동작의 `request_missing`은 오케스트레이터 도구(`settleChangeRequest`)만 내므로 HTTP로는 나오지 않는다. `appRefusalStatus`는 먼저 선언한 404를 찾는다.
  - 계약에 맞지 않는 payload(전에는 `invalid_board_edit`, `invalid_kanban_action`)는 HttpApi의 빈 400이다.
- 1-4b 응답 Schema (2026-10-31): `AgentChat` 기반 라우트의 응답 타입을 먼저 Schema로 바꿨다.
  - 세션 실행 상태(`SessionRunState`, `CancelResult`, `CompactResult`, `ContextView`, `RunStatus`)는 `agent/run-state.ts`, 그 안의 workflow 모양(`WorkflowExecutionState`, `WorkflowActions`, `ProviderRetryView`, `UncertainRun`, `WorkflowDisplay`)은 `workflow/contracts.ts`, `LeaseView`는 `sessions/contracts.ts`에 둔다.
  - 큐(`QueueSnapshot`, `QueueEditRequest`), 하위 에이전트(`SubagentView`), 중계 승인(`RelayedApprovalView`)은 원래 브라우저 안전 모듈(`*-state.ts`)에서 Schema가 됐다. `Data.taggedEnum` 생성자는 그대로 둔다.
  - `chat-store/schema.ts`의 `StoredRunStatus`는 `RunStatus`를 쓴다. 반대로 `run-state.ts`가 `chat-store/schema.ts`를 import하면 `tools/definitions.ts`를 거쳐 순환이 생긴다.
- 1-4b 경로 단위 (2026-10-31): React Router는 라우트 파일을 splat보다 먼저 고르므로, 같은 경로의 GET과 POST는 함께 옮긴다. 순서는 큐·하위 에이전트·중계 승인, 그다음 cancel·compact·interrupts.discard·uncertain·lease, 마지막으로 세션 상태(GET)와 수명주기(POST) `/api/sessions/:session`이다.
- 1-4b 큐·하위 에이전트·중계 승인 결과 (2026-10-31): `sessions.$session.{queue,subagents,approvals}*`를 `SessionsGroup`으로 옮겼다.
  - `AgentChat`의 해당 메서드는 HTTP `Response` 대신 값을 돌려주고, 페이지가 읽는 거부를 `{ error }` 값으로 실패한다. 다른 실패는 tagged error 그대로다. handler의 `refusalsOnly`가 `_tag` 있는 실패를 defect로 바꿔, 거부만 선언한 error로 남긴다.
  - `QueueRequest`는 `queue/queue-state.ts`로 옮겼다. 하위 에이전트 대화 응답은 계약의 `SubagentTranscript`다.
  - 응답이 바뀐 곳: 옛 라우트는 거부한 요청에도 무효화 이벤트를 발행했다. 이제 성공한 변경만 발행한다. `queue_reserved`(전달 중인 메시지)는 서버가 내던 code였지만 페이지 code 목록에 없었다. 계약이 이것을 찾아 목록에 넣었다.
  - 계약에 맞지 않는 payload(전에는 `invalid_queue_request`, `invalid_queue_edit`, `invalid_answer`)는 HttpApi의 빈 400이다.
- 1-4b run 제어 결과 (2026-10-31): `sessions.$session.{cancel,compact,interrupts.discard,uncertain,lease}`를 `SessionsGroup`의 `cancel`·`compact`·`discardInterrupts`·`continuePastUncertain`·`lease`로 옮겼다. `AgentChat`의 다섯 메서드도 값과 `{ error }` 거부를 돌려준다.
  - `compact`의 503 `provider_unavailable`은 `provider`를 싣는다. providers group에는 같은 code의 404가 있어서, `providersRefusals`에 503(`SelectedProviderUnavailable`)을 먼저 선언해 `appRefusalStatus`가 둘을 가른다. 세션 상태(GET)도 이것을 쓴다.
  - uncertain의 답은 옛 모양 그대로 `{ _tag: "acknowledged" }`다(`UncertainAcknowledged`). lease는 holder를 헤더가 아니라 본문으로 받고, 페이지를 닫을 때의 beacon(`application/json` Blob)도 같은 payload로 디코드된다.
  - 응답이 바뀐 곳: 옛 lease 라우트가 GET에 답하던 405 안내는 없어졌다. cancel과 lease의 `run-state` 발행은 성공한 요청에만 한다.
  - 테스트가 `cancel(...).status`를 HTTP 상태로 읽던 곳은 `CancelResult.status`(run 상태)와 이름이 겹쳐 타입으로 잡히지 않았다. 성공 여부를 보도록 고쳤다.
  - 계약에 맞지 않는 payload(전에는 `invalid_uncertain_continue`, `invalid_lease_request`)는 HttpApi의 빈 400이다.
- 1-4b 세션 상태·수명주기 결과 (2026-10-31): `sessions.$session._index`를 `SessionsGroup`의 `status`(GET)와 `change`(POST)로 옮겼다. `AgentChat`의 `status`·`archive`·`deleteSession`·`setWorkflowPhase`·`controlWorkflow`도 값과 거부를 돌려준다.
  - 세션 변경은 `SessionChange` TaggedUnion(`Archive`·`Delete`·`Phase`·`Control`) 하나를 받는다. client는 union payload를 case별로 받으므로 페이지가 `Match.valueTags`로 나눠 부른다.
  - 수명주기 결과는 `work-trace/contracts.ts`의 `LifecycleResult`(`completed`·`waiting_for_stop`·`blocked`)다. 요청부터 막히면 409 `blocked`, 멈춘 뒤 끝내다 막히면 202 `blocked`로 옛 상태와 같다. `blocked`는 `_tag`가 있으므로 `refusalsOnly`는 이제 `Error`인 실패만 defect로 바꾼다.
  - 응답이 바뀐 곳: 옛 라우트는 없는 세션을 잡지 않아 500으로 답했다. 이제 404 `session_not_found`다. workflow 전이·진행 거부 code 가운데 `unknown_step`, `step_evidence_required`, `verification_required`, `steps_incomplete`, `phase_not_executable`, `goal_completion_required`, `completion_evidence_*`, `completion_snapshot_conflict`는 페이지 code 목록에 없어 `request_failed`로 보였다. 계약이 이것을 찾아 목록에 넣었다.
  - 202인데 완료 모양인 답처럼 계약에 맞지 않는 응답은 `appCall`이 디코드 실패로 보고 invalid code(`invalid_session_change`)로 준다. 전에는 502였다. 응답 디코드 실패와 요청 거부를 가를지는 1-7에서 정한다.
  - 계약에 맞지 않는 payload(전에는 `invalid_session_change`)는 HttpApi의 빈 400이다.
- 1-4c trace 결과 (2026-10-31): `sessions.$session.trace`, `sessions.$session.trace.tasks.$task`, `projects.$project.trace`, `projects.$project.trace.tasks.$task`를 새 `TraceGroup`(`app-api/trace.ts`)으로 옮겼다. 세션과 프로젝트의 trace가 같은 메서드와 타입을 쓰므로 한 group에 둔다. `AgentChat`의 trace 메서드 여섯 개도 값과 거부를 돌려준다. `traceStream`은 SSE와 함께 1-6에서 옮긴다. 그것이 쓰는 `json`·`sessionNotFound`·`workTraceUnavailable`도 그때 지운다.
  - 응답 Schema는 `work-trace/contracts.ts`(`TraceTreeSnapshot`, `TraceTaskDetail`과 그 안의 view, `ResumeBlocker`, `ResumeTaskResult`)와 새 `memory/contracts.ts`(`MemoryCandidateView`, `MemoryUsageView`, `MemoryDisposition`)에 둔다. `store.ts`와 `knowledge.ts`는 같은 이름의 타입을 다시 내보낸다. `ResumeRequest`의 `Data.taggedEnum` 생성자는 그대로 둔다.
  - `refusalsOnly`는 `.server/api/agent-chat-refusals.ts`로 옮겨 sessions·trace handler가 같이 쓴다. 막힌 재시도(`{ _tag: "blocked", reason }`)도 `Error`가 아니므로 거부로 답한다.
  - 찾은 문제: 페이지의 `ResumeTaskResult.queued`는 서버가 보내지 않는 `jobId`를 요구했다. 그래서 다시 시도를 저장해도 페이지는 디코드에 실패해 `request_failed`로 보였다. 계약의 Schema를 쓰면서 고쳐졌다.
  - 응답이 바뀐 곳: Work Trace 설정을 읽지 못하면 전에는 tree만 500 `settings_unavailable`이고 나머지는 본문 없는 500이었다. 이제 다섯 endpoint가 모두 `settings_unavailable`이다. 태스크 보관·삭제가 끝내다 막힌 202 `blocked`는 전에 페이지가 502로 봤다. 이제 세션 수명주기처럼 결과로 돌려준다. `work_trace_disabled`, `trace_task_not_found`, `invalid_trace_task_action`은 페이지 code 목록에 없어 `request_failed`로 보였다. 목록에 넣었다.
  - 계약에 맞지 않는 payload(전에는 `invalid_trace_task_action`)는 HttpApi의 빈 400이다. facade는 같은 code를 `appCall`의 invalid code로 준다.
- 1-5 BTW 스레드 결과 (2026-10-31): `sessions.$session.btw`와 `btw.$thread._index`를 앱 API의 `BtwThreadsGroup`(`app-api/btw.ts`, group 이름 `btw`)으로 옮기고 `.server/btw-handlers.ts`를 지웠다. 스레드에 묻기와 메시지 읽기는 그대로 `ChatApi`의 `BtwGroup`이다. 페이지 facade가 `appCall`로 부르므로 목록·생성·삭제는 앱 API에 둔다.
  - 옛 라우트 handler를 부르던 `server/tests/btw-routes.test.ts`는 지웠다. 그 가운데 상태 코드는 계약이 정하고, 메인 대화를 물을 때마다 다시 읽는 동작만 `tests/btw/threads.test.ts`로 옮겼다.
  - 응답이 바뀐 곳: 삭제 경로가 DELETE 말고 다른 method에 답하던 405 `method_not_allowed`는 없어졌다.
- 1-5 reports 결과 (2026-10-31): `reports.{sessions,evidence,diagnosis,delivery}`를 `app-api/reports.ts`의 `ReportsGroup`으로 옮겼다. `.server/report-evidence.ts`에는 세션이 그 프로젝트에 있는지 보는 `reportSession`만 남았다.
  - 제보 페이지의 client(`entry/report/report-client.ts`)는 facade로 옮기지 않았다. 브라우저는 거부 본문을 읽지 않고 상태만 본다(`docs/decisions.md`의 제보 진단 결정). 요청 본문은 계약의 `ReportDeliveryCommand`를 쓰고, 계약은 진단·전송 실패의 reason마다 상태 하나를 `satisfies Record<…Failure, number>` 표로 둔다. reason마다 `Schema.Literal` 스키마를 만들어 `appRefusalStatus`가 상태를 가른다.
  - bundle 수집은 agent가 내보내는 서비스 여럿을 요청마다 요구한다. handler는 group을 만들 때 `Effect.context`로 꺼낸 값을 `Effect.provideContext`로 넣는다.
  - 응답이 바뀐 곳: 설정을 읽거나 쓰지 못한 전송 endpoint는 503이 아니라 500 `settings_unavailable`이다. 503은 페이지가 `invalid_webhook_url`로 읽던 상태라 둘이 부딪쳤고, 다른 group의 `settings_unavailable`도 500이다. evidence의 `no-store`는 성공에만 붙었지만 이제 거부에도 붙는다.
  - 계약에 맞지 않는 payload·query(전에는 `invalid_report_source`, `invalid_report_delivery`, `invalid_report_diagnosis`, `project_and_session_required`)는 HttpApi의 빈 400이다. 페이지는 전에도 이 상태를 `request_failed`로 봤다.
- SSE는 `HttpApiSchema.StreamSse`로 옮긴다. 첨부 업로드(`Content-Length`를 본문보다 먼저 검사)와 다운로드(바이트와 immutable 헤더)가 HttpApi로 같게 안 되면 RR 라우트로 남기고 이유를 적는다.

### 1-7. 정리

- `call<T>`, 손으로 쓴 응답 타입과 `ApiErrorCode` 목록을 지운다. `app/routes/api/README.md`를 계약 기준으로 다시 쓴다.

### 2. loader

- `_index.tsx` 서버 loader와 `HydrationBoundary`. 처음 채울 query는 프로젝트 목록, 선택된 프로젝트의 세션 목록, 선택된 세션의 run state다. 채팅 snapshot은 atom이 읽으므로 따로 본다.

### 3. ETag

- 측정, 그리고 이득이 있으면 revision 기반 middleware.

## 하지 않는 것

- OpenAPI 스펙을 거쳐 client를 생성하지 않는다. 같은 모노레포라 `HttpApiClient`가 계약에서 바로 client를 만든다. 생성 코드는 brand, TaggedUnion, Schema 변환을 잃는다. 문서가 필요하면 `OpenApi.fromApi`로 얻는다.
- 응답 JSON 모양과 status는 바꾸지 않는다. 브라우저 화면 코드는 1단계에서 거의 손대지 않는다.

## 위험

- 계약 모듈이 서버 코드를 끌어오면 브라우저 build가 깨진다. Schema를 옮길 때마다 browser build(`vp run agent#build`)로 확인한다.
- 응답을 Schema로 encode하므로, 지금 응답에 interface에 없는 필드가 섞여 있으면 사라진다. group마다 옮기기 전과 후의 응답을 비교한다.
- 서버 encode가 Schema의 runtime check(`Int`, 범위, `NonEmpty`)에 걸리면 지금은 보이던 화면이 500을 받는다. TS는 이것을 잡지 못한다. 그래서 응답 Schema에는 도메인이 이미 decode에 쓰는 check만 두고 새 check를 더하지 않는다. TS interface는 지우고 타입을 `typeof X.Type`으로 바꿔, 값을 만드는 서버 코드가 모두 Schema 타입으로 검사되게 한다. interface에서 Schema 초안을 만들 때는 `@effect/tsgo` refactor `typeToEffectSchema`를 쓸 수 있다.
- 브라우저 쪽 실패 변환: 선언한 refusal은 `appRefusalStatus`로 status를 찾는다. 선언하지 않은 status는 `call<T>`처럼 body의 `{ error, reason }`을 읽는다. 브라우저 Schema가 payload를 거절하면 그 endpoint의 `invalid_*` code(400)다. 서버가 payload decode에 실패하면 HttpApi 기본 응답(빈 400)이다.
- 다른 세션이 같은 checkout에서 `app/entry/*`를 고치고 있다. `api.ts`의 export 이름과 시그니처를 유지해 충돌을 줄인다.
