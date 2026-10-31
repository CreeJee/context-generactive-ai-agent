# acp

## Overview

`packages/memory-agent/src/acp`는 Zed 같은 에디터에 ACP(Agent Client Protocol) 에이전트로 붙는 브리지다. 브리지는 저장소를 갖지 않는다. 실행 중인 앱 프로세스의 HTTP API(`createAppApi`)와 `ChatApi`를 불러 세션, lease, 실행, 승인을 다룬다. 그래서 에디터에서 시작한 세션은 웹 페이지의 세션과 같다. `startAcpAgent`는 `packages/memory-agent/bin/context-agent-acp.ts`와 `apps/agent/server/main.ts`에서 호출된다. `tool-view.ts`는 도구 호출을 에디터용 제목, ACP `ToolKind`, 경로로 바꾼다. `web-streams.ts`는 Effect Stream/Sink를 SDK용 Web stream으로 잇는다.

## Interface

- `startAcpAgent` — `(options: { stream: AcpStream; api: AppApi })`를 받는 ACP 에이전트 진입점. 내부에서 `makeAcpAgent`를 부르고 `SecretRedactor.layer`를 제공한다. 호출처는 `bin/context-agent-acp.ts`, `apps/agent/server/main.ts`
- `createAppApi` — 앱 HTTP API 클라이언트를 만드는 dual 함수: `(baseUrl)`, `(baseUrl, fetcher)`, `(fetcher)(baseUrl)`. 반환 값에는 `auth`, `projects`, `createSession`, `sessionState`, `lease`, `cancel`, `approvals`, `answerApproval`, `request`가 있다
- `AppApi` — `createAppApi`가 반환하는 객체 타입
- `AppRequestFailed` — `status`, `code`, `message`, `reason`을 가진 `Schema.TaggedError`. 앱이 거절했거나 앱에 닿지 못했음을 나타낸다
- `AppRequestReason` — `TransportFailed` | `RequestRejected` | `InvalidResponse` TaggedUnion
- `requestFailure` — `{status, code, reason}`으로 `AppRequestFailed`를 만든다. message는 `${code} (${status})`
- `AuthSummary` — 앱의 현재 provider 연결 상태 TaggedUnion: `signed-out` | `pending` | `signed-in` | `error`. `GET /api/auth`를 provider 없이 부르면 앱이 지금 쓰는 provider(전역 설정, 없으면 `openai`)로 답한다
- `defaultAppUrl` — 기본 앱 주소 `http://127.0.0.1:5173`. 주석에 따르면 `CONTEXT_AGENT_URL`로 바꿀 수 있다
- `ProjectSummary` / `SessionSummary` — 앱 응답 타입. 프로젝트는 `{id, root, name}`, 세션은 `{id, projectId}`
- `toolView` — 도구 이름을 `{title, kind}`로 바꾼다. 표에 없는 `mcp_<server>__<tool>` 이름은 `MCP server · tool`로, 그 밖의 이름은 원래 이름과 kind `other`로 보여 준다
- `ToolView` — 에디터 표시용 인터페이스 `{ title: string; kind: ToolKind }`
- `toolDetail` — 인자 JSON의 `path`·`command`·`query`·`task` 중 첫 값을 80자 제한(77자 + `…`)으로 돌려준다. 없으면 `null`
- `toolLocations` — dual `(argumentsJson, projectRoot)`. `path` 인자를 `path.resolve`로 절대 경로 `[{ path }]`로 바꾼다
- `SdkStreams` — `Context.Service`(`memory-agent/acp/web-streams/SdkStreams`). `{readable, writable}` Web stream을 갖고, `SdkStreams.layer({input, output, closeOutput})`로 만든다
- 하위 디렉터리: 없음

## Invariants

- 브리지는 저장소를 갖지 않는다. DB, 벡터 인덱스, 모델 제공자 연결은 앱 프로세스가 갖는다. 브리지는 앱 HTTP API로만 상태를 다룬다(`app-api.ts` 주석)
- `session/new`는 세션을 만들기 전에 앱의 현재 provider가 로그인했는지 본다. 아니면 `login_required`로 거절하고 세션을 만들지 않는다
- lease 갱신 주기 `leaseRenewMs = 20_000`은 앱이 lease를 버리는 90초보다 짧아야 한다(주석)
- 에디터 연결마다 lease holder가 따로 있다(`BridgeSession.holder`, 브라우저 탭과 같은 역할). 쓰기 요청은 holder를 `sessionHolderHeader` 헤더로 보낸다. `sessionState`는 holder를 쿼리로 보낸다
- 보안: 프로젝트 등록은 file 도구가 닿는 범위를 넓히므로 웹 페이지만 한다. 등록되지 않은 root면 브리지는 `ProjectNotRegistered`로 거절한다
- 보안: `acp.RequestError`, `AppRequestFailed`, `EditorRequestRefused`가 아닌 오류는 URL이나 자격 증명을 담을 수 있다. 그래서 `SecretRedactor.shownDetail`로 가린 뒤 `run_failed`로 보낸다. `RunFailed.detail`도 가린 텍스트다
- 한 세션에는 진행 중 turn이 하나만 있다(`BridgeSession.turn: Ref<Option<PromptTurn>>`). 진행 중이면 `TurnInProgress`로 거절한다
- 앱에 닿지 못하면 `status 0`, `code "unreachable"`, `TransportFailed`다. 앱의 오류 본문 `{error}`는 code로 쓴다. 응답이 스키마에 맞지 않으면 `unexpected_response`, `InvalidResponse`다
- `request`는 호출자 `init.signal`과 소유 fiber의 `Effect.abortSignal`을 `AbortSignal.any`로 합치고, `Effect.scoped`로 실행한다. fiber를 중단하면 fetch도 취소된다
- session update 알림(`client.notify`)은 기다리지 않는다. 실행은 알림 전송을 기다리지 않는다(주석)
- 에디터로 보내는 도구 출력은 `maxToolOutput = 4_000`자에서 자른다
- `tool-view.ts` 표에서 예전 도구 이름 `run_shell`, `save_shell_skill`, `message_subagent`를 지우지 않는다. 기록된 과거 호출을 다시 보여 줄 때 쓰인다(주석)
- `SdkStreams`의 `write`는 Effect sink의 backpressure를 기다린다. `close`와 `abort`는 모두 `closeOutput`을 실행한다. Web stream reader/writer는 ACP SDK가 갖는다
- `askedCall`은 `Match.discriminatorsExhaustive("reason")`으로 `tool_call`과 `permission_review`를 모두 다룬다. 새 interrupt reason을 추가하면 이 매치를 갱신해야 한다

## Side Effects

- 네트워크: `fetch`로 앱 HTTP API를 부른다. 경로는 `GET /api/auth`, `GET /api/projects`, `POST /api/sessions`, `GET /api/sessions/:id?holder=`, `POST /api/sessions/:id/lease`(claim/release), `POST /api/sessions/:id/cancel`, `GET /api/sessions/:id/approvals`, `POST /api/sessions/:id/approvals/:approvalId`
- 네트워크: `agent-bridge.ts`는 `FetchHttpClient`, `HttpApiClient`, `ChatApi`를 import해 앱 chat API에 run, resume, 메시지 페이지를 요청한다
- ACP 연결: `turn.client.notify(acp.methods.client.session.update, …)`로 에디터에 session update를 보낸다. 에디터에 권한 요청(`RequestPermissionResponse`)도 한다
- 타이머/fiber: 세션마다 lease 갱신 fiber(`renew`, 20초 주기)가 있다. prompt 중에는 서브에이전트·외부 에이전트 승인을 1.5초 주기(`relayPollMs`)로 확인한다
- 메모리 상태: `Ref<HashMap<string, BridgeSession>>`에 세션 목록을 둔다. turn마다 `args`, `cancelled`, `failure` Ref가 있다
- 파일 시스템: `FileSystem.FileSystem`(`NodeFileSystem`)으로 에디터 cwd 폴더가 있는지 확인한다(`FolderNotFound` 거절)
- 암호: `Crypto.Crypto`(`NodeCrypto`)로 holder ID 같은 난수 ID를 만든다
- 스트림: `SdkStreams`가 Effect `Stream`을 `ReadableStream`으로, Effect `Sink`를 `WritableStream`으로 바꾸고 각 write를 `Effect.runPromiseWith`로 실행한다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
