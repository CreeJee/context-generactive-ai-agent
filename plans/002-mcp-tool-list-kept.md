# Plan 002: 변경을 알리는 MCP 서버의 도구 목록은 연결에 두고 다시 묻지 않는다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat af1a8d16..HEAD -- packages/memory-agent/src/mcp packages/memory-agent/tests/integrations/mcp.test.ts packages/memory-agent/tests/support/fake-mcp-server.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `af1a8d16`, 2026-11-13

## Why this matters

run이 시작할 때마다 설정된 MCP 서버 각각에 `tools/list`를 다시 보낸다. 연결은 재사용하지만
목록은 재사용하지 않는다. 2.5시간 dev span에서 `McpServers.listTools`는 70회, 합계 24.3초,
p50 185 ms, p95 1.3초였다. 카드 run과 대화 run은 첫 모델 요청 전에 이것을 기다린다.

이 계획 뒤에는 "도구가 바뀌면 알리겠다"고 선언한 서버(`tools.listChanged`)의 목록을 연결에
두고, 서버가 알리거나 연결이 닫히거나 호출이 전송 단계에서 실패할 때만 다시 묻는다.
선언하지 않은 서버는 지금처럼 run마다 묻는다.

측정하지 않은 것: 사용 중인 서버 가운데 몇 개가 `tools.listChanged`를 선언하는지. 0개라면
이 계획의 효과는 0이다. Step 1이 그 수를 span에 남긴다.

## Current state

### 관련 파일

- `packages/memory-agent/src/mcp/servers.ts` — 설정 읽기, 연결, discovery, run의 도구.
- `packages/memory-agent/src/mcp/client.ts` — SDK `Client`를 만들고 list·call을 감싼다.
- `packages/memory-agent/src/mcp/config.ts` — `<storage>/mcp.json`과 `<project>/.mcp.json`을 읽는다.
- `packages/memory-agent/tests/integrations/mcp.test.ts` — 실제 stdio 서버로 도는 테스트.
- `packages/memory-agent/tests/support/fake-mcp-server.ts` — 테스트용 stdio MCP 서버.
- SDK: `@modelcontextprotocol/client` 2.3.1, 타입은
  `node_modules/.pnpm/@modelcontextprotocol+client@2.3.1/node_modules/@modelcontextprotocol/client/dist/`.

### 설정 파일은 이미 run마다 읽는다 — 파일 감시는 필요 없다

`servers.ts:495-528`의 `configured`는 run마다 두 설정 파일을 읽고, fingerprint가 달라진
연결을 닫는다:

```ts
  const configured = Effect.fn("mcp.configured")(function* (project: Project) {
    const global = yield* readMcpFile(globalMcpFile(storage.path), "global").pipe(
// ...
    yield* closeWhere(
      (connection, key) =>
        key.startsWith(`${project.id}/`) &&
        !Option.exists(
          MutableHashMap.get(usableFingerprints, key),
          (fingerprint) => fingerprint === connection.fingerprint,
        ),
    );
```

그래서 목록을 `Connection`에 붙여 두면 설정이나 신뢰가 바뀔 때 연결과 함께 버려진다.
로그인·로그아웃도 `closeWhere(usesLogin(...))`로 연결을 바꾼다(`servers.ts:980,1135`).
남는 것은 설정이 그대로인데 서버 쪽 목록이 바뀌는 경우다.

### 목록을 다시 묻게 되는 곳

`servers.ts:269-275`:

```ts
interface Connection {
  readonly fingerprint: string;
  readonly client: Fiber.Fiber<Connected, Cause.UnknownError | McpConnectFailed | MissingVariable>;
  readonly state: Ref.Ref<McpServerState>;
  /** The discovery in flight, which callers meanwhile share. */
  readonly discovering: SynchronizedRef.SynchronizedRef<Option.Option<Fiber.Fiber<Discovered>>>;
}
```

`servers.ts:672-694` — discovery가 끝나면 `discovering`을 비워서 다음 run이 새로 시작한다:

```ts
const discover = (project: Project, server: ConfiguredServer, startAgain: StartAgain) => {
  const key = connectionKey(project, server);
  const discovered = Effect.flatMap(connect(project, server), (connection) =>
    SynchronizedRef.modifyEffect(connection.discovering, (current) =>
      Option.match(current, {
        onSome: (running) => Effect.succeed([running, current] as const),
        onNone: () =>
          discovery({ key, server, connection }).pipe(
            // A connection starts another discovery only once this one is cleared, so it is still this one.
            Effect.ensuring(SynchronizedRef.set(connection.discovering, Option.none())),
            // A caller that stops waiting does not stop the discovery the others share.
            Effect.forkIn(serviceScope),
            Effect.map((running) => [running, Option.some(running)] as const),
          ),
      }),
    ).pipe(Effect.flatMap(Fiber.join)),
  );
  return startAgain === "now"
    ? discovered
    : Effect.flatMap(waiting(key, server), (wait) =>
        wait ? Effect.succeed(nothingDiscovered) : discovered,
      );
};
```

`servers.ts:766-781` — discovery 본문:

```ts
    return Effect.gen(function* () {
      // A server that wants a login is not asked again until a login or logout replaces the connection.
      if (McpServerState.$is("needsLogin")(yield* Ref.get(connection.state)))
        return nothingDiscovered;
      const connected = yield* withTimeout(
        Fiber.join(connection.client),
        connectTimeoutMs,
        "connect",
      ).pipe(Effect.withSpan("McpServers.connect"));
      const tools = yield* withTimeout(
        listTools(connected.client),
        connectTimeoutMs,
        "tools/list",
      ).pipe(Effect.withSpan("McpServers.listTools"));
      return (yield* isCurrent) ? yield* offered(connected, tools) : nothingDiscovered;
    }).pipe(
```

`servers.ts:749-750` — 도구 호출:

```ts
          call: (args) =>
            authorized(login, callTool({ client, tool, args })).pipe(Effect.flatMap(limited)),
```

`servers.ts:733-737` — 호출이 로그인을 요구하면 연결 상태를 `needsLogin`으로 바꾼다. 그 뒤의
run은 이 서버의 도구를 받지 않는다.

`startAgain`의 두 값: run은 `"after-wait"`(`servers.ts:918`), 설정 화면의 동작(다시 신뢰,
로그인 끝, 로그아웃)은 `"now"`(`servers.ts:981,1098,1138`)다.

`client.ts:43-56` — 클라이언트 생성:

```ts
export const connectClient = (transport: Transport) =>
  Effect.suspend(() => {
    const client = new Client(
      { name: "context-generactive-agent", version: "0.0.1" },
      { versionNegotiation: { mode: "auto" } },
    );
```

### run마다 묻는 `tools/list`가 지금 하는 다른 일

목록 요청은 연결이 살아 있는지도 확인한다. 서버 프로세스가 죽으면 다음 run의 `listTools`가
실패하고, `servers.ts:783-803`이 연결을 실패로 표시하고 닫는다. 그다음 run이 새로 시작한다.
목록을 두고 쓰면 이 확인이 사라진다. 그래서 **연결이 닫히거나 호출이 전송 단계에서 실패하면
둔 목록을 버려야** 지금과 같은 복구가 일어난다. 이 계획의 Step 3이 그 부분이다.

### SDK가 주는 것 (2.3.1의 타입에서 확인)

- `ClientOptions.listChanged?: ListChangedHandlers` (`index.d.mts:1992`).
  `tools: { autoRefresh?: boolean; debounceMs?: number; onChanged: (error, items) => void }`
  (`index-B-4n9P0J.d.mts:869-887`). `autoRefresh`의 기본값은 `true`, `debounceMs`는 300이다.
  서버가 `tools.listChanged`를 선언하지 않으면 handler는 설정되지 않는다(`:894-896`).
- `client.getServerCapabilities()` (`index.d.mts:2347`).
- `Protocol`의 `onclose?: () => void`, `onerror?: (error: Error) => void`
  (`index-B-4n9P0J.d.mts:2110,2116`). `Client`는 `Protocol`을 상속한다(`index.d.mts:2165`).
- SDK 자체 응답 캐시가 있다(`index.d.mts:1639-1669, 2040-2049`). 서버가 결과에 `ttlMs`를 주면
  그 시간 동안 `listTools()`가 요청 없이 답한다. `defaultCacheTtlMs`의 기본값은 0이라, `ttlMs`를
  주지 않는 서버의 목록은 매번 다시 묻는다. 이 계획은 SDK 캐시 설정을 바꾸지 않는다.

### 지켜야 할 결정

`docs/decisions.md:4516-4519` "스킬 카탈로그는 캐시 없이 함께 읽는다 (2026-11-09)":

> 캐시는 두지 않는다. 스킬은 사람이 다른 에이전트나 편집기로 언제든 바꾸고, 카탈로그는 부를
> 때의 디스크를 보여야 한다.

MCP가 다른 점은 서버가 변경을 알리는 통로가 프로토콜에 있다는 것이다. 그래서 규칙은 하나다:
**변경을 알리겠다고 선언한 서버의 목록만 둔다.** 선언하지 않은 서버는 오래된 목록을 보일 수
있으므로 지금처럼 매번 묻는다. 전송 방식(stdio, HTTP)으로 나누지 않는다. 만료 시간을 두지 않는다.

저장소 규칙은 루트 `AGENTS.md`와 `CLAUDE.md`에 있다. 시작 전에 읽는다. 특히: `let`/`while`을
쓰지 않는다, lint 끄는 주석을 쓰지 않는다, 뜻 없는 `(x) => f(x)` 감싸기를 하지 않는다, 줄바꿈만
바꾸는 수정은 하지 않는다, 코드 주석은 영어로 쓰고 만들어 낸 용어 대신 쉬운 말을 쓴다.

## Commands you will need

| Purpose         | Command                                                                                      | Expected on success |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| MCP 테스트      | `cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts` | all pass            |
| MCP 단위 테스트 | `cd packages/memory-agent && vp test --run --project unit src/mcp`                           | all pass            |
| typecheck       | 저장소 루트에서 `vp run memory-agent#typecheck`                                              | exit 0, 경고 없음   |
| 포맷·lint       | 저장소 루트에서 `vp check`                                                                   | exit 0              |

- `--project feature <파일>` 형태는 `tests/app-events.test.ts`로 확인했다. `mcp.test.ts`는
  계획 작성 때 돌리지 않았다. 시작 전에 한 번 돌려 지금 통과하는지 본다. 실패하면 STOP이다.
- MCP 테스트는 서버 프로세스를 띄우므로 테스트마다 수 초가 걸린다(`serverStartTimeout = 20_000`).
- 전체 suite는 돌리지 않는다. lint는 저장소 루트에서 돌린다.

## Scope

**In scope**:

- `packages/memory-agent/src/mcp/servers.ts`
- `packages/memory-agent/src/mcp/client.ts`
- `packages/memory-agent/src/mcp/README.md`
- `packages/memory-agent/tests/integrations/mcp.test.ts`
- `packages/memory-agent/tests/support/fake-mcp-server.ts`
- `docs/decisions.md` (끝에 항목 하나)

**Out of scope**:

- 설정 파일 감시(file watcher) — `configured`가 이미 run마다 읽는다. 위 "Current state" 참고.
- `configured`가 run마다 하는 파일 읽기 2번과 SQL 2번을 줄이는 일 — 그것이 설정 변경 감지다.
- SDK 응답 캐시 설정(`defaultCacheTtlMs`, `responseCacheStore`).
- `tests/support/fake-oauth-mcp-server.ts`와 OAuth 경로(`src/mcp/oauth.ts`).
- 설정 화면(`overview`)과 페이지 쪽 코드. `McpServerState`의 모양을 바꾸지 않는다.
- 선언하지 않은 서버의 목록을 두는 일 — 결정이 필요하다 (Maintenance notes).

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 `git add <path>`로 올린다.
- 단계마다 commit한다. 각 commit은 typecheck를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `perf(workflow): update_goal도 Goal 본문 대신 저장된 버전만 돌려준다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 서버가 변경을 알리는지 span에 남긴다

`servers.ts`의 `McpServers.listTools` span(778–779행)에 속성 하나를 남긴다:
`mcp.tools.list_changed` = `connected.client.getServerCapabilities()?.tools?.listChanged === true`.
서버 이름이나 URL은 남기지 않는다. 저장소에서 span 속성을 붙이는 기존 방식을 따른다
(`rg -n "annotateCurrentSpan" packages/memory-agent/src | head`).

이 단계만으로 운영자는 dev를 한 번 돌린 뒤 선언하는 서버의 수를 셀 수 있다.

**Verify**: 저장소 루트에서 `vp run memory-agent#typecheck` → exit 0.
`cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts` → all pass.

### Step 2: 클라이언트가 "도구가 바뀌었다"와 "닫혔다"를 알린다

`client.ts`의 `connectClient`가 두 번째 값으로 callback 둘을 받는다:

```ts
export const connectClient = (
  transport: Transport,
  hooks: { readonly onToolsChanged: () => void; readonly onClosed: () => void },
) =>
```

- `new Client(...)`의 옵션에
  `listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: hooks.onToolsChanged } }`를 더한다.
  `autoRefresh: false`인 이유: SDK가 대신 다시 묻지 않게 한다. 다시 묻는 것은 다음 run이다.
  `debounceMs: 0`인 이유: 알림을 받은 바로 그때 표시해야 다음 run이 놓치지 않는다.
- `client.onclose = hooks.onClosed`를 연결 전에 단다.
- 호출부는 `rg -n "connectClient" packages/memory-agent`로 모두 찾아 고친다.

**Verify**: 저장소 루트에서 `vp run memory-agent#typecheck` → exit 0.

### Step 3: 목록을 연결에 두고, 믿을 수 있을 때만 쓴다

`servers.ts`의 `Connection`에 두 가지를 더한다:

- `changes`: SDK callback이 동기로 올리는 수. `effect`의 `MutableRef`를 쓴다
  (`node_modules/.pnpm/effect@4.1.2*/node_modules/effect/src/MutableRef.ts`에서 API를 확인한다).
  `onToolsChanged`와 `onClosed` 둘 다 이 수를 1 올린다.
- `kept`: 마지막 목록과 그것을 읽기 **시작할 때의** `changes` 값. 없을 수 있다.

`connect`의 `start`(606–619행)에서 `changes`를 먼저 만들고 `connectClient`에 hook을 넘긴다.

`discovery`(766행 이후):

- `listTools`를 부르기 **전에** `changes`를 읽어 둔다. 목록을 받는 도중에 알림이 오면 수가
  달라져 그 목록은 다음에 쓰이지 않는다.
- `offered`가 성공하고 `isCurrent`이며 서버가 `tools.listChanged === true`를 선언했으면
  `kept`에 `{ at: <읽어 둔 수>, discovered }`를 둔다. 선언하지 않았으면 `kept`를 비운다.

`discover`(672행):

- `startAgain === "after-wait"`이고 실패 대기 중이 아닐 때, `listTools`를 다시 부르기 전에 확인한다.
  아래 셋이 모두 참이면 `kept`의 `discovered`를 그대로 돌려준다:
  1. `kept`가 있다.
  2. `kept.at`이 지금의 `changes`와 같다.
  3. `connection.state`가 `connected`다. (`needsLogin`이나 `failed`면 쓰지 않는다. 지금도 그런
     연결은 도구를 주지 않는다.)
- 하나라도 거짓이면 기존 경로(`discovering`을 통한 공유 discovery)로 간다.
- `startAgain === "now"`는 `kept`를 보지 않고 항상 다시 묻는다. 결과는 위 규칙대로 `kept`를 고친다.

도구 호출(749–750행): 호출이 `Cause.UnknownError`로 실패하면 `changes`를 1 올린다. 전송이나
프로토콜 단계의 실패라는 뜻이다. `McpToolFailed`(서버가 오류로 답함, 입력을 요구함, 로그인
필요)에는 올리지 않는다. 이렇게 하면 죽은 서버나 끊긴 HTTP 세션은 다음 run에서 다시 목록을
묻고, 그 요청이 실패해 기존 복구 경로(실패 표시 → 다음 run이 다시 시작)로 간다.

`Connection`과 `discover`의 주석을 새 동작에 맞게 고친다. `discovering`의 주석과 동작은 그대로다.

**Verify**: 저장소 루트에서 `vp run memory-agent#typecheck` → exit 0.
`cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts` → 기존
테스트 all pass. 특히 `"concurrent discovery shares one listing"`이 그대로 통과해야 한다. 이
테스트의 서버는 선언하지 않으므로 run마다 묻는 동작이 그대로여야 한다.

### Step 4: 테스트 서버와 새 테스트

`tests/support/fake-mcp-server.ts`:

- env `FAKE_MCP_LIST_CHANGED`(Boolean, 기본 false)를 읽는다. 참이면 capabilities의 `tools`를
  `{ listChanged: true }`로 한다.
- 참일 때만 도구 `change`를 목록에 더한다. 호출되면 `server.sendToolListChanged()`를 **기다린 뒤**
  결과를 돌려준다. stdio에서는 알림이 응답보다 먼저 쓰이므로, 호출이 끝난 시점에 클라이언트는
  이미 알림을 처리했다. (`sendToolListChanged`는
  `@modelcontextprotocol/server` 2.3.1의 `dist/createMcpHandler-*.d.mts:3217`에 있다.)

`tests/integrations/mcp.test.ts`에 테스트를 더한다. 구조는 129–155행의
`"concurrent discovery shares one listing"`을 본뜬다(`FAKE_MCP_LIST_LOG`로 목록 요청 수를 센다,
`setTrusted` 직후의 줄 수를 기준 `listing`으로 삼는다):

1. **선언하는 서버는 run마다 묻지 않는다**: `FAKE_MCP_LIST_CHANGED: "true"`로 신뢰한 뒤
   `runTools`를 차례로 두 번 부른다. 목록 로그의 줄 수가 `listing` 그대로다. 두 결과의 도구
   이름이 같다.
2. **서버가 알리면 다음 run이 다시 묻는다**: 1번 상태에서 `change` 도구를 한 번 호출한 뒤
   `runTools`를 부른다. 줄 수가 `2 * listing`이다. 한 번 더 부르면 그대로 `2 * listing`이다.
   (도구를 호출하는 방법은 같은 파일의 기존 테스트에서 `runTools` 결과의 handler를 부르는
   곳을 찾아 따른다: `rg -n "handler\(" packages/memory-agent/tests/integrations/mcp.test.ts`.)
3. **설정이 바뀌면 다시 묻는다**: 1번 상태에서 `.mcp.json`의 env를 바꿔 fingerprint를 바꾸고
   다시 신뢰한다. 새 연결이 목록을 묻는다(줄 수가 늘어난다).
4. **선언하지 않는 서버는 그대로다**: 기존 `"concurrent discovery shares one listing"`이 이
   경우를 이미 본다. 고치지 않는다.

**Verify**: `cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts`
→ all pass, 새 테스트 3개 포함.

### Step 5: 문서

- `packages/memory-agent/src/mcp/README.md`: `Connection`이 목록을 두는 조건과 버리는 조건
  (서버의 알림, 연결 닫힘, 전송 단계의 호출 실패, 연결 교체, 설정 화면의 동작).
- `docs/decisions.md` 끝에 항목(한국어, 날짜 포함): 계기(위 측정값), 결정(선언한 서버만 둔다),
  스킬 카탈로그 결정과의 관계, 설정 파일 감시를 두지 않은 이유, 측정하지 않은 것.

**Verify**: `rg -n "listChanged|list_changed" packages/memory-agent/src/mcp/README.md docs/decisions.md` → 각 파일에서 한 줄 이상.

### Step 6: 운영자에게 알린다

dev 백엔드는 dev를 시작할 때 한 번만 빌드된다. 최종 보고에 "dev를 다시 시작해야 반영된다"와
"다시 시작한 뒤 `McpServers.listTools` span의 `mcp.tools.list_changed` 값으로 선언하는 서버 수를
볼 수 있다"를 적는다. 직접 재시작하지 않는다.

## Test plan

- 새 테스트 3개: Step 4의 1–3번. 파일은 `packages/memory-agent/tests/integrations/mcp.test.ts`.
- 회귀: 같은 파일의 기존 테스트 전부. 특히 연결 수명(`"removing a configured server closes its
  live process"`), 실패 뒤 다시 시작, 로그인 경로.
- 확인: `cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts` → all pass.

## Done criteria

- [ ] `cd packages/memory-agent && vp test --run --project feature tests/integrations/mcp.test.ts` exits 0, 새 테스트 3개 포함
- [ ] 저장소 루트에서 `vp run memory-agent#typecheck`, `vp check` 모두 exit 0
- [ ] `rg -n "listChanged" packages/memory-agent/src/mcp/client.ts` 결과 한 줄 이상
- [ ] `rg -n "mcp.tools.list_changed" packages/memory-agent/src/mcp/servers.ts` 결과 한 줄
- [ ] `rg -n "watch" packages/memory-agent/src/mcp/servers.ts packages/memory-agent/src/mcp/config.ts` 결과 없음 (파일 감시를 넣지 않았다)
- [ ] `git status --short`에 In scope 밖의 수정이 없다 (다른 세션의 수정은 건드리지 않는다)
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- 시작 전에 돌린 `mcp.test.ts`가 이미 실패한다.
- `listChanged` 옵션을 주면 기존 테스트의 서버 시작 수나 목록 요청 수가 달라진다. SDK가 연결
  때 추가 요청을 보낸다는 뜻이므로 보고한다.
- `client.onclose`를 달면 SDK나 transport가 쓰는 handler를 덮어쓴다 (타입이 아니라 구현에서
  확인된 경우).
- Step 4의 2번에서 알림이 호출 응답보다 늦게 처리돼 테스트가 불안정하다. 기다리는 코드를
  임의로 넣지 않고 보고한다.
- `McpServerState`나 설정 화면의 계약을 바꿔야 한다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- **결정 대기**: 선언하지 않는 서버의 목록도 둘지. 두면 서버 쪽에서 도구가 바뀌어도 연결이
  바뀔 때까지 보이지 않는다. Step 1의 span 값으로 선언하는 서버가 적다고 나오면 다시 정한다.
- HTTP 서버의 알림은 서버가 여는 스트림으로 온다. 그 스트림이 끊긴 동안의 알림은 놓칠 수
  있다. 그때 목록은 다음 연결까지 오래된 채로 남는다. 문제가 보고되면 여기부터 본다.
- 리뷰에서 볼 곳: `changes`를 `listTools` **전에** 읽는가. `needsLogin`·`failed` 상태에서 `kept`를
  쓰지 않는가. `Cause.UnknownError`에만 수를 올리는가.
- `configured`의 파일 읽기 2번과 SQL 2번은 run마다 남는다. 이것을 줄이려면 설정 변경을 다른
  방법으로 알아야 하므로 별개의 결정이다.
- 서버가 `ttlMs`를 주는 경우의 SDK 캐시 동작은 이 계획 전후로 같다.
