# Plan 018: `agent#typecheck`가 다시 통과하게 한다 (사이드바 테스트 두 파일)

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/navigation/sidebar-collapse.test.tsx apps/agent/app/entry/navigation/sidebar.browser.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P0 (004–017의 모든 계획이 이 검사를 통과 조건으로 쓴다)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. 004–017보다 먼저 한다.
- **Category**: tooling
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

저장소 루트에서 `vp run agent#typecheck`를 돌리면 commit `d65cc285`에서 오류 12개로 실패한다.
소스가 아니라 테스트 두 파일에서 난다. 이 저장소의 `tsc`는 Effect 언어 서비스의 진단도 오류로
낸다.

- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` — 10개. `TS377081`
  "This code declares an async function" (`effect(asyncFunction)`). 117, 123, 135, 137, 145, 150,
  156, 192, 225, 269행.
- `apps/agent/app/entry/navigation/sidebar.browser.tsx` — 2개. `TS377026`
  "This code uses `JSON.parse` or `JSON.stringify`" (`effect(preferSchemaOverJson)`). 637, 668행.

같은 종류의 실패를 commit `19417ef5`(`fix(test): typecheck를 막던 JSON 직접 호출과 동기 decode를
Schema로 바꾼다`)가 한 번 고쳤다. 그 뒤의 merge(`25dbe2d9`)로 들어온 두 테스트 파일이 다시 깼다.

004–017의 모든 계획이 "`vp run agent#typecheck` → exit 0"을 단계의 확인과 commit의 조건으로 쓴다.
이 검사가 처음부터 실패하면 어느 계획도 한 단계를 끝낼 수 없다(2026-11-15에 004가 Step 1에서
멈췄다). 004와 007은 새 테스트의 본보기로 `sidebar-collapse.test.tsx`를 가리키므로, 이 파일이
`async` 함수로 남아 있으면 새 테스트도 같은 오류를 낸다.

이 계획 뒤에는 `vp run agent#typecheck`가 exit 0이고, 두 테스트는 같은 것을 같은 단언으로 검사한다.

## Current state

### 관련 파일

- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` — jsdom에서 사이드바의 접이식 그룹을
  검사한다. 300행, 테스트 4개.
- `apps/agent/app/entry/navigation/sidebar.browser.tsx` — 브라우저 테스트. 두 줄만 고친다.
- `apps/agent/app/entry/session/use-run-state.test.tsx` — `@effect/vitest`의 `it.live`와 `sdkCall`을
  쓰는 테스트의 본보기.
- `apps/agent/app/entry/chat/board/project-board.browser.tsx:15` — JSON 글자를 Schema로 읽는 본보기.

### 발췌

`sidebar-collapse.test.tsx:66-72` — 모듈을 jsdom 준비 뒤에 동적으로 가져온다:

```tsx
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@lingui/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { SidebarProvider } = await import("../../components/ui/sidebar");
const { SessionSection } = await import("./sidebar");
const { afterEach, describe, expect, test } = await import("vite-plus/test");
```

`sidebar-collapse.test.tsx:116-154` — `async` 함수 셋과 `afterEach`:

```tsx
/** The rows are Links, so the section renders under the app's router like report tests do. */
const renderSection = async (ui: React.ReactElement) => {
  const container = documentRef.createElement("div");
  documentRef.body.append(container);
  const root = createRoot(container);
  mounts.push(root);
  const router = createMemoryRouter([{ path: "/", element: ui }], { initialEntries: ["/"] });
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>,
    );
  });
  return { container, router };
};

afterEach(async () => {
  for (const root of mounts.splice(0)) {
    await act(async () => root.unmount());
  }
  documentRef.body.replaceChildren();
  dom.window.localStorage.removeItem("context-agent-session-groups-open-v1");
});

const rowLinks = (container: HTMLElement) => [...container.querySelectorAll('a[href*="session="]')];

const click = async (container: HTMLElement, name: RegExp) => {
  const trigger = [...container.querySelectorAll("button")].find((button) =>
    name.test(button.textContent ?? ""),
  );
  if (trigger === undefined) throw new Error(`no button ${String(name)}`);
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
};
```

`sidebar-collapse.test.tsx:155-158` — 테스트의 모양(네 테스트가 모두 같다. 156, 192, 225, 269행):

```tsx
describe("SessionSection collapsible groups (jsdom)", () => {
  test("a folded group renders no row links; an open one mounts its own", async () => {
    // No stored folds: the selected project starts open, every other group starts folded.
    const { container } = await renderSection(
```

테스트 본문 안에서는 `await renderSection(...)`과 `await click(...)`만 `await`를 쓴다.

`use-run-state.test.tsx:1-2, 16-23` — 본보기:

```tsx
import { it } from "@effect/vitest";
import { Cause, Effect, Result } from "effect";
```

```tsx
const sdkCall = Effect.fn("sessionHook.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
```

`sidebar.browser.tsx:636-638`과 `:667-669` — 두 곳이 같은 모양이다:

```tsx
expect(localStorage.getItem("context-agent-session-groups-open-v1")).toBe(
  JSON.stringify({ alpha: false }),
);
```

```tsx
expect(localStorage.getItem("context-agent-session-groups-open-v1")).toBe(
  JSON.stringify({ alpha: true }),
);
```

`sidebar.browser.tsx:1-7` — import. 이 파일은 이미 `it.live`와 `Effect.gen`을 쓴다:

```tsx
import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Cause, Effect } from "effect";
import type { ReactNode } from "react";
import { useState } from "react";
import { Array as EffectArray } from "effect";
```

`project-board.browser.tsx:14-15` — 본보기:

```tsx
/** A posted body back from the JSON the page sent; only its shape as a value matters here. */
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
```

### 따라야 할 규칙

- `async` 함수를 선언하지 않는다(화살표 함수 포함). 비동기 흐름은 `Effect.gen`으로 쓴다.
- `JSON.parse`, `JSON.stringify`를 쓰지 않는다. `Schema.fromJsonString`으로 읽는다.
- 테스트가 검사하는 것을 바꾸지 않는다. 단언의 대상과 기대값은 그대로 둔다. 테스트를 지우거나
  `skip`하지 않는다.
- `let`, `while`, lint 끄기 주석(`eslint-disable`, `@ts-expect-error`, `@effect-diagnostics` 등),
  `unknown` 타입 선언, `as` 단언을 더하지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose         | Command                                                                                                                        | Expected on success |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck | 저장소 루트에서 `vp run agent#typecheck`                                                                                       | 오류 줄이 없다      |
| 포맷·lint       | 저장소 루트에서 `vp check`                                                                                                     | 0 errors            |
| jsdom 테스트    | `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx`                                                | 4 passed            |
| 브라우저 테스트 | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/navigation/sidebar.browser.tsx` | all pass            |

- `vp run agent#typecheck`는 실패해도 마지막 줄의 종료 코드가 0으로 보일 수 있다. 출력에
  `error TS`가 없는지로 판단한다: `vp run agent#typecheck 2>&1 | rg -c "error TS"` → 결과 없음(또는 0).
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 브라우저 테스트가 브라우저를 띄우지 못하는 환경이면 그 사실을 보고에 적고 넘어간다. STOP이 아니다.

## Scope

**In scope**:

- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx`
- `apps/agent/app/entry/navigation/sidebar.browser.tsx` (두 단언과 import, 작은 decode 함수 하나)

**Out of scope**:

- 소스 코드 전부. `navigation/sidebar.tsx`를 고치지 않는다.
- `tsconfig`, Effect 언어 서비스 설정, lint 설정. 진단을 끄지 않는다.
- 다른 테스트 파일.

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않고, push하지 않고, PR을 열지 않는다.
- `git add -A`를 쓰지 않는다. 위 두 파일만 올린다.
- commit은 하나면 된다. 메시지는 한국어 conventional commit이고, 왜 고치는지와 테스트의 뜻이
  그대로임을 본문에 적는다. 예:
  `fix(test): agent typecheck를 막던 사이드바 테스트의 async 함수와 JSON.stringify를 Effect와 Schema로 바꾼다`

## Steps

### Step 1: `sidebar-collapse.test.tsx`를 Effect로 쓴다

1. 파일 맨 위의 정적 import에 더한다: `import { Cause, Effect } from "effect";`. `effect`는 DOM을
   읽지 않으므로 jsdom 준비 앞에 와도 된다.
2. 동적 import 줄들(66–72행)에 한 줄을 더하고, `vite-plus/test`에서 `test`를 뺀다.

```tsx
const { it } = await import("@effect/vitest");
const { afterEach, describe, expect } = await import("vite-plus/test");
```

맨 위 수준의 `await import(...)`는 `async` 함수 선언이 아니다. 그대로 둔다. 3. `renderSection` 앞에 도우미 둘을 둔다.

```tsx
const sdkCall = Effect.fn("sidebarCollapse.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

/** React's act around `work`; returning a promise makes act wait for the work it scheduled. */
const acting = (work: () => void) =>
  sdkCall(() =>
    act(() => {
      work();
      return Promise.resolve();
    }),
  );
```

4. `renderSection`, `afterEach`, `click`을 바꾼다.

```tsx
/** The rows are Links, so the section renders under the app's router like report tests do. */
const renderSection = Effect.fn("sidebarCollapse.renderSection")(function* (
  ui: React.ReactElement,
) {
  const container = documentRef.createElement("div");
  documentRef.body.append(container);
  const root = createRoot(container);
  mounts.push(root);
  const router = createMemoryRouter([{ path: "/", element: ui }], { initialEntries: ["/"] });
  yield* acting(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>,
    ),
  );
  return { container, router };
});

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.forEach(mounts.splice(0), (root) => acting(() => root.unmount()), {
        discard: true,
      });
      documentRef.body.replaceChildren();
      dom.window.localStorage.removeItem("context-agent-session-groups-open-v1");
    }),
  ),
);
```

```tsx
const click = Effect.fn("sidebarCollapse.click")(function* (container: HTMLElement, name: RegExp) {
  const trigger = [...container.querySelectorAll("button")].find((button) =>
    name.test(button.textContent ?? ""),
  );
  if (trigger === undefined) return yield* Effect.die(new Error(`no button ${String(name)}`));
  yield* acting(() => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
});
```

5. 네 테스트를 같은 방식으로 바꾼다. 이름, 주석, 단언은 그대로 둔다.

   - `test("<이름>", async () => {` → `it.live("<이름>", () =>` 다음 줄에 `Effect.gen(function* () {`
   - 본문 안의 `await renderSection(` → `yield* renderSection(`, `await click(` → `yield* click(`
   - 테스트의 닫는 `});` → `}),` 다음 줄에 `);`

   바꾼 뒤의 첫 테스트 머리:

```tsx
  it.live("a folded group renders no row links; an open one mounts its own", () =>
    Effect.gen(function* () {
      // No stored folds: the selected project starts open, every other group starts folded.
      const { container } = yield* renderSection(
```

**Verify**:

- `rg -n "async |await (renderSection|click|act)" apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` → 결과 없음.
- `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` → 4 passed.

### Step 2: `sidebar.browser.tsx`의 두 단언

1. import를 고친다: `import { Cause, Effect, Schema } from "effect";`.
2. 파일의 다른 상수들 근처(import 다음)에 더한다.

```tsx
/** The folds as the sidebar stored them; a missing or malformed value fails the read. */
const storedFolds = () =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    localStorage.getItem("context-agent-session-groups-open-v1"),
  );
```

3. 두 단언을 바꾼다(636–638행, 667–669행).

```tsx
expect(yield * storedFolds()).toEqual({ alpha: false });
```

```tsx
expect(yield * storedFolds()).toEqual({ alpha: true });
```

두 곳 모두 `Effect.gen(function* () { … })` 안이다. `yield*`를 쓸 수 있다.

**Verify**: `rg -n "JSON\.(parse|stringify)" apps/agent/app/entry/navigation/sidebar.browser.tsx` → 결과 없음.

### Step 3: 전체 확인과 commit

**Verify**:

- `vp run agent#typecheck 2>&1 | rg "error TS"` → 결과 없음.
- `vp check` → 0 errors.
- 브라우저 테스트 명령 → 통과(띄울 수 없으면 보고에 적는다).

통과하면 두 파일을 commit한다.

## Test plan

새 테스트는 없다. 기존 테스트가 같은 단언으로 통과하는 것이 확인이다. jsdom 테스트 4개는 반드시
돌려서 통과를 본다.

## Done criteria

- [ ] `vp run agent#typecheck 2>&1 | rg -c "error TS"` → 결과 없음(0)
- [ ] `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` → 4 passed
- [ ] `vp check` → 0 errors
- [ ] `rg -n "async " apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` → 결과 없음
- [ ] `rg -n "JSON\.(parse|stringify)" apps/agent/app/entry/navigation/sidebar.browser.tsx` → 결과 없음
- [ ] `git show --stat HEAD`에 위 두 파일만 있다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `vp run agent#typecheck`의 오류가 위 12개 말고 더 있다(다른 파일의 오류). 고치지 말고 목록을 보고한다.
- 바꾼 뒤 jsdom 테스트가 실패하고, 실패가 단언의 기대값을 바꿔야만 없어진다.
- `acting`의 `act(() => { …; return Promise.resolve(); })`가 typecheck에서 실패한다.
- 진단을 끄는 주석이나 설정 변경 없이는 오류가 없어지지 않는다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 이 저장소의 `agent#typecheck`는 테스트 파일에도 Effect 진단(`asyncFunction`,
  `preferSchemaOverJson`)을 건다. 새 jsdom 테스트는 이 파일의 `sdkCall`, `acting`, `it.live` 모양을
  본보기로 쓴다. 004와 007의 새 테스트가 그렇게 쓴다.
- `vp run agent#typecheck`는 오류가 있어도 묶음 실행의 마지막 줄만 보면 성공처럼 보일 수 있다.
  `error TS`가 있는지를 본다.
- 리뷰에서 볼 곳: 단언의 대상과 기대값이 그대로인가. 진단을 끄는 주석이 없는가.
