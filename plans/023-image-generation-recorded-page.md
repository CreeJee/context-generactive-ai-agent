# Plan 023: 생성한 이미지를 대화에 적는다 (화면, 옛 경로 지우기)

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. `plans/README.md`는 고치지 않는다(검토자가 고친다).
>
> **Drift check (먼저 실행)**:
> `git diff --stat 9c84a663 HEAD -- apps/agent/app/entry packages/memory-agent/src/agent packages/memory-agent/src/api apps/agent/app/.server`
> 출력이 비어 있어야 한다. 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (입력창의 보내기 흐름에 닿는다. API 그룹 하나를 지운다)
- **Depends on**: Plan 022
- **Category**: 기능
- **Planned at**: commit `9c84a663`, 2026-11-16

## Why this matters

Plan 022가 서버에 새 경로 `POST /api/sessions/:session/images`를 더했다. 이 경로는 이미지를 만들고
대화에 "프롬프트, `generate_image` 호출, 결과 그림" 세 메시지를 적는다. 화면은 아직 옛 경로
`POST /api/media/image`를 부르고, 만든 그림을 입력창 위에 한 번 보일 뿐이다.

이 계획은 화면이 새 경로를 쓰게 한다. 만든 그림은 대화의 도구 카드 아래에 보이고, 새로고침해도
남는다. 그 뒤 옛 경로를 지운다. Plan 022 검토에서 나온 작은 고침 둘도 먼저 한다.

## Current state

경로는 저장소 루트 기준이다.

### 서버의 기록 동작 (Step 0이 고친다): `packages/memory-agent/src/agent/chat.ts`의 `recordImage`

```ts
        const write = Effect.gen(function* () {
          const prompt = (yield* redactor.redactText(image.prompt)).text;
          const ids = { user: …, assistant: …, tool: …, toolCall: … };
          const argumentsText = stringifyJson(imageCallArguments(prompt));
          const resultText = stringifyJson(imageResult(image.asset));
          const base = { projectId: session.projectId, sessionId };
          yield* nodes.append({ ...base, kind: "user", text: prompt });
          const callNode = yield* nodes.append({ … kind: "tool_call" … });
          const resultNode = yield* nodes.append({ … kind: "tool_result" … });
          yield* attachments.linkStored(resultNode.id, [image.asset.attachment.id]);
          const stored = yield* runStore.thread(sessionId);
          const now = yield* DateTime.now;
          yield* runStore.saveThread(sessionId, [...stored, ...imageMessages({ … })]);
          yield* events.publishProject(session.projectId, "sessions");
          yield* events.publishSession(sessionId, "run-state");
        });
        // …
        return yield* liveRuns.writing(sessionId, write).pipe(
          Effect.tap((written) => Effect.when(waitForRun, Effect.succeed(written === null))),
          Effect.repeat({ until: Predicate.isNotNull }),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.flatMap(Fiber.join),
        );
```

두 가지가 약하다.

1. node 셋, 그림 묶기, 대화 저장이 한 transaction이 아니다. 중간에 실패하면 node만 남고 대화에는
   메시지가 없다. 같은 파일에 `const sql = yield* SqlClient.SqlClient;`(`:464` 부근)가 있고,
   `packages/memory-agent/src/memory/record.ts`는 node 여러 개를 `.pipe(sql.withTransaction)`으로 묶는다.
2. `write`가 아무것도 돌려주지 않는다. 반복을 멈추는 조건이 "`null`이 아니다"인데, 지금은 `undefined`가
   `null`이 아니라는 데 기대고 있다.

### 화면의 이미지 요청: `apps/agent/app/entry/media/use-image-generation.ts` (76줄 전체)

```ts
export function useImageGeneration(onProblem: (message: string) => void) {
  const [intent, _setIntent, clearIntent, toggleIntent] = useBooleanState(false);
  const consentMutation = useCrossProviderConsentMutation();
  const settings = useImageSettingsQuery().data ?? null;
  const generation = useMutation({
    mutationFn: (prompt: string) =>
      runUiEffect(
        uiPromise(() => api.generateImage(prompt, true)).pipe(
          Effect.catchTag("UnknownError", (rejected) =>
            Effect.gen(function* () {
              const failure = rejected.cause;
              const approval = isApiError(failure) ? failure.approval : undefined;
              const choice = /* cross_provider 승인이 필요하면 창을 띄운다 */;
              if (choice === null) return yield* rejected;
              return yield* ApprovalChoice.$match(choice, {
                cancel: () => Effect.succeed(null),
                once: ({ approval: chosen }) =>
                  uiPromise(() => api.generateImage(prompt, true, chosen)),
                always: () =>
                  uiPromise(() => consentMutation.mutateAsync("always")).pipe(
                    Effect.andThen(uiPromise(() => api.generateImage(prompt, true))),
                  ),
              });
            }),
          ),
        ),
      ),
  });

  const generate = (prompt: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (generation.isPending) return false;
        return yield* Effect.gen(function* () {
          return (yield* uiPromise(() => generation.mutateAsync(prompt))) !== null;
        }).pipe(
          Effect.catchTag("UnknownError", () =>
            Effect.sync(() => {
              onProblem(t`이미지를 생성하지 못했습니다. 설정과 계정 권한을 확인해 주십시오.`);
              return false;
            }),
          ),
        );
      }),
    );

  return {
    intent, clearIntent, toggleIntent, settings,
    generating: generation.isPending,
    asset: generation.isPending ? null : (generation.data ?? null),
    generate,
  };
}
```

### 클라이언트: `apps/agent/app/entry/api.ts`

`:782-794`의 옛 호출과, 본보기로 삼을 대화 경로 호출(`:739-746`).

```ts
  generateImage: (
    prompt: string,
    approved: boolean,
    crossProviderApproval?: CrossProviderMediaRunApproval,
  ) =>
    appCall((client) =>
      client.media.generateImage({
        payload:
          crossProviderApproval === undefined
            ? { prompt, approved }
            : { prompt, approved, runId: crossProviderApproval.runId, crossProviderApproval },
      }),
    ),
```

```ts
  setSessionModel: (session: string, holder: string, model: ModelSelection | null) =>
    appCall((client) =>
      client.sessions.setModel({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: { model },
      }),
    ),
```

`:180`에 `export type GeneratedImageAsset = GeneratedImage;`가 있다.

### 대화 패널: `apps/agent/app/entry/chat/chat-panel.tsx`

- `:378` `const media = useImageGeneration((message) => setNotice(problem(message)));`
- `:421` `useAgentChat({ sessionId, holder, … })`의 결과를 구조 분해한다. `useAgentChat`은
  `reopen: () => open(undefined)`을 돌려준다(`apps/agent/app/entry/chat/use-agent-chat.ts:99`). `open`은
  서버에서 대화의 최신 쪽을 다시 읽어 화면의 메시지를 바꾼다
  (`packages/memory-agent/src/api/chat-session.ts:144-157`).
- `:849-862`

```tsx
const clearComposer = () => {
  setDraft("");
  draftImages.clear();
  media.clearIntent();
  setNotice(null);
};
const generateImage = (prompt: string) =>
  runUiEffect(
    Effect.gen(function* () {
      setImagePrompt(null);
      if (yield* uiPromise(() => media.generate(prompt))) clearComposer();
    }),
  );
```

- `:964-975` (보내기 `submit` 안)

```tsx
if (!generating && media.intent) {
  if (attachmentIds.length > 0)
    return setNotice(problem(t`첫 버전의 이미지 생성은 텍스트 프롬프트만 지원합니다.`));
  // A paid media model may run, so the dialog asks before `generateImage` does.
  return setImagePrompt(text);
}
if (!generating) return sendTurn();
```

- `:1168-1172` 입력창에 넘기는 props: `imageSettings`, `imageIntent`, `onToggleImageIntent`,
  `generatingImage={media.generating}`, `generatedImage={media.asset}`.

### 입력창: `apps/agent/app/entry/chat/chat-composer.tsx`

- `:47-76` `GeneratedImage` 컴포넌트(그림, 대화 모델, 실행 경로, 실행 방식, 예상 비용, 사용량 줄).
- `:92-128` props에 `generatingImage: boolean`, `generatedImage: GeneratedImageAsset | null`.
- `:230-235`

```tsx
{
  generatingImage && (
    <div className="mb-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
      <Trans>승인된 미디어 경로에서 이미지를 생성하고 있습니다…</Trans>
    </div>
  );
}
{
  generatedImage && <GeneratedImage image={generatedImage} />;
}
```

- 테스트 `apps/agent/app/entry/chat/chat-composer.test.tsx:31-32`가 `generatingImage={false}`와
  `generatedImage={null}`을 넘긴다.

### 도구 카드의 그림: `apps/agent/app/entry/chat/message.tsx`

`:57` `const toolLabels = { find_memory: msg\`기억 검색\`, … }`(도구 이름 → 이름표).

`:268-285`

```ts
/** A write_file / edit_file result that carries a picture of the SVG it wrote. */
const decodeDrawing = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      path: Schema.String,
      preview: Schema.Struct({ attachmentId: Schema.String }),
    }),
  ),
);

/** The picture to show for a result, when it is one of this app's stored images. */
function drawingOf(result: ToolResult | undefined) {
  if (!isTruthy(result)) return null;
  const drawing = Option.getOrUndefined(decodeDrawing(result.content));
  if (!(drawing !== undefined)) return null;
  const url = attachmentUrl(drawing.preview.attachmentId);
  return isTruthy(attachmentIdOf(url)) ? { url, path: drawing.path } : null;
}
```

`:700` `{drawing && <DrawingPicture url={drawing.url} path={drawing.path} />}`

생성한 이미지의 결과에는 `path`가 없다(`{ preview, route, model, estimatedCostUsd? }`). 그래서 지금은
그림이 그려지지 않는다.

`apps/agent/app/entry/chat/images.tsx:61-80`의 `DrawingPicture({ url, path }: { url: string; path: string })`는
`path`를 그림의 alt(`` t`그린 그림: ${path}` ``), 버튼 title(`` t`${path} 크게 보기` ``), 창 제목
(`<code>{path}</code>`)에 쓴다.

### 옛 경로를 쓰는 곳

- `packages/memory-agent/src/api/app-api/media.ts:43` `export class MediaGroup …`(`/api/media/image`).
  같은 파일의 `GenerateImage`, `GeneratedImage`, 거절 셋, `mediaRefusals`는 새 경로도 쓴다.
- `packages/memory-agent/src/api/app-api.ts:4`, `:27`, `:39`: `MediaGroup` import, `.add(MediaGroup)`,
  `...mediaRefusals`.
- `apps/agent/app/.server/api/media.ts`: `imageGenerationRefusals`(새 handler도 쓴다)와 `MediaApiHandlers`.
- `apps/agent/app/.server/api.ts:15`, `:64`: `MediaApiHandlers` import와 목록의 한 줄.
- `apps/agent/app/entry/api.ts:788` `client.media.generateImage`.

### 저장소 규칙

- UI는 shadcn 컴포넌트만 쓴다. 새 컴포넌트를 만들지 않는다. 문구는 Lingui 메시지(`t`, `msg`, `Trans`)다.
  문구가 바뀌면 `vp run agent#i18n:extract`로 catalog를 다시 뽑아 같은 commit에 올린다.
- 문구는 합니다체 평서문이고, 만든 말을 쓰지 않는다.
- `let`, `while`, `unknown`, lint 끄기 주석, 숨은 `useRef` 상태를 쓰지 않는다.
- 줄바꿈과 들여쓰기는 손으로 고치지 않는다.

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

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다. 실제 이미지 API를 부르지 않는다.**
- 브라우저 테스트가 처음 실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다. 브라우저를 띄우지
  못하면 그 사실을 보고에 적는다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/chat.ts` (`recordImage`의 `write`만)
- `packages/memory-agent/tests/sessions/image-record.test.ts`
- `apps/agent/app/entry/api.ts`, `apps/agent/app/entry/media/use-image-generation.ts`
- `apps/agent/app/entry/chat/chat-panel.tsx`, `chat-composer.tsx`, `chat-composer.test.tsx`, `message.tsx`,
  `images.tsx`, `message.browser.tsx`
- `packages/memory-agent/src/api/app-api/media.ts`, `packages/memory-agent/src/api/app-api.ts`
- `apps/agent/app/.server/api/media.ts`, `apps/agent/app/.server/api.ts`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- 위 파일들의 디렉터리 README, `apps/agent/README.md`의 이미지 생성 설명, `docs/decisions.md`

**Out of scope**:

- `ImageMediaWorkflow`, `packages/memory-agent/src/providers/`, `live-runs.ts`, `start`.
- 이미지를 붙인 요청 지원, 키 유무 배지, 설정이 꺼졌을 때 버튼 숨기기(설계 문서 5.1, 5.3, 5.4).
- 대화 끝에 생성 중 임시 줄을 보이는 일. 입력창 위의 진행 줄을 그대로 쓴다.
- 다른 탭이 생성을 바로 따라오게 하는 일.

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않는다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다. 지운 파일은 `git rm`으로 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다. 화면 문구가 바뀌는
  commit에는 추출한 `ko.po`를 함께 올린다.
- 메시지는 한국어 conventional commit이다.
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 0. 기록을 한 transaction으로 묶고 `write`가 메시지 id를 돌려주게 한다

`packages/memory-agent/src/agent/chat.ts`의 `recordImage` 안에서:

1. `write`에서 node 셋의 `nodes.append`, `attachments.linkStored`, `runStore.thread`, `runStore.saveThread`를
   한 `Effect.gen`으로 묶고 `.pipe(sql.withTransaction)`을 붙인다. `redactor.redactText`와 id 만들기는
   그 앞에, `events.publish…` 둘은 그 뒤에 둔다.
2. `write`가 `{ userMessageId: ids.user, assistantMessageId: ids.assistant, toolMessageId: ids.tool }`을
   돌려주게 한다. `recordImage`가 그 값을 돌려준다.
3. `sql.withTransaction`이 새 오류 타입을 더하면 `recordImage`의 `Effect.catchTags`에 그 태그를
   `imageNotRecorded`로 더한다.

`packages/memory-agent/tests/sessions/image-record.test.ts`의 첫 테스트에 단언을 더한다: `recordImage`가
돌려준 `userMessageId`, `assistantMessageId`, `toolMessageId`가 대화의 끝 세 메시지의 `id`와 같다.

handler(`apps/agent/app/.server/api/sessions.ts`의 `generateImage`)는 `recordImage`의 값을 쓰지 않으므로
고치지 않는다.

**Verify**:

- `cd packages/memory-agent && vp test --run tests/sessions/image-record.test.ts tests/agent/live-runs.test.ts tests/memory/record.test.ts tests/chat/api.test.ts` → all pass.
- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 오류와 경고 없음. `vp check` → exit 0.

안쪽 `saveThread`나 `nodes.append`가 바깥 transaction 안에서 실패하면 STOP이다. commit한다.

### Step 1. 화면이 새 경로를 부른다

1. `apps/agent/app/entry/api.ts`: `generateImage`를 지우고 그 자리에 새 호출을 쓴다.

```ts
  /** A paid image, written into the conversation as the prompt, a call and its result. */
  generateSessionImage: (
    session: string,
    holder: string,
    prompt: string,
    approved: boolean,
    crossProviderApproval?: CrossProviderMediaRunApproval,
  ) =>
    appCall((client) =>
      client.sessions.generateImage({
        params: { session },
        headers: { "x-session-holder": holder },
        payload:
          crossProviderApproval === undefined
            ? { prompt, approved }
            : { prompt, approved, runId: crossProviderApproval.runId, crossProviderApproval },
      }),
    ),
```

2. `apps/agent/app/entry/media/use-image-generation.ts`:
   - 시그니처를 `useImageGeneration(sessionId: string, holder: string, onProblem: (message: string) => void)`로
     바꾼다.
   - `api.generateImage(prompt, true, …)` 세 곳을 `api.generateSessionImage(sessionId, holder, prompt, true, …)`로
     바꾼다.
   - 돌려주는 값에서 `asset`을 뺀다.
   - 실패 문구를 코드에 따라 가른다. `generate`의 `Effect.catchTag("UnknownError", …)` 안에서
     `rejected.cause`가 `isApiError`이고 `code`가 `image_record_failed`면
     `` t`이미지를 만들었지만 대화에 적지 못했습니다. 다시 시도해 주십시오.` ``, `run_in_progress`면
     `` t`이 대화가 아직 답하는 중입니다. 답변이 끝난 뒤 다시 보내 주십시오.` ``, `session_in_use`면
     `` t`다른 탭이 이 대화를 쓰고 있습니다.` ``, 그 밖은 지금 문구다. `isApiError`가 주는 값의 `code`
     타입에 이 코드들이 없으면 STOP이다.
3. `apps/agent/app/entry/chat/chat-panel.tsx`:
   - `:378`을 `useImageGeneration(sessionId, holder, (message) => setNotice(problem(message)))`로 바꾼다.
   - `useAgentChat`의 구조 분해에 `reopen`을 더한다(이미 있으면 그대로 쓴다).
   - `generateImage`를 고친다. 성공하면 입력창을 비우고 대화를 다시 읽는다.

```tsx
if (yield * uiPromise(() => media.generate(prompt))) {
  clearComposer();
  reopen();
}
```

- `submit`에서 이미지를 만드는 동안 보내기를 막는다. `if (!generating && media.intent) {` 앞에 더한다.

```tsx
if (media.generating)
  return setNotice(
    problem(t`이미지를 만드는 동안에는 메시지를 보낼 수 없습니다. 끝난 뒤 보내 주십시오.`),
  );
```

- 이미지를 붙인 요청의 문구를 사실에 맞게 바꾼다:
  `` t`이미지를 붙인 채로는 아직 이미지를 만들 수 없습니다. 첨부를 지우고 다시 보내 주십시오.` ``
- 입력창에 넘기던 `generatedImage={media.asset}`을 지운다.

4. `apps/agent/app/entry/chat/chat-composer.tsx`: `GeneratedImage` 컴포넌트, `generatedImage` prop과 그
   타입, `{generatedImage && <GeneratedImage … />}` 줄을 지운다. 안 쓰이게 된 import를 지운다.
   `generatingImage`와 진행 줄은 그대로 둔다.
5. `apps/agent/app/entry/chat/chat-composer.test.tsx:32`의 `generatedImage={null}`을 지운다.
6. `apps/agent/app/entry/api.ts:180`의 `GeneratedImageAsset`이 안 쓰이면 지운다.
7. `vp run agent#i18n:extract`.

**Verify**:

- `vp run agent#typecheck` → 오류와 경고 없음. `vp check` → exit 0.
- `vp run agent#i18n:check` → exit 0. 문구 내용 검사 → exit 0.
- `cd apps/agent && vp test --run app` → all pass.
- `grep -rn "api.generateImage\|client.media" apps/agent/app/entry` → 출력 없음.

commit한다.

### Step 2. 도구 카드가 생성한 그림을 그린다

1. `apps/agent/app/entry/chat/message.tsx`:
   - `toolLabels`에 `generate_image: msg\`이미지 생성\`,`을 더한다.
   - `decodeDrawing`의 `path`를 `Schema.optionalKey(Schema.String)`으로 바꾸고 주석을
     `/** A result that carries a picture: the SVG a file tool wrote, or a generated image (no path). */`로
     바꾼다.
   - `drawingOf`가 `{ url, path: drawing.path ?? null }`을 돌려주게 한다.
2. `apps/agent/app/entry/chat/images.tsx`의 `DrawingPicture`: `path: string | null`을 받는다. `null`이면
   alt는 `` t`생성한 이미지` ``, 버튼 title은 `` t`크게 보기` ``, 창 제목은 `` t`생성한 이미지` ``다.
   `path`가 있으면 지금과 똑같이 그린다. 주석에 "or of an image the app generated"를 더한다.
3. `vp run agent#i18n:extract`.
4. 테스트를 더한다. `apps/agent/app/entry/chat/message.browser.tsx`에 도구 호출과 결과를 그리는 기존
   테스트가 있으면 그 모양을 따라 하나를 더한다: 이름이 `generate_image`인 호출과 내용이
   `{"preview":{"attachmentId":"<64자 16진수>","mimeType":"image/png"},"route":"media:test","model":"provider_managed"}`인
   결과를 그리면 alt가 "생성한 이미지"인 `img`가 있고, 카드의 이름표가 "이미지 생성"이다. 그 파일에
   도구 카드를 그리는 테스트가 없으면 `drawingOf`를 `export`하고
   `apps/agent/app/entry/chat/message.test.ts`를 새로 써서 두 경우(`path`가 있는 결과, 없는 결과)에
   돌려주는 값을 본다. 어느 쪽으로 했는지 보고에 적는다.

**Verify**:

- `vp run agent#typecheck` → 오류와 경고 없음. `vp check` → exit 0. 두 문구 검사 → exit 0.
- `cd apps/agent && vp test --run app` → all pass.
- `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/` → all pass.

commit한다.

### Step 3. 옛 경로를 지운다

1. `packages/memory-agent/src/api/app-api/media.ts`: `MediaGroup`과 그 주석을 지운다. `GenerateImage`,
   `GeneratedImage`, 거절 셋, `mediaRefusals`는 남긴다. `GenerateImage`의 주석을
   `/** A direct image generation for a conversation; it runs under the conversation's chat model. */`로
   바꾼다. 안 쓰이게 된 import를 지운다.
2. `packages/memory-agent/src/api/app-api.ts`: `MediaGroup` import와 `.add(MediaGroup)`을 지운다.
   `...mediaRefusals`는 남긴다(거절 코드의 상태를 찾는 데 쓴다).
3. `apps/agent/app/.server/api/media.ts`: `MediaApiHandlers`와 안 쓰이게 된 import를 지운다.
   `imageGenerationRefusals`는 남긴다.
4. `apps/agent/app/.server/api.ts`: `MediaApiHandlers` import와 목록의 한 줄을 지운다.

**Verify**:

- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 오류와 경고 없음. `vp check` → exit 0.
- `grep -rn "api/media/image\|MediaGroup\|MediaApiHandlers" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=build`
  → 출력 없음.
- `cd apps/agent && vp test --run app` → all pass.
- `cd packages/memory-agent && vp test --run tests/chat/api.test.ts tests/image-media.test.ts tests/sessions/image-record.test.ts` → all pass.
- 경로나 거절 코드의 목록을 통째로 적어 둔 테스트가 실패하면 그 목록에서 `media` 그룹의 항목만 뺀다.

commit한다.

### Step 4. 문서

- `apps/agent/app/entry/chat/README.md`, `apps/agent/app/entry/media/README.md`(있으면),
  `apps/agent/app/entry/README.md`의 `api` 메서드 목록, `apps/agent/app/.server/api/README.md`,
  `packages/memory-agent/src/api/README.md`, `packages/memory-agent/src/agent/README.md`,
  `apps/agent/README.md`의 이미지 생성 설명을 지금 코드에 맞춘다.
- `docs/decisions.md`의 `## 생성한 이미지는 대화에 도구 호출과 결과로 적는다 (2026-11-16)` 항목에서
  "남은 것" 줄을 아래로 바꾼다.

```md
- 화면은 새 경로를 부르고, 끝나면 대화를 다시 읽는다. 그림은 `generate_image` 도구 카드 아래에 보인다. 입력창 위에 그림을 보이던 자리와 옛 경로 `POST /api/media/image`는 없앴다.
- 만드는 동안에는 메시지를 보내지 못한다. 진행 줄은 입력창 위에 그대로 있다.
- 기록은 한 transaction이다.
- 남은 것: 이미지를 붙인 요청, 키 유무 표시, 설정이 꺼졌을 때 버튼 숨기기, 다른 탭이 생성을 바로 따라오게 하기. 이미지를 만든 대화의 다음 요청을 OpenAI와 Anthropic이 받는지는 실제 호출로 확인해야 한다.
```

**Verify**: `vp check` → exit 0. commit한다.

## Test plan

- `tests/sessions/image-record.test.ts`: 돌려준 메시지 id가 저장된 메시지의 id와 같다.
- `message.browser.tsx` 또는 `message.test.ts`: `path` 없는 `preview` 결과가 그림으로 나온다.
- `chat-composer.test.tsx`가 바뀐 props로 통과한다.
- 실제 이미지 API는 부르지 않는다. 버튼을 눌러 만드는 흐름 전체는 자동 테스트가 없다.

## Done criteria

- [ ] `vp run agent#typecheck`, `vp run memory-agent#typecheck` → exit 0, `error TS`와 `warning` 없음
- [ ] `vp check` → exit 0
- [ ] `vp run agent#i18n:check`, `vp run memory-agent#i18n:check`, 문구 내용 검사 → exit 0
- [ ] 각 단계의 테스트 명령 → all pass
- [ ] `grep -rn "api/media/image\|MediaGroup\|MediaApiHandlers\|generatedImage\|client.media" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=build`
      → 출력 없음
- [ ] `grep -n "generate_image" apps/agent/app/entry/chat/message.tsx` → 한 줄
- [ ] `git diff --stat <시작 commit> HEAD -- packages/memory-agent/src/providers packages/memory-agent/src/loop packages/memory-agent/src/agent/live-runs.ts`
      → 출력 없음
- [ ] `git status --short` → 비어 있다

## STOP conditions

- Drift check가 맞지 않는다.
- 바깥 transaction 안에서 `saveThread`나 `nodes.append`가 실패한다.
- `reopen()`이 답변 중이 아닌 대화에서 메시지를 다시 읽지 않는다(코드를 읽어 그렇게 보이면 보고한다).
- `isApiError`의 `code`가 새 거절 코드를 담지 못한다.
- `mediaRefusals`를 `app-api.ts`에서 빼야만 typecheck가 통과한다.

## Maintenance notes

- 손으로 확인할 것: 이미지 버튼을 켜고 보내 그림이 대화에 남는지, 새로고침 뒤에도 보이는지, 앱을
  다시 시작한 뒤에도 보이는지, 그 대화에서 다음 메시지를 보냈을 때 OpenAI와 Anthropic이 받는지.
- 다른 탭은 그 대화를 다시 열어야 그림을 본다.
- 설계 문서 5절의 나머지(이미지 붙임, 키 유무, 버튼 숨김)는 계획으로 만들지 않았다.
