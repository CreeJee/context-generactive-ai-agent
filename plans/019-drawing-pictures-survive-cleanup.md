# Plan 019: 모델이 그린 SVG 그림이 첨부 정리에서 지워지지 않게 한다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. `plans/README.md`는 고치지 않는다(검토자가 고친다).
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- packages/memory-agent/src/attachments packages/memory-agent/src/memory/record.ts packages/memory-agent/src/layers.ts packages/memory-agent/tests/memory/record.test.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED (모든 채팅 run이 지나는 기록 경로를 고친다)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

모델이 `write_file`이나 `edit_file`로 `.svg`를 쓰면 서버는 그 순간의 모습을 PNG로 구워 첨부로
저장하고, 도구 결과에 `preview { attachmentId, mimeType }`를 붙인다. 화면은 도구 카드 아래에 그
그림을 보인다. 결정은 "파일이 나중에 고쳐지거나 지워져도 그때 그린 그림이 남아야 한다"였다
(`docs/decisions.md`의 2026-09-16 항목 "모델이 그린 SVG는 대화에 그림으로 보여 준다").

그런데 이 첨부는 어디에도 묶이지 않는다. 첨부 정리는 묶이지 않은 첨부를 만든 시각과 상관없이
지운다. 정리는 앱이 시작할 때마다 돈다. 그래서 앱을 다시 시작하면 대화에 남아 있던 그림이
사라진다. 대화 기록의 도구 결과에는 `preview.attachmentId`가 그대로 남아 있지만 그 id의 파일이
없다. 2026-11-15에 사용자의 로컬 DB에서 그런 결과 1건을 확인했다(첨부 행이 없다).

이 계획은 도구 결과를 기록하는 node에 그 그림을 묶는다. 그러면 정리가 지우지 않고, 대화를
지우면 그 node의 연결이 지워져 그림도 함께 정리된다.

## Current state

경로는 모두 `packages/memory-agent/` 기준이다.

### 정리 조건: `src/attachments/attachments.ts:142-152`

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

`purgeOrphans`(`src/attachments/attachments.ts:417`)가 이 문장을 돌리고 파일을 지운다. 부르는 곳은
앱 시작(`src/agent/chat.ts:665`), 대화 삭제가 끝났을 때(`src/agent/chat.ts:2640`), BTW 스레드를 지울
때(`src/btw/store.ts:201`)다.

### 묶는 함수: `src/attachments/attachments.ts:393-407`

```ts
    /** Records the images a message carried, in order. */
    link: (nodeId: string, attachments: readonly Attachment[]) =>
      EffectArray.match(attachments, {
        onEmpty: () => Effect.void,
        onNonEmpty: (carried) =>
          Effect.asVoid(sql`
            INSERT INTO node_attachments ${sql.insert(
              EffectArray.map(carried, (attachment, position) => ({
                node_id: nodeId,
                position,
                attachment_id: attachment.id,
              })),
            )}
            ON CONFLICT DO NOTHING`),
      }),
```

`link`를 부르는 곳은 사용자 턴을 기록하는 세 곳뿐이다(`src/agent/chat.ts:1472`,
`src/queue/delivery.ts:63`, `src/btw/chat.ts:185`). 표는 이렇게 생겼다(`src/db/migrations.ts:946`).

```sql
  CREATE TABLE node_attachments (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (node_id, position)
  );
```

### 그림을 만드는 곳: `src/attachments/previews.ts`

`previewOf`(39–57행)가 `attachments.saveDrawing(svg)`를 부르고 `{ attachmentId, mimeType }`를
돌려준다. `withPreviews`(64–91행)가 결과에 `preview: { ...picture }`를 덧붙인다. 어디에도 묶지
않는다. 이 시점에는 결과를 기록할 node가 아직 없다. node는 step이 끝난 뒤에 생긴다.

```ts
export interface DrawingPreview {
  readonly attachmentId: string;
  readonly mimeType: string;
}
```

### 결과 node를 만드는 곳: `src/memory/record.ts`

```ts
/** A call of a step as the model made it, with its result if it has one. */
interface RecordedCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as the model wrote them. */
  readonly written: string;
  /** None while the call waits for the user. */
  readonly result: Option.Option<{ readonly ok: boolean; readonly text: string }>;
}
```

```ts
const recordedResult = ({ answer }: AnsweredCall) =>
  Match.valueTags(answer, {
    Returned: ({ result }) => ({ ok: !isErrorResult(result), text: jsonText(result) }),
    Failed: ({ message }) => ({ ok: false, text: message }),
    Refused: ({ result }) => ({ ok: !isErrorResult(result), text: jsonText(result) }),
  });
```

`recordStep`(163행부터) 안에서 결과 node를 적는 부분(214–233행쯤)이다. 한 transaction 안에서 돈다.

```ts
// Awaiting approval, or recorded already.
if (Option.isNone(result) || isTruthy(yield * nodes.toolNode(binding.sessionId, "tool_result", id)))
  return;
yield *
  nodes.append({
    ...base,
    // Keep the result in the run that made the call, so history shows them together.
    runId: callNode.runId ?? binding.runId,
    kind: "tool_result",
    text: resultTexts[index] ?? "",
    detail: { toolName: name, toolCallId: id, ok: result.value.ok, permission: permissions[index] },
    links: [{ kind: "returns", nodeId: callNode.id }],
  });
```

`recorderFor`(106행쯤)는 `SqlClient`, `Nodes`, `PermissionReviews`, `SecretRedactor`를 쓴다.
`makeRecordingHook`의 요구 타입과 `make`(330행쯤)의 `Effect.context<...>`가 이 넷을 적고 있다.

```ts
const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient
  >();
```

`Recorder.layer`는 `src/layers.ts:346`에서 `Attachments.layer`(`src/layers.ts:314`)와 같은 조립
안에 있다.

### 이 표를 읽는 다른 곳 (바뀌면 안 되는 동작)

- `forNode`(`attachments.ts:409`)는 `src/agent/history.ts:45`에서 **사용자 node에만** 불린다. 도구
  결과 node에 그림을 묶어도 모델에 보내는 대화 기록은 바뀌지 않는다.
- `inSession`(`attachments.ts:413`)의 SQL은 `kind = 'user'`인 node만 본다(`attachments.ts:139`
  근처). 이 조건을 그대로 둔다.
- 대화를 지우면 `src/work-trace/store.ts:1413`이 그 대화 node들의 `node_attachments` 행을 지운다.
  그 뒤 정리가 그림을 지운다. 고칠 것이 없다.

## Repo conventions to follow

- Effect v4. `let`, `while`, lint 끄는 주석, `unknown` 타입, `async` 함수, `JSON.parse`/
  `JSON.stringify`를 새로 쓰지 않는다(`record.ts`에 이미 있는 `jsonText`의 `JSON.stringify`는 그대로
  둔다). 조건 실행은 `Effect.when`, 값 가르기는 `Option`·`Match`를 쓴다.
- 손으로 줄을 다시 나누지 않는다. 포맷은 `vp check --fix`가 한다.
- 주석은 영어로, 코드가 왜 그런지를 한두 줄로 적는다(이 파일들의 기존 주석과 같은 말투).
- commit 메시지는 한국어 conventional commit이다. 예: `fix(attachments): …`.
- 저장소 루트의 `AGENTS.md`/`CLAUDE.md`를 먼저 읽는다.

## Commands you will need

| Purpose                | Command                                                                    | Expected on success |
| ---------------------- | -------------------------------------------------------------------------- | ------------------- |
| memory-agent typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                            | exit 0, 경고 없음   |
| 포맷·lint              | 저장소 루트에서 `vp check`                                                 | exit 0              |
| 기록 테스트            | `cd packages/memory-agent && vp test --run tests/memory/record.test.ts`    | all pass            |
| 첨부 테스트            | `cd packages/memory-agent && vp test --run tests/chat/attachments.test.ts` | all pass            |

- typecheck는 출력에 `error TS` 줄과 경고 줄이 없는지로 판단한다. pipe 뒤의 exit code를 믿지 않는다.
- lint는 저장소 루트에서 돌린다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.** 전체 테스트를 돌리지 않는다.
- 첨부 테스트는 `sharp` 런타임 패키지를 쓴다. 이 환경에서 그 파일이 고치기 전에도 실패하면 그
  사실을 보고에 적고 넘어간다. STOP이 아니다. 고치기 전의 결과를 Step 1 전에 한 번 적어 둔다.

## Scope

**In scope**:

- `packages/memory-agent/src/attachments/attachments.ts`
- `packages/memory-agent/src/attachments/previews.ts`
- `packages/memory-agent/src/memory/record.ts`
- `packages/memory-agent/src/layers.ts` (필요할 때만. Step 2 참고)
- `packages/memory-agent/tests/memory/record.test.ts`
- `packages/memory-agent/src/attachments/README.md`, `packages/memory-agent/src/memory/README.md`
- `docs/decisions.md` (끝에 항목 하나)

**Out of scope** (건드리지 않는다):

- `deleteOrphans`의 SQL과 `purgeOrphans`. 정리 조건은 그대로다.
- `src/agent/chat.ts`, `src/agent/history.ts`, `src/work-trace/`. 이미지 생성(`src/providers/image-*`)과
  `apps/agent` 전체. 생성한 이미지가 지워지는 문제는 다른 계획(011의 구현)이 다룬다.
- DB migration. 새 표나 열을 만들지 않는다.
- 이미 지워진 그림을 되살리는 일. 되살릴 수 없다.

## Git workflow

- 지금 있는 worktree의 branch에서 일한다. branch를 바꾸지 않고, push하지 않고, PR을 열지 않는다.
- 단계마다 commit한다. `git add <path>`로 고친 파일만 올린다. `--no-verify`를 쓰지 않는다.

## Steps

### Step 1: 그림 id로 묶는 함수와 결과에서 그림을 읽는 함수

`src/attachments/attachments.ts`의 돌려주는 객체에 `link` 다음으로 멤버 하나를 더한다.

```ts
    /**
     * Ties stored pictures to the node that records the result naming them, so cleanup keeps them.
     * An id whose picture is already gone is skipped: the insert reads from `attachments`.
     */
    linkStored: (nodeId: string, attachmentIds: readonly string[]) =>
      Effect.forEach(
        attachmentIds,
        (attachmentId, position) =>
          sql`
            INSERT INTO node_attachments (node_id, position, attachment_id)
            SELECT ${nodeId}, ${position}, id FROM attachments WHERE id = ${attachmentId}
            ON CONFLICT DO NOTHING`,
        { discard: true },
      ),
```

- `INSERT … SELECT … WHERE id = …`로 쓰는 까닭: 그림을 저장한 때와 node를 적는 때 사이에 다른
  대화의 삭제가 정리를 돌리면 그 그림 행이 이미 없을 수 있다. 그때 외래 키 오류로 기록 전체가
  실패하면 안 된다. 없는 id는 조용히 건너뛴다.
- 이 파일의 다른 SQL이 `SqlSchema`로 감싼 모양을 쓰고 있어 lint나 typecheck가 맨 `sql` 문을
  막으면, 같은 파일의 `deleteOrphans`처럼 `SqlSchema.void`(또는 이 파일이 쓰는 같은 종류의 함수)로
  감싼다. 동작은 같아야 한다.

`src/attachments/previews.ts`에 결과에서 그림 id를 읽는 함수를 더하고 export한다. `drawingIn`
가까이에 둔다.

```ts
const decodePreview = Schema.decodeUnknownOption(
  Schema.Struct({ preview: Schema.Struct({ attachmentId: Schema.String }) }),
  { onExcessProperty: "ignore" },
);

/** The pictures a tool result names, for tying them to the node that records the result. */
export const picturesIn = (result: JsonValue): ReadonlyArray<string> =>
  Option.match(decodePreview(result), {
    onNone: () => [],
    onSome: ({ preview }) => [preview.attachmentId],
  });
```

같은 파일의 `decodeWritten`(13–16행)과 같은 방식이다. `result`가 문자열이나 배열이면 빈 배열이
나와야 한다.

**Verify**: `vp run memory-agent#typecheck` → `error TS` 줄과 경고 없음.

### Step 2: 결과 node를 적을 때 그림을 묶는다

`src/memory/record.ts`:

1. import를 더한다: `Attachments`(`../attachments/attachments.ts`), `picturesIn`
   (`../attachments/previews.ts`). `src/attachments/`가 `src/memory/record.ts`를 import하지 않는지
   `rg -n "memory/record" packages/memory-agent/src/attachments`로 확인한다. 결과가 있으면 순환이므로
   STOP이다.
2. `RecordedCall.result`의 모양에 `pictures`를 더한다.

   ```ts
     /** None while the call waits for the user. */
     readonly result: Option.Option<{
       readonly ok: boolean;
       readonly text: string;
       /** Attachment ids of the pictures the result names. */
       readonly pictures: ReadonlyArray<string>;
     }>;
   ```

3. `recordedResult`가 `pictures`를 채운다. `Returned`와 `Refused`는 `picturesIn(result)`, `Failed`는
   빈 배열이다.
4. `recorderFor`에서 `const attachments = yield* Attachments;`를 더한다.
5. 결과 node를 적는 `nodes.append({... kind: "tool_result" ...})`의 반환값을 받아, 바로 뒤에서
   묶는다. 같은 transaction 안이다.

   ```ts
   const resultNode = yield * nodes.append({/* 지금과 같은 인자 */});
   // A drawing's picture is saved before this node exists; tying it here keeps cleanup
   // from deleting what the recorded result still points at.
   yield * attachments.linkStored(resultNode.id, result.value.pictures);
   ```

   `nodes.append`가 node를 돌려주는지는 같은 함수의 `callNode`(`nodes.append`의 결과를 `.id`로
   쓴다)로 확인된다.

6. 요구 타입을 맞춘다. `makeRecordingHook`의 반환 타입 주석과 `make`의 `Effect.context<...>`에
   `Attachments`를 더한다.

   ```ts
   const context =
     yield *
     Effect.context<
       Attachments | Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient
     >();
   ```

7. `vp run memory-agent#typecheck`를 돌린다. `Recorder.layer`를 조립하는 곳에서 `Attachments`가
   빠졌다는 오류가 나면 `src/layers.ts`에서 `Recorder.layer`에 `Attachments.layer`가 닿게 한다
   (같은 파일의 다른 layer가 `Layer.provide`로 받는 방식을 따른다). `src/layers.ts`와 테스트 지원
   파일 밖에서 layer를 고쳐야 하면 STOP이다.

**Verify**: `vp run memory-agent#typecheck` → `error TS` 줄과 경고 없음.
`cd packages/memory-agent && vp test --run tests/memory/record.test.ts` → 기존 테스트 all pass.

### Step 3: 테스트

`packages/memory-agent/tests/memory/record.test.ts`에 테스트 둘을 더한다. 같은 파일의
"stores every message of a tool-using run with structural edges"(77행)가 본보기다: `userTurn`,
`scriptedRun`, `runTool`, `(yield* Recorder).hookFor(...)`를 같은 방식으로 쓴다. 작은 PNG는
`tests/support/images.ts`의 `tinyPng`를 쓴다(`tests/chat/attachments.test.ts`가 쓰는 방식을 본다).

1. "a result's picture stays through attachment cleanup"
   - `const attachments = yield* Attachments;`
   - `const picture = yield* attachments.save(tinyPng);` (`tinyPng`의 타입이 `Uint8Array`가 아니면
     `tests/chat/attachments.test.ts`가 넘기는 모양을 그대로 따른다.)
   - `write_file`이라는 이름의 `runTool`을 만든다. handler는
     `Effect.succeed({ path: "a.svg", preview: { attachmentId: picture.id, mimeType: picture.mimeType } })`.
   - `scriptedRun`으로 그 도구를 한 번 부르는 run을 돌린다(도구 호출 id `call-1`).
   - `expect(yield* attachments.purgeOrphans).toBe(0);`
   - `expect(yield* attachments.get(picture.id)).not.toBeNull();`
   - 결과 node에 묶였는지 본다: `const node = yield* nodes.toolNode(session.id, "tool_result", "call-1");`
     뒤에 `expect((yield* attachments.forNode(node!.id)).map(({ id }) => id)).toEqual([picture.id]);`
     (이 파일이 `!`를 쓰지 않는 방식으로 node를 다루고 있으면 그 방식을 따른다.)
2. "a picture no result names is removed by cleanup" (대조)
   - `attachments.save(tinyPng)`만 하고 run을 돌리지 않는다.
   - `expect(yield* attachments.purgeOrphans).toBe(1);`
   - `expect(yield* attachments.get(picture.id)).toBeNull();`

   두 테스트가 같은 DB를 쓰면 첫 테스트의 그림과 id가 같아(내용 해시) 서로 영향을 준다. 이 파일의
   테스트들이 테스트마다 새 환경을 쓰는지(`testAgent()`) 확인하고, 아니면 대조 테스트에는 다른
   바이트의 그림을 쓴다.

테스트 환경에 `Attachments`가 없다는 타입 오류가 나면 `tests/support/test-env.ts`가 무엇을
제공하는지 읽고, `tests/chat/attachments.test.ts`가 `Attachments`를 얻는 방식을 따른다.

**Verify**: `cd packages/memory-agent && vp test --run tests/memory/record.test.ts` → all pass, 새
테스트 2개 포함. 첫 테스트는 Step 2를 되돌리면 실패해야 한다(`purgeOrphans`가 1을 돌려준다).
되돌려 보지는 않아도 되지만, 단언이 그 차이를 잡는 모양인지 읽어 확인한다.

### Step 4: 문서

- `packages/memory-agent/src/attachments/README.md`: Invariants에 한 줄. 도구 결과가 가리키는 그림은
  그 결과를 기록하는 `tool_result` node에 묶인다(`linkStored`). 묶기 전(저장부터 step 끝까지)에는
  정리 대상이다. API 목록에 `linkStored`와 `picturesIn`을 적는다.
- `packages/memory-agent/src/memory/README.md`: `Recorder`가 `Attachments`를 쓰고, 결과 node에 그림을
  묶는다는 것을 적는다. SQLite 쓰기 목록에 `node_attachments`를 더한다.
- `docs/decisions.md` 끝에 항목 하나(2026-11-15). 계기(그림이 어디에도 묶이지 않아 앱을 다시
  시작하면 지워졌다. 2026-09-16의 "그때 그린 그림이 남아야 한다"가 지켜지지 않았다), 결정(결과를
  기록하는 node에 묶는다. 대화를 지우면 함께 정리된다. 정리 조건은 그대로), 남는 틈(저장부터
  step 끝 사이에 다른 대화의 삭제가 정리를 돌리면 그 그림은 지워진다. 그때 기록은 실패하지 않고
  그림만 없다), 하지 않은 것(이미 지워진 그림은 되살리지 못한다). 문서의 말투(평서문 "~다")를
  따른다.

**Verify**: `vp check` → exit 0.

## Test plan

- `tests/memory/record.test.ts`에 2개를 더한다(Step 3).
- `tests/chat/attachments.test.ts`는 고치지 않는다. 돌려서 고치기 전과 결과가 같은지만 본다.

## Done criteria

- [ ] 저장소 루트에서 `vp run memory-agent#typecheck` → `error TS` 줄과 경고 없음
- [ ] 저장소 루트에서 `vp check` → exit 0
- [ ] `cd packages/memory-agent && vp test --run tests/memory/record.test.ts` → all pass, 새 테스트 2개 포함
- [ ] `cd packages/memory-agent && vp test --run tests/chat/attachments.test.ts` → 고치기 전과 같은 결과
- [ ] `rg -n "linkStored" packages/memory-agent/src --glob '!*.md'` → `attachments.ts`의 정의 하나와 `record.ts`의 쓰임 하나
- [ ] `git diff --stat d65cc285..HEAD`에 "In scope" 밖의 파일이 없다
- [ ] `rg -n "DELETE FROM attachments" packages/memory-agent/src/attachments/attachments.ts`의 문장이 바뀌지 않았다

## STOP conditions

- `src/attachments/`가 `src/memory/record.ts`를 import한다(순환).
- `Attachments`를 `Recorder`에 닿게 하려면 `src/layers.ts`와 테스트 지원 파일 밖의 layer 조립을
  고쳐야 한다.
- `nodes.append`가 만든 node의 id를 돌려주지 않는다.
- 도구 결과가 `recordedResult`에 올 때 `preview.attachmentId`가 이미 가려져 있다(비밀 가리기가 64자
  hex를 바꾼다). Step 3의 첫 테스트가 그 까닭으로 실패하면 멈추고 실패 메시지를 보고한다.
- 기존 `record.test.ts` 테스트가 이 변경으로 실패하고, 까닭이 단언의 낡음이 아니라 동작 변화다.

## Maintenance notes

- 011의 구현(생성한 이미지를 대화에 남기기)은 같은 `linkStored`를 쓰면 된다. 결과 JSON에
  `preview.attachmentId`를 넣으면 이 계획의 경로가 그대로 묶는다.
- `forNode`를 사용자 node 밖에서 부르게 바꾸면, 도구 결과의 그림이 모델에 보내는 대화 기록에
  끼어든다. 그때는 node 종류로 걸러야 한다.
- 검토자가 볼 것: `recordStep`의 transaction 안에서 묶는가, `Failed` 결과에 그림이 없는가, 정리
  SQL이 그대로인가.
- 서버 코드가 바뀌므로 개발 서버를 다시 시작해야 적용된다.
