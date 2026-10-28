# mcp

## Overview

`packages/memory-agent/src/mcp`는 사용자가 설정한 MCP 서버를 읽고, 신뢰를 관리하고, 연결해 실행 도구로 넘기는 계층이다. 설정 파일은 `<storage>/mcp.json`(global)과 `<project>/.mcp.json`(project) 두 곳이다.

`config.ts`는 설정 파일 schema 파싱, 지문(fingerprint), `${NAME}` 환경변수 치환을 맡는다. `client.ts`는 `@tanstack/ai-mcp`를 대신하는 공식 SDK 기반 클라이언트로, 연결·도구 목록·호출과 spec 2025 task 폴링을 맡는다. `servers.ts`는 Effect 서비스 `McpServers`로 설정 화면용 overview, 신뢰 지정, 실행용 도구(`RunTool`)와 서버 안내문(guide)을 제공한다.

이 서비스는 `packages/memory-agent/src/layers.ts`, `packages/memory-agent/src/agent/chat.ts`, `packages/memory-agent/src/report/bundle.ts`, 그리고 `apps/agent`의 `/api/projects/$project/mcp` 라우트에서 쓰인다.

## Interface

- `McpServers` — `Context.Service`(`memory-agent/mcp/servers/McpServers`)이고 `McpServers.layer = Layer.effect(McpServers, make)`이다. 확인한 메서드: `overview(project)`, 신뢰 지정/해제 메서드(실행 후 overview 반환), `runTools(project)`
- `McpServerState` — `Data.TaggedEnum`이고 상태는 `untrusted`/`changed`/`trusted`/`connected{tools}`/`failed{failure}`이다. 설정 화면이 서버마다 표시한다
- `McpServerView` / `McpOverview` — 설정 화면용 서버 뷰(scope, name, transport, 비밀을 가린 target, envNames, headerNames, shadowed, state)와 파일별 오류 목록
- `McpServerGuide` / `McpRunTools` — 서버가 연결 때 보낸 사용 안내문, 그리고 실행에 쓸 `RunTool[]`과 guides 묶음
- `mcpToolPrefix` / `mcpToolName` / `isMcpToolName` — MCP 도구 이름 규칙 `mcp_<server>__<tool>`의 접두어, 생성 함수(dual), 판별 함수
- `mcpInstructions` / `mcpInstructionsForMode` — MCP 도구 사용 규칙 시스템 프롬프트. 권한 모드 `full`이면 승인 문구를 바꾸고, 서버 guide를 `<server name=...>` 블록으로 덧붙인다
- `maxMcpGuideCharacters`(8_000) / `maxMcpResultCharacters`(60_000) — 서버 guide와 도구 결과를 모델에 넘길 때의 최대 길이
- `McpStepTimedOut` — `connect` 또는 `tools/list` 단계 시간 초과를 나타내는 TaggedError
- `McpServerConfig` — `Schema.TaggedUnion`이고 `stdio{command,args,env}` 또는 `http{url,headers}`이다
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
- connect 시간 제한은 20_000ms이다. `McpStepTimedOut` 단계는 `connect_timed_out` / `tools_list_timed_out` 코드에 대응한다.
- 진행 중인 discovery는 `SynchronizedRef<Option<Fiber>>`로 호출자들이 함께 쓴다. `runTools`는 시작에 실패한 서버를 건너뛰고(설정 화면에는 failed로 표시) 실행을 계속한다.
- `McpServers.layer`의 `make`는 `StorageRoot`를 yield한다. `readMcpFile`에는 `FileSystem`을 provide해서 쓴다. `SqlClient`와 `SecretRedactor`도 import해서 쓴다.

## Side Effects

- 파일 시스템: `<storageRoot>/mcp.json`과 `<projectRoot>/.mcp.json`을 `fs.exists`와 `fs.readFileString`으로 읽는다
- SQLite(effect/sql `SqlClient`): MCP 신뢰 행을 조회하고, `(scope, project_id, name, fingerprint, trusted_at)`를 INSERT ... ON CONFLICT DO UPDATE로 upsert한다. 신뢰 해제 경로도 있다
- 자식 프로세스: `StdioClientTransport`로 stdio MCP 서버(command, args, env)를 띄운다
- 네트워크: `StreamableHTTPClientTransport`로 HTTP MCP 서버(url, headers)에 연결한다. 프로토콜 요청은 `tools/list`, `tools/call`, `tasks/get`, `tasks/result`, `tasks/cancel`이다
- 환경변수: `${NAME}` 치환 때 `NodeJS.ProcessEnv`를 읽는다
- 타이머: task 폴링에 `Effect.sleep`을 쓴다(서버의 `pollInterval`, 기본 1_000ms). connect와 tools/list에 `Effect.timeoutOrElse`(connect 20_000ms)를 건다
- 백그라운드 fiber: `Effect.forkDetach`로 `tasks/cancel`과 client 종료(`stopInBackground`)를 기다리지 않고 실행한다
- Clock: 신뢰 시각 `trusted_at`을 기록한다
- Tracing span: `mcp.readConfig`, `mcp.configured`, `McpServers.call`

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
