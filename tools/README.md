# tools

## Overview

`tools`는 저장소 개발 도구를 모아 두는 디렉터리다. 바로 아래의 직접 소스는 `navigation-verification.mjs` 하나다. 이 Playwright(chromium headless) 스크립트는 이미 실행 중인 에이전트 웹 UI(기본 `http://localhost:5173`)에서 세션 간 클라이언트 측 이동을 검증한다. 모든 `/api/**` 요청을 가로채 고정 응답(fixture)으로 바꾸고, 세션 A와 가상의 세션 `navigation-fixture-b` 사이를 오가며 기록·실행 상태·승인·작성 중 초안이 섞이지 않는지 확인한다. 뒤로/앞으로 이동, 늦게 도착한 응답의 취소, 새 탭 열기, 전체 문서 재요청이 없는지도 확인한다. 저장소 안에서 이 스크립트를 import하거나 package 스크립트로 등록한 곳은 없으며, 손으로 실행하는 개발 도구다. 하위 디렉터리(`chat-store-check`, `oxlint`, `profile`)는 각각 독립된 개발용 CLI와 lint 플러그인이다.

## Interface

- `navigation-verification.mjs` — export가 없는 독립 실행 Node ESM 스크립트. top-level await로 실행되고, 성공하면 검증 결과 JSON 한 줄(`fixture`, `runIsolation`, `approvalIsolation`, `draftIsolation`, `draftRestoration`, `historyIsolation`, `delayedHistoryIsolation`, `newTab`, `backForward`, `documentRequests`, `serverMutations`)을 stdout에 출력한다.
- 환경 변수 입력 — `NAV_TEST_PROJECT`, `NAV_TEST_SESSION`(필수, 실제로 있는 활성 세션), `NAV_TEST_ORIGIN`(기본 `http://localhost:5173`), `NAV_TEST_APPROVALS`(`"1"`이면 승인 대기 interrupt 모드, 아니면 실패한 실행(run) 공지 모드로 검증)
- `navigationInterrupt` (import, `apps/agent/scripts/navigation-fixtures.ts`) — `interruptFor`라는 이름으로 가져와 세션 id별 대기 승인 항목 fixture를 만든다. 화면에서는 `자동 검토: NAV-APPROVAL-<id>` 텍스트로 확인한다.
- [`chat-store-check`](./chat-store-check/README.md) — TanStack 채팅 행 마이그레이션을 로컬 DB 복사본에서 검증하는 일회성 개발용 CLI
- [`oxlint`](./oxlint/README.md) — 저장소 전용 Oxlint JS 플러그인(`anti-slop`, `anti-slop-effect`)
- [`profile`](./profile/README.md) — Effect span과 V8 `.cpuprofile`을 수집·요약하는 `profile` CLI

## Invariants

- 스크립트는 브라우저 측 fixture만 쓴다(주석 원문: "never send a message, change settings, or claim a server lease"). GET이 아닌 `/api/**` 요청은 `/lease`로 끝나는 경로(`{ state: "mine" }`로 응답)만 빼고 403으로 막고 횟수를 센다. 마지막에 `blockedMutations === 0`이어야 한다.
- SSE 요청(`accept`에 `text/event-stream`)은 `route.fetch`로 넘기지 않고 빈 fixture 스트림(`: fixture\n\n`)으로 응답한다. 끝나지 않는 스트림을 피하고 실행 상태를 바꾸지 않기 위해서다.
- `NAV_TEST_SESSION`은 `/api/sessions?project=` 목록에 실제로 있는 활성 세션이어야 한다. 그 세션 행과 `/api/sessions/<id>` 응답을 template으로 삼아 가상 세션 `navigation-fixture-b`를 만든다. 세션 B의 다른 하위 경로 요청은 세션 A 경로로 바꿔 실제 서버에 보낸다.
- 승인 모드에서는 ChatPanel이 대기 중인 승인이 있을 때 종료된 실행 공지를 숨긴다. 그래서 `assertSessionState`는 모드에 따라 실행 오류 텍스트와 승인 텍스트 가운데 하나만 확인한다.
- 늦은 응답 취소 검증에서는 지연시킨 B 기록 요청이 실제로 시작된 것(`releaseLate` 설정)을 먼저 확인해야 한다. 이 확인이 없으면 취소 assertion이 공허해진다.
- 세션 간 이동은 SPA 내부 이동이어야 한다. 메인 프레임의 navigation 요청 수 증가가 0이어야 하고, `window.__navigationSentinel`이 살아 있어야 한다. 페이지 오류(`pageerror`)도 0건이어야 한다.
- 초안은 세션별로 분리되고 다시 돌아오면 복원되어야 한다. A의 `DRAFT-A`는 B에서 보이지 않고, A로 돌아오거나 뒤로/앞으로 이동하면 각 세션의 초안이 그대로 있어야 한다.
- `finally` 블록에서 `releaseLate`를 풀고, `context.unrouteAll({ behavior: "ignoreErrors" })`를 부른 뒤 브라우저를 닫는다.

## Side Effects

- 네트워크: `NAV_TEST_ORIGIN`에 `fetch`로 `GET /api/sessions?project=...`와 `GET /api/sessions/<session>`을 보낸다(읽기만 한다).
- chromium 브라우저 프로세스를 headless로 띄우고, 페이지 이동, 클릭, textarea 입력, 새 탭 열기를 수행한다.
- Playwright `context.route`로 `/api/**` 요청을 가로챈다. 일부는 fixture로 응답하고, 일부는 `route.fetch`나 `route.continue`로 실제 서버에 GET으로 보낸다.
- 타이머: `page.waitForTimeout(20)`으로 최대 50회 폴링하고, `page.waitForTimeout(500)`으로 기다린다.
- 환경 변수 `NAV_TEST_APPROVALS`, `NAV_TEST_ORIGIN`, `NAV_TEST_PROJECT`, `NAV_TEST_SESSION`을 읽는다.
- stdout에 결과 JSON을 출력한다. assertion이 실패하면 예외로 종료한다.

## Verification

- Run: `vp check` (저장소 루트)
