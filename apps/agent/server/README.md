# server

## Overview

`apps/agent/server`는 `context-agent` 실행 파일(Node SEA 또는 `vp pack` 번들)의 프로덕션 진입점이다. `main.ts`는 명령줄을 해석해 두 경로 중 하나로 간다. 하나는 웹 앱 서버를 띄우고 에이전트 백엔드를 같은 프로세스에서 구성한 뒤 폴더를 프로젝트로 여는 경로이고, 다른 하나는 실행 중인 앱에 붙는 stdio ACP 에이전트(`acp`)다.

나머지 파일은 이를 돕는다. 저장소 루트 단일 소유 lock, 개발 백엔드 빌드 지문과 요청 차단(dev-safety), SEA 자산(런타임 파일·빌드 설정·릴리스 정보) 풀기, 서명된 릴리스 매니페스트 검증과 업데이트 정책(release-contract), HTTP 서빙(serve)을 맡는다.

## Interface

- `main.ts` — 실행 파일 엔트리. 쓰는 법은 `context-agent [folder] [--port 5173] [--no-open] [--storage <폴더>] [--broadcast] [--dev-backend]`, `context-agent acp`, `--version`, `--help`이다
- `serve(options: ServeOptions)` — 노출 범위에 따라 client 정적 파일은 직접 내주고 나머지는 React Router(`#server-build`)로 서빙한다
- `ServeOptions` / `Exposure` — 서버 옵션(build, port, exposure, clientDirectory, developmentBuildId?, runtimeInstanceId)과 노출 범위 `{kind:"loopback"} | {kind:"broadcast"}`
- `openInBrowser(url)` — 시스템 브라우저로 페이지를 연다
- `launchFolder(argument, cwd, storageRoot, executableFolder)` — 실행 인자와 cwd로 열 프로젝트 폴더를 정한다. 결과는 `LaunchFolder`(folder/none/invalid)이고 dual 함수다
- `isThisApp(baseUrl)` / `openProject` / `openProjectEffect` / `runLaunchRequest` — 이미 떠 있는 앱을 `/api/projects`로 확인한다. 같은 API로 폴더를 프로젝트로 등록하거나 찾고(`OpenedProject`), FetchHttpClient ManagedRuntime으로 실행한다
- `acquireStorageLock(storageRoot, port, instanceId)` — `<storage>/backend.lock`으로 저장소 루트당 백엔드 하나를 확보하고 멱등 release 함수를 돌려준다
- `createDevelopmentBoundary` / `DevelopmentBoundary` / `developmentRequestDecision` / `DevelopmentRequestDecision` — 개발 백엔드의 drain 상태와 `/api/health` 응답을 맡는다. buildId가 다른 변경 요청은 409로, drain 중인 변경 요청은 503으로 거절한다
- `developmentBuildId(appRoot)` / `developmentBackendWatchPaths` / `affectsDevelopmentBackend` / `developmentBuildHeader`(`x-context-agent-build-id`) — no-HMR 백엔드 경계 소스의 SHA-256 지문(24 hex)과 감시 경로, 영향 판정, 헤더 이름
- `parseCommandLine(name, config, usage, args)` — Effect CLI built-in 플래그 없이 인자를 해석한다. 도움말과 오류는 stderr로 보낸다
- `readBuildConfig` / `BuildConfigInvalid` — SEA 자산의 빌드 설정을 `BuildServerConfig`로 디코드한다. 소스 번들이면 `{}`를 쓴다
- `readReleaseInfo()` / `ReleaseInfo` / `releaseInfoAsset` — SEA 자산 `release/info.json`의 버전·채널·대상을 읽는다. SEA가 아니면 `0.0.0-dev`/prerelease를 쓴다
- `unpackRuntime(storageRoot)` / `RuntimeManifest` / `runtimeManifestAsset` / `runtimeFilePrefix` — SEA에 담긴 런타임 파일을 `<storage>/runtime/<hash>`에 한 번 풀고 그 경로를 돌려준다. SEA가 아니면 null이다
- `ReleaseManifest` / `ReleaseAsset` / `ManifestSignature` / `ReleaseEnvelope` / `ReleaseChannel` / `releaseManifestSchemaVersion`(=1) — 릴리스 매니페스트 계약 스키마다. version·database 호환 범위·플랫폼별 asset·sha256을 담는다
- `acceptRelease(envelope, trustedKeys, options: UpdateDecisionOptions)` — 서명·정책(prerelease, 더 새 버전, minUpdaterVersion, asset 존재와 이름)을 검증하고 받을 플랫폼 asset을 돌려준다
- `signReleaseManifest` / `verifyManifestSignature` — canonical JSON에 Ed25519로 서명하고 검증한다(PEM SPKI/PKCS#8)
- `ReleaseRejected`(`ReleaseRejectedReason`) / `ReleaseSigningFailed`(`ReleaseSigningFailedReason`) — 릴리스 거절과 서명 실패 TaggedError, 그리고 사유 TaggedUnion
- `canonicalJson` / `compareVersions` / `releaseAssetName` — 키를 정렬한 결정적 JSON, SemVer 우선순위 비교, `context-agent-v<ver>-<target>.<zip|tar.gz>` 자산 이름
- `server-build.d.ts` — `#server-build` 모듈 선언. React Router `ServerBuild`에 `entry.module`(`app/entry.server.tsx`)의 타입을 더한다
- [AGENTS.md](./AGENTS.md) — 서버 작업 지침
- `tests/` — 서버 테스트 (문서화 제외)

## Invariants

- `acp` 모드에서는 stdout이 프로토콜 채널이다. 그 밖의 것은 stdout에 쓰면 안 된다. 그래서 CLI 도움말과 파싱 오류도 `Console.log`를 stderr로 돌려 출력한다
- CLI 파싱용 `NodeTerminal`은 파싱 동안만 scoped로 만든다. 서버는 stdin listener를 들고 있지 않는다
- 저장소 루트 하나에는 서버 하나만 둔다. 같은 포트에 이 앱이 이미 응답하면(`isThisApp`) 두 번째 실행은 폴더를 실행 중인 앱에 넘기고 종료한다
- `backend.lock`은 `wx` 플래그(0o600)로 만든다. 디렉터리는 0o700이다. 기존 lock의 소유자가 살아 있으면 인수하지 않는다. 같은 pid라도 `startedAt`(`performance.timeOrigin`)이 다르면 pid가 재사용된 stale lock으로 보고 인수한다. 해제할 때는 instanceId가 자기 것일 때만 파일을 지운다
- 백엔드 종료 정리는 `backendScope` finalizer에 등록하고 역순으로 실행한다. 대상은 storage lock 해제, 시그널과 `beforeExit` 리스너 제거, `disposeAgent`다. `shutdown`은 `stopping` 플래그로 한 번만 실행된다
- `--dev-backend`일 때는 dev 스크립트가 stdin을 열어 둔다. stdin이 끝나거나 읽기가 실패하면 백엔드도 종료한다. 이때 프로젝트 폴더는 열지 않는다(`kind: none`)
- `configureAgentBackend`는 `unpackRuntime`과 `readBuildConfig`가 끝난 뒤, `serve` 전에 호출한다. 단계가 실패하면 `closeBackend`를 먼저 실행하고 오류를 다시 던진다
- 개발 경계 규칙: `/api/` 아래의 변경 메서드(GET/HEAD/OPTIONS 외)는 drain 중이면 503 `backend_restarting`으로 거절한다. 제시된 buildId가 다르면 409 `backend_restart_required`로 거절한다. `/api/health`는 항상 200이다. OAuth 콜백은 별도 loopback listener를 쓰므로 이 규칙에 포함되지 않는다
- 개발 빌드 지문 대상(`developmentBackendWatchPaths`)과 `affectsDevelopmentBackend` 경로 목록은 서로 맞아야 한다. 지문에서 `.test.` 파일과 심볼릭 링크는 제외한다
- 런타임 unpack은 `.staging-<pid>`에 쓰고 `.complete` 마커를 만든 뒤 rename으로 승격한다. 마커가 있으면 다시 풀지 않는다. 다른 16 hex 해시 폴더는 지운다
- 릴리스 서명은 canonicalJson(키 정렬) 바이트에 대한 Ed25519 서명이다. trustedKeys에 없는 keyId는 거절한다. 매니페스트 `schemaVersion`은 1로 고정한다
- 업데이트 정책: prerelease 채널은 `allowPrerelease`가 있어야 받는다. `allowDowngrade`가 없으면 현재 버전보다 엄격히 새 버전만 받는다. updater 버전은 `minUpdaterVersion` 이상이어야 한다. asset 이름은 `releaseAssetName(version, target)`과 같아야 한다
- `BuildConfigInvalid`는 내용을 담지 않는다. 빌드 설정 자산에 비밀이 들어 있기 때문이다
- `launchFolder`는 인자 없이 시작했을 때 다음 위치에서 프로젝트를 열지 않는다(`none`): 파일시스템 루트, 홈, 저장소 루트 내부, 실행 파일 폴더. 인자로 준 경로가 디렉터리가 아니거나 없으면 `invalid`이고 종료 코드는 2다
- `--broadcast`는 모든 인터페이스에서 듣고 모든 Host에 응답한다. 인증이 없다는 경고를 stderr에 출력한다. 기본 노출은 loopback이다

## Side Effects

- 파일시스템: `<storage>/backend.lock` 생성·읽기·삭제와 저장소 루트 디렉터리 생성(0o700)
- 파일시스템: SEA 자산(`runtime/manifest.json`, `runtime/files/*`)을 `<storage>/runtime/<hash>`에 쓰고 rename하며, 다른 빌드 폴더를 지운다
- 파일시스템: 개발 빌드 지문용으로 `packages/memory-agent/src`, `app/routes/api`, `app/.server`, `server` 등을 재귀로 읽는다
- SEA 자산 읽기: `node:sea`의 `getAsset`/`getRawAsset`으로 빌드 설정, `release/info.json`, 런타임 매니페스트와 파일을 읽는다
- 네트워크: `http://127.0.0.1:<port>/api/projects`에 GET(3초 timeout)과 POST를 보낸다(FetchHttpClient)
- 네트워크: HTTP 서버를 listen한다. loopback이 기본이고 `--broadcast`면 모든 인터페이스다. `EADDRINUSE`면 안내 메시지를 출력하고 exit 1이다
- 프로세스: `process.kill(pid, 0)`로 lock 소유자가 살아 있는지 확인한다. `SIGINT`/`SIGTERM`/`SIGHUP`/`beforeExit` 리스너를 등록·해제하고 `process.exit`(0/1/2)를 호출한다
- 프로세스: `openInBrowser`로 외부 브라우저를 띄운다(nodePlatform 사용)
- stdio: `acp` 모드에서 stdin/stdout으로 ndJSON ACP를 주고받는다. dev-backend 모드에서는 stdin이 끝날 때까지 drain한다. 사용자 메시지는 stdout과 stderr로 출력한다
- 환경 변수: `CONTEXT_AGENT_BUILD_ID`를 읽는다. `process.execPath`, `process.cwd()`, `process.platform`/`arch`, 홈 디렉터리도 읽는다
- 에이전트 백엔드: `build.entry.module.configureAgentBackend`로 storageRoot·runtimeRoot·buildConfig·release를 설정하고, 종료 때 `disposeAgent`를 호출한다
- 암호: WebCrypto Ed25519 키 import·서명·검증, SHA-256 digest, `Crypto.randomUUIDv4`로 runtimeInstanceId를 만든다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
