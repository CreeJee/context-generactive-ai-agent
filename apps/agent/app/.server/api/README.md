# api (server)

## Overview

앱 API 계약 `AppApi`(`memory-agent/app-api`)의 group별 handler다. 파일 하나가 group 하나 또는 몇 개를 `HttpApiBuilder.group(AppApi, ...)`으로 구현한다. 한 단계 위의 `../api.ts`가 이 handler와 채팅 API(`ChatApi`) handler를 web handler 하나(`serveApi`)로 묶고, `app/routes/api/$.tsx`가 라우트 파일이 없는 `/api/*` 요청을 그리로 넘긴다.

경로·상태·거부 code는 계약이 정한다(`packages/memory-agent/src/api/README.md`). handler는 서비스를 부르고, 도메인 실패를 그 endpoint가 선언한 거부로 바꾼다.

## Interface

- `settings.ts` `SettingsApiHandlers` — `/api/settings/*`.
- `projects.ts` `ProjectsApiHandlers` — `/api/projects`, `/api/projects/pick`, `/api/projects/:project`과 그 아래 agents·mcp·skills·kanban·boards·decisions.
- `providers.ts` `AuthApiHandlers`·`AccountsApiHandlers`·`ModelsApiHandlers` — `/api/auth`, `/api/accounts`, `/api/accounts/quota`, `/api/models`, `/api/models/:model`.
- `sessions.ts` `SessionsApiHandlers` — `/api/sessions`, `/api/sessions/:session`과 그 아래 결정·보드·칸반·큐·하위 에이전트·중계 승인·run 제어.
- `trace.ts` `TraceApiHandlers` — 세션과 프로젝트의 Work Trace, 세션 trace SSE(`/api/sessions/:session/trace/stream`).
- `btw.ts` `BtwThreadsApiHandlers` — `/api/sessions/:session/btw`, DELETE `/api/btw/:thread`.
- `reports.ts` `ReportsApiHandlers` — `/api/reports/{sessions,evidence,diagnosis,delivery}`.
- `media.ts` `MediaApiHandlers` — `/api/media/image`.
- `events.ts` `EventsApiHandlers` — 무효화 SSE(`/api/events`, `/api/projects/:project/events`, `/api/sessions/:session/events`).
- `agent-chat-refusals.ts` `refusalsOnly` — `AgentChat` 메서드의 실패 가운데 `Error`가 아닌 거부 값만 남기고 나머지를 defect로 바꾼다.

## Invariants

- handler가 쓰는 서비스는 group을 만들 때 꺼낸다(`Effect.fn(function* (handlers) { ... })`). 요청 handler 안에서 꺼내면 그 서비스가 web handler의 요청별 context 요구로 남는다. 메서드가 호출마다 서비스를 요구하면 group을 만들 때 꺼낸 값을 `Effect.provideService`나 `Effect.provideContext`로 넣는다.
- 상태를 바꾸는 endpoint는 `SameSite` middleware(`../api.ts`의 `SameSiteLive`, `../http.ts`의 `crossSiteRefusal`)를 거친다. 계약에 맞지 않는 payload·query는 HttpApi가 빈 400으로 거절한다.
- 브라우저에 keychain·native OAuth 에러나 토큰을 노출하지 않는다. accounts group은 `../account-failures.ts`의 `accountRefusal` 표와 `../compatible-handlers.ts`의 operation별 거부로 고정 code만 답한다. 선언하지 않은 실패는 `Effect.orDie`로 500이고, `HttpEffect`가 cause를 보고한다. webhook URL과 토큰은 반환하지 않는다. MCP의 env·header 값과 외부 에이전트의 env 값은 숨긴다.
- 계정·quota·보고서·SSE 응답은 `Cache-Control: no-store`다. `NoStore` middleware(`../api.ts`의 `NoStoreLive`)가 거부를 포함한 모든 답에 붙인다.
- 구독 quota는 검증되고 허용된 경로만 숫자를 보고한다. 로컬 토큰 수로 대체하지 않는다.
- 레거시 OAuth import(`OAuthProfiles.importLegacy`)가 실패하면 로그만 남긴다. 기존 인증은 그대로 쓰고, 다음 요청에서 다시 시도한다.
- auth group의 `action`은 구독 공급자만 받는다(계약의 payload가 `SubscriptionAccountProvider`). 브라우저 응답에서는 pending 상태의 `authorizationUrl`을 `authUrl`로 바꿔 내보낸다(`browserState`). models `list`의 401 `auth`도 같은 모양이다.
- models group의 `select`는 공급자 fallback 없이 명시된 provider/model/effort만 저장한다.
- media group의 이미지 생성은 chat 도구 컨텍스트 밖에서 하며, `initiatorChatRouteId`는 활성 선택에서 `chat:${provider}:${model}` 형태로 만든다. 선택한 chat 모델이 없으면 422 `image_route_unavailable`이다.
- reports group 계약의 `deliveryFailureStatus`와 `diagnosisFailureStatus`는 실패 reason마다 상태 하나를 둔다. 제보 페이지는 거부된 본문을 읽지 않고 이 표로 상태에서 reason을 찾는다.
- reports group `evidence`의 query 식별자는 권한 근거가 아니다(local-server 전용, read-only). handler는 `../report-evidence.ts`의 `reportSession`으로 세션이 그 프로젝트에 있는지 먼저 확인한다. 번들은 redact하고 한도에 맞춰 자른다. 분석 세션 열기(`openSession`)는 성공한 뒤에만 `publishProject(project, "sessions")`를 발행한다.
- projects group의 프로젝트 하위 endpoint(kanban, boards, decisions)는 서비스 호출 전에 `Projects.get(params.project)`로 존재를 확인하고, 실패는 `../kanban-failures.ts`의 `kanbanRefusal`로 답한다. kanban `MoveGoal`은 `Sessions.get`으로 `sessionId`와 `before`(null이 아닐 때)를 확인한 뒤 `ProjectScheduler.moveGoal`을 호출한다.
- 프로젝트 등록 경로는 정규화한다. 앱 storage 디렉터리와 겹치면 안 된다(`Projects.add`가 `ProjectRootRejected`로 거부한다).
- 폴더 선택 창(projects group `pick`, `../folder-picker.ts`)의 답은 경로일 뿐이다. 등록은 브라우저가 그 경로로 POST /api/projects를 다시 불러 같은 검사를 거친다. 플랫폼별 창(darwin `osascript`, win32 `powershell.exe`, linux `zenity`→`kdialog`) 가운데 처음 시작되는 것이 답한다. 시작되는 창이 없거나 창이 실패하면 `unavailable`이고, 브라우저는 경로 입력 다이얼로그를 연다.
- sessions group의 보드·칸반 endpoint도 holder를 확인한다. 보드 변경이 저장되면 멈춘 카드의 결정을 `card_stopped`로 닫고(`CancelCard`), 닫은 Plan의 loop를 깨운다(`ClosePlan`). 보드·칸반 변경 뒤에는 `publishSession(session, "run-state")`를 발행하고, 다른 대화로 옮긴 카드는 받는 대화에도 발행한다. 실패는 `kanbanRefusal`로 답한다.
- sessions group의 결정 답변은 `SessionLeases.permits`로 holder를 확인하고(423 `session_in_use`), 답한 뒤 `KanbanOrchestrator.poke`로 그 Goal의 loop를 깨운다. 외부 에이전트로 대화를 만들면 `ExternalAgents.available(project)`에 그 에이전트가 있어야 한다(409 `external_agent_unavailable`). 새 대화는 `publishProject(project, "sessions")`를 발행한다.
- sessions group의 큐·하위 에이전트·중계 승인·run 제어(cancel, compact, interrupts/discard, uncertain, lease)·세션 상태·세션 변경 endpoint는 `AgentChat` 메서드를 부른다. 메서드가 `{ error }` 값이나 `blocked` 수명주기 결과로 낸 거부는 그대로 답하고, 그 밖의 실패(`Error`)는 `refusalsOnly`가 defect로 바꿔 500으로 답한다. 큐를 바꾸면 `publishSession(session, "queue")`, 승인에 답하면 `publishSession(session, "relayed-approvals")`, cancel과 lease 뒤에는 `publishSession(session, "run-state")`를 발행한다. 세션 변경은 보관·복원·삭제 뒤에 `publishProject(project, "sessions")`, workflow 단계·동작 뒤에 `publishSession(session, "run-state")`를 발행한다. 거부된 요청은 handler가 발행하지 않는다. cancel은 거부되기 전에 이미 멈춘 continuation을 `AgentChat` 안에서 발행한다.
- trace group endpoint도 `AgentChat` 메서드를 부르고 `refusalsOnly`로 거부만 답한다. 막힌 재시도와 막힌 태스크 변경은 `blocked` 값으로 답한다. 태스크 변경은 무효화 이벤트를 발행하지 않는다. 페이지가 변경 뒤에 `work-trace:changed`를 낸다.
- 상태를 바꾼 뒤에는 `AppEvents`로 무효화를 발행한다. 프로젝트 변경은 `publishGlobal("projects")`, 인증·계정 변경은 `publishGlobal("auth")`, Goal 이동은 `publishProject(project, "sessions")`다. 분리된 대기 fiber는 끝나는 방식과 상관없이 `Effect.ensuring`으로 `auth`를 발행한다.
- 개발용 `Server-Timing`(`handler;dur=`)은 `import.meta.env.DEV || process.argv.includes("--dev-backend")`일 때만 `../api.ts`가 붙인다. stable dev backend는 Vite DEV 플래그가 꺼진 production 번들이기 때문이다.

## Side Effects

- 모든 handler가 `../agent.ts`의 `agent` 런타임 context에서 돈다.
- OAuth 계정을 바꾼다: `OAuthProfiles.importLegacy`(OS keychain에서 import)와 `remove`/`rename`/`select`, `OAuthAccountLogins.start`/`cancel`(로그인은 다른 탭에서 끝난다). `ProviderRegistry` 공급자의 `auth.connect`/`disconnect`/`cancel`도 여기에 속한다.
- `Effect.forkDetach`로 백그라운드 fiber를 띄운다. 계정 add는 `manager.settled`를 기다린다. auth pending은 250ms 간격으로 상태를 polling하고(`Effect.repeat`), 끝나면 `publishGlobal("auth")`를 발행한다.
- projects group `pick`은 서버 기기에서 폴더 선택 창 프로세스를 띄운다(`ChildProcessSpawner`). 요청이 끊기면 Scope와 함께 창을 닫는다. 고른 경로는 `FileSystem.realPath`로 정규화한다.
- media group이 `ImageMediaWorkflow.generate`로 유료 외부 이미지 생성을 호출한다. 요청이 끊겨 handler가 interrupt되면 `Effect.abortSignal`로 넘긴 signal이 그 호출을 멈춘다.
- 모델 선택(`configured.models.select`)을 전역 선택으로 저장하고, 공급자 모델 카탈로그를 네트워크로 조회한다.
- `ReportDelivery.send`로 서버 설정의 Discord webhook(`DISCORD_WEBHOOK_URL`)에 보고서와 JSON evidence 첨부를 전송한다. `GlobalConfig.update({ defectReports })`로 전역 설정을 쓴다.
- `ReportDiagnoser.diagnose`로 사용자가 선택한 모델을 호출한다. 보내는 내용은 사용자가 포함한 설명과 evidence뿐이다.
- `collectReportBundle`로 세션 evidence를 수집한다. SQL 저장소를 읽는다.
- events group과 trace SSE가 장기 연결을 연다. 페이지가 연결을 끊으면 응답 본문이 취소되고, 서버가 멈추면 스트림이 끝난다.
- `process.argv`와 `import.meta.env.DEV`를 읽는다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
