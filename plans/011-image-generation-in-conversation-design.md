# Plan 011: 생성한 이미지를 대화에 남기는 설계를 정한다 (조사와 설계 문서)

> **Executor instructions**: 이 계획은 **설계 계획**이다. 소스 코드를 고치지 않는다. 순서대로
> 조사하고, 끝에 설계 문서 하나를 쓴다. "STOP conditions"에 해당하면 멈추고 보고한다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/media apps/agent/app/entry/chat/chat-composer.tsx apps/agent/app/.server/api/media.ts packages/memory-agent/src/api/app-api/media.ts packages/memory-agent/src/providers/image-media.ts packages/memory-agent/src/providers/image-media-contracts.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 설계 문서의 "지금 동작" 절을
> 실제 코드에 맞춰 쓴다(이 계획은 코드를 고치지 않으므로 STOP이 아니다).

## Status

- **Priority**: P3
- **Effort**: M (조사와 문서. 구현은 이 계획에 없다)
- **Risk**: LOW
- **Depends on**: none (Plan 008이 먼저 들어가 있으면 그 결과를 설계에 반영한다)
- **Category**: direction
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

이미지 생성은 켤 수 있고 돈이 드는 기능인데, 만든 이미지가 대화에 남지 않는다. 사용자가
2026-11-14에 정했다: 이미지 생성을 제대로 만든다.

지금 확인된 것:

- 만든 이미지는 입력창 **위**에 한 번 보인다. 대화 기록에 들어가지 않는다. 그 값은 브라우저의
  mutation 상태뿐이라 채팅 패널이 다시 마운트되면(다른 대화로 갔다 오기, 새로고침) 사라진다.
- 생성 요청(`POST /api/media/image`)은 대화 id를 받지 않는다. 서버는 어느 대화에서 만든 것인지
  모른다.
- 이미지는 첨부 파일로 저장된다. 그런데 어디에도 묶이지 않은 첨부를 지우는 정리
  (`attachments.purgeOrphans`)가 앱이 시작할 때와 대화의 보관·삭제가 끝날 때 돈다. 그 조건은
  "대화 node, BTW, 대기 메시지 어느 것에도 묶이지 않은 첨부"이고 시간 조건이 없다. 생성한 이미지는
  저장만 되고 묶이지 않는 것으로 보인다. 그렇다면 다음 정리 때 파일이 지워진다. Step 2가 이것을
  확정한다.
- 이미지를 붙인 요청은 막혀 있다("첫 버전의 이미지 생성은 텍스트 프롬프트만 지원합니다").
- 사용량을 JSON 글자 그대로 보인다.
- 설정의 스위치는 OpenAI API 키가 있는지와 상관없이 켜진다. 키는 서버의 환경 변수에서 읽는다.

구현 방법이 둘 이상이고 저장 구조에 닿는다. 그래서 먼저 설계를 정한다. 이 계획의 산출물은
사용자가 읽고 고를 수 있는 설계 문서다.

## Current state

### 관련 파일

- `apps/agent/app/entry/media/use-image-generation.ts` — 생성 요청, 교차 공급자 동의, 결과 상태.
- `apps/agent/app/entry/media/cross-provider-approval.tsx` — Claude 대화에서 OpenAI로 보내는 동의 창.
- `apps/agent/app/entry/chat/chat-composer.tsx` — `GeneratedImage`(41–70행), 이미지 생성 버튼(330–364행).
- `apps/agent/app/entry/chat/chat-panel.tsx` — 보내기 흐름에서 이미지 요청으로 갈리는 곳(957–962행),
  "이미지를 만들까요?" 확인 창(1197–1225행).
- `apps/agent/app/entry/api.ts:777-788` — `api.generateImage`.
- `packages/memory-agent/src/api/app-api/media.ts` — `/api/media/image`의 선언.
- `apps/agent/app/.server/api/media.ts` — 그 handler.
- `packages/memory-agent/src/providers/image-media.ts` — `ImageMediaWorkflow`: 승인 → 경로 고르기 →
  실행 → 첨부 저장.
- `packages/memory-agent/src/providers/image-media-contracts.ts` — `ImageMediaAsset`.
- `packages/memory-agent/src/attachments/attachments.ts` — 첨부 저장, `deleteOrphans`(143행),
  `purgeOrphans`(417행).
- `packages/memory-agent/src/agent/chat.ts` — 665행(시작할 때)과 2640행(대화의 보관·삭제가 끝날 때)에서
  `attachments.purgeOrphans`를 부른다. 1614행부터 채팅 run이
  `forwardedProps.imageIntent === "generate_image"`를 다루는 다른 경로가 있다.
- `packages/memory-agent/src/chat-store/schema.ts` — 저장되는 메시지의 모양. 16행에 `image` 부분이 있다.
- `packages/memory-agent/src/providers/README.md` — 이미지 경로의 불변식(Invariants 절).
- `docs/decisions.md` — "화면 데이터와 이미지 생성 흐름 (2026-09-24)"(2015행 근처),
  "화면 메시지는 transcript 구간으로 저장한다 (2026-11-04)", "이미지 첨부 (2026-09-14)".

### 발췌

`packages/memory-agent/src/api/app-api/media.ts:12-20,43-49`:

```ts
/** A direct image generation; it runs under the chat model the app has selected. */
export const GenerateImage = Schema.Struct({
  prompt: Schema.NonEmptyString,
  /** The user agreed to a paid generation. */
  approved: Schema.Boolean,
  runId: Schema.optionalKey(Schema.String),
  crossProviderApproval: Schema.optionalKey(CrossProviderMediaRunApproval),
  maximumEstimatedCostUsd: Schema.optionalKey(Schema.Finite),
});
// ...
/** Media the page asks for directly, outside the chat's tools (`/api/media/*`). */
export class MediaGroup extends HttpApiGroup.make("media")
  .add(
    /** A paid image generation; the page asks the user before it calls. */
    HttpApiEndpoint.post("generateImage", "/api/media/image", {
```

`apps/agent/app/.server/api/media.ts:16-30` — 대화를 모르고, 앱의 기본 선택으로 시작 경로를 적는다:

```ts
const selected = yield * Effect.orDie(active.selected);
if (selected === null)
  return (
    yield *
    Effect.fail({
      error: "image_route_unavailable",
      reason: "no chat model selected",
    } as const)
  );
// The paid request stops when the page goes away and the handler is interrupted.
const signal = yield * Effect.abortSignal;
const asset =
  yield *
  workflow.generate({
    ...payload,
    initiatorChatRouteId: `chat:${selected.provider}:${selected.model}`,
    signal,
  });
return { ...asset, url: `/api/attachments/${encodeURIComponent(asset.attachment.id)}` };
```

`apps/agent/app/entry/media/use-image-generation.ts:66-74` — 결과는 mutation 상태뿐이다:

```ts
return {
  intent,
  clearIntent,
  toggleIntent,
  settings,
  generating: generation.isPending,
  asset: generation.isPending ? null : (generation.data ?? null),
  generate,
};
```

`apps/agent/app/entry/chat/chat-composer.tsx:220-225` — 입력창 위에 그린다:

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

`apps/agent/app/entry/chat/chat-composer.tsx:47,62-66` — 사용량을 글자 그대로 보인다:

```tsx
const usage = JSON.stringify(image.usage);
// ...
{
  image.usage && (
    <div>
      <Trans>사용량: {usage}</Trans>
    </div>
  );
}
```

`apps/agent/app/entry/chat/chat-panel.tsx:957-962`:

```tsx
if (!generating && media.intent) {
  if (attachmentIds.length > 0)
    return setNotice(problem(t`첫 버전의 이미지 생성은 텍스트 프롬프트만 지원합니다.`));
  // A paid media model may run, so the dialog asks before `generateImage` does.
  return setImagePrompt(text);
}
```

`packages/memory-agent/src/attachments/attachments.ts:142-152` — 묶이지 않은 첨부를 지우는 문장:

```ts
// One statement decides and deletes, so a link added meanwhile keeps its blob.
const deleteOrphans = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AttachmentRow,
  execute: () => sql`
      DELETE FROM attachments AS a
      WHERE NOT EXISTS (SELECT 1 FROM node_attachments n WHERE n.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM btw_attachments b WHERE b.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM queued_message_attachments q WHERE q.attachment_id = a.id)
      RETURNING *`,
});
```

`packages/memory-agent/src/providers/image-media.ts:223,387` — workflow는 `attachments.save`만 받는다
(`readonly attachments: Pick<AttachmentsApi, "save">`). 묶는 함수를 받지 않는다.

`packages/memory-agent/src/providers/README.md`의 Invariants에서 이 설계가 지켜야 할 것:

- 운영 이미지 경로는 `productionEnabled && verification === "verified"`인 계약만이다.
  `openai:provider_tool:image_generation`은 unverified·비활성이다.
- `decideImageContext`: 사용자 설정이 켜져 있고, 명시적인 `generate_image` 의도가 있고, 고른 경로가
  있어야 허용한다. 공급자 도구 주입은 `provider_tool` 모드에서만, 직접 실행은 `direct_adapter`에서만이다.
- 실패 뒤 사용자 확인 없이 다른 유료 경로로 다시 시도하거나 바꾸지 않는다.
- `ImageMediaWorkflow.generate`는 `approved`가 false면 먼저 `ImageMediaApprovalRequired(paid_execution)`로
  실패한다.
- 교차 공급자 동의가 없으면 기본은 `disabled`다.

### 따라야 할 규칙

- **소스 코드를 고치지 않는다.** 읽기와 읽기 전용 명령만 쓴다.
- `~/.context-generactive-agent/agent.db`는 `sqlite3 -readonly`로만 연다. 개수와 스키마만 본다.
  대화 내용이나 프롬프트를 문서에 옮기지 않는다.
- 이미지 생성 API를 실제로 부르지 않는다. 돈이 든다.
- API 키나 토큰의 값을 문서에 적지 않는다. 있는 곳(`file:line`)과 종류만 적는다.
- 설계 문서는 한국어 평서문("…한다")으로 쓴다. 만들어 낸 용어를 쓰지 않는다. 코드의 이름은 그대로 쓴다.
- 코드 위치를 찾을 때는 CodeGraph(`codegraph_explore`)를 먼저 쓴다(`AGENTS.md`). 문자열로만 나오는
  이름(API 경로, SQL 열)은 `rg`로 찾는다.

## Commands you will need

| Purpose                      | Command                                                                                                                                                                   | Expected on success |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 첨부와 메시지의 연결 스키마  | `sqlite3 -readonly ~/.context-generactive-agent/agent.db ".schema attachments" ".schema node_attachments" ".schema queued_message_attachments" ".schema btw_attachments"` | 표 정의가 나온다    |
| 어디에도 묶이지 않은 첨부 수 | Step 2에서 `purgeOrphans`의 SQL을 읽고 같은 조건으로 `select count(*)`를 쓴다                                                                                             | 숫자 하나           |
| 문서 포맷·lint               | 저장소 루트에서 `vp check`                                                                                                                                                | exit 0              |
| 문구 검사                    | 저장소 루트에서 `node lint/wording/check/main.ts check`                                                                                                                   | exit 0              |

## Scope

**In scope**:

- `docs/designs/image-generation-in-conversation.md` (새 파일. 이 계획의 산출물)
- `plans/README.md` (이 계획의 행)

**Out of scope**:

- 모든 소스 코드, 테스트, 설정 파일.
- `docs/decisions.md`. 결정은 사용자가 설계 문서를 읽고 고른 뒤에 적는다.
- 실제 구현. 사용자가 방법을 고르면 별도 계획으로 쓴다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add docs/designs/image-generation-in-conversation.md plans/README.md`만 올린다.
- commit 하나. 메시지: `docs(designs): 생성한 이미지를 대화에 남기는 설계를 적는다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 지금 동작을 끝까지 따라간다

아래를 코드에서 확인하고, 각 답에 `file:line`을 붙여 메모한다.

1. 사용자가 이미지 생성 버튼을 켜고 보내면 일어나는 일의 순서: `chat-panel.tsx`의 보내기 흐름 →
   확인 창 → `use-image-generation.ts` → `api.generateImage` → handler → `ImageMediaWorkflow.generate` →
   첨부 저장 → 응답 → `GeneratedImage`.
2. 그 사이에 대화 기록(`chat_thread_messages`, `chat_thread_display_messages`, `nodes`)에 쓰이는 것이
   있는가. 없다면 그렇다고 적는다.
3. 프롬프트 글자는 어디로 가는가. 입력창에서 지워지는가, 남는가.
4. `chat.ts:1614` 근처의 다른 경로: 채팅 run이 `forwardedProps.imageIntent`를 받는 경우는 언제이고,
   지금 그 경로로 실제로 이미지가 만들어질 수 있는가(Invariants의 "unverified·비활성"과 견준다).
   화면의 어느 코드가 `imageIntent`를 run에 싣는가(`rg -n "imageIntent" apps/agent/app packages/memory-agent/src`).

**Verify**: 네 질문 모두에 `file:line`이 붙은 답이 있다.

### Step 2: 생성한 이미지가 살아남는지 확인한다

1. `attachments.ts`의 `deleteOrphans`가 쓰는 SQL을 읽는다. "묶이지 않은 첨부"의 조건을 정확히 적는다
   (어느 표에 행이 없으면 고아인가, 만든 지 얼마가 지나야 하는가).
2. `ImageMediaWorkflow`가 첨부를 저장할 때(`image-media.ts:387` 근처) 그 조건을 벗어나게 하는
   연결을 만드는가.
3. 결론을 한 문장으로 적는다: 생성한 이미지는 앱을 다시 시작하면 (지워진다 / 남는다), 근거는 ….
4. 같은 조건으로 지금 DB의 고아 첨부 수를 센다(읽기 전용). 숫자만 적는다.

**Verify**: 결론 문장과 그 근거의 `file:line` 둘 이상.

### Step 3: 대화에 남기는 방법을 견준다

적어도 아래 두 방법을 코드에 비춰 견준다. 더 나은 방법이 보이면 더한다.

**방법 A — 대화에 묶인 직접 생성.** 화면이 지금처럼 버튼과 확인 창으로 요청하되, 요청이 대화 id를
싣는다(`POST /api/sessions/:session/images` 같은 새 경로, 또는 지금 경로에 `sessionId`). 서버가
생성 뒤에 그 대화의 기록에 두 메시지를 적는다: 사용자의 프롬프트, 그리고 이미지를 담은 답.
모델은 부르지 않는다.

**방법 B — 채팅 run 안의 도구.** 이미지 생성을 모델이 부르는 도구로 둔다. 사용자가 버튼을 켜고
보내면 그 턴에서만 도구가 보이고, 호출은 기존 승인 카드를 거친다. 결과는 도구 결과로 기록되고,
기본 skill `draw`의 SVG처럼 도구 카드 아래에 그림이 보인다.

방법마다 아래를 답한다. 답마다 근거 코드의 `file:line`을 붙인다.

1. 기록: 어느 표에 무엇을 적는가. `chat-store/schema.ts`의 메시지 부분 중 무엇을 쓰는가(16행의
   `image` 부분이 답에 쓸 수 있는 모양인가, 사용자 메시지 전용인가). `docs/decisions.md`의 "화면
   메시지는 transcript 구간으로 저장한다 (2026-11-04)"와 맞는가.
2. 첨부: Step 2의 고아 조건을 어떻게 벗어나는가.
3. 다시 열기: 새로고침, 다른 탭의 읽기 전용 화면, 이전 쪽 불러오기에서 그 이미지가 보이는가.
4. 기억: 그 프롬프트와 이미지가 기억 검색에 들어가야 하는가. 들어간다면 어떤 node로.
5. 다음 턴: 모델이 그 이미지를 볼 수 있는가(이미지를 읽는 모델일 때). 봐야 하는가.
6. 승인과 돈: 유료 실행 확인(`approved`)과 교차 공급자 동의가 어디서 일어나는가. Invariants의
   다섯 항목을 모두 지키는가. 하나라도 못 지키면 그 방법은 탈락이라고 적는다.
7. 한 대화 한 run: 답변 중에 요청하면 어떻게 되는가(지금은 "답변이 끝난 뒤 별도 요청으로"라고
   막는다, `chat-panel.tsx:964-967`). 대기열과 어떻게 만나는가.
8. 모델 고르기: 시작 경로(`initiatorChatRouteId`)를 무엇으로 적는가. Plan 008이 들어가 있으면 대화의
   모델(`session.model`)을 쓴다. 호환 공급자 대화에서는 지금 막혀 있다
   (`chat.ts`의 `provider_image_generation_unavailable`). 그대로 둘 것인가.
9. 화면: 입력창 위의 `GeneratedImage`와 "생성하고 있습니다…" 줄은 어디로 가는가. 생성 중 표시는
   대화의 어디에 보이는가.
10. 바꿔야 할 파일의 목록과 크기 어림(S/M/L). 새 표나 migration이 필요한가.
11. 깨질 수 있는 것: 무엇을 시험해야 하는가.

**Verify**: 방법마다 11개 답이 있다. 근거 없는 답에는 "확인 못 함"이라고 적는다.

### Step 4: 곁가지 문제의 처리도 정한다

각각 한 단락으로, 권하는 처리와 바꿀 파일을 적는다.

1. 이미지를 붙인 요청(이미지 고치기). 지금은 막혀 있다. 이번 범위에 넣을지, 계속 막을지. 막는다면
   문구("첫 버전의…")를 어떻게 바꿀지.
2. 사용량 표시. `image.usage`(이름 → 숫자의 표)를 어떻게 읽히게 보일지, 또는 접어 둘지.
3. 키 유무. 설정의 이미지 쪽이 OpenAI API 키가 있는지 보이게 할지. 상태 응답
   (`packages/memory-agent/src/api/app-api/settings.ts`의 이미지 상태)에 무엇을 더해야 하는지.
   키의 값은 어디에도 싣지 않는다.
4. 켜지 않았을 때의 버튼. 지금은 꺼진 채 자리를 차지한다(`chat-composer.tsx:330-364`). 숨길지.

**Verify**: 네 단락이 있다.

### Step 5: 설계 문서를 쓴다

`docs/designs/image-generation-in-conversation.md`를 쓴다. 같은 폴더의 `cli-import.md`,
`workflow-normalization.md`의 머리 구성을 먼저 읽고 맞춘다. 절:

1. **요약** — 세 문장 안. 무엇이 문제이고, 무엇을 권하는가.
2. **지금 동작** — Step 1과 Step 2의 답. `file:line`을 붙인다.
3. **방법** — Step 3의 방법들. 방법마다 11개 답을 표 하나로 모으고, 그 아래에 풀어 쓴다.
4. **권하는 방법과 까닭** — 하나를 고른다. 고르지 못하면 무엇을 알아야 고를 수 있는지 적는다.
5. **곁가지** — Step 4.
6. **사용자가 정할 것** — 질문 목록. 질문마다 권하는 답을 붙인다. 다섯 개를 넘기지 않는다.
7. **구현 순서 어림** — 권하는 방법을 단계로 나눈 것. 단계마다 바꿀 파일과 확인 방법. 이것은
   다음 계획의 재료다.

**Verify**: `vp check` → exit 0. `node lint/wording/check/main.ts check` → exit 0.
`rg -c "file:line|\.tsx?:[0-9]+" docs/designs/image-generation-in-conversation.md` → 15 이상
(근거가 붙어 있다).

## Test plan

- 코드를 고치지 않으므로 테스트가 없다.
- 문서의 근거 줄 번호가 실제 코드와 맞는지 스스로 세 곳을 뽑아 다시 확인한다.

## Done criteria

- [ ] `docs/designs/image-generation-in-conversation.md`가 있고 일곱 절을 모두 가진다
- [ ] 문서에 방법이 둘 이상 있고, 방법마다 11개 항목의 답이 있다
- [ ] 문서에 "사용자가 정할 것" 절이 있고 질문마다 권하는 답이 있다
- [ ] `git status --short`에 `docs/designs/image-generation-in-conversation.md`와 `plans/README.md` 밖의 수정이 없다
- [ ] `vp check` exits 0
- [ ] `plans/README.md`의 행을 고쳤다(상태는 DONE이 아니라 "설계 문서 작성됨, 사용자 선택 대기")

## STOP conditions

- 두 방법 모두 `providers/README.md`의 Invariants 가운데 하나를 깨야만 된다. 어느 항목인지 보고한다.
- 대화 기록에 모델이 만들지 않은 답을 적는 길이 저장 계층에 없다(run 없이 메시지를 적을 수 없다).
  이것은 방법 A의 전제다. 그렇다면 그 사실을 근거와 함께 보고하고, 방법 B만으로 문서를 쓴다.
- 조사에 소스 수정이나 이미지 API 호출이 필요해진다.
- 로컬 DB를 읽을 수 없다. 그 부분은 "확인 못 함"으로 두고 계속한다(STOP이 아니다).

## Maintenance notes

- 이 계획이 끝나면 사용자가 설계 문서의 질문에 답하고, 그 답으로 구현 계획을 따로 쓴다.
- Plan 008(대화별 모델)이 먼저 들어가면 시작 경로를 대화의 모델로 적을 수 있다. 들어가지 않았으면
  문서에 그 의존을 적는다.
- Plan 009가 입력창 아래줄에 선택기를 더한다. 이미지 생성 버튼의 자리는 그 줄의 맨 앞이다. 버튼을
  숨기거나 옮기는 결정은 이 문서의 "곁가지 4"에서 한다.
- 리뷰에서 볼 곳: 권하는 방법이 유료 실행 확인과 교차 공급자 동의를 건너뛰지 않는가. 근거 없는
  단정이 없는가.
