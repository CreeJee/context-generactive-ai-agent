# scripts

## Overview

`apps/agent/scripts`는 에이전트 앱의 개발·배포용 Node 스크립트 모음이다. `dev.ts`는 개발 진입점이다. 안정 백엔드(빌드된 `dist/context-agent.mjs`)와 React Router HMR 프런트엔드를 띄우고, 매니페스트·로그·OTLP 수집기를 관리한다. `dev-configuration.ts`는 설정 파싱을, `dev-process.ts`는 포트 확인을 맡는다.

`package.ts`는 SEA 실행 파일을 만들고 런타임 네이티브 패키지를 스테이징·서명한다. `notarize-macos.ts`는 그 결과를 `.dmg`로 묶어 공증·스테이플한다. `smoke-package.ts`는 패키징된 실행 파일을 임시 저장소로 띄워 HTTP·ACP·SQLite 동작을 점검한다. `report-webhook-receipt.ts`는 `memory-agent`의 `ReportDelivery` 경로로 합성 메시지 한 건을 실제 웹훅에 보내 수신을 확인한다. `navigation-fixtures.ts`는 승인 인터럽트 픽스처를 제공한다.

## Interface

- `readDevConfiguration` — `Effect.fn("dev.readConfiguration")`; argv·env·app 경로로 mode(`all|agent|web`), backend/web 포트, storage, manifestFile, spans를 검증해 반환한다(`Path.Path` 필요, 실패 시 `DevConfigurationError`)
- `DevConfigurationError` — `Schema.TaggedError`; `detail`을 message로 내는 dev 설정 오류
- `DevSpans` — 판별 유니온 `{ kind: "off" } | { kind: "local"; port; file }`; dev 백엔드 span 전송 위치
- `devHelp` — `vp run dev [all|agent|web] [options]` 사용법 문자열(옵션과 환경 변수 우선순위 설명)
- `assertPortAvailable` — `Effect.fn("dev.assertPortAvailable")`; `NodeSocketServer`로 host:port를 바인드 후 해제하고, 이미 점유되어 있으면 `DevelopmentPortUnavailable`로 실패한다
- `DevelopmentPortUnavailable` — `Schema.TaggedError`; label·host·port·cause를 담고 기존 dev 서버 중지 또는 다른 포트 선택을 안내하는 message
- `navigationInterrupt` — threadId로 `PendingInterrupts["pending"][number]` 형태의 `permission_review` 승인 인터럽트 픽스처(`save_code_skill` 호출)를 만든다
- `scripts/dev.ts` (CLI, `vp run dev`) — 모드별로 백엔드 빌드(`react-router build`, `vp pack`)·기동·헬스 대기, 매니페스트 기록, 웹 프런트엔드(`react-router dev --host 127.0.0.1 --strictPort`) 실행
- `scripts/package.ts` (CLI, `vp run package`) — `dist/context-agent-<platform>-<arch>/context-agent`(+ `.sha256`) SEA 실행 파일 생성, 런타임 패키지 수집·네이티브 파일 검증·macOS 서명
- `scripts/notarize-macos.ts` (CLI, `vp run notarize`) — 서명된 실행 파일을 `dist/context-agent-darwin-<arch>.dmg`로 묶어 `notarytool` 공증·`stapler` 스테이플·`spctl` 평가 후 `.sha256` 기록
- `scripts/smoke-package.ts` (CLI) — 패키징된 실행 파일을 임시 디렉터리로 복사해 기동하고 정적 자산 캐싱, Host/cross-site 거부, auth 검증, 프로젝트·세션 생성, keychain, 내장 스킬, `acp initialize`, 종료 코드, 비밀 스윕을 점검
- `scripts/report-webhook-receipt.ts` (CLI, `node scripts/report-webhook-receipt.ts --env-dir <폴더>`) — `--env-dir` env 파일의 `DISCORD_WEBHOOK_URL`로 `ReportDelivery.send`를 한 번 실행하고 결과만 출력

## Invariants

- `dev.ts`는 빌드·프로세스·저장소 변경 전에 CLI/환경 설정을 먼저 검증한다. 오류 시 메시지를 출력하고 exit 1, `--help`면 exit 0으로 끝난다.
- CLI 옵션이 `CONTEXT_AGENT_DEV_BACKEND_PORT`, `CONTEXT_AGENT_DEV_WEB_PORT`, `CONTEXT_AGENT_HOME`, `CONTEXT_AGENT_DEV_MANIFEST`보다 우선한다. 기본 포트는 backend 5180, web 5173, otlp 4318이다.
- 포트는 1~65535 정수여야 하고, `all` 모드에서 backend와 web 포트는 달라야 한다.
- 백엔드 준비 판정은 `/api/health`가 2xx이고 `buildId`가 기대값과 같고 `status === "ready"`일 때만 성립한다(기대 buildId와 `"ready"`를 Literal로 둔 스키마의 디코드 성공). 요청마다 1초 timeout을 두고 100ms 간격으로 다시 묻는다. 30초 안에 성립하지 않으면 오류다.
- 백엔드를 띄우는 모드(`all`, `agent`)에서 `dev.ts`의 첫 SIGINT·SIGTERM·SIGHUP은 web과 backend에 같은 신호를 보낸 뒤 span 수집기를 멈추고 자기 매니페스트를 지운다. 종료 중에 신호가 한 번 더 오면 web·backend·수집기를 모두 `SIGKILL`하고 매니페스트를 지운다. 신호 핸들러가 읽는 `web`과 `stopping`은 `MutableRef`이고, 강제 종료는 실행 시점의 web을 읽는다.
- 매니페스트는 임시 파일(`<manifest>.<pid>.tmp`, mode 0o600)에 쓴 뒤 rename으로 원자적으로 교체한다. 제거는 현재 매니페스트의 `buildId`가 자기 것일 때만 한다.
- web 단독 모드는 같은 backend-port/manifest로 `vp run dev:agent`가 먼저 기록한 매니페스트를 요구한다.
- 백엔드·span 수집기 자식 프로세스의 수명은 열린 stdin 파이프에 묶인다(부모가 죽으면 함께 종료). 종료 시 `forceKillAfter: 5_000`을 쓴다.
- 프런트엔드는 반드시 `127.0.0.1`로 바인드한다(macOS에서 Vite 기본 `localhost`는 IPv6만 바인드).
- 백엔드 로그는 시작마다 새 파일(`flag: "wx"`)에 기록한다. 파일 쓰기 실패는 파일 복사만 멈추고 터미널로의 파이프 배출은 계속한다.
- `--no-otel`(spans `off`)일 때 백엔드는 호출자 자신의 `OTEL_*` 변수를 그대로 쓴다.
- `package.ts`: `vp pack`이 `dist/`를 비우므로 작업물은 `build/package` 아래에서 만들고 패킹 후에야 `dist/`로 게시한다.
- `package.ts`: 릴리스 버전은 SemVer 패턴을 통과해야 한다(`v` 접두사 제거). 채널은 `CONTEXT_AGENT_RELEASE_CHANNEL`을 따르고, 없으면 공급 버전에 `-`가 없을 때 `stable`, 있을 때 `prerelease`다.
- `package.ts`: 필수 네이티브 파일(turbovec `memory-turbovec.node`, onnxruntime 바인딩, `@napi-rs`·`@img` `.node`, kiwi wasm)이 하나라도 없으면 패키징을 중단한다.
- `package.ts`: onnxruntime-node 바이너리는 현재 platform/arch만 남긴다. `turbovec`·`@huggingface/transformers`는 지정 파일만 복사하고 지정 의존성은 건너뛴다.
- macOS 서명은 postject 이후에 hardened runtime과 `entitlements.plist`로 항상 수행한다. `CONTEXT_AGENT_SIGN_IDENTITY`가 없으면 ad-hoc(배포 불가)이고, 있으면 `--timestamp`를 포함한다.
- `notarize-macos.ts`는 macOS 전용이다. ad-hoc 서명이거나 Team ID가 없거나 notarytool keychain 프로필이 없으면 사전 점검에서 중단한다. 환경에서 비밀을 읽지 않고 keychain 프로필(`CONTEXT_AGENT_NOTARY_PROFILE`, 기본 `context-agent`)만 사용한다.
- `report-webhook-receipt.ts`는 웹훅 URL·토큰을 절대 출력하지 않고 결과만 출력한다. 보내는 텍스트는 사용자·세션·증거 데이터가 없는 합성 문구다(`evidence: null`).
- `smoke-package.ts`의 테스트용 토큰은 저장소에 키 모양 문자열이 남지 않도록 런타임에 조립한다.

## Side Effects

- 자식 프로세스 실행: `pnpm`/`npm_execpath`/`vp` 경유 `react-router build`, `vp pack`, `react-router dev`; `node --trace-warnings dist/context-agent.mjs --dev-backend`; `tools/profile/main.ts collect-otlp`; `codesign`, `hdiutil`, `xcrun notarytool`/`stapler`, `spctl`; 패키징된 `context-agent`(서버·`acp`); Windows의 `taskkill`
- 파일 시스템: dev 매니페스트(`build/dev-backend-<port>.json`) 쓰기·읽기·삭제, `build/logs/dev-backend-<port>-<시각>.log` 생성, `build/dev-spans-<port>.ndjson`(수집기), `build/package` 스테이징·`dist/` 게시·`.sha256` 기록, `.dmg` 생성·삭제, smoke 임시 디렉터리 생성·재시도 삭제
- SQLite: `smoke-package.ts`가 임시 저장소의 `agent.db`에 `node:sqlite` `DatabaseSync`로 `nodes` 행(비밀 포함 `tool_result`)을 직접 INSERT한다
- 네트워크: `/api/health` 폴링(HTTP), smoke의 로컬 HTTP 요청(`/api/auth`, `/api/projects`, `/api/sessions`, `/api/settings/kagi`, skills 목록), report 스크립트의 Discord 웹훅 전송, Apple 공증 서버 제출
- 포트 바인드: `assertPortAvailable`와 smoke `freePort`가 루프백 소켓을 열고 해제한다
- 환경 변수 읽기: `CONTEXT_AGENT_DEV_*`, `CONTEXT_AGENT_HOME`, `npm_execpath`, `CONTEXT_AGENT_VERSION`, `CONTEXT_AGENT_RELEASE_CHANNEL`, `CONTEXT_AGENT_SIGN_IDENTITY`, `CONTEXT_AGENT_NOTARY_PROFILE`. 자식 프로세스에 `CONTEXT_AGENT_BUILD_ID`, `CONTEXT_AGENT_DEV_BACKEND`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`를 설정한다
- keychain: notarytool keychain 프로필 조회, 서명 identity 사용
- 프로세스 상태: `process.exit`, `process.exitCode` 설정, `Effect.retry(Schedule.spaced(...))`와 `Effect.timeoutOrElse` 기반 폴링(dev health 100ms·30초, smoke `until` 250ms)

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
