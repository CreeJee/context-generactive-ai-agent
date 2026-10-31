# entry

## Overview

`apps/agent/app/entry`는 에이전트 웹앱 프론트엔드(React)의 최상위 진입 디렉터리다. `index.tsx`의 `App`은 사이드바(모델·프로젝트·세션), 세션 채팅 화면, 프로젝트 보드, 계정 관리, 설정·제보 진입을 하나로 묶는다. 위치(project/session/board 등)는 nuqs URL 쿼리 상태가 소유한다.

`api.ts`는 브라우저 쪽 백엔드 클라이언트 계층이다. `appFetch`로 `/api/*` 라우트를 부르는 `api` 객체, `ApiError`/`ApiErrorCode` 오류 계약, 서버로 보내는 명령 TaggedEnum, 화면용 거절 문구 함수를 정의한다. memory-agent의 타입도 다시 내보낸다. 하위 디렉터리는 모두 이 두 파일을 import하거나 `App`에서 렌더된다.

## Interface

- `App` — `index.tsx`의 루트 React 컴포넌트다. 인증·모델·프로젝트·세션 쿼리, nuqs `useQueryStates(locationParsers)`로 URL 위치(project, session, card, board, boards, boardCard)를 관리한다. 세션 보관·삭제·복원, 프로젝트 추가, 모델 선택, 설정 열기를 연결한다
- `api` — `/api/*` 백엔드 호출을 모은 객체 리터럴(`api.ts` 639-1104행)이다. 메서드는 auth/authAction/accounts/accountAction/accountQuota, models/selectModel, projects/hiddenProjects/addProject/hideProject/restoreProject/pickFolder/moveProject/setPermissionMode/setCrossRecallExcluded, sessions/archivedSessions/createSession, board/editBoard/decisions/decisionInbox/answerDecision/projectBoards, kanban/startKanban/boardIntent/restartKanbanLoop/setGoalDependencies/moveGoal/projectKanban/setProtectedBranches, setWorkflowPhase/controlWorkflow, sessionRunState/cancelRun/discardInterrupts/continuePastUncertain/compactSession/leaseAction, queue/enqueue/editQueued, btwThreads/createBtw/deleteBtw, image·kagi·imports·embedding·conversation·recall·kanban 설정, mcpServers/mcpAction, externalAgents/trustExternalAgent/reconnectExternalAgent, skills, work trace 계열(resume/archive/deleteWorkTraceTask, workTraceStreamUrl), subagents/relayedApprovals/subagentTranscript/answerApproval, uploadAttachment(file)이다
- `ApiError` — `Schema.TaggedError("ApiError")`이다. 코드는 `ApiErrorCode`를 따르고 `CrossProviderMediaRunApproval`을 담을 수 있다. `message` getter를 override한다
- `ApiErrorCode` — 브라우저 API가 이해하는 모든 오류 코드의 `Schema.Literals`다. 로컬 fallback(`request_failed`, `upload_failed` 등)도 포함한다. 예: `account_*`, `card_*`, `goal_*`, `image_*`, `backend_restart_required`, `cross_site_request`
- `refusalOf` / `isApiError` — 실패 값(F)에서 `ApiError | null`을 꺼내는 헬퍼와 그 판별 함수다
- `archiveErrorMessage` / `projectErrorMessage` / `attachmentErrorMessage` / `compactErrorMessage` — `ApiError | null`을 받아 한국어 거절 문구로 바꾼다. 각각 `ArchiveRejection`/`ProjectRejection`/`AttachmentRejection`/`CompactRejection` 리터럴 표를 쓴다
- `makeSessionLifecycleClient(appFetch: typeof fetch)` — fetch를 주입받아 세션 수명주기(보관·삭제·복원) 클라이언트를 만든다. `SessionChange`를 보내고 `SessionArchiveResult`를 돌려준다. `api`가 내부에서 호출한다
- `SessionChange` — `/api/sessions/:session` 본문 TaggedEnum이다. `Archive{archived, idempotencyKey}`, `Delete{idempotencyKey}`, `Phase{phase}`, `Control{workflowAction}`으로 이루어진다
- `PendingLifecycle` / `SessionArchiveResult` — 끝나지 않은 수명주기 변경(`waiting_for_stop`, `blocked{blocker}`)의 타입과, 완료(현재 Session 포함) 또는 pending인 보관·복원 결과의 타입이다
- `ResumeTaskResult` / `ArchiveTaskResult` / `SessionSnapshot` — work trace 작업 재개·보관 결과와 세션 스냅샷의 `Schema.TaggedUnion`/`Schema.Struct` 디코더다(`decode*`도 함께 있다)
- `FolderPick` — 폴더 선택 창의 답(`picked{root}` | `cancelled` | `unavailable`) `Schema.TaggedUnion`이다. `memory-agent/app-api`의 계약을 다시 내보낸다
- `ProviderAuthState` — `/api/auth`의 공급자 연결 상태 TaggedEnum이다. 타입은 계약(`memory-agent/app-api`의 `ProviderAuthState`)에서 꺼내고 `Data.taggedEnum` 생성자를 붙인다. 변형은 `signed-out`, `pending{authUrl}`, `signed-in{planType?}`, `error{message, code?, operation?, httpStatus?, providerCode?, credentialStage?, transportCode?, proxyRoute?}`이다
- `AccountsView` / `AccountAction` — 한 공급자의 OAuth 프로필 목록과 pending login(비밀값 제외, 계약의 `SubscriptionAccountsView`), 그리고 계약의 `SubscriptionAccountCommand`에서 `provider`를 뺀 계정 동작 유니온이다. `intent`는 add, cancel, select, remove, rename 중 하나다
- `KanbanView` — `{active:false}` 또는 `{active:true} & KanbanBoardView`인 세션 Goal 칸반 상태다
- `BoardEdit` / `BoardIntent` / `DecisionAnswer` — memory-agent 타입에서 `Data.taggedEnum`으로 만든 생성자·matcher다. 페이지가 서버로 보낼 때 쓴다
- `KagiCommand` / `ImportCommand` / `EmbeddingCommand` — `/api/settings/kagi`, `/api/settings/imports`, `/api/settings/embedding` 명령 TaggedEnum이다. 비공개 `ImageSettingsCommand`, `ExternalAgentCommand`, `KanbanCommand`도 같은 방식으로 정의된다
- `EmbedderRuntime` / `GpuState` / `AgentTrustState` / `AgentLinkState` / `McpServerState` / `AccountLoginState` / `ImportActivity` / `WorkflowExecutionState` — 서버 유니온 타입에 `Data.taggedEnum` 생성자·matcher를 붙여 다시 내보낸 것이다
- `GeneratedImageAsset` / `ImageSettingsView` / `CrossProviderMediaRunApproval` — 이미지 자산(+url) 타입, 이미지 설정 뷰(+crossProviderMediaConsent) 타입, 교차 공급자 실행 승인 `Schema.Struct`다
- `ConversationSettings` / `RecallSettings` / `KanbanSettings` / `KanbanSettingsCommand` / `ProjectKanbanSettings` / `ProjectKanbanCommand` — 대화·회상·칸반 설정 뷰와 명령 타입으로, `api.ts`에 정의되어 있다
- `DeliveredEvent` / `ContextEvent` / `eventDecoders` — 스트림 이벤트(대기열 전달, context) `Schema.Struct`와 그 디코더 표다
- `ErrorBody` / `JsonValue` / `JsonBody` — 오류 응답 본문 Schema와 요청 본문 JSON 타입이다
- 재내보내기 — `memory-agent/definitions`의 값 `ApprovalRequester`, `NextDelivery`, `QueueEdit`, `QueueItemState`와, `memory-agent`·definitions의 타입(`Session`, `Project`, `ModelSelection`, `ProviderId`, `QueueSnapshot`, `SessionRunState`, `LeaseView`, `BoardView`, `McpOverview`, `SkillCatalog`, `SubagentView`, `WorkflowPhase` 등)을 `api.ts`에서 다시 내보낸다
- 하위 디렉터리:
  - [`chat`](./chat/README.md) — 한 세션의 대화 패널, 입력창, 메시지 렌더링, 승인 카드, 대기열·BTW·워크플로·작업 추적·보드 패널
  - [`events`](./events/README.md) — 서버 SSE 스트림(`/api/events`)을 구독해 TanStack Query 캐시를 무효화하는 계층
  - [`media`](./media/README.md) — 이미지 생성 훅 `useImageGeneration`과 cross-provider 승인 대화상자
  - [`navigation`](./navigation/README.md) — 왼쪽 사이드바의 모델·프로젝트·세션·판단 대기함·칸반·계정 UI
  - [`queries`](./queries/README.md) — TanStack React Query 키와 범위별 `queryOptions`·훅
  - [`report`](./report/README.md) — `/report` 문제 제보 화면 모듈
  - [`session`](./session/README.md) — 세션 lease, 메시지 큐, run·워크플로 상태, work trace 구독 훅
  - [`settings`](./settings/README.md) — 전역 설정 대화상자 진입점과 페이지 공용 컴포넌트
  - [`shared`](./shared/README.md) — API fetch 래퍼, 재시작 상태, Effect 실행 도우미, Web Crypto, 공용 UI

## Invariants

- 브라우저는 `memory-agent` 루트에서 타입만 import한다(`import type`). 서버로 보내는 유니온의 생성자는 그 타입에서 `Data.taggedEnum`으로 만든다. 도착한 본문은 서버 라우트가 디코드한다(`api.ts` 97-100행 주석). 런타임 값은 `memory-agent/definitions`와 `memory-agent/provider-contracts`에서만 가져온다
- `ApiErrorCode`는 브라우저 API가 이해하는 모든 오류 코드 목록이다. 서버가 새 오류 코드를 보내면 이 리터럴 목록에 추가해야 `ApiError`로 디코드된다
- 세션 보드에 들어가면 프로젝트 보드(`boards`, `boardCard`)를 닫는다(`leaveProjectBoard`). 두 보드는 URL을 함께 쓰지 않는다. 프로젝트를 바꾸면 이전 프로젝트의 session, card, board를 모두 지운다(`leaveProject`)
- URL의 project가 프로젝트 목록에 없으면 `projects[0]`로 바꾼다. 이때 project가 바뀌었으면 session을 null로 둔다. URL의 session이 활성 세션 목록에 없으면 `sessions[0]`로 바꾼다
- 세션 보관·삭제·복원의 결과가 `completed`가 아니면 `PendingLifecycle`(waiting_for_stop / blocked, `goal_dependents` 포함)을 문구로만 보여 준다. 이때 선택 세션은 바꾸지 않는다. `completed`일 때만, 현재 세션이 대상이면 남은 첫 세션으로 옮긴다
- 수명주기 mutation은 `pageHolder`와 함께 만든다. lease가 필요한 세션 변경 api 메서드(`setWorkflowPhase`, `editBoard`, `cancelRun`, `enqueue`, `answerApproval` 등)는 모두 `holder` 인자를 받는다(`sessionHolderHeader` 사용)
- Promise 경계는 `runUiEffect`/`uiPromise`로 감싼다. 실패는 `UnknownError`를 `catchTag`로 잡고 `refusalOf(failure.cause)`로 원래 `ApiError`를 꺼내 문구로 바꾼다
- 공급자별 모델 쿼리는 그 공급자가 `ProviderAuthState` `signed-in`일 때만 켠다
- `SessionChange`의 `Archive`/`Delete` 본문은 `idempotencyKey`를 반드시 담는다

## Side Effects

- 네트워크: `api`의 `call(method: GET|POST|DELETE, path, body?)`이 `appFetch`로 같은 origin의 `/api/*` 라우트에 HTTP 요청을 보낸다. 실패 응답은 `ErrorBody`로 디코드해 `ApiError`로 만든다(`apiError`)
- 네트워크: `uploadAttachment(file)`로 첨부 파일을 업로드한다. `generateImage`로 이미지를 생성 요청한다
- `workTraceStreamUrl(sessionId, after)`로 work trace SSE 스트림 URL을 만든다(구독은 호출자가 맡는다)
- `api.ts`는 `browserCrypto`(Web Crypto 기반 Effect Crypto)를 import한다
- URL 상태: `App`이 nuqs `setLocation`으로 브라우저 쿼리스트링을 바꾼다. 프로젝트 선택·추가 때는 `history: "push"`를 쓴다
- React Query mutation(프로젝트 추가, 모델 선택, 계정 전환, 권한 모드, cross recall, 프로젝트 숨김, 세션 생성, 세션 수명주기)으로 서버 상태를 바꾼다
- `openSettingsOverlay`로 overlay-kit 설정 대화상자를 연다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
