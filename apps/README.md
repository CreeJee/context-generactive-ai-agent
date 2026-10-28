# apps

## Overview

`apps`는 저장소의 실행 가능한 앱 패키지를 모아 두는 디렉터리다. 이 디렉터리에는 직접 소스 파일이 없고, 현재 하위 앱은 `agent` 하나다. `agent`는 메인 에이전트 앱으로 최종 로딩과 채팅 라우터 API를 맡으며, 에이전트 서버 로직은 `packages/memory-agent`에 둔다.

## Subdirectories & Boundaries

- agent: [`./agent/README.md`](./agent/README.md) - React Router v7 SSR 기반 에이전트 웹 앱 패키지(`agent`)다. API 라우트와 UI를 제공하고, 서버 로직은 `packages/memory-agent`가 맡는다. 루트의 `vite.config.ts`·`package.json`·`entitlements.plist`가 dev `/api` 프록시(`developmentApiProxy`), lint, SSR 번들 범위, `vp pack` 단일 파일 번들(entry `server/main.ts`, outDir `dist`)과 SEA 실행 파일, Vite Task 작업(`build`, `bundle`, `typecheck`, `package`, `smoke-package`, `notarize`)을 정의한다. UI는 `app/`, 실행 파일 엔트리는 `server/`, 개발·배포 스크립트는 `scripts/`에 있다.
