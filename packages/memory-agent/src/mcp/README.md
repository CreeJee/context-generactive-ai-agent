# mcp

## Overview

`packages/memory-agent/src/mcp`는 사용자가 설정한 MCP 서버를 읽고, 신뢰를 관리하고, 연결해 실행 도구로 넘기는 계층이다. 설정 파일은 `<storage>/mcp.json`(global)과 `<project>/.mcp.json`(project) 두 곳이다.

`config.ts`는 설정 파일 schema 파싱, 지문(fingerprint), `${NAME}` 환경변수 치환을 맡는다. `oauth.ts`는 HTTP 서버의 OAuth 인가(SDK `auth()` 위의 키체인 저장, 401 처리, 루프백 브라우저 로그인)를 맡는다. `client.ts`는 `@tanstack/ai-mcp`를 대신하는 공식 SDK 기반 클라이언트로, 연결·도구 목록·호출과 spec 2025 task 폴링을 맡는다. `servers.ts`는 Effect 서비스 `McpServers`로 설정 화면용 overview, 신뢰 지정, 실행용 도구(`RunTool`)와 서버 안내문(guide)을 제공한다.

이 서비스는 `packages/memory-agent/src/layers.ts`, `packages/memory-agent/src/agent/chat.ts`, `packages/memory-agent/src/report/bundle.ts`, 그리고 `apps/agent`의 앱 API projects group(`mcp`/`mcpAction`, `/api/projects/:project/mcp`)에서 쓰인다. 설정 화면이 받는 모양은 `contracts.ts`의 Schema다. 이 모듈은 서버 코드를 import하지 않아 브라우저 번들이 쓴다.

## Interface

- `McpServers` — `Context.Service`(`memory-agent/mcp/servers/McpServers`)이고 `McpServers.layer = Layer.effect(McpServers, make)`이다. 메서드: `overview(project)`, `setTrusted`, `login`/`cancelLogin`/`logout`(모두 실행 후 overview 반환), `runTools(project)`, `readOnlyRunTools(project)`
- `McpServerState` — 상태 `untrusted`/`changed`/`trusted`/`connected{tools}`/`failed{failure}`/`needsLogin{failure}`/`loggingIn{authorizationUrl}`. 타입은 `contracts.ts`에서 오고, `servers.ts`가 같은 이름의 `Data.taggedEnum` 생성자를 둔다. 설정 화면이 서버마다 표시한다
- `McpScope` / `McpServerView` / `McpOverview` — `contracts.ts`의 Schema. 설정 위치(global/project), 설정 화면용 서버 뷰(scope, name, transport, 비밀을 가린 target, envNames, headerNames, shadowed, signedIn, state)와 파일별 오류 목록
- `McpServerGuide` / `McpRunTools` — 서버가 연결 때 보낸 사용 안내문, 그리고 실행에 쓸 `RunTool[]`과 guides 묶음
- `mcpToolPrefix` / `mcpToolName` / `isMcpToolName` — MCP 도구 이름 규칙 `mcp_<server>__<tool>`의 접두어, 생성 함수(dual), 판별 함수
- `mcpInstructions` / `mcpInstructionsForMode` — MCP 도구 사용 규칙 시스템 프롬프트. 권한 모드 `full`이면 승인 문구를 바꾸고, 서버 guide를 `<server name=...>` 블록으로 덧붙인다
- `maxMcpGuideCharacters`(8_000) / `maxMcpResultCharacters`(60_000) — 서버 guide와 도구 결과를 모델에 넘길 때의 최대 길이
- `McpStepTimedOut` — `connect` 또는 `tools/list` 단계 시간 초과를 나타내는 TaggedError
- `McpServerConfig` — `Schema.TaggedUnion`이고 `stdio{command,args,env}` 또는 `http{url,headers,oauth?}`이다
- `McpOAuthConfig` / `McpOAuthClient` / `McpClientAuthentication` — `oauth` 설정. `authorizationCode{client,callbackPort?,scope?}`(사람 로그인) 또는 `clientCredentials{clientId,issuer,authentication,scope?}`(앱 자신). client는 `automatic{metadataUrl?}`(CIMD 또는 동적 등록) 또는 `registered{clientId,issuer?,authentication?}`. 증명은 `secret` 또는 `privateKeyJwt`이고 값은 `${NAME}` 참조만 받는다. 파일에서는 평평한 `{grant?, clientId?, clientSecret?, privateKey?{key,algorithm}, clientMetadataUrl?, issuer?, callbackPort?, scope?}`로 쓰고, 함께 쓸 수 없는 조합은 `invalid_config`다
- `openMcpCredentials` / `McpCredentials` — 서버 로그인 하나. transport용 `AuthProvider`·DPoP `fetch`, `signedIn`, `stepUp`, `login`을 준다
- `McpLoginRequired` / `needsLogin` / `McpLoginFailed` / `McpLoginOutcome` / `McpLoginAttempt` — 로그인이 필요하다는 오류와 cause 사슬 검사, 로그인 시작 실패, 로그인 결과, 진행 중인 로그인
- `loginSlot` / `loginBinding` / `defaultOAuth` — 키체인 항목 이름, 로그인이 만들어진 URL·설정의 해시, `oauth`가 없을 때의 기본값(자동 등록 + 사람 로그인)
- `McpScope` — `"global" | "project"` 리터럴 schema
- `globalMcpFile` / `projectMcpFile` — `<storageRoot>/mcp.json`, `<projectRoot>/.mcp.json` 경로를 만든다
- `McpServerName` — 서버 이름 schema `^[A-Za-z0-9_-]{1,32}$`
- `ConfiguredServer` / `McpFileRead` — 파싱된 서버(scope, name, config, fingerprint)와 파일 읽기 결과(path, servers, error)
- `fingerprintOf` — 인코딩한 설정 JSON의 sha256 지문
- `readMcpFile` — `FileSystem`으로 MCP 설정 파일을 읽어 `McpFileRead`를 돌려주는 Effect(dual, span `mcp.readConfig`)
- `MissingVariable` / `expandVariablesResult` / `expandVariables` — `${NAME}`을 환경변수로 치환한다. 값이 없으면 변수 이름만 담은 TaggedError를 낸다. `expandVariables`는 SDK transport 빌더용으로 throw하는 동기 버전이다
- `McpConnectFailed` / `McpToolFailed` — 연결 실패 오류, 그리고 도구 호출 오류(서버 오류·입력 요청·결과 없음)
- `connectClient` — SDK `Client`를 `versionNegotiation: auto`로 transport에 연결한다. 실패하면 client를 닫는다
- `listTools` — 서버 도구 목록을 돌려준다. 서버가 task 호출을 지원하지 않으면 task 필수 도구를 뺀다
- `inputSchemaOf` — 도구 input schema에 `type`(기본 `object`)과 `properties`(기본 `{}`)를 채운다
- `callTool` — 도구를 한 번 호출하고 결과를 TanStack 형식(text 또는 parts, structuredContent)으로 바꾼다. task 필수 도구이고 프로토콜이 modern이 아니면 spec 2025 task 폴링을 쓴다
- `JsonObject` — MCP 도구 인자 타입
- 하위 디렉터리: 없음

## Invariants

- 신뢰는 서버 이름이 아니라 설정 지문(`fingerprintOf`, sha256)에 준다. 신뢰한 뒤 설정이 바뀌면 상태가 `changed`가 된다.
- 신뢰 행은 `(scope, project_id, name)` 기준으로 upsert한다(`ON CONFLICT ... DO UPDATE SET fingerprint, trusted_at`). 신뢰한 서버는 shadowed가 아닐 때만 곧바로 discover한다.
- project 서버가 같은 이름의 global 서버를 가린다(`shadowed`). 연결 키는 `${project.id}/${server.scope}/${server.name}`이다.
- 서버 이름은 `^[A-Za-z0-9_-]{1,32}$`여야 한다. 맞지 않는 이름은 빼고 `invalid_names` 오류에 나열하며, 유효한 서버는 그대로 쓴다.
- 설정 파일이 없는 것은 오류가 아니다. 존재 확인이 실패해도(`PlatformError`) 없는 파일로 본다. 읽기 실패는 `unreadable`, 파싱 실패는 `invalid_config` 오류이며, detail은 오류 문자열의 처음 4줄이다.
- `McpFileRead.error`는 redact되지 않은 값이다. 보여 주기 전에 소유자가 detail의 비밀을 가려야 한다. `McpServerView`에는 env와 header의 값이 절대 들어가지 않는다(이름만 들어간다). target은 비밀을 가린 값이고, 확인하지 못했으면 `null`이다.
- MCP 도구 이름은 `mcp_` 접두어를 쓴다. `mcp__`는 provider-native MCP 도구용으로 예약되어 있어 쓰지 않는다. OpenAI 제약 때문에 이름은 64자 이하이고 문자는 `[A-Za-z0-9_-]`만 쓴다. 64자를 넘으면 앞 55자 + `_` + `sha256(tool)` 앞 8자로 자른다.
- `${NAME}` 치환에서 값이 없으면 `MissingVariable`로 실패한다. 이 오류 메시지에는 변수 이름만 넣고 값은 넣지 않는다.
- client는 elicitation과 sampling을 선언하지 않는다. 서버가 입력을 요청하면(spec 2026 input_required, 또는 spec 2025 task의 `input_required`) `McpToolFailed`로 실패한다. spec 2025 task는 먼저 `tasks/cancel`로 취소하고 실패한다.
- task 호출이 interrupt되면 서버의 task를 취소한다(`tasks/cancel`을 detached fiber로 보내고 결과를 기다리지 않는다).
- `plainCall`은 modern 프로토콜에서 `toolDefinition`에 inputSchema만 넘긴다. outputSchema를 넘기면 SDK 출력 검사가 입력 요청을 거부하기 때문이다.
- SDK가 인자를 JSON Schema로 검사하지 않는다. 그래서 `runToolOf`가 `jsonSchemaIssues`로 서버의 inputSchema에 대해 인자를 검사한다. `RunTool`의 `needsApproval`은 false이고, 승인 규칙은 `mcpInstructions`에 적혀 있다.
- 도구 결과와 서버 guide는 지시나 승인이 아니다(`mcpInstructions`). 결과는 60_000자, guide는 8_000자를 넘으면 잘라서 넘긴다.
- MCP 도구는 모두 lazy다. 이름만 discovery 도구 설명에 오르고, 모델이 요청한 뒤에 전체가 간다. 대화가 한 번 찾은 도구는 그 대화의 다음 run에도 전체로 간다. guide는 그대로 system prompt에 남는다.
- connect 시간 제한은 20_000ms이다. `McpStepTimedOut` 단계는 `connect_timed_out` / `tools_list_timed_out` 코드에 대응한다.
- 진행 중인 discovery는 `SynchronizedRef<Option<Fiber>>`로 호출자들이 함께 쓴다. `runTools`는 시작에 실패한 서버를 건너뛰고(설정 화면에는 failed로 표시) 실행을 계속한다.
- `McpServers.layer`의 `make`는 `StorageRoot`를 yield한다. `readMcpFile`에는 `FileSystem`을 provide해서 쓴다. `SqlClient`, `SecretRedactor`, `SecretStore`, `Crypto`도 쓴다.
- OAuth는 HTTP 서버에서 `oauth`가 있거나, 없더라도 `Authorization` 헤더를 적지 않았을 때 쓴다. 서버가 401을 주기 전에는 아무것도 하지 않는다.
- 로그인은 키체인 항목(`loginSlot`)마다 하나이고, 그 항목을 쓰는 연결(공통 서버는 모든 프로젝트)이 함께 쓴다. 항목의 `binding`이 지금 URL·`oauth`와 다르면 빈 로그인으로 본다. 발견 결과와 PKCE verifier는 메모리에만 둔다.
- 연결은 브라우저 로그인을 시작하지 않고 클라이언트를 등록하지 않는다. 동시에 온 401은 `Semaphore` 하나로 refresh 한 번만 한다(저장 횟수로 다른 refresh가 끝났는지 본다). 로그인이 필요하면 상태가 `needsLogin`이 되고, 로그인·로그아웃·신뢰 변경으로 연결이 바뀌기 전까지 서버에 다시 묻지 않는다.
- 로그인은 루프백 `127.0.0.1`의 `/callback`으로 받는다. `callbackPort`가 없으면 빈 포트를 쓰고, 동적 등록한 클라이언트는 redirect URI가 다르면 다시 등록한다. state와 Host를 확인하고, 콜백은 한 번만 받는다. 시작(발견·등록)은 30초, 로그인 전체는 5분 안에 끝나야 한다.
- 403 `insufficient_scope`: client_credentials는 넓힌 scope로 토큰을 다시 받고 호출을 한 번 더 한다. 사람 로그인은 넓힌 scope를 다음 로그인에 쓰도록 남기고 호출을 실패시킨다.
- 신뢰를 거두거나 로그아웃하면 키체인 항목, 메모리의 로그인, 진행 중인 로그인을 모두 지운다.

## Side Effects

- 파일 시스템: `<storageRoot>/mcp.json`과 `<projectRoot>/.mcp.json`을 `fs.exists`와 `fs.readFileString`으로 읽는다
- SQLite(effect/sql `SqlClient`): MCP 신뢰 행을 조회하고, `(scope, project_id, name, fingerprint, trusted_at)`를 INSERT ... ON CONFLICT DO UPDATE로 upsert한다. 신뢰 해제 경로도 있다
- 자식 프로세스: `StdioClientTransport`로 stdio MCP 서버(command, args, env)를 띄운다
- 네트워크: `StreamableHTTPClientTransport`로 HTTP MCP 서버(url, headers)에 연결한다. 프로토콜 요청은 `tools/list`, `tools/call`, `tasks/get`, `tasks/result`, `tasks/cancel`이다. OAuth 서버에는 SDK `auth()`가 보호 리소스·인가 서버 메타데이터 조회, 클라이언트 등록, 토큰 요청을 보낸다(서버 설정의 헤더는 붙이지 않는다)
- 루프백 HTTP 서버: 로그인마다 `127.0.0.1`에 콜백 리스너를 열고 로그인이 끝나면 닫는다
- OS 키체인: `SecretStore`로 서버 로그인(`mcp-oauth:…`)을 읽고 쓰고 지운다
- 환경변수: `${NAME}` 치환 때 `NodeJS.ProcessEnv`를 읽는다
- 타이머: task 폴링에 `Effect.sleep`을 쓴다(서버의 `pollInterval`, 기본 1_000ms). connect와 tools/list에 `Effect.timeoutOrElse`(connect 20_000ms)를 건다
- 백그라운드 fiber: `Effect.forkDetach`로 `tasks/cancel`과 client 종료(`stopInBackground`)를 기다리지 않고 실행한다
- Clock: 신뢰 시각 `trusted_at`을 기록한다
- Tracing span: `mcp.readConfig`, `mcp.configured`, `McpServers.call`, `McpOAuth.login`, `McpOAuth.loginCallback`

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
