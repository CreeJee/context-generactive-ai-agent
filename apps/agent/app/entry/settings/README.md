# settings

## Overview

`apps/agent/app/entry/settings`는 웹 앱의 전역 설정 대화상자 진입점이다. `openSettingsOverlay`가 overlay-kit으로 `SettingsOverlay`를 연다. `SettingsOverlay`는 연결·기억·실행·개선·지침 그룹의 세로 탭을 그린다. 각 탭 본문은 `pages/` 하위 컴포넌트이고, `QuerySection` 로딩 경계 안에서 렌더한다. `shared.tsx`에는 여러 설정 페이지가 함께 쓰는 UI 부품과 헬퍼가 있다. 헤더, 오류 표시, 경로 축약, 설정 파일 출처, MCP/에이전트 항목, 신뢰 버튼이 여기에 속한다.

## Interface

- `openSettingsOverlay` — `{ project: Project | null; initialPage?: "web" }`를 받아 overlay-kit `overlay.open`으로 `SettingsOverlay`를 연다. 닫을 때 `close()` 후 `unmount()`를 호출한다
- `SettingsOverlay` — `{ project, open, onClose, initialPage?: SettingsPage }` 설정 Dialog 컴포넌트다. `settingsGroups`의 탭(web, image, mcp, agents, conversation, recall, imports, embedding, kanban, improvements, skills)을 그리고 `pageBodies`로 각 페이지를 렌더한다
- `errorMessage` — `ApiError | null`을 한국어 오류 문구로 바꾼다. `keychain_failed`와 `kagi_key_required`는 전용 문구를 쓰고, 나머지는 기본 문구를 쓴다
- `PageHeader` — 설정 페이지 상단 컴포넌트다. 제목, 배지, 설명, 선택 프로젝트 배지(`project`가 있을 때), 주 동작을 보여 준다
- `PageError` — 오류 문자열이 truthy일 때만 destructive `Alert`를 렌더한다
- `NoProject` — 프로젝트를 고르지 않았을 때 쓰는 안내 `FieldDescription`이다
- `shortPath` — 홈 폴더(`/Users/x`, `/home/x`, `C:\Users\x`)를 `~`로 바꾼다. 경로 조각이 5개를 넘으면 `…/` 뒤에 마지막 3개만 남긴다
- `pathIn` — `EffectFunction.dual(2)` 헬퍼다. 프로젝트 안의 경로는 `project.name` 기준 상대 경로로, 밖의 경로는 `shortPath`로 보여 준다
- `ConfigProblem` — 설정된 서버/에이전트가 동작하지 않는 이유 `{ text, detail: string | null }` 인터페이스다
- `SourceFiles` — 페이지 목록의 출처 파일을 한 줄씩 보여 주는 컴포넌트다. 줄마다 전체 경로 복사 버튼을 달고, `ConfigFileFailureCode` 오류 문구와 `FailureDetails`도 표시한다
- `ConfigEntry` — MCP 서버나 에이전트 항목 하나를 그리는 `Item`이다. 이름, scope 배지, 상태, 명령줄(`target`), 비밀정보 이름, 문제, 동작을 보여 준다
- `TrustButton` — `active`/`changed`/`busy`에 따라 '사용 중지', '다시 신뢰하기', '신뢰하기'를 표시하는 버튼이다
- `scopeLabels`, `skillScopeLabels`, `shadowedBadge` — scope 표시 라벨 상수(global/project, skill용 builtin 추가)와 '프로젝트 설정으로 대체됨' 배지 엘리먼트다
- [`pages`](./pages/README.md) — 설정 대화상자의 페이지 본문 React 컴포넌트. `settings-dialog.tsx`의 `pageBodies`가 렌더한다

## Invariants

- `pageBodies`는 `Record<SettingsPage, ...>` 타입이다. `settingsGroups`에 탭 value를 추가하면 `pageBodies`에도 본문을 넣어야 한다. 이 규칙은 타입이 강제한다
- 페이지마다 자기 데이터를 읽는다. 그래서 각 페이지 본문은 자기 `QuerySection` 로딩 경계로 따로 감싼다(주석에 명시)
- Dialog는 페이지가 바뀌어도 크기를 유지한다(`h-[min(40rem,calc(100dvh-2rem))]`). 페이지 내용은 `TabsContent` 안에서 스크롤한다(주석에 명시)
- `openSettingsOverlay`의 `initialPage` 타입은 `"web"`만 허용한다. `SettingsOverlay`는 모든 `SettingsPage`를 받는다
- `configFileFailureText`는 `satisfies Record<ConfigFileFailureCode, string>`로 모든 실패 코드에 문구가 있어야 한다
- `ConfigEntry`는 `target === null`(서버가 비밀정보를 확인하지 못함)이면 명령줄을 숨긴다. 비밀정보는 이름만 보여 주고 값은 보여 주지 않는다
- `keychain_failed` 문구에 따르면 OS 키체인 접근에 실패해도 키를 다른 곳에 대신 저장하지 않는다
- `CopyPathButton`의 1500ms 복사 표시 타이머는 Effect fiber로 실행한다. effect cleanup에서 `Fiber.interrupt`로 중단한다

## Side Effects

- `overlay.open`(overlay-kit)으로 전역 overlay 상태에 설정 Dialog를 마운트한다. 닫을 때 `close()`와 `unmount()`를 호출한다
- `CopyPathButton`이 `navigator.clipboard.writeText`로 전체 경로를 클립보드에 쓴다
- `Effect.runFork(Effect.sleep(1500))` 타이머가 복사 표시 상태를 되돌린다. 언마운트되거나 상태가 바뀌면 `Fiber.interrupt`로 중단한다
- 이 디렉터리 파일은 직접 네트워크를 호출하지 않는다. 데이터 조회는 `pages/` 컴포넌트가 `QuerySection` 안에서 React Query로 수행한다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
