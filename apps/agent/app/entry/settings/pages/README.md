# pages

## Overview

`apps/agent/app/entry/settings/pages`에는 앱 설정 대화상자의 페이지 본문 React 컴포넌트가 있다. `settings-dialog.tsx`의 `pageBodies`가 이 컴포넌트들을 렌더한다. 각 페이지는 `../../queries`의 React Query 훅으로 백엔드 설정을 읽는다. mutation은 `runUiEffect`/`uiPromise`로 감싼 Effect 경계에서 실행한다. 다루는 설정은 외부 ACP 에이전트, 긴 대화 요약, 임베딩, 이미지 생성, 대화 가져오기, 프로젝트 개선, 칸반, MCP, 회상 범위, 스킬, Kagi 웹 검색이다. 화면 문구는 모두 한국어다. 프로젝트 범위 페이지는 `project: Project | null`을 받고, 프로젝트가 없으면 `NoProject`를 보여 준다.

## Interface

- `AgentSettings` — `{ project: Project | null }`. 외부 ACP 에이전트 목록, 신뢰·연결 상태 배지, 신뢰 토글과 다시 연결 버튼(`AgentChange.trust`/`AgentChange.reconnect`)을 보여 주는 페이지
- `ConversationSettings` — 긴 대화를 요약으로 보내기 시작하는 시점(`summaryStartPercent`, 0~50%)을 저장하는 페이지
- `EmbeddingSettings` — 임베딩 실행 방식(auto/cpu/gpu) 선택, WebGPU 다시 확인(`EmbeddingCommand.choose`/`check`), 임베딩 대기 수와 기억 그래프 정리 상태를 보여 주는 페이지
- `ImageSettings` — 이미지 생성 켜기/끄기와 공급자 간 이미지 생성 동의 모드(disabled/ask/always)를 고르는 페이지
- `ImportSettings` — Claude Code·Codex CLI 대화 가져오기 페이지. 실행·계속 가져오기·감시 재시작·해석(`ImportCommand.run/enable/disable/restart_watch/interpret`)을 다루고 진행 상황, 소스별 통계, 등록하지 못한 폴더, 실패 기록을 보여 준다
- `ImprovementSettings` — 프로젝트 개선 스캔 페이지. `/api/settings/improvements`로 시작·중지 명령을 보내고, 저장소별 `ImprovementReport`와 작업 명세 markdown을 보여 주며 복사할 수 있다
- `KanbanSettings` — `{ project: Project | null }`. 칸반 동시 실행 카드 수(`ConcurrencyField`), 프로젝트 순서(`ProjectOrderField`), 보호 브랜치(Goal 병합 위치)를 정하는 페이지
- `McpSettings` — `{ project: Project | null }`. 프로젝트의 MCP 서버 설정 페이지. 프로젝트가 없으면 `NoProject`를 보여 준다
- `RecallSettings` — 대화가 자기 프로젝트 밖에서 닿을 수 있는 기억 범위를 정하는 페이지(`useRecallSettingsQuery`/`useRecallSettingsMutation`)
- `SkillSettings` — `{ project: Project | null }`. 프로젝트 스킬 설정 페이지
- `KagiSettings` — Kagi Search/Extract(R19) 페이지. 키를 keychain에 저장한 뒤 명시적 스위치로 켠다(`useKagiQuery`/`useKagiMutation`, `KagiCommand`)

## Invariants

- mutation은 모두 `runUiEffect(Effect.gen(...))` 안에서 `uiPromise(() => mutation.mutateAsync(...))`로 실행한다. 실패는 `Effect.catchTag("UnknownError", ...)`로 받아 `setError`에 문구를 넣는다.
- 오류 문구는 `errorMessage(refusalOf(failure.cause))`, `isApiError`→`ApiErrorCode`별 문구, 페이지 고정 문구 중 하나로 만든다. `ImprovementSettings`의 `requestFailure`는 브라우저·전송 계층 메시지를 노출하지 않고 페이지 자체 문구만 보여 준다.
- 고정 조회표는 `Schema.Literals` 키와 `satisfies Record<typeof X.Type, string>` 객체 리터럴로 정의한다(`GpuUnavailableReason`, `UnplacedReason`, `ImportFailureTag`, `PlatformFailureReason`, `crashReasons`). 표에 없는 값은 GPU 사유와 가져오기 실패에서 일반 문구로 바꾸고, `unplacedReason`만 원문 그대로 보여 준다.
- 가져오기 실패 문자열 형식은 `Tag` 또는 `Tag:Reason`을 쉼표로 이은 것이다. `importFailureText`는 조각마다 문구로 바꾸고 중복을 없앤다. 구버전이 저장한 텍스트에는 경로나 대화 내용이 들어 있을 수 있으므로 원문을 보여 주지 않는다.
- `ConversationSettings`의 `summaryStartPercent`는 0 이상 `maximumPercent`(50) 이하 정수만 저장한다. 현재 값과 같으면 저장 버튼을 끈다.
- 칸반 동시 실행 수는 1~`maximumConcurrency`(32) 정수이며, memory-agent `kanbanConcurrencyLimit`과 일치해야 한다. 브랜치 목록은 쉼표·공백으로 나누고 중복을 제거한다.
- `ImprovementSettings`는 상태가 `ScanState` running일 때만 2000ms 간격으로 refetch하고 `retry: false`다. 명령이 성공하면 `queryKey` 캐시의 `state`만 교체한다. 404 응답이면 '서버가 지원하지 않음' 문구를 쓰고, 다른 실패는 `FailureBody`(`reason: "report"`)를 디코딩해 `failures` 표로 문구를 고른다.
- `AgentSettings`: shadowed 에이전트는 `shadowedBadge`만 보여 주고 동작 버튼이 없다. '다시 연결' 버튼은 trusted이면서 link가 `stopped`일 때만 보인다. 연결 문제 문구는 `AgentLinkState`가 `retrying` 또는 `stopped`일 때만 만든다.
- `ImageSettings`: 공급자 간 동의 Select는 이미지 생성이 꺼져 있으면 비활성이다. 키 `anthropic->openai:media.image.generate`의 값이 없으면 `disabled`로 본다. 허용 모드는 `disabled`, `ask`, `always`뿐이다.
- `EmbeddingSettings`: local runtime의 `mode`가 `overview.next`와 다르면 재시작 안내를 보여 준다. WebGPU 확인 중(`GpuState` checking)이거나 busy일 때는 다시 확인 버튼을 끈다.
- `ImportSettings`: 가져오기 실행 중(`ImportActivity` running)이거나 busy일 때 '지금 가져오기' 버튼을 끈다. 감시 상태(`LoopHealthStatus`)는 `enabled`이고 `watch !== null`일 때만 보인다.

## Side Effects

- 페이지들은 React Query 훅(`../../queries/global`, `../../queries/project`, `../../queries/mutations/*`)으로 백엔드 HTTP API를 읽고 쓴다. 바꾸는 대상은 에이전트 신뢰·재연결, 요약 시점, 임베딩 방식·GPU 확인, 이미지 설정, 가져오기 명령, 칸반 설정, 프로젝트 순서, 보호 브랜치, 회상 설정, Kagi 설정이다. SQLite나 파일 시스템을 직접 만지지 않는다.
- `ImprovementSettings`의 `request`는 `appFetch("/api/settings/improvements")`로 GET하거나, `ScanCommand`(start/stop) JSON body로 POST한다. 스캔이 running인 동안 2000ms 간격으로 폴링한다.
- `ImprovementSettings`의 `Report`는 `navigator.clipboard.writeText(report.markdown)`로 클립보드에 쓴다.
- `KagiSettings` 문서 주석에 따르면 Kagi 키는 keychain에 저장되며, 저장은 백엔드 mutation이 수행한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
