# navigation

## Overview

`apps/agent/app/entry/navigation`은 에이전트 웹앱(React) 왼쪽 사이드바의 UI 모듈 모음이다. 프로젝트 추가, 프로젝트 헤더의 새 대화·메뉴, 세션 목록, 판단 대기함을 맡는다. 구독(ChatGPT·Claude) 계정 전환기와 계정 관리자(한도 게이지, 이름 변경, 로그아웃)도 이 디렉터리에 있다. `compatible-client.ts`는 OpenAI 호환 엔드포인트 계정을 `/api/accounts`로 조회·변경하는 Effect 기반 클라이언트다. 이 컴포넌트들은 `apps/agent/app/entry/index.tsx`의 `App`이 렌더링한다.

## Interface

- `ModelSection` — "새 대화의 기본 모델" 섹션. 모델 Select와, 선택한 모델이 허용하는 추론 강도 Select를 그린다. 사이드바 맨 위의 모델 패널은 없어졌고, 이 섹션은 계정 관리 Sheet의 `AccountManager` 위에서 로그인한 공급자일 때만 보인다. 대화마다의 모델은 채팅 입력창 아래줄(`SessionModelPicker`)에서 고른다 (sidebar.tsx)
- `sessionLabel` — 대화 제목(없으면 시작 시각)을 만드는 함수. 채팅 헤더도 쓴다 (sidebar.tsx)
- `ProjectMenu` — 한 프로젝트의 `…` 메뉴(`project-menu.tsx`). 프로젝트 설정(설정 창을 그 프로젝트로 연다), 칸반 보드(보드 수 배지, 실행 중인 보드가 있으면 강조), 다른 프로젝트 기억 검색 허용 체크 항목(R08), 프로젝트 보관을 담는다. 자기 프로젝트의 mutation 훅을 직접 부르고, 거부된 변경은 `onProblem`으로 목록 위에 알린다. 권한 모드(ask/auto/full)는 설정 창의 권한 페이지에 있다
- `ArchivedProjects` — 목록 아래에 접히는 "보관된 프로젝트" 구역. 프로젝트마다 "보관 해제" 버튼이 `onRestore`를 부른다 (sidebar.tsx)
- `SessionSection` — 모든 표시 프로젝트의 세션·보관 세션 목록. 프로젝트별로 접히는 그룹(`ProjectSessionGroup`, 헤더 한 줄에 접는 트리거(프로젝트 이름, 폴더가 없으면 `FolderXIcon`, 진행 중 대화가 있으면 그 개수 배지)와 그 형제인 `+`(`onCreate(projectId)`로 그 프로젝트에 새 대화)·`projectActions`의 `…` 메뉴를 둔다. 열린 대화의 프로젝트는 저장된 접힘이 없을 때만 펼치고 행의 `isActive`에 쓴다)을 두고, 그 안은 한 목록이다: 답변 중이거나 보드가 도는 대화(행에 Spinner)가 먼저 오고 나머지가 서버가 준 순서(최근 순)로 이어진다. 처음엔 `firstRows`(8)개까지만 보이고 "N개 더 보기"(`firstRows` 밖의 숨은 수)로 나머지를 펴며 "접기"로 되돌린다. 펼침은 그룹의 `useState`라 저장하지 않는다. 진행 중인 대화와 열린 대화(`openSessionId`)는 8개 밖이어도 늘 보인다. 목록 끝에는 `SessionGroup`이 그리는 접히는 "보관함" 한 줄이 있다(처음엔 접힘, 행을 누르면 복원·원본 삭제 메뉴). 진행 중 여부는 `ProjectWorking`(`answering`·`boardRunning` 집합)으로 행과 배지에 같이 판정한다. 프로젝트 헤더 줄(`div`)은 목록 스크롤 맨 위에 붙고(sticky, `z-20`), 그 아래 보관함 머리줄(`top-8`, `z-10`)이 지나가며 가리지 않는다. 접힘 상태는 jotai `atomWithStorage("context-agent-session-groups-open-v1")`에 프로젝트별로 저장해 다음 방문에도 유지한다(서버 렌더와 첫 렌더는 빈 기본값, 저장된 값은 마운트 뒤 적용). 접힌 그룹 헤더는 대화 수를 함께 보인다. 세션이 없는 프로젝트도 그룹이고, 헤더의 `+`가 첫 대화를 만든다. 목록 맨 위 줄은 `header`(프로젝트 추가 버튼)가 채운다. 각 프로젝트 안의 목록 위에는 위치 필터 메뉴(`sessionPlace`·`placeFilterOf`·`shownIn`)로 나눠 보여 준다. 행은 `SidebarMenuButton`이고 `Session.projectId`를 반영해 `?project=…&session=…` 링크로 다른 프로젝트 대화도 바로 연다. 보관·원본 삭제는 행에 올리거나 포커스하면 나타나는 `SidebarMenuAction` 메뉴에 있고, 프로젝트와 세션을 함께 이름으로 넘긴다(`onArchive`·`onDelete`·`onRestore`). 원본 삭제는 `AlertDialog`로 확인받는다. 목록을 불러오는 동안(`loading`)은 Skeleton을, 어떤 프로젝트 목록이 실패하면(`failed`) 다시 시도를 보인다. 제목 없는 대화는 시작 시각(`dayAndTime`, 브라우저 시간대)으로 부르고, 서버 HTML과 hydration 동안에는 `제목 없는 대화`로 부른다 (sidebar.tsx, `App`이 렌더)
- `Separator` — sidebar.tsx가 `~/components/ui/separator`에서 다시 내보내는 구분선
- `SidebarDisclosureTrigger` — `CollapsibleTrigger` 래퍼. `leading` 슬롯, 말줄임 본문, 회전하는 chevron을 그린다
- `DecisionInbox` — `projects`로 받은 모든 프로젝트에서 사람의 판단과 승인을 기다리는 카드 수를 `useAllWaitingDecisions`로 모아 `SidebarMenuBadge`로 보여 준다(0이면 배지 없음). `SidebarMenuItem`을 돌려주므로 `SidebarMenu` 안에 둔다. Sheet는 기다리는 것이 있는 프로젝트만 프로젝트별로 그리고(둘 이상이면 프로젝트 이름 머리줄), `ProjectWaitingList`가 `DecisionPrompt`로 답하거나 승인한다. `onOpenCard(projectId, sessionId, cardId)`는 그 프로젝트의 대화에서 보드를 연다
- `providerLabels` — `ProviderId`별 표시 이름(ChatGPT/Claude/OpenAI 호환) Lingui 메시지. `satisfies Record<ProviderId, MessageDescriptor>`라서 화면에서 `t(…)`로 푼다
- 문구 — 쓰이는 자리에 Lingui 메시지로 쓴다. `app/locales/ko.po`로 추출되고 `lint/wording`이 검사한다
- `effortChoices` / `EffortChoice` — `(selection, model)` dual 함수. 계정 관리 Sheet의 `ModelSection`, 채팅의 모델 선택기, `/effort`가 쓰는 추론 강도 선택지를 만든다
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
- 재수출 타입: `CompatibleAccountsView`, `CompatibleAccountStatus`, `CompatibleConnectionInput`, `CompatibleModelInput` (`memory-agent/compatible-config`). 명령과 `test`·`discover`의 답은 앱 API 계약(`memory-agent/app-api`)의 `CompatibleAccountCommand`, `CompatibleTestResult`, `CompatibleModelList`로 encode·decode한다

## Invariants

- 호환 클라이언트 요청 본문에는 항상 `provider: "openai-compatible"`이 들어간다. 본문이 없으면 GET `/api/accounts?provider=openai-compatible`(operation `list`)이고, 있으면 POST `/api/accounts`에 `CompatibleAccountCommand` JSON을 보낸다.
- 응답 처리 순서는 다음과 같다. HTTP 409는 `PartialWrite`(키·설정이 일부만 저장됐을 수 있으니 목록 새로고침을 안내), 그 밖의 non-ok는 `RequestRejected`, JSON 파싱이나 스키마 디코딩 실패는 `InvalidResponse`, fetch 실패는 status 0의 `TransportFailed`다. 거부된 응답 본문은 읽지 않는다.
- `compatibleErrorMessage`는 업스트림 본문을 보여 주지 않는다. `CompatibleRequestFailed`가 아니면 일반 문구를 쓰고, `RequestRejected`이면서 상태가 400/404/502일 때만 고정 문구를 쓴다.
- 계정을 바꾸는 호환 명령(`CompatibleAccountChange`)은 응답으로 전체 `CompatibleAccountsView` 목록을 돌려준다(주석). `test`는 `{ok:true}`(`CompatibleTestResult`), `discover`는 `{models:[{id}]}`(`CompatibleModelList`)로 디코딩한다.
- 요청 Effect는 `Effect.abortSignal`을 fetch에 넘기고 `Effect.scoped`로 감싼다.
- `providerLabels`는 `satisfies Record<ProviderId, MessageDescriptor>`이다. `ProviderId`를 추가하면 라벨도 함께 추가해야 한다.
- `effortChoices`: 노력 목록이 1개 이하인 `openai-compatible` 모델은 선택지를 내지 않는다(서버 기본값만 있음). 호환 모델의 `default`는 '서버 기본값'으로 표시한다.
- 계정 전환기의 '사용 중' 계정은 `activeProvider === provider && selected`로 정한다. 사용 계정은 모델 선택을 따른다. 이미 사용 중인 항목을 클릭하면 아무 일도 하지 않는다. 호환 항목 key는 `openai-compatible:` 접두사를 붙인다.
- 한도는 앱이 추정하지 않는다(주석). `unavailable` 사유는 `credential_expired`·`lookup_failed`뿐이다. `stale` 값은 흐리게 표시한다. 사용률은 0~100으로 자른다.
- `AccountManager`는 계정 시트가 열려 있는 동안에만 마운트된다(주석).
- 폴더 등록은 파일 도구가 접근할 수 있는 범위를 넓힌다. 폴더 열기는 `onPickFolder`(서버 기기의 폴더 선택 창)의 답을 `FolderPick.match`로 나눈다. `cancelled`는 아무것도 하지 않는다. `picked`는 그 경로를 `onAdd`로 등록하고, 서버가 거부하면 그 경로와 사유를 채운 경로 입력 다이얼로그(`AddProjectDialog`)를 연다. `unavailable`이나 호출 실패는 빈 다이얼로그를 연다.
- 경로 입력 다이얼로그는 앞뒤 공백을 자르고, 빈 값은 무시한다. `onAdd`가 오류 문자열을 돌려주면 다이얼로그를 닫지 않는다.
- 이미 목록에 있는 폴더를 고르면 다시 등록하지 않고 그 프로젝트를 선택한다(`onSelect`). 다시 등록하면 `already_registered`로 거부되기 때문이다.
- `ProjectMenu`의 보관은 프로젝트를 목록에서만 뺀다. 대화와 기억은 남는다. 열려 있던 대화가 그 프로젝트의 것이면 `onHidden`이 다른 프로젝트로 옮긴다. 보관된 프로젝트는 `ArchivedProjects`의 버튼으로 보관을 푼다.
- UI의 Effect 실행은 `runUiEffect`/`uiPromise` 경계를 거친다. 도메인 Effect는 호출자 런타임에서 실행된다(주석).
- `SidebarMenuButton`을 쓰는 `SessionSection`·`DecisionInbox`는 `SidebarProvider` 안에서만 렌더할 수 있다(`useSidebar`가 밖에서는 throw한다). `App`이 왼쪽 패널 전체를 `SidebarProvider`로 감싼다.

## Side Effects

- 네트워크: `compatibleClient`가 `appFetch`로 `/api/accounts`를 GET/POST한다(list, create, connect, rename, save-model, remove-model, select, remove, test, discover).
- React Query 조회·변경 훅이 백엔드 API를 호출한다: `useAccountsQuery`, `useAccountQuotaQuery`, `useCompatibleAccountsQuery`, `useAllWaitingDecisions`, `useProjectBoardsQuery`, `useAccountActionMutation`, `useCompatibleAccountMutation`.
- 브라우저 localStorage: jotai `atomWithStorage("context-agent-project-section-open-v2")`에 프로젝트 섹션이 열려 있는지, `atomWithStorage("context-agent-session-groups-open-v1")`에 프로젝트별 대화 그룹 접힘을 저장한다.
- 확인 창: 구독 계정 로그아웃(`remove`), 호환 엔드포인트 삭제, 대화 원본 삭제는 `AlertDialog`로 먼저 확인받는다.
- 시계 읽기: `DateTime.nowUnsafe()`로 한도 창이 초기화되기까지 남은 시간을 계산한다(account-switcher, account-profiles).

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
