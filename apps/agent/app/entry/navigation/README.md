# navigation

## Overview

`apps/agent/app/entry/navigation`은 에이전트 웹앱(React) 왼쪽 사이드바의 UI 모듈 모음이다. 모델·추론 강도 선택, 프로젝트 선택·추가·권한, 세션 목록, 판단 대기함, 칸반 보드 버튼을 맡는다. 구독(ChatGPT·Claude) 계정 전환기와 계정 관리자(한도 게이지, 이름 변경, 로그아웃)도 이 디렉터리에 있다. `compatible-client.ts`는 OpenAI 호환 엔드포인트 계정을 `/api/accounts`로 조회·변경하는 Effect 기반 클라이언트다. 이 컴포넌트들은 `apps/agent/app/entry/index.tsx`의 `App`이 렌더링한다.

## Interface

- `ModelSection` — 모델 Select와, 선택한 모델이 허용하는 추론 강도 Select를 그리는 사이드바 섹션 (sidebar.tsx)
- `ProjectSection` — 접히는 프로젝트 섹션. 이름으로 찾는 프로젝트 Combobox(보관한 프로젝트는 따로 묶음), 폴더 열기 버튼, 권한 모드(ask/auto/full), 다른 프로젝트 기억 검색 토글(R08), 보관하기를 담는다 (sidebar.tsx)
- `SessionSection` — 세션·보관 세션 목록. "대화" 머리줄의 위치 필터 메뉴(`sessionPlace`·`placeFilterOf`·`shownIn`)로 나눠 보여 준다. 행은 `SidebarMenuButton`이다. 위치 칩은 모든 위치를 볼 때 worktree 대화에만 붙는다. 보관·원본 삭제는 행에 올리거나 포커스하면 나타나는 `SidebarMenuAction` 메뉴에 있다. 원본 삭제는 `AlertDialog`로 확인받는다. 목록을 불러오는 동안(`loading`)은 Skeleton을 보인다 (sidebar.tsx, `App`이 렌더)
- `Separator` — sidebar.tsx가 `~/components/ui/separator`에서 다시 내보내는 구분선
- `SidebarDisclosureTrigger` — `CollapsibleTrigger` 래퍼. `leading` 슬롯, 말줄임 본문, 회전하는 chevron을 그린다
- `AccountModelPanel` / `accountSummary` — 공급자 인증 상태와 선택 모델을 한 줄로 요약하고 설정을 접어 두는 패널. `accountSummary`는 `{status, model, hasError}`를 돌려주는 dual 함수다
- `DecisionInbox` — 프로젝트 전체에서 사람의 판단을 기다리는 카드 수를 `SidebarMenuBadge`로 보여 준다(0이면 배지 없음). `SidebarMenuItem`을 돌려주므로 `SidebarMenu` 안에 둔다. Sheet에서 `DecisionPrompt`로 답하거나 `onOpenCard(sessionId, cardId)`로 보드를 연다
- `ProjectBoardButton` — 프로젝트 칸반 보드를 여는 `SidebarMenuItem`. 배지는 보드 수를 보이고 실행 중(`kanbanActive`)인 보드가 있으면 강조된다
- `providerLabels` — `ProviderId`별 표시 이름(ChatGPT/Claude/OpenAI 호환). `satisfies Record<ProviderId, string>`
- `effortChoices` / `EffortChoice` — `(selection, model)` dual 함수. 사이드바와 `/effort`가 쓰는 추론 강도 선택지를 만든다
- `AccountSwitcher` / `AccountSwitcherMenu` — 사이드바 하단의 계정 전환 드롭다운. openai·anthropic 프로필, 한도, 호환 계정을 모아 `onSwitch(AccountTarget)`과 `onManage`를 호출한다
- `AccountEntry` — 전환기 한 줄을 나타내는 `Data.TaggedEnum` (`profile` | `compatible`)
- `AccountManager` — 모든 구독 계정을 그린 뒤 `children`을 그리는 계정 관리자. 시트가 열려 있는 동안만 마운트된다 (`App`이 렌더)
- `AccountManagerList` / `ProviderAccounts` — 공급자별 계정 그룹 목록(추가·이름 변경·로그아웃)과 그 입력 타입
- `ProviderHeader` / `ProviderMark` — 공급자 제목 줄과 아이콘(Codex·Claude SVG, 호환 엔드포인트는 CpuIcon)
- `QuotaStatus` — `SubscriptionQuotaReport` 한도 상태(`unavailable` | `observed` | `stale`)의 `Data.taggedEnum`
- `windowLabel` / `quotaUnavailableText` / `usedPercent` / `gaugeTone` / `percentTone` — 한도 창 라벨, 조회 불가 사유 문구, 0~100으로 자른 사용률, 70/90% 경계의 색 톤
- `CompatibleAccounts` / `CompatibleAccountsList` — 호환 엔드포인트 계정 관리 UI. 쿼리와 뮤테이션을 연결한 래퍼와 순수 목록 컴포넌트
- `CompatibleHandlers` — `onChange`/`onTest`/`onDiscover` Promise 핸들러 타입
- `compatibleErrorMessage` — `CompatibleRequestFailed`를 사용자에게 보여 줄 안전한 한국어 문구로 바꾼다 (400/404/502 고정 문구)
- `makeCompatibleClient(fetcher)` / `compatibleClient` — `effects.{list,change,test,discover}` Effect와 같은 이름의 `runPromise` 래퍼를 제공하는 호환 계정 클라이언트. 기본 인스턴스는 `appFetch`를 쓴다
- `CompatibleRequestFailed` / `CompatibleRequestFailedReason` — `Schema.TaggedError`(operation, status, reason, message)와 사유 TaggedUnion(`TransportFailed`·`PartialWrite`·`RequestRejected`·`InvalidResponse`)
- `CompatibleAccountChange` — 계정을 바꾸는 호환 명령(create/connect/rename/save-model/remove-model/select/remove). `provider` 필드는 빠지고 `test`·`discover`는 포함되지 않는다
- `compatibleQueryKey` — `appQueryKeys.global.accounts("openai-compatible")` 쿼리 키
- 재수출 타입: `CompatibleAccountsView`, `CompatibleAccountStatus`, `CompatibleConnectionInput`, `CompatibleModelInput` (`memory-agent/compatible-config`)

## Invariants

- 호환 클라이언트 요청 본문에는 항상 `provider: "openai-compatible"`이 들어간다. 본문이 없으면 GET `/api/accounts?provider=openai-compatible`(operation `list`)이고, 있으면 POST `/api/accounts`에 `CompatibleAction` JSON을 보낸다.
- 응답 처리 순서는 다음과 같다. HTTP 409는 `PartialWrite`(키·설정이 일부만 저장됐을 수 있으니 목록 새로고침을 안내), 그 밖의 non-ok는 `RequestRejected`, JSON 파싱이나 스키마 디코딩 실패는 `InvalidResponse`, fetch 실패는 status 0의 `TransportFailed`다. 거부된 응답 본문은 읽지 않는다.
- `compatibleErrorMessage`는 업스트림 본문을 보여 주지 않는다. `CompatibleRequestFailed`가 아니면 일반 문구를 쓰고, `RequestRejected`이면서 상태가 400/404/502일 때만 고정 문구를 쓴다.
- 계정을 바꾸는 호환 명령(`CompatibleAccountChange`)은 응답으로 전체 `CompatibleAccountsView` 목록을 돌려준다(주석). `test`는 `{ok:true}`, `discover`는 `{models:[{id}]}`로 디코딩한다.
- 요청 Effect는 `Effect.abortSignal`을 fetch에 넘기고 `Effect.scoped`로 감싼다.
- `providerLabels`는 `satisfies Record<ProviderId, string>`이다. `ProviderId`를 추가하면 라벨도 함께 추가해야 한다.
- `effortChoices`: 노력 목록이 1개 이하인 `openai-compatible` 모델은 선택지를 내지 않는다(서버 기본값만 있음). 호환 모델의 `default`는 '서버 기본값'으로 표시한다.
- 계정 전환기의 '사용 중' 계정은 `activeProvider === provider && selected`로 정한다. 사용 계정은 모델 선택을 따른다. 이미 사용 중인 항목을 클릭하면 아무 일도 하지 않는다. 호환 항목 key는 `openai-compatible:` 접두사를 붙인다.
- 한도는 앱이 추정하지 않는다(주석). `unavailable` 사유는 `credential_expired`·`lookup_failed`뿐이다. `stale` 값은 흐리게 표시한다. 사용률은 0~100으로 자른다.
- `AccountManager`는 계정 시트가 열려 있는 동안에만 마운트된다(주석).
- 폴더 등록은 파일 도구가 접근할 수 있는 범위를 넓힌다. 폴더 열기는 `onPickFolder`(서버 기기의 폴더 선택 창)의 답을 `FolderPick.match`로 나눈다. `cancelled`는 아무것도 하지 않는다. `picked`는 그 경로를 `onAdd`로 등록하고, 서버가 거부하면 그 경로와 사유를 채운 경로 입력 다이얼로그(`AddProjectDialog`)를 연다. `unavailable`이나 호출 실패는 빈 다이얼로그를 연다.
- 경로 입력 다이얼로그는 앞뒤 공백을 자르고, 빈 값은 무시한다. `onAdd`가 오류 문자열을 돌려주면 다이얼로그를 닫지 않는다.
- 이미 목록에 있는 폴더를 고르면 다시 등록하지 않고 그 프로젝트를 선택한다(`onSelect`). 다시 등록하면 `already_registered`로 거부되기 때문이다.
- `ProjectSection`의 `onHide`는 프로젝트를 목록에서만 뺀다(보관). 대화와 기억은 남는다(주석). Combobox에서 보관한 프로젝트를 고르면 `onRestore`로 보관을 푼다.
- UI의 Effect 실행은 `runUiEffect`/`uiPromise` 경계를 거친다. 도메인 Effect는 호출자 런타임에서 실행된다(주석).
- `SidebarMenuButton`을 쓰는 `SessionSection`·`DecisionInbox`·`ProjectBoardButton`은 `SidebarProvider` 안에서만 렌더할 수 있다(`useSidebar`가 밖에서는 throw한다). `App`이 왼쪽 패널 전체를 `SidebarProvider`로 감싼다.

## Side Effects

- 네트워크: `compatibleClient`가 `appFetch`로 `/api/accounts`를 GET/POST한다(list, create, connect, rename, save-model, remove-model, select, remove, test, discover).
- React Query 조회·변경 훅이 백엔드 API를 호출한다: `useAccountsQuery`, `useAccountQuotaQuery`, `useCompatibleAccountsQuery`, `useDecisionInboxQuery`, `useProjectBoardsQuery`, `useAccountActionMutation`, `useCompatibleAccountMutation`.
- 브라우저 localStorage: jotai `atomWithStorage("context-agent-project-section-open-v2")`에 프로젝트 섹션이 열려 있는지 저장한다.
- 확인 창: 구독 계정 로그아웃(`remove`), 호환 엔드포인트 삭제, 대화 원본 삭제는 `AlertDialog`로 먼저 확인받는다.
- 시계 읽기: `DateTime.nowUnsafe()`로 한도 창이 초기화되기까지 남은 시간을 계산한다(account-switcher, account-profiles).

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
