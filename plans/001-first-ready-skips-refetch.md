# Plan 001: 첫 `ready`는 loader가 읽은 뒤로 바뀐 것이 없으면 다시 읽지 않는다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 01ae0dc1..HEAD -- packages/memory-agent/src/events packages/memory-agent/src/api/app-api/events.ts packages/memory-agent/tests/app-events.test.ts apps/agent/app/.server/api/events.ts apps/agent/app/.server/first-screen.ts apps/agent/app/routes/_index.tsx apps/agent/app/entry/events apps/agent/app/entry/index.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `01ae0dc1`, 2026-11-14 (2026-11-13에 `af1a8d16`에서 쓰고 줄 번호를 새로 맞췄다)

## Why this matters

첫 화면은 같은 데이터를 두 번 읽는다. SSR loader가 쿼리 13종을 읽어 HTML에 싣는다.
브라우저가 `/api/events` 스트림을 열면 첫 `ready`가 `["app"]` 아래 쿼리를 모두 무효화한다.
그래서 화면에 떠 있는 쿼리가 방금 받은 값을 다시 GET으로 읽는다. loader가 채우지 않은
쿼리(auth, accounts, quota, models)도 `ready`보다 먼저 마운트됐다면 한 번 더 읽는다.
이 쿼리들은 공급자와 원격 endpoint를 부른다.

이 계획 뒤에는 loader가 읽기 직전의 "기준점"(이벤트 서비스 시작 시각 + revision)을 함께
내려보낸다. 첫 `ready`의 기준점이 그것과 같으면 다시 읽지 않는다.

측정하지 않은 것: 중복 GET의 실제 개수와 시간. 코드로 확인한 것은 무효화 경로뿐이다.
이 재조회는 화면이 그려진 **뒤에** 일어난다. 줄어드는 것은 로드 직후의 서버 부하와
네트워크 요청이다. 첫 화면이 그려지기까지의 시간은 이 계획으로 줄지 않는다.

## Current state

### 관련 파일

- `packages/memory-agent/src/events/contracts.ts` — 이벤트 schema. `AppReadyEvent`는 revision만 가진다.
- `packages/memory-agent/src/events/app-events.ts` — 이벤트 서비스. revision 카운터와 스트림을 만든다.
- `packages/memory-agent/src/api/app-api/events.ts` — `AppApi`의 events group (SSE endpoint 3개).
- `apps/agent/app/.server/api/events.ts` — events group의 서버 handler.
- `apps/agent/app/.server/first-screen.ts` — SSR loader. 쿼리 13종을 채워 `dehydrate`한다.
- `apps/agent/app/routes/_index.tsx` — loader를 부르고 `HydrationBoundary`로 감싼다.
- `apps/agent/app/entry/events/invalidation.ts` — `ready`와 `changed`를 쿼리 무효화로 바꾼다.
- `apps/agent/app/entry/events/providers.tsx` — 스트림을 열고 invalidator를 만든다.
- `apps/agent/app/entry/index.tsx` — `App` 컴포넌트(164행)가 `AppEventsProvider`를 렌더한다(650행).

### 발췌

`packages/memory-agent/src/events/contracts.ts:33,58-60`:

```ts
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
// ...
/** The revision a stream starts after: the page reloads what it read before it. */
export const AppReadyEvent = Schema.Struct({ revision: Revision });
export type AppReadyEvent = typeof AppReadyEvent.Type;
```

`packages/memory-agent/src/events/app-events.ts:68-70,87-96,106,136`:

```ts
  const changes = yield* PubSub.unbounded<AppChangedEvent>();
  // Numbered and published under one lock, so every subscriber gets the events in revision order.
  const revision = yield* SynchronizedRef.make(0);
// ...
  const stream = Effect.fnUntraced(function* (accepts: (event: AppChangedEvent) => boolean) {
    // Subscribed before the stream is handed over, so an event published right after it is not
    // lost; subscribing and reading the revision the page starts from take the publishing lock.
    const subscribed = yield* Scope.make();
    const [subscription, current] = yield* SynchronizedRef.modifyEffect(revision, (current) =>
// ...
    return Stream.succeed<AppEventFrame>({ event: "ready", data: { revision: current } }).pipe(
// ...
    revision: SynchronizedRef.get(revision),
```

revision은 프로세스 메모리 값이다. 백엔드를 다시 시작하면 0부터 다시 센다.

`packages/memory-agent/src/api/app-api/events.ts:13-29` — group은 `all`, `project`, `session`
SSE endpoint 3개를 가지고 `.middleware(NoStore)`를 건다.

`apps/agent/app/.server/api/events.ts:12-16`:

```ts
return handlers.handleAll({
  all: () => events.allStream,
  project: ({ params: { project } }) => events.projectStream(project),
  session: ({ params: { session } }) => events.sessionStream(session),
});
```

`apps/agent/app/.server/first-screen.ts:33,61-65,108-128`:

```ts
const firstScreenDeadline = "500 millis";
// ...
export const firstScreen = (url: URL) =>
  loaderRuntime.runPromise(
    Effect.gen(function* () {
      const { client: app, fetch } = yield* appApi;
      const cache = new QueryClient();
// ...
      yield* apart([
        fill(globalQueries.projects().queryKey, app.projects.list({ query: {} })).pipe(
// ...
      ]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.timeout(firstScreenDeadline),
        Effect.ignore,
      );
      return dehydrate(cache);
    }).pipe(Effect.catchCause(() => Effect.succeed(null))),
  );
```

`apps/agent/app/routes/_index.tsx:12,18,20-26`:

```tsx
export const loader = ({ request }: Route.LoaderArgs) => firstScreen(new URL(request.url));
// ...
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export default function Agent({ loaderData }: Route.ComponentProps) {
  return (
    <HydrationBoundary state={loaderData}>
      <App />
    </HydrationBoundary>
  );
}
```

`apps/agent/app/entry/events/invalidation.ts:13-29`:

```ts
function createEventInvalidatorBody(invalidate: (key: QueryKey) => void, root: QueryKey) {
  let revision: number | null = null;

  return {
    ready(nextRevision: number) {
      // The first ready closes the initial query/subscription gap. Later ready events
      // only need repair if the stream missed a revision while disconnected.
      if (revision === null || revision !== nextRevision) invalidate(root);
      revision = nextRevision;
    },
    changed(event: AppChangedEvent) {
      if (revision !== null && event.revision <= revision) return;
      revision = event.revision;
      for (const key of invalidationKeys(event)) invalidate(key);
    },
  };
}
```

`apps/agent/app/entry/events/providers.tsx:15-39,113-115`:

```tsx
function useScopedEvents(
  url: string | null,
  readyKey: readonly unknown[],
  onStatus: (state: EventConnection) => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isTruthy(url)) return;
    const invalidations = createEventInvalidator(
      (queryKey) => void queryClient.invalidateQueries({ queryKey }),
      readyKey,
    );
// ...
        onReady: (event) => invalidations.ready(event.revision),
// ...
export function AppEventsProvider({ children }: PropsWithChildren) {
  const [connection, setConnection] = useState<EventConnection>({ _tag: "connecting" });
  useScopedEvents("/api/events", appQueryKeys.root, setConnection);
```

### 지켜야 할 설계

- `docs/app-state-streams.md:13,45-47`: REST가 기준이고 이벤트는 힌트다. `ready`는 "읽은 시점과
  스트림을 연 시점 사이의 틈", "끊긴 동안 놓친 변경", "백엔드 재시작"을 전체 재조회로 메운다.
  이 계획은 **틈에 변경이 없었다는 것을 확인할 수 있을 때만** 재조회를 건너뛴다. 나머지 경우는
  지금처럼 다시 읽는다.
- `apps/agent/app/entry/queries/README.md:38`: "staleTime 0인 query는 채운 값을 먼저 보이고
  마운트할 때 다시 읽는다." loader가 채우는 13종 중 `session.kanban`, `project.decisions`,
  `project.boards`가 staleTime 0이다. 이 셋은 이 계획 뒤에도 마운트 때 다시 읽는다. 바꾸지 않는다.
- 저장소 규칙은 루트 `AGENTS.md`와 `CLAUDE.md`에 있다. 시작 전에 읽는다. 특히: `let`/`while`을
  새로 쓰지 않는다(이 파일에 이미 있는 `let`은 그대로 둔다), lint 끄는 주석을 쓰지 않는다,
  줄바꿈만 바꾸는 수정은 하지 않는다(포매터가 한다), 코드 주석은 영어로 쓴다.

### 왜 revision만으로는 부족한가

revision은 재시작하면 0으로 돌아간다. loader가 프로세스 A에서 revision 0을 읽고, A가 변경을
쓴 뒤 재시작해 스트림이 프로세스 B의 revision 0을 받으면 번호는 같지만 변경을 놓친다. 그래서
기준점은 **이벤트 서비스가 시작한 시각(epoch ms)과 revision의 쌍**이다. 시작 시각이 다르면
다른 프로세스다.

uuid 대신 시작 시각을 쓰는 이유: `makeAppEvents`와 `AppEvents.layer`가 요구하는 서비스가
늘지 않는다(`Clock`은 기본 제공이다). uuid는 `SecureRandom`을 layer 네 곳에 새로 연결해야 한다.

## Commands you will need

| Purpose                | Command                                                                                | Expected on success                   |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| 이벤트 서비스 테스트   | `cd packages/memory-agent && vp test --run --project feature tests/app-events.test.ts` | all pass (계획 작성 때 4 passed 확인) |
| invalidator 테스트     | `cd apps/agent && vp test --run app/entry/events/invalidation.test.ts`                 | all pass (계획 작성 때 2 passed 확인) |
| memory-agent typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                                        | exit 0, 경고 없음                     |
| agent typecheck        | 저장소 루트에서 `vp run agent#typecheck`                                               | exit 0                                |
| 포맷·lint              | 저장소 루트에서 `vp check`                                                             | exit 0                                |

- 단계마다 건드린 테스트만 돌린다. 전체 suite는 돌리지 않는다.
- lint는 저장소 루트에서 돌린다. 패키지 안에서 돌리면 pre-commit hook이 보는 규칙 일부가 빠진다.

## Scope

**In scope**:

- `packages/memory-agent/src/events/contracts.ts`
- `packages/memory-agent/src/events/app-events.ts`
- `packages/memory-agent/src/events/README.md`
- `packages/memory-agent/src/api/app-api/events.ts`
- `packages/memory-agent/src/api/app-api.ts` (새 schema를 re-export할 때만, 108행 근처)
- `packages/memory-agent/tests/app-events.test.ts`
- `apps/agent/app/.server/api/events.ts`
- `apps/agent/app/.server/first-screen.ts`
- `apps/agent/app/routes/_index.tsx`, `apps/agent/app/routes/README.md`
- `apps/agent/app/entry/index.tsx` (`App`의 prop과 `AppEventsProvider`에 넘기는 부분만)
- `apps/agent/app/entry/events/invalidation.ts`, `invalidation.test.ts`, `providers.tsx`
- `ready` 프레임의 data를 `{ revision: N }`으로 적어 둔 다른 테스트 (3단계의 grep으로 찾는다)
- `docs/app-state-streams.md` (13행, 45–47행의 `ready` 설명만)

**Out of scope**:

- 쿼리들의 `staleTime`과 `refetchOnMount` — README에 적힌 의도된 동작이다.
- `apps/agent/app/entry/events/event-source.ts`의 재연결 로직 — schema가 바뀌면 decode는 따라온다.
- `apps/agent/app/entry/events/query-keys.ts`의 topic → key 표.
- `project`·`session` 스트림(`projectStream`, `sessionStream`)을 쓰는 화면을 새로 만들지 않는다.
- 요청 묶기(coalescing) 재도입 — 별개의 결정이다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 `git add <path>`로 올린다.
- 단계마다 commit한다. 각 commit은 빌드와 typecheck를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `perf(workflow): update_goal도 Goal 본문 대신 저장된 버전만 돌려준다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 기준점 schema와 이벤트 서비스

`packages/memory-agent/src/events/contracts.ts`:

- `AppSyncPoint`를 더한다: `Schema.Struct({ startedAt: <0 이상 정수>, revision: Revision })`.
  주석으로 뜻을 적는다: 이 이벤트 서비스가 시작한 시각과, 그 뒤로 발행한 변경의 수.
- `AppReadyEvent`를 `AppSyncPoint`와 같은 모양으로 바꾼다(`startedAt` 필수).

`packages/memory-agent/src/events/app-events.ts`:

- `make` 안에서 revision을 만들 때 `Clock.currentTimeMillis`로 `startedAt`을 한 번 읽는다.
- `ready` 프레임의 data를 `{ startedAt, revision: current }`로 바꾼다.
- `AppEventsApi`에 `readonly syncPoint: Effect.Effect<AppSyncPoint>`를 더한다. 값은
  `{ startedAt, revision: <지금 revision> }`이다. 기존 `revision` 필드는 그대로 둔다.

`packages/memory-agent/tests/app-events.test.ts`:

- `ready` 기대값(42, 80, 111, 129행 근처)에 `startedAt`을 넣는다. 테스트의 clock이 주는 값을 쓴다.
- 테스트를 더한다: `syncPoint`가 새 스트림의 첫 `ready` data와 같다. 한 번 publish한 뒤에는
  `revision`만 1 늘고 `startedAt`은 같다.

**Verify**: `cd packages/memory-agent && vp test --run --project feature tests/app-events.test.ts` → all pass.
저장소 루트에서 `vp run memory-agent#typecheck` → exit 0.

### Step 2: 기준점 endpoint

`packages/memory-agent/src/api/app-api/events.ts`의 `EventsGroup`에 endpoint를 더한다:

```ts
/** Where the page's first read stands: compared with the first `ready` of its stream. */
HttpApiEndpoint.get("syncPoint", "/api/events/sync-point", { success: AppSyncPoint }),
```

`apps/agent/app/.server/api/events.ts`의 `handleAll`에 `syncPoint: () => events.syncPoint`를 더한다.

페이지가 타입을 쓰도록 `packages/memory-agent/src/api/app-api.ts`의 re-export(108행,
`AppChangedEvent, AppReadyEvent`)에 `AppSyncPoint`를 더한다.

**Verify**: 저장소 루트에서 `vp run memory-agent#typecheck` → exit 0, `vp run agent#typecheck` → exit 0.

### Step 3: invalidator가 시작 기준점을 받는다

`apps/agent/app/entry/events/invalidation.ts`:

- `createEventInvalidator`가 세 번째 값 `current: AppSyncPoint | null`을 받는다. 지금은
  `EffectFunction.dual(2, ...)`이므로 `dual(3, ...)`으로 바꾸고 data-last 형태의 타입도 맞춘다.
  호출부는 `rg -n "createEventInvalidator" apps/agent`로 모두 찾아 고친다.
- 내부 상태는 `startedAt`과 `revision` 둘이다. 시작값은 `current`에서 온다(없으면 둘 다 `null`).
- `ready(next: AppReadyEvent)`: `revision === null`이거나 `startedAt !== next.startedAt`이거나
  `revision !== next.revision`이면 `invalidate(root)`. 그 뒤 둘 다 `next`의 값으로 바꾼다.
- `changed`는 지금 그대로다(revision만 본다).
- 주석을 고친다: 첫 `ready`는 loader의 기준점과 같으면 아무것도 하지 않는다. 기준점이 없거나
  다르면 틈을 메우려고 전체를 다시 읽는다.

`apps/agent/app/entry/events/invalidation.test.ts`에 테스트를 더하고 기존 호출을 새 모양으로 고친다:

1. 기준점 없이 시작 → 첫 `ready`가 root를 무효화한다 (기존 테스트).
2. 기준점 `{ startedAt: 5, revision: 3 }`로 시작, `ready({ startedAt: 5, revision: 3 })` → 무효화하지 않는다.
3. 같은 시작, `ready({ startedAt: 5, revision: 4 })` → root를 무효화한다.
4. 같은 시작, `ready({ startedAt: 9, revision: 3 })` → root를 무효화한다 (재시작).
5. `ready`를 한 번 받은 뒤 같은 revision에 다른 `startedAt`의 `ready` → root를 무효화한다.
6. 2번 뒤에 revision 3 이하의 `changed`는 무시하고, 4는 해당 key를 무효화한다.

`ready` data를 `{ revision: N }`으로 쓰는 다른 테스트를 찾아 `startedAt`을 넣는다:
`rg -n "revision" apps/agent/app apps/agent/server -g '*.test.*' -g '*.browser.*'`

**Verify**: `cd apps/agent && vp test --run app/entry/events/invalidation.test.ts` → all pass (새 테스트 5개 포함).

### Step 4: loader가 기준점을 먼저 읽어 내려보낸다

`apps/agent/app/.server/first-screen.ts`:

- 쿼리를 채우기 **전에** `app.events.syncPoint()`를 읽는다. 순서가 핵심이다. 읽는 도중의 변경은
  revision을 올리므로 첫 `ready`와 달라져 재조회가 일어난다. 순서를 바꾸면 변경을 놓친다.
  이 이유를 주석으로 남긴다.
- 기준점 읽기는 기존 500 ms 기한 안에 든다. 기한을 늘리거나 두 번 주지 않는다.
- 기준점 읽기가 실패해도 쿼리 채우기는 그대로 한다. 그때 기준점은 `null`이다.
- 기한이 채우는 도중에 끝나도 이미 읽은 기준점은 내려보낸다. `cache`가 부수 효과로 채워지는
  것과 같은 방식으로 `Ref`에 담아 두고 끝에서 읽으면 된다.
- 반환값을 `{ state: dehydrate(cache), syncPoint }`로 바꾼다. `catchCause` 쪽은
  `{ state: null, syncPoint: null }`을 돌려준다. `syncPoint`는 숫자 둘의 객체 또는 `null`이라
  파일의 `Plain` 조건(turbo-stream이 그대로 옮기는 값)을 지킨다.

`apps/agent/app/routes/_index.tsx`: `<HydrationBoundary state={loaderData.state}>`,
`<App syncPoint={loaderData.syncPoint} />`.

`apps/agent/app/entry/index.tsx`: `App`이 `syncPoint: AppSyncPoint | null` prop을 받아
`<AppEventsProvider syncPoint={syncPoint}>`로 넘긴다. `App`을 쓰는 다른 곳은
`rg -n "<App\b" apps/agent/app`로 찾아 `syncPoint={null}`을 준다.

`apps/agent/app/entry/events/providers.tsx`: `AppEventsProvider`와 `useScopedEvents`가 기준점을
받아 `createEventInvalidator`에 넘긴다. `onReady`는 `invalidations.ready(event)`가 된다.
`useEffect`의 deps에는 객체 대신 숫자 둘(`startedAt`, `revision`, 없으면 `null`)을 넣는다.
loaderData의 객체 identity가 바뀔 때 스트림을 다시 열지 않게 하려는 것이다.

**Verify**: 저장소 루트에서 `vp run agent#typecheck` → exit 0, `vp check` → exit 0.
`cd apps/agent && vp test --run app/entry/events` → all pass.

### Step 5: 문서

- `docs/app-state-streams.md` 13행과 45–47행: `ready`가 기준점(`startedAt`, `revision`)을 싣고,
  페이지가 가진 기준점과 같으면 다시 읽지 않는다고 고친다. 재시작은 `startedAt`으로 구분한다.
- `packages/memory-agent/src/events/README.md`: `AppSyncPoint`, `syncPoint`, `ready`의 새 data.
- `apps/agent/app/routes/README.md` 9행 근처: loader가 기준점도 돌려준다.
- `docs/decisions.md` 끝에 항목을 더한다(한국어, 날짜 포함). 계기, 결정(기준점 쌍, 순서),
  측정하지 않은 것을 적는다. 만들어 낸 용어를 쓰지 않는다.

**Verify**: `rg -n "sync-point|syncPoint|AppSyncPoint" docs packages/memory-agent/src/events/README.md apps/agent/app/routes/README.md` → 각 파일에서 한 줄 이상.

### Step 6: 운영자에게 알린다

dev 백엔드는 dev를 시작할 때 한 번만 빌드된다. 이 변경이 들어간 뒤 dev를 다시 시작하기
전에는 옛 백엔드가 `startedAt` 없는 `ready`를 보낸다. 새 페이지는 그 `ready`를 decode하지
못해 버린다. 최종 보고에 "dev를 다시 시작해야 한다"를 적는다. 직접 재시작하지 않는다.

## Test plan

- `apps/agent/app/entry/events/invalidation.test.ts`: Step 3의 6개 경우.
- `packages/memory-agent/tests/app-events.test.ts`: `syncPoint`와 첫 `ready`의 일치, publish 뒤의 값.
- `first-screen.ts`는 기존 테스트가 없다. 읽는 순서는 typecheck로 잡히지 않으므로 주석과
  리뷰로 지킨다 (Maintenance notes 참고).
- 운영자가 손으로 확인할 것(선택): dev를 다시 시작하고 페이지를 새로 연다. 브라우저 Network에서
  로드 뒤 2초 동안의 `/api/` GET 수를 바꾸기 전과 견준다. 바꾼 뒤에는 `sessions`, `agents`,
  `skills`, `queue`, `subagents`, `approvals`, `trace`가 한 번씩만 보여야 한다.

## Done criteria

- [ ] `cd packages/memory-agent && vp test --run --project feature tests/app-events.test.ts` exits 0
- [ ] `cd apps/agent && vp test --run app/entry/events` exits 0, 새 invalidator 테스트 5개 포함
- [ ] 저장소 루트에서 `vp run memory-agent#typecheck`, `vp run agent#typecheck`, `vp check` 모두 exit 0
- [ ] `rg -n "ready\(event\.revision\)" apps/agent/app` 결과 없음
- [ ] `rg -n "sync-point" packages/memory-agent/src/api/app-api/events.ts` 결과 한 줄
- [ ] `git status --short`에 In scope 밖의 수정이 없다 (다른 세션의 수정은 건드리지 않는다)
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `EventsGroup`에 일반 GET endpoint를 더했을 때 SSE endpoint와 타입이나 middleware가 충돌한다.
- loader에서 기준점을 쿼리보다 먼저 읽으려면 500 ms 기한을 늘려야 한다.
- `App`이 `_index.tsx` 밖에서도 loader 없이 쓰이고, 거기서 `null`을 주면 동작이 달라진다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 리뷰에서 볼 곳: `first-screen.ts`에서 기준점을 쿼리보다 **먼저** 읽는가. 순서가 뒤집히면
  읽는 도중의 변경을 조용히 놓친다.
- 이벤트를 발행하지 않는 쓰기는 이 계획 전에도 로드 뒤에는 화면에 오지 않았다. 달라지는 것은
  로드 직후 약 1초 동안의 쓰기뿐이다. 새 쓰기 경로를 만들 때 이벤트 발행을 빠뜨리지 않는다.
- staleTime 0 쿼리 3종(`session.kanban`, `project.decisions`, `project.boards`)은 여전히 두 번
  읽는다. 이것까지 없애려면 README의 "마운트할 때 다시 읽는다"는 의도를 바꿔야 한다.
- 이 계획은 첫 화면이 그려지기까지의 시간을 줄이지 않는다. 그 시간은 백엔드 runtime을 첫
  `/api` 요청에서 만드는 것(`apps/agent/app/.server/agent.ts:59`)과 첫 화면 JS 크기 쪽을
  따로 재야 한다.
