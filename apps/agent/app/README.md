# app

## Overview

`apps/agent/app`은 agent 앱의 React Router v7 앱 루트 디렉터리다. `root.tsx`는 HTML 레이아웃, 클라이언트 공용 Provider(React Query, nuqs, overlay-kit, Tooltip), 오류 경계를 정의한다. `entry.server.tsx`는 Effect로 SSR 문서를 Web Stream으로 렌더링하고 loader/action 오류를 로그로 남기며, `.server/agent.ts`의 백엔드 수명주기 함수를 다시 내보낸다. `routes.ts`는 `routes/`와 `routes/api/`의 flat route를 묶고, `app.css`는 Tailwind v4 테마 토큰과 다크 모드 변수를 정의한다.

## Interface

- `entry.server.tsx` `default handleRequest` — React Router 서버 엔트리다. `EffectFunction.dual(5, ...)`로 `(request, status, headers, context, loadContext)` 형태와 data-last `(status, headers, context, loadContext)(request)` 형태를 모두 받는다. `renderDocument`를 `Effect.runPromise`로 실행해 `Response`를 돌려준다.
- `handleError` — `HandleErrorFunction`의 dual 구현이다. loader/action 오류를 `[server] METHOD pathname failed`와 `Cause.pretty(Cause.die(error))`로 stderr에 남긴다. 중단된 요청이면 아무것도 하지 않는다.
- `streamTimeout` — `5_000`(ms) 상수다. React Router가 스트림 타임아웃으로 읽고, 렌더 abort 시한은 `streamTimeout + 1_000`이다.
- `configureAgentBackend` / `disposeAgent` — `./.server/agent.ts`에서 다시 내보내는 에이전트 백엔드 설정·정리 함수다(정의는 `.server`에 있다).
- `DocumentRenderFailed` (모듈 내부) — `Schema.TaggedError`다. `stage: "shell" | "all_ready"`와 `cause: Schema.Defect()`를 담는다. shell 렌더 실패나 `allReady` 대기 실패를 나타낸다.
- `root.tsx` `Layout` — `<html lang="ko" suppressHydrationWarning>` 문서 골격이다. head에 `themeScript` 인라인 스크립트, `Meta`, `Links`를 두고 body를 `TooltipProvider`로 감싸며 `ScrollRestoration`, `Scripts`를 렌더링한다.
- `root.tsx` `default App` — 루트 컴포넌트다. `QueryClient`(queries: `refetchOnReconnect: false`, `refetchOnWindowFocus: false`, `staleTime: Infinity`)를 `useState`로 한 번 만든다. `QueryClientProvider` > `NuqsAdapter`(`nuqs/adapters/react-router/v8`) > `OverlayProvider` > `Outlet` 순서로 감싼다. `useBackendRestartRequired()`가 참이면 상단 고정 `role="alert"` 새로고침 안내 배너를 띄운다.
- `root.tsx` `ErrorBoundary` — 라우트 오류 화면이다. `isRouteErrorResponse`면 404 또는 `statusText`를 보이고, 그 밖의 `Error`는 `import.meta.env.DEV`일 때만 message와 stack을 보인다.
- `root.tsx` `links` — 빈 배열을 돌려주는 `Route.LinksFunction`이다.
- `routes.ts` `default` — `RouteConfig`다. `flatRoutes()` 결과에 `prefix("api", flatRoutes({ rootDirectory: "routes/api" }))`를 이어 붙인다.
- `isTruthy<T>(value)` — `truthy.ts`의 타입 가드다. JavaScript truthiness를 그대로 쓰면서 `Exclude<NonNullable<T>, false | 0 | 0n | "">`로 좁힌다.
- `app.css` — Tailwind v4 진입 스타일이다. `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, `@fontsource-variable/inter`를 가져온다. `:root`/`.dark` 색 토큰(`--warning` 포함), `--radius` 파생 반경, `--text-2xs`/`--text-3xs`, base 레이어 규칙을 정의한다.
- [`components`](./components/README.md) — 공유 UI 프리미티브(`~/components/ui/<name>`)를 묶는 디렉터리다.
- [`entry`](./entry/README.md) — 프론트엔드 최상위 진입 `App`과 브라우저 백엔드 클라이언트 `api`를 둔다.
- [`lib`](./lib/README.md) — `~/lib/*` 별칭으로 쓰는 날짜 표시·`cn` 유틸리티다.
- [`routes`](./routes/README.md) — 페이지 라우트(`_index.tsx`, `report.tsx`)와 하위 `api/` 리소스 라우트다.

## Invariants

- `routes/api/*`는 `routes.ts`에서 `prefix("api", ...)`로 명시적으로 마운트해야 한다. 주석: flat routes는 `route.tsx`가 없는 폴더를 건너뛴다.
- `handleError`는 `request.signal.aborted`이면 로그를 남기지 않는다. 주석: Node는 Effect 오류를 stack 없이 필드로만 출력하므로 요청 정보와 `Cause.pretty`를 함께 남긴다.
- `renderDocument`는 `HEAD` 요청에 body 없이 `new Response(null, { status, headers })`를 돌려준다.
- 렌더 abort 신호는 `AbortSignal.any([request.signal, AbortSignal.timeout(streamTimeout + 1_000)])`다. 주석: `Response`를 HTTP 스트림 소유자에게 넘긴 뒤에는 React가 이 시한을 소유한다.
- `renderToReadableStream`의 `onError`는 `status`를 500으로 바꾼다. shell 렌더 뒤의 오류만 `Console.error`로 남기고, shell 전 실패는 `DocumentRenderFailed{stage: "shell"}`로 실패한다.
- `isbot(user-agent)`가 참이거나 `context.isSpaMode`면 `body.allReady`를 기다린 뒤 응답한다. 실패는 `DocumentRenderFailed{stage: "all_ready"}`다. 그 밖에는 shell 직후 스트리밍한다.
- SSR 응답에는 `Content-Type: text/html`을 설정한다. 주석: Node pipe 어댑터 없이 React Web Stream 엔트리로 shell/all-ready 동작을 유지한다.
- `QueryClient`는 `useState` 초기화로 컴포넌트 수명 동안 하나만 만든다. 기본값은 창 포커스·재연결 시 자동 재요청이 없고 `staleTime`이 무한대다.
- Provider 중첩 순서는 `QueryClientProvider` > `NuqsAdapter` > (배너, `OverlayProvider` > `Outlet`)다. `TooltipProvider`는 `Layout` body에서 감싼다.
- 다크 모드는 조상 요소의 `.dark` 클래스로 켠다(`@custom-variant dark (&:is(.dark *))`). `.dark`는 `color-scheme: dark`를 설정해 네이티브 부품이 OS가 아니라 페이지 테마를 따른다. `themeScript`는 head에서 렌더 전에 실행되고 `<html>`은 `suppressHydrationWarning`을 갖는다.
- Streamdown 계열 패키지(`streamdown`, `@streamdown/code`, `@streamdown/cjk`)의 dist JS는 `@source`로 Tailwind 스캔 대상에 넣어야 그 클래스가 생성된다.
- `ErrorBoundary`는 `import.meta.env.DEV`에서만 오류 message와 stack을 노출한다.
- 본문 줄바꿈 규칙은 `word-break: keep-all`(한국어를 단어 사이에서 줄바꿈)과 `overflow-wrap: anywhere`(끊을 곳 없는 경로·URL도 줄바꿈)다.

## Side Effects

- `handleError`: `Effect.runFork(Console.error(...))`로 실패한 loader/action 요청을 stderr에 쓴다.
- `renderDocument`: shell 렌더 뒤 React 렌더 오류를 `Console.error`로 stderr에 쓴다. `AbortSignal.timeout(6_000)` 타이머를 만든다.
- `entry.server.tsx`: `./.server/agent.ts`의 `configureAgentBackend`, `disposeAgent`를 다시 내보내 서버 런타임에 백엔드 설정·정리 진입점을 노출한다(동작은 `.server`에 정의).
- `root.tsx` `Layout`: 브라우저에서 head의 인라인 `themeScript`를 실행한다.
- `root.tsx` `App`: 브라우저 메모리에 React Query 캐시(`QueryClient`)를 만들고, `useBackendRestartRequired` 결과에 따라 재시작 안내 배너를 띄운다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
