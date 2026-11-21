# Plan 003: 백엔드는 listen을 시작하자마자 agent runtime을 만들기 시작한다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 01ae0dc1..HEAD -- apps/agent/app/.server/agent.ts apps/agent/app/entry.server.tsx apps/agent/server/main.ts apps/agent/server/server-build.d.ts apps/agent/app/.server/first-screen.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `01ae0dc1`, 2026-11-14 (2026-11-13에 `4a803b10`에서 쓰고 줄 번호를 새로 맞췄다)

## Why this matters

dev를 시작한 직후의 첫 화면이 느리다. 백엔드 프로세스는 뜨자마자 `/api/health`에 답하지만,
agent runtime(DB, 워크플로, 네이티브 검색, 스케줄러)은 첫 `/api` 요청이 올 때에야 만들기
시작한다. 그 요청은 브라우저가 페이지를 열 때 온다. SSR loader는 500 ms만 기다리고 빈 화면을
내려보낸다. 그 뒤 페이지의 쿼리들이 runtime이 다 만들어질 때까지 기다린다.

2026-11-13 20:24(KST) dev 시작 한 번의 측정이다 (`apps/agent/build/dev-spans-5180.ndjson`,
`apps/agent/build/logs/dev-backend-5180-2026-11-13T11-24-06-848Z.log`).

| 구간                                                                           | 값                              |
| ------------------------------------------------------------------------------ | ------------------------------- |
| 백엔드 로그 파일 생성(프로세스 시작 직후) → runtime의 첫 span(`Database.make`) | 60.1초 동안 아무 일도 하지 않음 |
| `Database.make` → 첫 API handler span(`SubscriptionQuota.accounts`)            | 5.6초                           |
| 그중 `NativeOwner.make`(네이티브 검색 worker 열기)                             | 3.57초                          |
| 그중 벡터 정리 SQL 3개                                                         | 0.54초                          |

runtime을 listen 직후에 만들기 시작했다면 이 5.6초는 Vite frontend가 뜨고 사람이 브라우저를
여는 동안 끝났을 것이다. 표본은 한 번이다. 앞선 다른 표본에서는 5.4초였다.

이 계획이 줄이지 않는 것:

- runtime을 만드는 시간 자체(5.6초). 백엔드가 뜨고 5초 안에 페이지를 열면 남은 만큼 기다린다.
- Vite dev 서버가 첫 요청에서 모듈을 변환하는 시간. 재지 않았다.
- `dev` 명령이 백엔드를 띄우기 전에 하는 빌드(`react-router build`, `vp pack`).

## Current state

### 관련 파일

- `apps/agent/app/.server/agent.ts` — 서버 프로세스의 단일 agent runtime. `ManagedRuntime.make`로 만든다.
- `apps/agent/app/entry.server.tsx` — 서버 빌드의 entry. runtime 수명주기 함수를 다시 내보낸다.
- `apps/agent/server/server-build.d.ts` — `#server-build`의 타입. `entry.module`은 `entry.server.tsx`의 타입이다.
- `apps/agent/server/main.ts` — `context-agent` 진입점. 설정 → `serve` → 브라우저 열기.
- `apps/agent/app/.server/api.ts` — `/api` handler. 첫 요청에서 `agent.contextEffect`로 만든다.
- `apps/agent/app/.server/first-screen.ts` — SSR loader. 500 ms 기한.
- `apps/agent/scripts/dev.ts` — dev 스크립트. 백엔드를 `--dev-backend`로 띄우고 `/api/health`를 기다린다.

### 발췌

`apps/agent/app/.server/agent.ts:59-71`:

```ts
function createAgentRuntime(): AgentRuntime {
  // The server entry configures storage before the first request builds this layer.
  return ManagedRuntime.make(runtimeLayer);
}

/** The single memory-agent runtime of this server process. Server-only. */
export const agent = createAgentRuntime();

/** The backend owner's Scope disposes this exact runtime from the server build. */
export function disposeAgent(): Promise<void> {
  stopAllCommands();
  return agent.dispose();
}
```

`apps/agent/app/entry.server.tsx:11`:

```ts
export { configureAgentBackend, disposeAgent } from "./.server/agent.ts";
```

`apps/agent/server/main.ts:286-331` (줄임):

```ts
build.entry.module.configureAgentBackend({
  storageRoot,
  runtimeRoot: runtime,
  buildConfig,
  release: readReleaseInfo().version,
});
await runNativeEffect(
  Scope.addFinalizer(backendScope, Effect.promise(build.entry.module.disposeAgent)),
);
// ... clientDirectory ...
await serve({
  build,
  port,
  // ...
}).catch((error: NodeJS.ErrnoException) =>
  closeBackend()
    // ... 포트 충돌 등을 알리고 ...
    .then(() => process.exit(1)),
);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
await Effect.runPromise(
  Console.log(
    i18n._(msg`Context Agent가 ${{ baseUrl }} 에서 실행 중입니다. Ctrl+C를 누르면 끝납니다.`),
  ),
);
```

`apps/agent/server/main.ts:208-210,340-341` — dev 백엔드는 폴더를 열지 않는다. 그래서 listen
뒤에 `/api`를 부르는 것이 없다. 폴더를 주고 띄운 앱은 `pageFor`가 `/api`를 불러 runtime을 만든다.

```ts
const folder: LaunchFolder = commandLine.devBackend
  ? { kind: "none" }
  : await launchFolder(folderArgument, process.cwd(), storageRoot, executableFolder);
// ...
const page = await runLaunchRequest(pageFor(folder));
if (commandLine.open) openInBrowser(page);
```

`apps/agent/app/.server/first-screen.ts:29-33`:

```ts
/**
 * How long the page waits for the first screen. A warm server answers in milliseconds; the first
 * request after a start also builds the agent, and the page renders without waiting for that.
 */
const firstScreenDeadline = "500 millis";
```

`effect@4.1.2`의 `ManagedRuntime.ts:359-383` — runtime은 한 번만 만든다. 처음 쓰는 쪽이
`buildFiber`를 따로 fork하고, 뒤에 오는 쪽은 그 fiber를 기다린다. 실패도 같은 fiber의 결과라
모두에게 같은 실패로 간다. `dispose`는 만드는 중인 fiber도 중단한다.

```ts
const contextEffect = Effect.withFiber<Context.Context<R>, ER>((fiber) => {
  if (!buildFiber) {
    buildFiber = Effect.runFork(
      Effect.tap(Layer.buildWithMemoMap(layer, memoMap, layerScope) /* cachedContext에 저장 */),
      {/* ... 만드는 fiber는 runtime의 fiberScope에 든다 ... */},
    );
  }
  return Effect.flatten(Fiber.await(buildFiber));
});
```

### 지켜야 할 설계

- runtime을 늦게 만드는 까닭은 순서뿐이다. 모듈이 load된 뒤에 `configureAgentBackend`가 저장소
  위치를 정하므로, 만들기는 그 뒤여야 한다 (`agent.ts:8`의 주석, `docs/decisions.md:2985`).
  "첫 요청까지 미룬다"는 결정은 없다.
- 만들기는 **`serve`가 listen에 성공한 뒤**에 시작한다. 포트 충돌로 끝나는 프로세스가 DB를 열고
  워크플로를 다시 시작하면 안 된다. 지금도 그 경우에는 runtime을 만들지 않는다.
- listen을 runtime 구성에 묶지 않는다. `/api/health`는 지금처럼 바로 답한다. dev 스크립트의
  30초 대기(`dev.ts:103`)와 `backend_restart_required` 판정이 여기에 기대고 있다.
- 구성이 실패해도 프로세스를 끝내지 않는다. 지금처럼 첫 요청이 그 실패를 받는다.

## Commands you will need

| Purpose         | Command                                               | Expected on success                   |
| --------------- | ----------------------------------------------------- | ------------------------------------- |
| 서버 테스트     | `cd apps/agent && vp test --run server/serve.test.ts` | all pass (계획 작성 때 1 passed 확인) |
| agent typecheck | 저장소 루트에서 `vp run agent#typecheck`              | exit 0                                |
| 포맷·lint       | 저장소 루트에서 `vp check`                            | exit 0                                |

- 단계마다 건드린 테스트만 돌린다. 전체 suite는 돌리지 않는다.
- lint는 저장소 루트에서 돌린다. 패키지 안에서 돌리면 pre-commit hook이 보는 규칙 일부가 빠진다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.** 운영자의 dev가 같은 checkout의
  `apps/agent/build`와 `apps/agent/dist`를 쓰고 있다.

## Scope

**In scope**:

- `apps/agent/app/.server/agent.ts`
- `apps/agent/app/entry.server.tsx`
- `apps/agent/server/main.ts`
- `apps/agent/app/.server/first-screen.ts` (29–32행의 주석만)
- `apps/agent/server/README.md`, `apps/agent/app/README.md`
- `docs/decisions.md` (끝에 항목 하나)

**Out of scope**:

- `apps/agent/app/.server/api.ts` — handler를 첫 요청에서 만드는 것은 그대로 둔다.
- `firstScreenDeadline`의 값.
- `packages/memory-agent`의 runtime 구성 순서와 `NativeOwner.make`. 메모리 검색은 재설계 중이다.
- `apps/agent/scripts/dev.ts`와 `apps/agent/server/dev-safety.ts` — health 응답과 대기는 그대로다.
- `apps/agent/vite.config.ts` — Vite의 첫 변환 시간은 이 계획의 대상이 아니다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 `git add <path>`로 올린다.
- 단계마다 commit한다. 각 commit은 빌드와 typecheck를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `perf(agent): 백엔드가 listen 직후에 agent runtime을 만들기 시작한다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: runtime 구성을 시작하는 함수

`apps/agent/app/.server/agent.ts`의 `disposeAgent` 위에 함수를 더한다.

```ts
/**
 * Starts building the agent's services now, so the first request does not wait for all of it.
 * A failed build is not reported here: the first request gets that same failure.
 */
export function startAgent(): void {
  agent.runFork(Effect.void);
}
```

- `Effect`는 이 파일이 이미 import한다.
- `runFork`는 fiber를 돌려준다. Promise가 아니므로 실패해도 unhandled rejection이 나지 않는다.
  `runPromise`로 바꾸지 않는다.
- `let`이나 "이미 시작했는가" 플래그를 더하지 않는다. `ManagedRuntime`이 한 번만 만든다.

`apps/agent/app/entry.server.tsx:11`의 re-export에 `startAgent`를 더한다.

```ts
export { configureAgentBackend, disposeAgent, startAgent } from "./.server/agent.ts";
```

`server-build.d.ts`는 `typeof ServerEntry`를 쓰므로 고치지 않아도 타입이 따라온다.

**Verify**: 저장소 루트에서 `vp run agent#typecheck` → exit 0.

### Step 2: listen에 성공한 뒤에 부른다

`apps/agent/server/main.ts`에서 `await serve({ ... }).catch(...)`(299–325행) 바로 다음,
"실행 중입니다" 로그(327행) 앞에 한 줄을 넣는다.

```ts
// The page is about to ask: the agent's services start building now, not on that first request.
build.entry.module.startAgent();
```

- `serve` 앞에 두지 않는다. listen에 실패한 프로세스가 DB를 열면 안 된다.
- `--dev-backend`일 때만 부르지 않는다. 폴더 없이 띄운 앱도 같은 대기를 겪는다. 폴더를 주고
  띄운 앱은 곧바로 `pageFor`가 `/api`를 부르므로 달라지는 것이 없다.
- `await`하지 않는다. "실행 중입니다" 로그와 브라우저 열기가 runtime을 기다리면 안 된다.

**Verify**: `vp run agent#typecheck` → exit 0. `cd apps/agent && vp test --run server/serve.test.ts` → all pass.
`rg -n "startAgent" apps/agent/server/main.ts apps/agent/app` → `main.ts` 한 줄, `agent.ts` 한 줄, `entry.server.tsx` 한 줄.

### Step 3: 주석과 문서

- `apps/agent/app/.server/first-screen.ts:29-32`의 주석을 사실에 맞게 고친다. 바꾼 뒤의 뜻:
  서버는 listen 직후에 agent를 만들기 시작한다. 그 사이에 온 요청은 구성이 끝날 때까지
  기다리고, 페이지는 그것을 기다리지 않고 그린다. 값 `"500 millis"`는 그대로 둔다.
- `apps/agent/server/README.md` 43행과 65행 근처: `serve`가 listen에 성공하면 `startAgent`를
  부른다는 것, 기다리지 않는다는 것, 실패는 첫 요청이 받는다는 것.
- `apps/agent/app/README.md` 12행과 50행: re-export 목록에 `startAgent`.
- `docs/decisions.md` 끝에 항목을 더한다(한국어, 날짜 포함). 계기(위 표의 숫자), 결정(listen 뒤,
  기다리지 않음, 모든 시작 방식에 적용), 달라지는 것과 그에 대한 사용자 결정(아래 Maintenance
  notes의 첫 항목),
  줄지 않는 것. 만들어 낸 용어를 쓰지 않는다.

**Verify**: `rg -n "startAgent" apps/agent/server/README.md apps/agent/app/README.md docs/decisions.md` → 각 파일에서 한 줄 이상. `vp check` → exit 0.

### Step 4: 운영자에게 알린다

dev 백엔드는 dev를 시작할 때 한 번만 빌드된다. 최종 보고에 "dev를 다시 시작해야 반영된다"와
아래 "운영자가 확인할 것"의 명령을 적는다. 직접 재시작하지 않는다.

## Test plan

- 자동 테스트를 더하지 않는다. `main.ts`는 최상위 `await`로 도는 스크립트이고, `startAgent`를
  검증하려면 실제 runtime(네이티브 검색 worker, 임베딩 모델)을 만들어야 한다. 그 테스트는
  느리고 모델 캐시에 기댄다.
- 기존 `apps/agent/server/serve.test.ts`가 계속 통과해야 한다.
- 운영자가 확인할 것: dev를 다시 시작하고, **페이지를 열기 전에** 10초 기다린 뒤 아래를 돌린다.

  ```sh
  ls -t apps/agent/build/logs | head -1
  jq -s -r 'sort_by(.startUnixMs) | .[0] | "\(.name) \(.startUnixMs/1000|strftime("%H:%M:%S")) UTC"' apps/agent/build/dev-spans-5180.ndjson
  ```

  로그 파일 이름의 시각(UTC)과 첫 span의 시각이 몇 초 안이어야 한다. 바꾸기 전에는 페이지를
  열 때까지 span 파일이 비어 있었다(위 표의 60.1초). 그다음 페이지를 열어 첫 화면이 loader가
  채운 값으로 바로 그려지는지 본다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run server/serve.test.ts` exits 0
- [ ] `rg -n "startAgent\(\)" apps/agent/server/main.ts` 결과 한 줄이고, 그 줄이 `await serve(` 뒤에 있다
- [ ] `rg -n "runPromise" apps/agent/app/.server/agent.ts` 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다 (다른 세션의 수정은 건드리지 않는다)
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `main.ts`가 아닌 곳에서 서버를 띄우는 경로가 runtime을 listen 전에 만들기를 요구한다.
- `agent.runFork(Effect.void)`가 lint나 typecheck에 걸려 `let`, 플래그, lint 끄기 주석 없이는
  통과하지 않는다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 달라지는 동작: runtime과 함께 시작하는 백그라운드 일(가져오기 회차, 임베딩·rerank 모델 load,
  중단된 워크플로와 카드 run의 재개)이 "첫 요청 때"가 아니라 "백엔드 시작 때" 돈다. 페이지를
  열지 않고 백엔드만 띄워 둬도 돈다. 사용자가 2026-11-14에 이 동작이 맞다고 정했다:
  `Running`으로 둔 Goal은 페이지를 열지 않아도 돌아야 한다. `--dev-backend`로 좁히지 않는다.
- 리뷰에서 볼 곳: 호출이 `serve` 뒤에 있는가, `await`가 없는가.
- runtime 구성 5.6초 중 3.57초는 `NativeOwner.make`가 worker의 `Open`을 기다리는 시간이다
  (`packages/memory-agent/src/memory/native-search/client.ts:201`). 이것이 구성을 막지 않게 하면
  백엔드가 뜨고 곧바로 여는 경우도 빨라진다. 메모리 검색 재설계와 함께 볼 일이다.
- runtime이 준비된 뒤에도 첫 요청들은 느린 일을 한다. 같은 표본에서 `ProjectSkills.catalog`
  0.68초가 동시에 두 번, `SubscriptionQuota.accounts` 1.0초가 세 번 돌았다. 화면이 그려진 뒤의
  일이라 이 계획에서 다루지 않았다.
- Vite dev 서버의 첫 변환 시간은 재지 않았다. 이 계획 뒤에도 dev 직후가 느리면 그쪽을 먼저 잰다.
