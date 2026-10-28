# bin

## Overview

`bin`은 memory-agent 패키지의 ACP(Agent Client Protocol) CLI 진입점 하나(`context-agent-acp.ts`)만 둔다. Zed 같은 에디터가 이 스크립트를 실행하면 stdin/stdout으로 ACP를 주고받고, 실제 작업은 이미 실행 중인 context-generactive-agent 앱의 HTTP API(`createAppApi`)로 넘긴다. 스크립트는 `packages/memory-agent/src/acp`의 `SdkStreams`, `createAppApi`, `startAcpAgent`, `defaultAppUrl`을 조립하는 얇은 래퍼이며, 연결이 닫힐 때까지 기다린다.

## Interface

- `bin/context-agent-acp.ts` — `#!/usr/bin/env node` CLI 진입점. stdin/stdout ndjson 스트림 위에서 ACP 에이전트를 시작하고 `connection.closed`까지 기다린다. export한 심볼은 없다
- `CONTEXT_AGENT_URL` (환경 변수) — 연결할 앱 주소. 없으면 `defaultAppUrl`을 쓰고, 끝의 `/`는 모두 지운다
- 하위 디렉터리 없음

## Invariants

- stdin/stdout은 ACP 프로토콜 채널이다. 에디터와 ACP를 주고받는 데 쓴다(파일 머리 주석: speaks ACP on stdin/stdout)
- 이 바이너리는 에이전트 로직을 직접 돌리지 않는다. 실행 중인 앱에 `createAppApi(baseUrl)`로 위임하므로 앱이 먼저 떠 있어야 한다(주석: works through the running context-generactive-agent app)
- `baseUrl`은 `/+$` 정규식으로 끝 슬래시를 지운 뒤 `createAppApi`에 넘긴다
- 출력 sink는 `endOnDone: false`로 stdout을 닫지 않는다. stdout 종료는 따로 둔 `closeOutput`(`endOnDone: true` sink에 `Stream.empty` 실행)만 맡는다
- `NodeStream`/`NodeSink` 오류는 모두 `Cause.UnknownError`로 감싼다
- ACP 스트림은 `ndJsonStream(writable, readable)` 순서로 만든다. 출력이 먼저, 입력이 다음이다
- `SdkStreams.layer`는 `Effect.scoped` 안에서 `Layer.build`로 만들고, `Context.get(context, SdkStreams)`로 `readable`/`writable`을 꺼낸다

## Side Effects

- 환경 변수 `CONTEXT_AGENT_URL`을 `Config.String`으로 읽는다
- `process.stdin`을 읽고 `process.stdout`에 쓴다(ACP ndjson). 종료할 때 stdout을 닫을 수 있다
- `createAppApi`로 실행 중인 앱 주소에 네트워크 요청을 보낸다(`packages/memory-agent/src/acp`에서 구현)
- top-level `await`로 `connection.closed`까지 프로세스를 붙잡아 둔다

## Verification

- Run: `vp run memory-agent#typecheck`
