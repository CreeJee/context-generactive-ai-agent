# shared

## Overview

`apps/agent` 프론트엔드 엔트리(`app/entry`)들이 함께 쓰는 공용 모듈 모음이다. 백엔드 API 호출용 fetch 래퍼(빌드 ID 헤더 고정, 백엔드 재시작 필요 응답 감지)와 그 재시작 상태 저장소·React 훅, React/React Query용 Effect 실행 도우미, 브라우저 Web Crypto 기반 Effect `Crypto` 구현을 제공한다. UI 쪽으로는 한국어 로컬 시각 포맷, 테마 선택 컴포넌트와 페인트 전 테마 스크립트, 백그라운드 루프 상태 배지, 실패 상세 접힘 컴포넌트를 담는다.

## Interface

- `appFetch` — 앱 전역 fetch(dual). 브라우저에서는 `backendFetch`(빌드 ID `VITE_CONTEXT_AGENT_BUILD_ID`, `window.location.origin`)로 감싼 `sdkHttpTransport`, SSR/비브라우저에서는 `sdkHttpTransport`를 직접 쓴다. 직접 백엔드 탐색과 채팅 SSE 전송에 쓰인다
- `backendFetch` — `(buildId, origin, transport)` dual. 같은 origin의 `/api/` 요청에 `x-context-agent-build-id` 헤더를 붙이고, 응답을 보고 재시작 필요 상태를 기록하는 fetch를 만든다
- `responseRequiresBackendRestart` — 실패 응답 본문이 `{ error: "backend_restart_required" | "backend_restarting" }`인지 `Promise<boolean>`으로 판정한다
- `subscribeBackendRestart` — 재시작 필요 알림 리스너를 등록하고 해제 함수를 돌려준다
- `backendRestartSnapshot` — 모듈 전역 `restartRequired` 값을 돌려준다
- `useBackendRestartRequired` — `useSyncExternalStore`로 재시작 필요 상태를 구독하는 React 훅(서버 스냅샷은 `false`)
- `uiPromise` — Promise 작업을 `Cause.UnknownError`로 실패하는 Effect로 감싼다
- `runUiEffect` — Effect를 Promise로 실행하고 실패 시 `UnknownError`를 벗겨 원래 API/브라우저 에러 identity로 reject한다
- `browserCrypto` — Web Crypto(`crypto.getRandomValues`, `crypto.subtle.digest`)로 만든 Effect `Crypto` 서비스 구현. digest 실패는 `PlatformError.systemError`로 바꾼다
- `koreanLocalTime` / `koreanTimeOfDayOf` / `koreanShortTime` — 서버 타임스탬프를 ko-KR 로컬 날짜·시각 / 시각 / 월·일·분으로 포맷한다. 파싱 불가 시 `Invalid Date`
- `timeUntil` — `(timestamp, now)` dual. 남은 시간을 `3d 8h 7m` 형태로 돌려주고, 지났거나 파싱 불가면 `null`
- `themes` — 테마 선택지 상수(`system`/`light`/`dark`와 한국어 라벨)
- `ThemeSelect` — 테마 선택 React 컴포넌트. localStorage `context-agent-theme`에 저장하고 `document.documentElement`의 `dark` 클래스를 토글한다
- `themeScript` — 페인트 전에 실행할 인라인 테마 스크립트 문자열
- `loopHealthLabel` — `LoopHealth`(`Healthy`/`Retrying`/`Exhausted`/`Defected`)를 한국어 문구로 바꾼다
- `LoopHealthStatus` — 백그라운드 루프 상태 배지와, `Exhausted`/`Defected`일 때만 보이는 '다시 시작' 버튼 컴포넌트
- `FailureDetails` — 실패의 외부 프로그램 원문(`detail`)을 접힌 `<pre>`로 보여 준다. `null`이면 렌더하지 않는다
- 하위 디렉터리 없음

## Invariants

- `backendFetch`는 거부된 변경 요청을 재시도하지 않는다(주석: "never retry a rejected mutation"). 빌드 ID 헤더는 `buildId`가 비어 있지 않고 같은 origin이며 경로가 `/api/`로 시작할 때만 붙인다
- 재시작 필요 판정은 `!response.ok`이고 본문이 `BackendRestartBody` 스키마(`backend_restart_required` | `backend_restarting`)와 맞을 때만 true다. 그 밖의 실패 응답(JSON 여부 무관)은 호출자가 처리한다. 판정 시 `response.clone()`으로 읽어 원 본문을 소비하지 않는다
- `restartRequired`는 한 번 true가 되면 되돌리지 않으며, 리스너는 처음 전환될 때 한 번만 호출된다
- `sdkHttpTransport`는 native `ReadableStream`이 아닌 본문(문자열 등)을 스트림이 아닌 raw/bytes 본문으로 보낸다. 브라우저 스트리밍 업로드는 HTTP/2가 필요해 HTTP/1.1 dev 프록시에서 JSON POST가 깨지기 때문이다. Request/FormData 본문은 인코딩·multipart boundary를 보존하려고 `arrayBuffer`로 읽는다
- `sdkHttpTransport`의 요청 Scope는 abort 시, 실패 시, 본문 없는 응답(HEAD, 204/205/304)일 때 즉시, 그 밖에는 응답 스트림이 끝날 때 닫혀야 하며 닫을 때 abort 리스너를 제거한다. TransportError는 원래 `cause`로 풀어 reject한다
- `runUiEffect`는 `Cause.UnknownError`를 벗겨 API·브라우저 에러 identity를 보존해야 한다(React/React Query 콜백이 소비)
- `use-backend-restart.ts`는 React 바인딩만 두고 비-React 저장소(`backend-restart.ts`)와 분리해 둔다(주석 근거)
- 테마 저장 키 `context-agent-theme`는 `theme.tsx`와 `themeScript`에서 같아야 하며, localStorage 접근 실패 시에도 시스템 테마로 동작해야 한다
- `FailureDetails`의 문구는 실패 코드에서 오고, `detail` 원문은 조사용 보조 정보일 뿐이다(주석 근거)
- `LoopHealthStatus`에서 루프 상태는 서버가 소유하고 변경을 알린다. 재시작 버튼은 `Exhausted` 또는 `Defected`일 때만 보인다

## Side Effects

- `backend-restart.ts`: 모듈 전역 가변 상태(`restartRequired`, `listeners` MutableHashSet)를 바꾸고 리스너를 동기 호출한다
- `backend-restart.ts`: `FetchHttpClient.layer`로 모듈 로드 시 `ManagedRuntime`(`transportRuntime`)을 만들고 `globalThis.fetch`로 네트워크 요청을 보낸다. 요청 signal에 abort 리스너를 붙였다 뗀다
- `backend-restart.ts`: `import.meta.env.VITE_CONTEXT_AGENT_BUILD_ID`, `window.location`, `document.baseURI`, `location.href`를 읽는다
- `browser-crypto.ts`: `crypto.getRandomValues`, `crypto.subtle.digest`를 호출한다
- `theme.tsx`: localStorage `context-agent-theme` 읽기·쓰기, `document.documentElement` `dark` 클래스 토글, `matchMedia("(prefers-color-scheme: dark)")` change 리스너 등록·해제
- `theme-script.ts`: 실행 시 localStorage를 읽고 `document.documentElement` `dark` 클래스를 토글한다(문자열로만 내보냄)
- `local-time.ts`: `DateTime.formatLocal`로 브라우저 로컬 시간대를 사용한다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
