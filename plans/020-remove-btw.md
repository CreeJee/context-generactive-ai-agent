# Plan 020: BTW 곁질문 기능을 없앤다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. `plans/README.md`는 고치지 않는다(검토자가 고친다).
>
> **Drift check (먼저 실행)**:
> `git diff --stat 510b0aed HEAD -- apps packages .agents`
> 출력이 비어 있어야 한다(코드는 `510b0aed`와 같고 `docs/decisions.md`만 다르다). 출력이 있으면
> "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (서버의 API 계약과 서비스 묶음에서 한 묶음을 뺀다. 파일 삭제가 많다)
- **Depends on**: 004–019가 모두 들어간 브랜치
- **Category**: 기능 정리
- **Planned at**: commit `510b0aed`의 코드, 2026-11-16

## Why this matters

BTW는 열린 대화 옆에서 따로 묻는 곁질문 패널이다. 대화 헤더의 BTW 버튼으로 연다. 질문과 답은 그
대화의 기록에 들어가지 않고 따로 저장된다. 사용자는 "다른 대화에서 묻는 것과 비슷하다"고 보았고
2026-11-16에 이 기능을 정리하라고 정했다. 사용자의 로컬 DB에는 BTW 스레드가 2개, BTW에 붙인 이미지가
0개 있다(2026-11-16에 읽기 전용으로 센 값).

이 계획은 BTW의 화면, API 경로, 서버 서비스, 그 테스트를 지운다. **DB의 표와 옛 migration은 그대로
둔다.** 표를 지우면 저장된 스레드를 되살릴 수 없다. 표를 지울지는 사용자가 따로 정한다.

## Current state

경로는 저장소 루트 기준이다.

### 통째로 지울 파일

| 파일                                              | 줄 수 | 하는 일                                              |
| ------------------------------------------------- | ----- | ---------------------------------------------------- |
| `apps/agent/app/entry/chat/btw-panel.tsx`         | 414   | BTW 패널과 헤더의 BTW 버튼                           |
| `apps/agent/app/entry/chat/btw-panel.browser.tsx` | 111   | 그 브라우저 테스트                                   |
| `apps/agent/app/entry/chat/use-btw-thread.ts`     | 47    | 스레드 하나의 훅                                     |
| `apps/agent/app/.server/api/btw.ts`               | 37    | 앱 API의 `btw` 그룹 handler(`BtwThreadsApiHandlers`) |
| `packages/memory-agent/src/btw/chat.ts`           | 282   | `BtwChat` 서비스                                     |
| `packages/memory-agent/src/btw/context.ts`        | 64    | BTW run에 줄 대화 맥락                               |
| `packages/memory-agent/src/btw/contracts.ts`      | 59    | `BtwThread`, `btwToolNames`                          |
| `packages/memory-agent/src/btw/store.ts`          | 215   | `BtwThreads` 저장 서비스                             |
| `packages/memory-agent/src/btw/tools.ts`          | 34    | BTW run의 도구 묶음                                  |
| `packages/memory-agent/src/btw/README.md`         |       | 디렉터리 문서                                        |
| `packages/memory-agent/src/api/btw-thread.ts`     | 78    | 페이지 쪽 Atom 묶음(`btwThreads`)                    |
| `packages/memory-agent/src/api/app-api/btw.ts`    | 54    | 앱 API의 `BtwThreadsGroup`, `btwRefusals`            |
| `packages/memory-agent/tests/btw/threads.test.ts` | 224   | BTW 서비스 테스트                                    |

### 화면이 BTW를 쓰는 곳

`apps/agent/app/entry/index.tsx:104`

```ts
import { BtwPanel } from "./chat/btw-panel";
```

`apps/agent/app/entry/index.tsx:621-627`

```tsx
<ChatHeader
  title={openSession === null ? t`제목 없는 대화` : sessionLabel(hydrated)(openSession)}
  projectName={projects.find((item) => item.id === openProjectId)?.name ?? null}
>
  {selection && <BtwPanel key={id} projectId={openProjectId} sessionId={id} />}
  <WorkTracePanel key={id} projectId={openProjectId} sessionId={id} />
</ChatHeader>
```

`apps/agent/app/entry/chat/chat-header.tsx:13`

```tsx
  /** The buttons at the header's end: BTW and Work Trace. */
  readonly children: ReactNode;
```

`apps/agent/app/entry/api.ts:706-710` (같은 파일 54행과 208행에 `BtwThread` 이름이 한 번씩 더 있다)

```ts
  btwThreads: (session: string) => appCall((client) => client.btw.list({ params: { session } })),
  /** A new BTW thread bound for good to this conversation. */
  createBtw: (session: string) => appCall((client) => client.btw.create({ params: { session } })),
  /** `filesPending`: the rows are gone, some unreferenced image files wait for the next cleanup. */
  deleteBtw: (thread: string) => appCall((client) => client.btw.remove({ params: { thread } })),
```

`apps/agent/app/entry/queries/session.ts:62-66`

```ts
  btw: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.btw(projectId, sessionId),
      queryFn: () => api.btwThreads(sessionId),
    }),
```

`apps/agent/app/entry/queries/keys.ts:57-58`

```ts
    btw: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "btw"] as const,
```

`apps/agent/vite.browser.config.ts:27`

```ts
      "apps/agent/app/entry/chat/btw-panel.browser.tsx",
```

`apps/agent/app/entry/chat/refusals.ts:17`

```ts
  btw_not_found: msg`이 BTW는 삭제되었습니다.`,
```

`apps/agent/app/entry/chat/chat-runtime.ts:11`의 주석에 "its sessions and BTW threads"라는 말이 있다.

### 서버가 BTW를 묶는 곳

`packages/memory-agent/src/api/chat-api.ts:41-46`

```ts
const NotFound = chatRefusal(404, [
  "session_not_found",
  "project_not_found",
  "run_not_found",
  "btw_not_found",
]);
```

`packages/memory-agent/src/api/chat-api.ts:260-284`: `BtwQuestion`, `BtwGroup`(`/api/btw/:thread/messages`,
`/api/btw/:thread/runs`), 그리고 마지막 줄.

```ts
export class ChatApi extends HttpApi.make("chat").add(ChatGroup).add(BtwGroup) {}
```

`packages/memory-agent/src/api/chat-api-live.ts:4`, `:41-80`

```ts
import { BtwChat } from "../btw/chat.ts";
```

```ts
const refusedWith = (refusal: Refusal) => Effect.succeed(Result.fail(refusal));
const providerRefusal = ({ provider }: { readonly provider: string }) =>
  refusedWith({ error: "provider_unavailable", provider });
const btwNotFound = () => refusedWith({ error: "btw_not_found" });

/** The BTW group of `ChatApi`, on `BtwChat`. A BTW run's events are numbered from its start. */
export const BtwApiHandlers = HttpApiBuilder.group(
  ChatApi,
  "btw",
  // … 80행의 `);`까지
```

`refusedWith`, `providerRefusal`, `btwNotFound`, `Result` import는 `BtwApiHandlers`만 쓰는지 확인한 뒤
안 쓰이면 함께 지운다. 그 위의 `refused`, `sessionNotFound`, `providerUnavailable`은 chat 그룹이 쓴다.

`packages/memory-agent/src/api/app-api.ts:3`, `:27`, `:40`

```ts
import { BtwThreadsGroup, btwRefusals } from "./app-api/btw.ts";
```

```ts
  .add(BtwThreadsGroup)
```

```ts
  ...btwRefusals,
```

`packages/memory-agent/src/index.ts:26`, `:342-343`

```ts
export { BtwApiHandlers, ChatApiHandlers } from "./api/chat-api-live.ts";
```

```ts
export { BtwChat } from "./btw/chat.ts";
export { BtwThread, btwToolNames } from "./btw/contracts.ts";
```

`packages/memory-agent/src/layers.ts:16`, `:442`

```ts
import { BtwChat } from "./btw/chat.ts";
```

```ts
        MemoryTools.layer,
        BtwChat.layer,
```

`packages/memory-agent/package.json:44`

```json
    "./btw-thread": "./src/api/btw-thread.ts",
```

`apps/agent/app/.server/api.ts:10`, `:14`, `:45-50`, `:66`

```ts
import { type AgentChat, BtwApiHandlers, type BtwChat, ChatApiHandlers } from "memory-agent";
```

```ts
import { BtwThreadsApiHandlers } from "./api/btw.ts";
```

```ts
export const chatApiRoutes = <E>(
  services: Effect.Effect<Context.Context<AgentChat | BtwChat>, E>,
) =>
  HttpApiBuilder.layer(ChatApi).pipe(
    Layer.provide(Layer.merge(ChatApiHandlers, BtwApiHandlers)),
```

```ts
      BtwThreadsApiHandlers,
```

### 테스트 도우미가 BTW를 쓰는 곳

- `packages/memory-agent/tests/support/chat-api.ts:6-7`, `:20-31`: `btwApi`와 그것만 쓰는 import
  (`BtwApiHandlers`, `BtwChat`, 그리고 `btwApi`만 쓴다면 `HttpServer`, `HttpApiTest`, `ChatApi`, `SameSite`,
  `Layer`, `sameSite`, `TestEnv`). `chatApi`는 남긴다.
- `packages/memory-agent/tests/agents/app-fetch.ts:9-10`, `:32`, `:37`: `BtwApiHandlers`, `BtwChat`,
  `Effect.context<AgentChat | BtwChat>()`, `Layer.merge(ChatApiHandlers, BtwApiHandlers)`.
- `packages/memory-agent/tests/fixtures/goal-owner-process.mts:20`, `:109`: `BtwApiHandlers` import와
  `Layer.merge(ChatApiHandlers, BtwApiHandlers)`.

### 남기는 것 (고치지 않는다)

- `packages/memory-agent/src/db/migrations.ts`의 BTW 표 정의와 `btwThreadMessagesMigration`. 옛 DB가
  지금 판으로 올라오는 길이다.
- `packages/memory-agent/src/chat-store/tanstack-migration.ts`의 `btw_threads` 읽기와 쓰기.
- `packages/memory-agent/src/attachments/attachments.ts:149`의 `btw_attachments` 조건. 표가 남아 있는 동안
  그 표가 가리키는 첨부를 지우지 않는다.
- `packages/memory-agent/tests/btw-thread-messages-migration.test.ts`, `tests/tanstack-rows-migration.test.ts`,
  `tests/fixtures/release-0.0.17.sql`. migration의 테스트다.
- `pnpm-lock.yaml`. 그 안의 `btw`는 우연히 겹친 글자다.
- `docs/` 아래의 옛 문서(`effect-ai-migration.md`, `httpapi-migration.md`, `designs/`). 그때의 기록이다.

### 저장소 규칙

- 지워서 안 쓰이게 된 import, 변수, 타입은 함께 지운다. lint 끄기 주석을 쓰지 않는다.
- `let`, `while`, `unknown`을 쓰지 않는다. 이 계획은 새 코드를 거의 쓰지 않는다.
- 화면 문구는 Lingui 메시지다. 문구가 사라지면 catalog를 다시 뽑아야 commit hook이 통과한다.
- 줄바꿈과 들여쓰기는 손으로 고치지 않는다. `vp check --fix`가 맡는다.
- 문서는 한국어 평서문으로 쓴다.

## Commands you will need

| Purpose           | Command                                                                                               | Expected on success                          |
| ----------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                              | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| 서버 typecheck    | 저장소 루트에서 `vp run memory-agent#typecheck`                                                       | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                            | exit 0                                       |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                           | `ko.po`가 바뀐다                             |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`와 `vp run memory-agent#i18n:check`                          | exit 0                                       |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`                  | exit 0                                       |
| agent 단위 테스트 | `cd apps/agent && vp test --run app`                                                                  | all pass                                     |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/` | all pass                                     |
| 서버 테스트       | `cd packages/memory-agent && vp test --run <파일들>`                                                  | all pass                                     |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 새 worktree에서는 먼저 `pnpm install --frozen-lockfile`을 한다. `./+types/*`를 못 찾는 오류가 나면
  `apps/agent`에서 `react-router typegen`을 한다. 서버 테스트가 `NativeOwnerFailed: native-incompatible`로
  건너뛰면 저장소 루트에서 `vp run turbovec#build`를 한다.
- `memory-agent#i18n:check`가 실패하면 `packages/memory-agent/package.json`의 scripts에서 추출 명령의
  이름을 찾아 돌린다.
- 브라우저 테스트가 브라우저를 띄우지 못하면 그 사실을 보고에 적고 넘어간다. STOP이 아니다. 처음
  실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다.

## Scope

**In scope**: "Current state"의 "통째로 지울 파일", "화면이 BTW를 쓰는 곳", "서버가 BTW를 묶는 곳",
"테스트 도우미가 BTW를 쓰는 곳"에 적은 파일. 그리고 Step 3의 문서 파일, `apps/agent/app/locales/ko.po`
(추출 명령이 고친다), 서버 문구 catalog(추출 명령이 고칠 때만).

**Out of scope**:

- "남기는 것"에 적은 파일 전부.
- DB 표를 지우는 migration. 사용자가 따로 정한다.
- Work Trace 패널, 대화 헤더의 모양, 대기열.
- BTW가 쓰던 공용 코드(`loop/`, `tools/memory.ts`, `attachments/model-images.ts` 등). 다른 곳도 쓴다.
  고치지 않는다.

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않는다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다. 지운 파일은 `git rm`으로 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다. commit hook이 문구
  catalog를 검사하므로, 화면 문구가 사라지는 commit에는 추출한 `ko.po`를 함께 올린다.
- 메시지는 한국어 conventional commit이다. 예: `refactor(chat): BTW 곁질문 패널을 없앤다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1. 화면에서 BTW를 뺀다

1. `git rm`으로 `apps/agent/app/entry/chat/btw-panel.tsx`, `btw-panel.browser.tsx`, `use-btw-thread.ts`를
   지운다.
2. `apps/agent/app/entry/index.tsx`에서 `BtwPanel` import와 `{selection && <BtwPanel … />}` 줄을 지운다.
   `<WorkTracePanel … />`은 그대로 둔다.
3. `apps/agent/app/entry/chat/chat-header.tsx:13`의 주석을 `/** The buttons at the header's end: Work Trace. */`로
   바꾼다.
4. `apps/agent/app/entry/api.ts`에서 `btwThreads`, `createBtw`, `deleteBtw`와 그 주석을 지운다. 54행과
   208행의 `BtwThread`가 그 뒤 안 쓰이면 지운다.
5. `apps/agent/app/entry/queries/session.ts`의 `btw` 항목과 `queries/keys.ts`의 `btw` 항목을 지운다.
6. `apps/agent/vite.browser.config.ts:27`의 `btw-panel.browser.tsx` 줄을 지운다.
7. `apps/agent/app/entry/chat/chat-runtime.ts:11`의 주석에서 "and BTW threads"를 뺀다.
8. `vp run agent#i18n:extract`를 돌린다.

`refusals.ts`의 `btw_not_found`는 이 단계에서 건드리지 않는다. 서버가 아직 그 코드를 가지고 있다.

**Verify**:

- `vp run agent#typecheck` → 오류와 경고 없음.
- `vp check` → exit 0.
- `vp run agent#i18n:check` → exit 0.
- `cd apps/agent && vp test --run app` → all pass.
- `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/` → all pass.

commit한다.

### Step 2. 서버에서 BTW를 뺀다

1. `git rm`으로 `packages/memory-agent/src/btw/`의 파일 전부, `packages/memory-agent/src/api/btw-thread.ts`,
   `packages/memory-agent/src/api/app-api/btw.ts`, `apps/agent/app/.server/api/btw.ts`,
   `packages/memory-agent/tests/btw/threads.test.ts`를 지운다.
2. `packages/memory-agent/src/api/chat-api.ts`: `BtwQuestion`(값과 타입), `BtwGroup`, `.add(BtwGroup)`,
   `NotFound` 목록의 `"btw_not_found"`를 지운다. 그 뒤 안 쓰이는 import를 지운다.
3. `packages/memory-agent/src/api/chat-api-live.ts`: `BtwChat` import, `btwNotFound`, `BtwApiHandlers`를
   지운다. `refusedWith`, `providerRefusal`, `Result`가 그 뒤 안 쓰이면 지운다.
4. `packages/memory-agent/src/api/app-api.ts`: `./app-api/btw.ts` import, `.add(BtwThreadsGroup)`,
   `...btwRefusals`를 지운다.
5. `packages/memory-agent/src/index.ts`: 26행을 `export { ChatApiHandlers } from "./api/chat-api-live.ts";`로
   바꾸고 342–343행을 지운다.
6. `packages/memory-agent/src/layers.ts`: `BtwChat` import와 `BtwChat.layer,` 줄을 지운다.
7. `packages/memory-agent/package.json`: `"./btw-thread"` 줄을 지운다.
8. `apps/agent/app/.server/api.ts`: 10행을 `import { type AgentChat, ChatApiHandlers } from "memory-agent";`로,
   `Context.Context<AgentChat | BtwChat>`를 `Context.Context<AgentChat>`로,
   `Layer.merge(ChatApiHandlers, BtwApiHandlers)`를 `ChatApiHandlers`로 바꾼다. `./api/btw.ts` import와
   `BtwThreadsApiHandlers,` 줄을 지운다.
9. `apps/agent/app/entry/chat/refusals.ts:17`의 `btw_not_found` 줄을 지운다.
10. `packages/memory-agent/tests/support/chat-api.ts`: `btwApi`와 그것만 쓰던 import, `sameSite`를 지운다.
    `chatApi`는 남긴다.
11. `packages/memory-agent/tests/agents/app-fetch.ts`와 `tests/fixtures/goal-owner-process.mts`: `BtwApiHandlers`와
    `BtwChat`을 빼고 `Layer.merge(ChatApiHandlers, BtwApiHandlers)`를 `ChatApiHandlers`로,
    `Effect.context<AgentChat | BtwChat>()`를 `Effect.context<AgentChat>()`로 바꾼다.
12. `packages/memory-agent/src/sessions/dispatches.ts:123`의 주석에서 BTW를 말하는 구절을 뺀다.
    `tests/sessions/dispatches.test.ts:149`의 테스트 이름을
    `"an id that is no session is refused like any unknown target"`으로 바꾼다. 테스트의 내용은 그대로 둔다.
13. `vp run agent#i18n:extract`를 돌린다.

`layers.ts`에서 `BtwChat.layer`를 뺀 뒤 typecheck가 "어떤 서비스가 주어지지 않았다"고 하면, 그 서비스를
`BtwChat.layer`가 대신 주고 있었던 것이다. 이 경우 STOP하고 어느 서비스인지 보고한다.

테스트가 API의 경로나 거절 코드의 목록을 통째로 적어 두고 견주다가 실패하면, 그 목록에서 BTW 항목만
지운다. 그 밖의 실패는 STOP이다.

**Verify**:

- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 오류와 경고 없음.
- `vp check` → exit 0.
- `vp run agent#i18n:check`, `vp run memory-agent#i18n:check` → exit 0.
- `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` → exit 0.
- `cd packages/memory-agent && vp test --run tests/chat/api.test.ts tests/chat/attachments.test.ts tests/sessions/dispatches.test.ts tests/tanstack-rows-migration.test.ts tests/btw-thread-messages-migration.test.ts tests/database.test.ts tests/db-migrator-metadata.test.ts`
  → all pass.
- `grep -rl "agents/app-fetch" packages/memory-agent/tests`가 내는 테스트 파일들을 같은 방식으로 돌린다
  → all pass. 돌린 파일을 보고에 적는다.
- `cd apps/agent && vp test --run app` → all pass.

commit한다.

### Step 3. 문서

아래 파일에서 BTW를 말하는 문장을 지금 코드에 맞게 고친다. BTW 항목은 지우고, 여러 가지를 늘어놓은
문장에서는 BTW만 뺀다.

- `apps/agent/README.md:77` (헤더의 버튼 설명)
- `apps/agent/app/entry/README.md` (12행의 `api` 메서드 목록, 35행의 `chat` 설명)
- `apps/agent/app/entry/chat/README.md` (5, 7, 16, 23, 33, 66행 부근)
- `apps/agent/app/entry/queries/README.md` (9, 13, 51행 부근)
- `apps/agent/app/lib/README.md:9`
- `apps/agent/app/.server/api/README.md:16`
- `packages/README.md:12`
- `packages/memory-agent/src/README.md` (16행, 36행의 `btw` 디렉터리 줄)
- `packages/memory-agent/src/api/README.md` (BTW 항목과 문장 전부)
- `packages/memory-agent/src/messages/README.md:16` ("호출처 다섯 곳"을 남은 세 곳 `loop/store.ts`,
  `agent/compaction.ts`, `agent/chat.ts`로 고친다. 먼저 `grep -rn "empty-user" packages/memory-agent/src`로
  실제 호출처를 센다)
- `.agents/skills/effect-profile/SKILL.md:76` ("BTW 질문(`BtwChat.handle`)" 구절을 뺀다)

`packages/memory-agent/src/attachments/README.md`와 `src/chat-store/README.md`의 BTW 표 이름은 그대로 둔다.
표가 남아 있어서 사실이다.

`docs/decisions.md`의 맨 끝에 아래 항목을 더한다.

```md
## BTW 곁질문을 없앤다 (2026-11-16)

- 계기: BTW는 열린 대화 옆에서 따로 묻는 패널이었다. 사용자는 다른 대화에서 묻는 것과 다르지 않다고 보았다. 화면과 서버에 따로 유지하는 코드가 1,600줄쯤 있었다.
- 결정: BTW의 패널과 헤더 버튼, `/api/sessions/:session/btw`와 `/api/btw/:thread` 경로, `BtwChat`·`BtwThreads` 서비스, 그 테스트를 지운다.
  - DB의 `btw_threads`, `btw_thread_messages`, `btw_attachments` 표와 그 migration은 그대로 둔다. 옛 DB가 지금 판으로 올라오는 길이고, 저장된 스레드를 지우면 되살릴 수 없다.
  - 첨부 정리는 `btw_attachments`가 가리키는 첨부를 계속 남긴다.
  - 이제 이 표들에 쓰는 코드는 없다.
- 남은 것: 표를 지우는 migration. 저장된 스레드를 버리는 일이라 사용자가 따로 정한다.
```

**Verify**:

- `vp check` → exit 0.
- `grep -c "^## BTW 곁질문을 없앤다 (2026-11-16)" docs/decisions.md` → `1`.

commit한다.

## Test plan

새 테스트는 쓰지 않는다. 지운 기능의 테스트(`tests/btw/threads.test.ts`, `btw-panel.browser.tsx`)를 함께
지우고, 남은 테스트가 모두 통과하는 것으로 확인한다. migration 테스트 두 개는 BTW 표가 든 옛 DB가
여전히 열리는지를 계속 확인한다.

## Done criteria

- [ ] `vp run agent#typecheck`, `vp run memory-agent#typecheck` → exit 0, `error TS`와 `warning` 없음
- [ ] `vp check` → exit 0
- [ ] `vp run agent#i18n:check`, `vp run memory-agent#i18n:check` → exit 0
- [ ] `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` → exit 0
- [ ] Step 1과 Step 2의 테스트 명령 → all pass
- [ ] `grep -rnE "BtwChat|BtwThreads|BtwApiHandlers|BtwThreadsApiHandlers|BtwGroup|BtwThreadsGroup|BtwPanel|useBtwThread|btwToolNames|createBtw|deleteBtw|btw_not_found|btw-thread\"" apps packages --include=*.ts --include=*.tsx --include=*.mts --include=*.json --exclude-dir=node_modules --exclude-dir=build`
      → 출력 없음
- [ ] `ls packages/memory-agent/src/btw packages/memory-agent/tests/btw 2>&1` → 두 디렉터리 모두 없다
- [ ] `grep -c "BTW" apps/agent/app/locales/ko.po` → `0`
- [ ] `git diff --stat <시작 commit> HEAD -- packages/memory-agent/src/db packages/memory-agent/src/chat-store packages/memory-agent/src/attachments/attachments.ts pnpm-lock.yaml`
      → 출력 없음
- [ ] `git status --short` → 비어 있다

보고에는 `grep -rli btw apps packages .agents --exclude-dir=node_modules --exclude-dir=build`의 출력을 붙인다.
남은 것이 "남기는 것"에 적은 파일과 표 이름을 말하는 README뿐인지 검토자가 본다.

## STOP conditions

- Drift check가 맞지 않는다.
- `BtwChat.layer`를 뺀 뒤 주어지지 않는 서비스가 생긴다.
- "남기는 것"의 파일을 고쳐야만 typecheck나 테스트가 통과한다.
- BTW가 아닌 기능의 테스트가 실패하고, 원인이 경로나 거절 코드 목록의 BTW 항목이 아니다.
- 적지 않은 파일에서 BTW 코드를 쓰는 곳이 나온다(주석과 문서는 뺀다). 어디인지 보고한다.

## Maintenance notes

- DB 표를 지우는 migration은 사용자가 정하면 따로 쓴다. 그때 `attachments.ts`의 `btw_attachments` 조건,
  `tanstack-migration.ts`의 BTW 부분, migration 테스트 두 개를 함께 본다.
- 이미지 생성 설계 문서(`docs/designs/image-generation-in-conversation.md`)는 첨부 정리의 세 표 가운데
  하나로 `btw_attachments`를 말한다. 표가 남아 있어 아직 사실이다.
