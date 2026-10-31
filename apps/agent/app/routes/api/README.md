# api

## Overview

`apps/agent`의 React Router v7 리소스 라우트 모음이다. 파일 이름이 곧 `/api/...` 경로이며(예: `sessions.$session.board.tsx` → `/api/sessions/:session/board`), 각 파일은 `loader`(GET)와 `action`(POST)만 export한다.

모든 핸들러는 `~/.server/agent`의 `agent.runPromise`로 Promise 경계를 넘어 `packages/memory-agent`의 Effect 서비스(Projects, ProviderRegistry, OAuthProfiles, Attachments, AppEvents, ReportDelivery 등)를 호출한다. 태그된 실패는 `{ error, reason? }` JSON과 HTTP 상태 코드로 바꾼다.

계정·인증·모델 선택·첨부 이미지·이미지 생성·프로젝트 설정(에이전트/MCP/스킬/칸반/보드/결정)·보고서 전송·SSE 무효화 이벤트를 브라우저 UI에 노출하는 얇은 HTTP 어댑터 계층이다.

라우트 파일은 Effect HttpApi로 옮기는 중이다(`docs/httpapi-migration.md`). 파일이 없는 `/api/...` 요청은 `$.tsx`가 받아 `~/.server/api`의 `serveApi`로 넘긴다. 채팅 API(`memory-agent/chat-api`)와 옮긴 앱 API group(`memory-agent/app-api`, 핸들러는 `~/.server/api/<group>.ts`)이 그 web handler에서 답한다. React Router는 정적 경로를 splat보다 먼저 고르므로, 남은 라우트 파일은 그대로 답한다.

## Interface

- `$.tsx` `loader`/`action` — 라우트 파일이 없는 `/api/*` 요청을 `serveApi`로 넘긴다. 채팅 API(`/api/sessions/:session/messages`, `/api/sessions/:session/runs`, `/api/sessions/:session/runs/:run/events`, `/api/btw/:thread/messages`, `/api/btw/:thread/runs`), 앱 API settings group(`/api/settings/{conversation,recall,kanban,kagi,embedding,image,imports,improvements}`), projects group(`/api/projects`, `/api/projects/pick`, `/api/projects/:project`, `/api/projects/:project/{agents,mcp,skills,kanban,boards,decisions}`), auth·accounts·models group(`/api/auth`, `/api/accounts`, `/api/accounts/quota`, `/api/models`, `/api/models/:model`), sessions group(`/api/sessions`, `/api/sessions/:session/decisions`, `/api/sessions/:session/decisions/:decision`)이 여기서 답한다.
- `attachments._index.tsx` `action` — POST /api/attachments: 원시 이미지 바이트를 content hash로 저장하고 201 `{ id, mimeType, bytes }`를 돌려준다(PNG/JPEG/GIF/WebP, 최대 `maxAttachmentBytes`).
- `attachments.$attachment.tsx` `loader` — GET /api/attachments/:attachment: 저장된 이미지 바이트를 immutable 캐시 헤더로 돌려준다. 실패 태그는 404 `attachment_not_found`, 500 `attachment_unreadable`.
- `media.image.tsx` `action` — POST /api/media/image: 유료 직접 이미지 생성(`ImageMediaWorkflow.generate`)이다. 승인 필요 시 409, 사용 불가 시 422, 실행 실패 시 502를 돌려준다.
- `projects.$project.trace.tsx`, `projects.$project.trace.tasks.$task.tsx` `loader` — `AgentChat.projectTraceTree` / `projectTraceTask`.
- `events.tsx`, `projects.$project.events.tsx` `loader` — `AppEvents.allStream` / `projectStream` 무효화 이벤트 스트림.
- `reports.delivery.tsx` `loader`/`action` — webhook 상태와 defectReports 조회. TaggedUnion `send`(보고서+evidence 전송)/`defect_reports`(켜기·끄기) 처리.
- `reports.diagnosis.tsx` `action` — `ReportDiagnoser.diagnose`로 검토된 초안을 선택 모델로 진단한다.
- `reports.evidence.tsx` `loader` — `reportBundleResponse` + `collectReportBundle`로 세션 evidence 번들을 돌려준다(redact 후 한도에 맞춰 자른다).
- `btw.$thread._index.tsx` `action`(= `makeBtwHandlers(agent).remove`).
- (본문 미확인, export만 확인) `sessions.$session._index.tsx`, `sessions.$session.{board,kanban,lease,queue._index,trace.tasks.$task}.tsx` `loader`+`action`; `sessions.$session.{approvals._index,events,subagents._index,subagents.$subagent,trace,trace.stream}.tsx` `loader`; `sessions.$session.{approvals.$approval,cancel,compact,interrupts.discard,queue.$message,uncertain}.tsx`, `reports.sessions.tsx` `action`; `sessions.$session.btw.tsx` `loader`/`action`(= btw handlers list/create).
- 하위 디렉터리 없음.

## Invariants

- HttpApi로 옮긴 group은 cross-site 검사를 `SameSite` middleware(`~/.server/api`의 `SameSiteLive`, 같은 `crossSiteRefusal`)로 하고, 본문 검사와 실패 매핑을 계약 Schema와 handler의 `Effect.catchTags`로 한다. 계약에 없는 payload는 HttpApi가 빈 400으로 거절한다. 아래 규칙은 남은 라우트 파일의 것이다.
- 상태를 바꾸는 모든 `action`은 맨 먼저 `rejectCrossSite(request)`를 호출한다. 결과가 null이 아니면 그 Response를 그대로 돌려준다(same-origin 전용). `attachments.$attachment.tsx` loader도 `Sec-Fetch-Site: cross-site`이면 403을 돌려준다(이미지는 공개 자산이 아니라 대화 evidence).
- 요청 본문은 `readJson(request, Schema)`로 디코드한다. 실패하면 라우트별 고유 에러 코드와 400을 돌려준다.
- 라우트는 Promise 경계일 뿐이다. 도메인 로직은 `agent.runPromise` 안의 Effect로 실행하고, 실패 태그는 `Effect.catchTag(s)`로 HTTP 상태 JSON에 매핑한다.
- 브라우저에 keychain·native OAuth 에러나 토큰을 노출하지 않는다. accounts group은 `~/.server/account-failures`의 `accountRefusal` 표와 `~/.server/compatible-handlers`의 operation별 거부로 고정 code만 답하고, 남은 라우트는 `answerDefect`를 쓴다. webhook URL과 토큰은 반환하지 않는다. MCP의 env·header 값과 외부 에이전트의 env 값은 숨긴다.
- `reports.delivery.tsx`의 `failureStatus`와 `reports.diagnosis.tsx`의 `diagnosisStatus`는 `satisfies Record<…Failure, number>`로 모든 실패 reason에 상태 코드를 하나씩 둔다. 브라우저는 거부된 본문을 읽지 않고 상태 코드로 reason을 복원하므로 이 매핑은 1:1로 유지해야 한다.
- 구독 quota는 검증되고 허용된 경로만 숫자를 보고한다. 로컬 토큰 수로 대체하지 않는다.
- 레거시 OAuth import(`OAuthProfiles.importLegacy`)가 실패하면 로그만 남긴다. 기존 인증은 그대로 쓰고, 다음 요청에서 다시 시도한다.
- auth group의 `action`은 구독 공급자만 받는다(계약의 payload가 `SubscriptionAccountProvider`). 브라우저 응답에서는 pending 상태의 `authorizationUrl`을 `authUrl`로 바꿔 내보낸다(`browserState`). models `list`의 401 `auth`도 같은 모양이다.
- 계정 label은 trim 후 비어 있지 않고 80자 이하여야 한다(add/rename). accountId는 비어 있지 않고 128자 이하여야 한다(select/remove/rename).
- 첨부는 content-addressed다. 같은 id는 같은 바이트이므로 `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`을 붙인다. 업로드는 본문을 읽기 전에 `Content-Length`를 `maxAttachmentBytes`와 비교한다(초과 시 413). `AttachmentRejected` reason이 `too_large`이면 413, 그 밖은 422다.
- models group의 `select`는 공급자 fallback 없이 명시된 provider/model/effort만 저장한다. 이미지 생성은 chat 도구 컨텍스트 밖에서 하며, `initiatorChatRouteId`는 활성 선택에서 `chat:${provider}:${model}` 형태로 만든다.
- sessions group의 결정 답변은 `SessionLeases.permits`로 holder를 확인하고(423 `session_in_use`), 답한 뒤 `KanbanOrchestrator.poke`로 그 Goal의 loop를 깨운다. 외부 에이전트로 대화를 만들면 `ExternalAgents.available(project)`에 그 에이전트가 있어야 한다(409 `external_agent_unavailable`). 새 대화는 `publishProject(project, "sessions")`를 발행한다.
- projects group의 프로젝트 하위 endpoint(kanban, boards, decisions)는 서비스 호출 전에 `Projects.get(params.project)`로 존재를 확인하고, 실패는 `~/.server/kanban-failures`의 `kanbanRefusal`로 답한다. kanban `MoveGoal`은 `Sessions.get`으로 `sessionId`와 `before`(null이 아닐 때)를 확인한 뒤 `ProjectScheduler.moveGoal`을 호출한다.
- 상태를 바꾼 뒤에는 `AppEvents`로 무효화를 발행한다. 프로젝트 변경은 `publishGlobal("projects")`, 인증·계정 변경은 `publishGlobal("auth")`, Goal 이동은 `publishProject(project, "sessions")`다. 분리된 대기 fiber는 끝나는 방식과 상관없이 `Effect.ensuring`으로 `auth`를 발행한다.
- `Server-Timing` 헤더는 `import.meta.env.DEV || process.argv.includes("--dev-backend")`일 때만 붙인다. stable dev backend는 Vite DEV 플래그가 꺼진 production 번들이기 때문이다. `serveApi`가 답하는 요청은 handler 전체 시간 하나(`handler;dur=`)를 붙인다.
- `reports.evidence.tsx`의 query 식별자는 권한 근거가 아니다(local-server 전용, read-only). 번들은 redact하고 한도에 맞춰 자른다.
- 프로젝트 등록 경로는 정규화한다. 앱 storage 디렉터리와 겹치면 안 된다(주석 근거, `Projects.add`가 `ProjectRootRejected`로 거부한다).
- 계정·quota·보고서 응답은 `Cache-Control: no-store`로 돌려준다. accounts group은 `NoStore` middleware(`~/.server/api`의 `NoStoreLive`)가 거부를 포함한 모든 답에 붙인다.
- 폴더 선택 창(projects group `pick`, `~/.server/folder-picker`)의 답은 경로일 뿐이다. 등록은 브라우저가 그 경로로 POST /api/projects를 다시 불러 같은 검사를 거친다. 플랫폼별 창(darwin `osascript`, win32 `powershell.exe`, linux `zenity`→`kdialog`) 가운데 처음 시작되는 것이 답한다. 시작되는 창이 없거나 창이 실패하면 `unavailable`이고, 브라우저는 경로 입력 다이얼로그를 연다.

## Side Effects

- 모든 핸들러가 `~/.server/agent`의 `agent` 런타임에서 Effect를 실행한다(`agent.runPromise`).
- OAuth 계정을 바꾼다: `OAuthProfiles.importLegacy`(OS keychain에서 import)와 `remove`/`rename`/`select`, `OAuthAccountLogins.start`/`cancel`(로그인은 다른 탭에서 끝난다). `ProviderRegistry` 공급자의 `auth.connect`/`disconnect`/`cancel`도 여기에 속한다.
- `Effect.forkDetach`로 백그라운드 fiber를 띄운다. 계정 add는 `manager.settled`를 기다린다. auth pending은 250ms 간격으로 상태를 polling하고(`Effect.repeat`), 끝나면 `publishGlobal("auth")`를 발행한다.
- 첨부 파일을 저장소에 쓰고 읽는다(`Attachments.save`, `Attachments.read`).
- projects group `pick`은 서버 기기에서 폴더 선택 창 프로세스를 띄운다(`ChildProcessSpawner`). 요청이 끊기면 Scope와 함께 창을 닫는다. 고른 경로는 `FileSystem.realPath`로 정규화한다.
- `ImageMediaWorkflow.generate`로 유료 외부 이미지 생성을 호출한다. `request.signal`을 넘긴다.
- 모델 선택(`configured.models.select`)을 전역 선택으로 저장하고, 공급자 모델 카탈로그를 네트워크로 조회한다.
- `ReportDelivery.send`로 서버 설정의 Discord webhook(`DISCORD_WEBHOOK_URL`)에 보고서와 JSON evidence 첨부를 전송한다. `GlobalConfig.update({ defectReports })`로 전역 설정을 쓴다.
- `ReportDiagnoser.diagnose`로 사용자가 선택한 모델을 호출한다. 보내는 내용은 사용자가 포함한 설명과 evidence뿐이다.
- `collectReportBundle`로 세션 evidence를 수집한다. `SqlError`를 잡으므로 SQL 저장소를 읽는다.
- `AppEvents.allStream`/`projectStream`으로 장기 연결 이벤트 스트림을 연다. `publishGlobal`/`publishProject`로 무효화 이벤트를 발행한다.
- `process.argv`와 `import.meta.env.DEV`를 읽는다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
