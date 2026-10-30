# queries

## Overview

`apps/agent/app/entry/queries`는 에이전트 앱 프런트엔드의 TanStack React Query 읽기 계층이다. `keys.ts`가 `["app", ...]` 계층의 캐시 키(global / project / session)를 한곳에서 정의한다. `global.ts`·`project.ts`·`session.ts`는 범위별 `queryOptions` 팩토리(`globalQueries`·`projectQueries`·`sessionQueries`)와 그 위의 `useQuery`/`useSuspenseQuery` 훅을 제공한다. 쿼리 함수는 `../api` 클라이언트(`api`, `compatibleClient`)로 백엔드를 읽는다. `mutations` 하위 디렉터리는 같은 키와 팩토리로 캐시를 갱신하거나 무효화한다. `boundary.tsx`는 설정 페이지별로 로딩·오류를 가두는 Suspense와 에러 바운더리 래퍼를 둔다.

## Interface

- `appQueryKeys` — 모든 React Query 키의 단일 정의. `root`(`["app"]`), `global.*`(auth, accountsRoot/accounts(provider), accountQuota(provider), imports, embedding, imageSettings, kagi, conversation, recall, kanban, modelsRoot/models(provider), projects, hiddenProjects), `project.*`(root, sessions, mcp, agents, skills, trace, decisions, boards, kanban, traceTask), `session.*`(root, runState, queue, subagents, approvals, trace, btw, board, decisions, kanban)
- `AppQueryKey` — 쿼리 키 타입 `readonly unknown[]`
- `globalQueries` — global 범위 `queryOptions` 팩토리: auth(60초 `refetchInterval`), accounts, compatibleAccounts(`compatibleQueryKey`+`compatibleClient.list`), accountQuota, projects, hiddenProjects, imports, embedding, imageSettings, kagi, conversation, recall, kanban, models
- `projectQueries` — project 범위 `queryOptions` 팩토리: sessions(active와 archived를 `runUiEffect`+`Effect.gen`으로 묶어 `{active, archived}` 반환), mcp, agents, skills, trace, decisions, boards, traceTask, kanban
- `sessionQueries` — session 범위 `queryOptions` 팩토리: runState(holder 인자), queue, subagents, approvals, trace, board, decisions, kanban, btw
- `useAuthQuery` / `useCompatibleAccountsQuery` / `useProjectsQuery` / `useHiddenProjectsQuery` / `useImageSettingsQuery` — global 범위의 일반 `useQuery` 훅
- `useAccountsQuery` / `useAccountQuotaQuery` / `useModelsQuery` — `(provider, enabled)` 형태의 global 훅. `Function.dual(2, ...)`로 data-last `(enabled)(provider)` 호출도 지원한다
- `useSuspenseImageSettingsQuery` / `useImportsQuery` / `useEmbeddingQuery` / `useKagiQuery` / `useConversationSettingsQuery` / `useRecallSettingsQuery` / `useKanbanSettingsQuery` — 설정 페이지용 `useSuspenseQuery` 훅
- `useProjectSessionsQuery(projectId | null)` / `useAgentsQuery(projectId | null)` — projectId가 null이면 `enabled: false`로 비활성화한다
- `useSkillsQuery` / `useProjectTraceTaskQuery` — `Function.dual(2)` project 훅. traceTask는 taskId가 null이면 비활성화한다
- `useDecisionInboxQuery` / `useProjectBoardsQuery` / `useProjectTraceQuery` — project 범위 일반 `useQuery` 훅
- `useSuspenseMcpQuery` / `useSuspenseAgentsQuery` / `useSuspenseSkillsQuery` / `useSuspenseProjectKanbanQuery` — project 범위 Suspense 훅
- `usableAgents(overview)` — `api.externalAgents` 결과에서 shadowed가 아니고 `AgentTrustState`가 `trusted`인 agent의 이름만 고른다
- `useRunStateQuery` / `useObservedRunStateQuery` — session run-state 훅. `Function.dual(3)`과 `Function.dual(4)`로 data-first와 data-last `(sessionId, holder[, enabled])(projectId)` 호출을 지원한다
- `useQueueQuery` / `useSubagentsQuery` / `useApprovalsQuery` / `useBoardQuery` / `useDecisionsQuery` / `useKanbanQuery` / `useSessionTraceQuery` — `Function.dual(2)` session 훅. `(projectId, sessionId)` 또는 `(sessionId)(projectId)`로 호출한다
- `QuerySection` — `QueryErrorResetBoundary`, 내부 `SectionErrorBoundary`, `Suspense`(Spinner fallback)로 감싸 실패나 로딩을 설정 섹션 안에 가두는 React 컴포넌트. '다시 시도' 버튼이 query reset과 오류 상태 초기화를 함께 한다
- `mutations` — 같은 키와 팩토리로 캐시를 갱신·무효화하는 mutation 훅 모음: [`./mutations/README.md`](./mutations/README.md)

## Invariants

- 쿼리 키는 `appQueryKeys`로만 만든다. 모든 키는 `["app", ...]` 접두사 계층을 따른다. 예외로 `globalQueries.auth`는 키를 `[...appQueryKeys.global.auth, provider]`로 인라인 조합한다.
- session 키는 `["app","project",projectId,"session",sessionId, ...]`로 project 키 아래에 중첩된다. 그래서 project root 키를 무효화하면 그 프로젝트의 session 쿼리도 함께 무효화된다. session API 호출은 sessionId만 쓰지만 키에는 projectId를 넣어야 한다.
- `accounts(provider)`와 `models(provider)` 키는 `accountsRoot`와 `modelsRoot` 아래에 놓인다. 그래서 root 키로 모든 provider를 한꺼번에 무효화할 수 있다. mutation의 `publishModelSelection`은 이 구조에 의존한다.
- `hiddenProjects` 키는 `projects` 키 아래(`["app","global","projects","hidden"]`)에 놓인다. 그래서 프로젝트 목록을 무효화하면 보관 목록도 함께 다시 읽는다.
- `sessionQueries.runState` 키에는 `holder`가 들어가지 않는다. 같은 세션의 run-state 캐시는 holder와 관계없이 하나다.
- staleTime 0을 유지하는 쿼리: project decisions·boards, session runState·board·decisions·kanban. 이 쿼리들은 항상 최신 서버 상태를 다시 읽어야 한다.
- nullable id 훅(`useProjectSessionsQuery`, `useAgentsQuery`, `useProjectTraceTaskQuery`)은 null이면 키에 빈 문자열을 넣고 `enabled: false`로 둔다. 코드 주석은 '프로젝트는 URL과 프로젝트 목록이 정리되는 동안 없을 수 있다'고 설명한다.
- `projectQueries.sessions`의 queryFn은 Promise 경계다. 주석: 'Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.' active와 archived 세션은 순차로 읽는다.
- dual 훅의 data-last 형태에서 마지막에 받는 인자는 항상 첫 인자(provider 또는 projectId)다. arity(2·3·4)는 body 함수의 인자 수와 맞아야 한다.
- Suspense 훅(`useSuspense*`, `useImportsQuery` 등)은 `QuerySection` 같은 Suspense와 에러 바운더리 안에서만 렌더해야 한다.

## Side Effects

- 네트워크: queryFn이 `api.*`(auth, accounts, accountQuota, projects, hiddenProjects, imports, embedding, imageSettings, kagi, conversationSettings, recallSettings, kanbanSettings, models, sessions, archivedSessions, mcpServers, externalAgents, skills, projectWorkTrace, decisionInbox, projectBoards, projectWorkTraceTask, projectKanban, sessionRunState, queue, subagents, relayedApprovals, workTrace, board, decisions, kanban, btwThreads)와 `compatibleClient.list`로 백엔드를 읽는다
- 타이머: `globalQueries.auth`는 `refetchInterval: 60_000`으로 60초마다 다시 요청한다
- React Query 캐시: 훅이 쿼리 결과를 QueryClient 캐시에 읽고 쓴다
- `QuerySection`의 '다시 시도' 버튼은 `QueryErrorResetBoundary`의 reset으로 실패한 쿼리를 다시 시도하게 한다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
