# mutations

## Overview

`apps/agent/app/entry/queries/mutations`는 에이전트 앱 프런트엔드의 TanStack React Query mutation 훅 모음이다. 각 훅은 `apps/agent/app/entry/api`의 `api` 클라이언트(또는 `compatibleClient`)로 백엔드에 쓰기 요청을 보낸다. 성공하거나 끝나면 `globalQueries`·`projectQueries`·`sessionQueries`·`appQueryKeys`의 키로 캐시를 갱신하거나 무효화한다.

파일은 범위별로 나뉜다. `global.ts`는 전역 설정·계정·모델 선택을 맡는다. `project.ts`는 프로젝트 설정과 대화 생명주기를 맡는다. `session.ts`는 대화별 칸반·결정·큐·trace·workflow를 맡는다. session/project 범위 훅은 `Effect`의 `Function.dual`로 data-first와 data-last(`projectId`를 마지막에 받는 curried) 두 호출 형태를 함께 제공한다.

## Interface

- `useSwitchAccountMutation` — 사이드바 계정 전환. provider가 바뀌면(`selectModel`) 그 provider의 기본 모델도 `api.selectModel`로 고른다. `runUiEffect`+`Effect.gen`으로 실행한다.
- `AccountTarget` — 전환할 계정 타입: `{provider: SubscriptionAccountProvider | "openai-compatible", accountId}`
- `useSelectModelMutation(provider)` — 모델과 effort를 선택하고 `publishModelSelection`으로 모든 provider의 models 캐시의 `selected`를 고친다.
- `useAccountActionMutation(provider)` — 구독 계정 동작 결과 view를 accounts 캐시에 쓰고, quota·auth·models 쿼리를 무효화한다.
- `useCompatibleAccountMutation` — `compatibleClient.change`로 openai-compatible endpoint와 모델을 추가·수정·삭제한다.
- `useConversationSettingsMutation` / `useKanbanSettingsMutation` / `useRecallSettingsMutation` / `useProjectOrderMutation` — 응답 스냅샷을 해당 global 쿼리에 `setQueryData`로 바로 쓴다. `useProjectOrderMutation`은 `api.moveProject`로 스케줄러의 프로젝트 순서를 바꾼다.
- `useImageGenerationEnabledMutation` / `useCrossProviderConsentMutation` / `useKagiMutation` / `useImportMutation` / `useEmbeddingMutation` / `useAddProjectMutation` — 설정 쓰기 후 해당 global 쿼리를 무효화한다.
- `useGoalOrderMutation(projectId)` — `api.moveGoal`로 대화 Goal 순서를 바꾼다. 성공하면 project kanban 캐시에 쓰고, 끝나면 boards를 무효화한다.
- `AgentChange` / `useExternalAgentMutation(projectId)` — 외부 에이전트 trust와 reconnect용 tagged enum과 그 mutation
- `SessionLifecycleChange` / `useSessionLifecycleMutation` — 대화 archive·restore·delete. holder는 `() => string` thunk이고 dual arity는 2다.
- `useMcpTrustMutation` / `useProtectedBranchesMutation` / `usePermissionModeMutation` / `useCrossRecallMutation` / `useHideProjectMutation` / `useCreateSessionMutation` — 프로젝트 단위 설정과 세션 생성 mutation
- `KanbanAction` — 칸반 동작 tagged enum: `Start`, `RestartLoop`, `Intent{intent: BoardIntent}`, `SetDependencies{dependsOn}`
- `useKanbanMutation` — 한 대화의 칸반 시작, intent, 의존성 변경. 끝나면 kanban과 board를 무효화한다(dual arity 3).
- `useBoardsKanbanMutation` — 여러 Plan을 보여 주는 보드에서 요청마다 sessionId를 지정하는 칸반 동작. Transfer면 받는 대화의 kanban·board도 무효화한다(dual arity 2).
- `useEditBoardMutation` / `useBoardsEditMutation` — `api.editBoard`로 보드를 편집한다. 끝나면 board·runState(+boards)를 무효화한다.
- `useAnswerDecisionMutation` — 프로젝트 안 아무 세션의 카드 결정에 답한다. board·decisions·kanban·project decisions를 무효화한다.
- `WorkflowChange` / `useWorkflowMutation` — workflow 변경 tagged enum과 mutation. `api.setWorkflowPhase` 또는 `api.controlWorkflow`를 호출한다(301행 이후는 그래프로만 확인).
- `useCancelRunMutation` / `useCompactSessionMutation` — 실행 취소(`api.cancelRun`)와 세션 compact. 성공하면 runState를 무효화한다.
- `useEnqueueMutation` / `useEditQueueMutation` / `useRelayedApprovalMutation` — 메시지 큐 추가(`mode: "queue" | "steer"`)와 편집, 중계된 승인 응답. queue와 approvals 쿼리를 무효화한다.
- `useResumeTraceTaskMutation` / `useArchiveTraceTaskMutation` / `useDeleteTraceTaskMutation` — work-trace task 재개(`confirmUncertain`), 보관, 삭제. 세션 trace와 project trace를 무효화한다.
- 하위 디렉터리 없음

## Invariants

- 모델 선택은 성공한 쓰기가 소유한다. `publishModelSelection`은 먼저 `appQueryKeys.global.modelsRoot` 쿼리를 `cancelQueries`로 취소한다. 그다음 `openai`·`anthropic`·`openai-compatible` 각 models 캐시의 `selected`를 바꾼다. 선택한 provider만 selection을 받고 나머지는 null이 된다. 이렇게 해서 오래된 catalog 응답이 선택을 되돌리지 못한다.
- 모델을 바꾸는 mutation(`useSelectModelMutation`, `useSwitchAccountMutation`)은 `onSettled`에서 `modelsRoot`를 무효화한다. 실패해도 무효화한다.
- `useSwitchAccountMutation`은 계정이나 endpoint를 선택한 직후 그 provider의 진행 중인 models 쿼리를 취소한다. 진행 중인 catalog는 이전 계정 것일 수 있기 때문이다. 그다음 `staleTime: 0`으로 다시 fetch해서 `isDefault` 모델을, 없으면 첫 모델을 고른다. 모델 선택 하나가 chat이 어느 계정으로 실행될지 정한다.
- quota·auth·models 갱신은 `void client.invalidateQueries`로 띄우고 기다리지 않는다. 그 오류는 React Query가 해당 쿼리에 보고한다(주석 근거).
- openai-compatible 계정 목록을 바꾸면 `publishCompatibleAccounts`가 compatibleAccounts 캐시를 쓰고 `auth("openai-compatible")`와 models를 무효화해야 한다.
- 설정 mutation의 응답은 그 쿼리의 완전한 새 서버 스냅샷이다. 그래서 conversation·kanban·recall·project kanban은 `setQueryData`로 바로 덮어쓴다.
- 세션 범위 API 호출에는 항상 `holder`(세션 소유자 식별자)를 넘긴다. `useSessionLifecycleMutation`은 holder를 thunk로 받아 mutate 시점에 평가한다.
- dual 훅의 arity는 고정이다. `(projectId, sessionId, holder)` 형태는 3, `(projectId, holder)` 형태는 2다. data-last 형태는 `projectId`를 마지막에 받는다.
- 보드와 칸반 변경(`useEditBoardMutation`, `useKanbanMutation`, `useBoardsKanbanMutation`, `useBoardsEditMutation`, `useAnswerDecisionMutation`, `useGoalOrderMutation`의 boards)은 `onSettled`에서 무효화한다. 실패해도 다시 읽는다. 나머지 대부분은 `onSuccess`에서만 무효화한다.
- Transfer intent는 보내는 대화와 받는 대화(`intent.toSessionId`)의 kanban·board를 둘 다 무효화하고, project boards도 무효화한다.
- tagged enum(`KanbanAction`, `AgentChange`, `SessionLifecycleChange`, `WorkflowChange`)은 `$match`로 모든 케이스를 API 호출에 매핑한다. 케이스를 추가하면 매핑도 추가해야 한다.
- 주석: mutationFn은 native SDK 호출자를 위한 Promise 경계이고, 도메인 Effect는 호출자 runtime에서 실행된다.

## Side Effects

- `api.*`와 `compatibleClient.change`로 백엔드에 네트워크 쓰기 요청을 보낸다. 대상은 설정, 계정 선택과 삭제, 모델 선택, 프로젝트와 Goal 순서, MCP와 외부 에이전트 trust, 세션 생성·보관·삭제, 칸반, 결정 응답, 큐, 승인, work-trace task, compact, 실행 취소, workflow다.
- React Query 캐시를 바꾼다: `setQueryData`, `invalidateQueries`(그에 따른 refetch), `cancelQueries`.
- `useSwitchAccountMutation`은 `client.fetchQuery`로 models catalog를 직접 다시 가져오고, `runUiEffect`로 Effect 프로그램을 실행한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
