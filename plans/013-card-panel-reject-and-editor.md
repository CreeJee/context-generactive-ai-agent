# Plan 013: 카드 패널에서 바로 거절하고, 의존 카드를 골라 넣고, 드문 항목을 접는다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/chat/board/card-peek.tsx apps/agent/app/entry/chat/board/board-surface.tsx`
> Plan 012가 `board-surface.tsx`에 배지 둘(`PlannerStalledBadge`, `ReplanWaitBadge`)을 더한 것은
> 예상된 차이다. `card-peek.tsx`가 바뀌었으면 "Current state"의 발췌와 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (012와 순서가 바뀌어도 된다)
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

카드 패널(카드를 누르면 오른쪽에 뜨는 패널)에 네 가지 불편이 있다.

1. 승인을 기다리는 카드를 거절하려면 "편집" → "카드 취소" → 확인의 세 단계를 거친다. 승인은 버튼
   하나다. 패널에는 "거절하려면 편집에서 카드를 취소해 주십시오."라는 안내문이 있다.
2. 편집기에서 의존 카드를 카드 id의 쉼표 목록으로 손으로 적는다. 카드 id는 화면의 작은 글자를
   보고 외워야 한다. 로컬 DB의 카드 161장 가운데 126장이 의존 카드를 가진다.
3. 편집기에 경계, 위험, 필요한 근거, 사람 판단의 네 항목이 늘 펼쳐져 있다. 로컬 DB의 카드 161장
   가운데 위험을 적은 카드가 2장이고 나머지 셋은 0장이다. 자주 쓰는 네 항목(제목, 설명, 의존
   카드, 완료 조건)이 그만큼 밀린다.
4. 카드가 몇 번 실패했고 몇 번 다시 짜였는지 보이지 않는다. 서버는 이 수를 이미 준다.

이 계획 뒤에는:

- 승인 블록에 "승인" 옆에 "거절"이 있다. 누르면 확인을 한 번 묻고 카드를 취소한다.
- 의존 카드는 같은 Plan의 카드 제목을 눌러 고른다.
- 드문 네 항목은 "추가 조건" 안에 접힌다. 값이 있는 카드는 펼쳐진 채로 열린다.
- 카드 상세에 "실행 기록"(연속 실패, Plan 재작성, 충돌 해결 횟수)이 나온다. 모두 0이면 나오지 않는다.

## Current state

### 관련 파일

- `apps/agent/app/entry/chat/board/card-peek.tsx` — `CardPeek`, `CardDetails`, `CardEditor`,
  `contractFields`. 832행.
- `apps/agent/app/entry/chat/board/board-surface.tsx` — `CardPeek`를 그리고 props를 넘긴다.
- `apps/agent/app/entry/chat/board/project-board.tsx:211-228` — 여러 개를 고르는 `ToggleGroup`의 본보기.
- `apps/agent/app/entry/chat/board/project-board.browser.tsx` — 브라우저 테스트의 본보기.

### 발췌

`card-peek.tsx:79-114` — 폼의 모양과 변환:

```tsx
/** The text without its surrounding spaces, unless nothing is left. */
const trimmed = (text: string) => {
  const kept = text.trim();
  return kept.length > 0 ? Result.succeed(kept) : Result.failVoid;
};
const lines = (text: string) => Arr.filterMap(text.split("\n"), trimmed);
const ids = (text: string) => Arr.filterMap(text.split(","), trimmed);

/** The editor's text fields; contract fields left empty are cleared. */
interface CardForm {
  readonly title: string;
  readonly description: string;
  readonly dependsOn: string;
  readonly acceptanceCriteria: string;
  readonly boundaries: string;
  readonly risk: CardRisk | "none";
  readonly requiredEvidence: string;
  readonly humanDecision: string;
}

const formOf = (card: PlanStep | null): CardForm => ({
  title: card?.title ?? "",
  description: card?.description ?? "",
  dependsOn: card?.dependsOn.join(", ") ?? "",
  acceptanceCriteria: card?.acceptanceCriteria.join("\n") ?? "",
  boundaries: card?.boundaries?.join("\n") ?? "",
  risk: card?.risk ?? "none",
  requiredEvidence: card?.requiredEvidence?.join("\n") ?? "",
  humanDecision: card?.humanDecision ?? "",
});
```

`card-peek.tsx:238-265` — 승인 블록:

```tsx
{
  card.approval !== undefined && (
    <div className="space-y-2 rounded-md border px-3 py-2" role="status">
      <p>
        <Trans>
          Plan 작성자가 실행 중에 더한 카드라 승인을 기다립니다. 승인하기 전에는 실행하지 않습니다.
        </Trans>
      </p>
      {card.approval.review !== undefined && (
        <p className="whitespace-pre-wrap text-muted-foreground">
          <Trans>자동 검토: {ph({ reason: card.approval.review.reason })}</Trans>
        </p>
      )}
      <p className="text-muted-foreground">
        <Trans>거절하려면 편집에서 카드를 취소해 주십시오.</Trans>
      </p>
      <Button
        type="button"
        size="sm"
        disabled={disabled || closed || intentPending}
        onClick={() => onIntent("Approve", card.id)}
      >
        <Trans comment="Button in the card panel that approves the card to run">승인</Trans>
      </Button>
    </div>
  );
}
```

`card-peek.tsx:313-318` — 상세를 그리는 곳:

```tsx
<CardDetails card={card} titleOf={titleOf} outcomeOf={outcomeOf} lastChange={lastChange} />
```

`card-peek.tsx:553-561` — 상세의 마지막 항목(새 항목을 이 앞에 둔다):

```tsx
<DataListItem
  term={<Trans comment="Card field: who changed the card last, and when">마지막 변경</Trans>}
>
  {lastChange === null
    ? authorLabel(null)
    : `${authorLabel(lastChange.author)} · ${koreanLocalTime(lastChange.at)}`}
</DataListItem>
```

`card-peek.tsx:585-590` — 편집기의 상태:

```tsx
const [form, setForm] = useState<CardForm>(() => formOf(card));
const [error, setError] = useState<string | null>(null);
const set = (key: keyof CardForm) => (value: string) => setForm({ ...form, [key]: value });
const executing = card?.status === "in_progress";

const submit = (change: BoardEdit) => void onSubmit(change).then((message) => setError(message));
```

`card-peek.tsx:672-686` — 의존 카드 입력:

```tsx
<Field>
  <FieldLabel htmlFor="card-depends">
    <Trans comment="Card editor field: ids of the cards this card waits for">의존 카드</Trans>
  </FieldLabel>
  <Input
    id="card-depends"
    value={form.dependsOn}
    onChange={(event) => set("dependsOn")(event.target.value)}
  />
  <FieldDescription>
    <Trans>카드 id를 쉼표로 구분합니다.</Trans>
  </FieldDescription>
</Field>
```

`card-peek.tsx:700-753` — 접을 네 `Field`: 경계(`card-boundaries`), 위험(`card-risk`), 필요한 근거
(`card-evidence`), 사람 판단(`card-decision`). 이 순서로 `FieldGroup`의 끝에 있다.

`card-peek.tsx:763-802` — 편집기의 "카드 취소" 확인. 거절 확인의 본보기다:

```tsx
<AlertDialog>
  <AlertDialogTrigger
    render={
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="mr-auto"
        disabled={pending}
      />
    }
  >
    <Trans comment="Button in the card editor that cancels the card">카드 취소</Trans>
  </AlertDialogTrigger>
  <AlertDialogContent size="sm">
    <AlertDialogHeader>
      <AlertDialogTitle>
        <Trans>이 카드를 취소할까요?</Trans>
      </AlertDialogTitle>
      <AlertDialogDescription>{/* ... */}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>
        <Trans comment="Closes the dialog without cancelling the card">그만두기</Trans>
      </AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        onClick={() => submit(BoardEdit.CancelCard({ planVersion, cardId: card.id }))}
      >
        <Trans comment="Button in the card editor that cancels the card">카드 취소</Trans>
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

`board-surface.tsx:430-446` — `CardPeek`에 넘기는 props의 앞부분:

```tsx
        <CardPeek
          key={peekKey}
          peek={peekState}
          entry={peeked}
          loopCard={peek === null ? null : loopCard(peek)}
          decisions={peek === null ? [] : decisionsOf(peek)}
          titleOf={titleIn(peekSession)}
          outcomeOf={outcomeIn(peekSession)}
          group={peekBoard?.label ?? null}
          changePending={peek !== null && changePending(peek)}
          projectId={projectId}
          holder={holder}
          disabled={disabled}
          closed={peekBoard === null || closedIn(peekBoard)}
          planVersion={peekBoard?.plan.version ?? 0}
          cardCount={peekBoard?.view.cards.length ?? 0}
          editPending={edit.isPending || action.isPending}
```

`project-board.tsx:211-228` — 여러 개를 고르는 `ToggleGroup`:

```tsx
<ToggleGroup
  aria-label={t({ message: "보이는 대화", comment: "…" })}
  multiple
  size="sm"
  spacing={1}
  value={shown}
  onValueChange={setShown}
  className="flex-wrap"
>
  {rows.map((row) => (
    <ToggleGroupItem key={row.sessionId} value={row.sessionId}>
      {titleOf(row)}
    </ToggleGroupItem>
  ))}
</ToggleGroup>
```

`project-board.tsx:236-251` — 접이식의 버튼 모양(본보기):

```tsx
<CollapsibleTrigger render={<Button type="button" size="sm" variant="ghost" className="group" />}>
  <ChevronRightIcon
    data-icon="inline-start"
    className="transition-transform group-data-[panel-open]:rotate-90"
  />
  <Trans>대화 순서와 상태</Trans>
</CollapsibleTrigger>
```

### 알아 둘 것

- `CardPeek`의 `onSubmit(edit)`는 `Promise<string | null>`을 준다. 값은 오류 문구이고, 받아들여지면
  null이다. `BoardEdit.CancelCard`를 넘기면 `BoardSurface`가 `BoardIntent.Cancel`로 바꿔 보낸다
  (`board-surface.tsx:338`). 편집기의 "카드 취소"가 이미 이 길을 쓴다.
- `loopCard`는 칸반 루프가 아는 카드 정보다. 타입은 `card-peek.tsx:54`의 `LoopCard`이고
  `failures`, `replans`, `conflictRounds`(모두 수)를 가진다(`packages/memory-agent/src/kanban/contracts.ts:114-123`).
  칸반 루프가 돌지 않는 보드에서는 null이다.
- 승인을 기다리는 카드는 아직 시작하지 않았다. 취소하면 바로 보드에서 빠진다.
- 의존 카드는 같은 Plan 안의 카드만 가리킬 수 있다. 서버가 없는 카드와 순환을 거절한다
  (`plan_dependencies_rejected`).

### 따라야 할 규칙

- UI는 `apps/agent/app/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
  shadcn 컴포넌트의 모양을 `className`으로 덮어쓰지 않는다(lint `shadcn/no-restyle`).
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 짧은 문구에는 `comment`를 단다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose           | Command                                                                                                                          | Expected on success |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                                                         | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                                                       | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                                                      | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                                                                        | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check`                                                                          | exit 0              |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/board/card-peek.browser.tsx` | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 브라우저 테스트가 브라우저를 띄우지 못하는 환경이면 그 사실을 보고에 적고 넘어간다. STOP이
  아니다. 처음 실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다.

## Scope

**In scope**:

- `apps/agent/app/entry/chat/board/card-peek.tsx`
- `apps/agent/app/entry/chat/board/board-surface.tsx` (`CardPeek`에 prop 하나를 더하는 곳만)
- `apps/agent/app/entry/chat/board/card-peek.browser.tsx` (새 파일)
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/board/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 서버. `BoardEdit`, `BoardIntent`의 모양은 그대로다.
- 카드 패널을 Sheet로 여는 방식. Plan 015가 다룬다.
- 카드 작업 폴더의 경로. Plan 017이 다룬다.
- 보드의 카드 앞면(`card-face.tsx`).

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(board): 승인 대기 카드를 카드 패널에서 바로 거절한다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 승인 블록에 "거절"을 둔다

`card-peek.tsx`의 `CardPeek`:

1. state를 더한다(`transferTo` 다음).

```tsx
const [rejectError, setRejectError] = useState<string | null>(null);
```

2. 승인 블록에서 `<Trans>거절하려면 편집에서 카드를 취소해 주십시오.</Trans>`을 담은 `<p>`를 지운다.
3. "승인" 버튼을 아래로 바꾼다.

```tsx
<span className="flex flex-wrap items-center gap-2">
  <Button
    type="button"
    size="sm"
    disabled={disabled || closed || intentPending}
    onClick={() => onIntent("Approve", card.id)}
  >
    <Trans comment="Button in the card panel that approves the card to run">승인</Trans>
  </Button>
  <AlertDialog>
    <AlertDialogTrigger
      render={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || closed || intentPending || editPending}
        />
      }
    >
      <Trans comment="Button in the card panel that rejects a card waiting for approval">
        거절
      </Trans>
    </AlertDialogTrigger>
    <AlertDialogContent size="sm">
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>이 카드를 거절할까요?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>거절한 카드는 취소되고 실행되지 않습니다.</Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans comment="Closes the dialog without rejecting the card">그만두기</Trans>
        </AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          onClick={() => {
            setRejectError(null);
            void onSubmit(BoardEdit.CancelCard({ planVersion, cardId: card.id })).then(
              setRejectError,
            );
          }}
        >
          <Trans comment="Button that confirms rejecting a card waiting for approval">
            카드 거절
          </Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</span>;
{
  rejectError !== null && (
    <p className="text-destructive" role="alert">
      {rejectError}
    </p>
  );
}
```

"그만두기"는 기존 문구와 글자가 같아 catalog에서 한 항목으로 합쳐진다. 문제없다.

**Verify**:

- `vp run agent#typecheck` → exit 0.
- `rg -n "거절하려면 편집에서" apps/agent/app --glob '!*.po'` → 결과 없음.

### Step 2: 카드 상세에 실행 기록을 보인다

`card-peek.tsx`:

1. `<CardDetails … />`에 `loopCard={loopCard}`를 더한다.
2. `CardDetails`의 props에 `readonly loopCard: LoopCard | null;`을 더한다(주석:
   `/** What the kanban loop counted for the card; null while no loop runs the board. */`).
3. `CardDetails` 안, `list` 정의 다음에 더한다.

```tsx
const attempts =
  loopCard !== null && loopCard.failures + loopCard.replans + loopCard.conflictRounds > 0
    ? loopCard
    : null;
```

4. "마지막 변경" `DataListItem` **앞**에 더한다.

```tsx
{
  attempts !== null && (
    <DataListItem
      term={
        <Trans comment="Card field: how often the card failed, was replanned and met conflicts">
          실행 기록
        </Trans>
      }
    >
      <Trans comment="failures: failures in a row; replans: Plan rewrites; conflicts: conflict rounds">
        연속 실패 {ph({ failures: attempts.failures })} · Plan 재작성{" "}
        {ph({ replans: attempts.replans })} · 충돌 해결 {ph({ conflicts: attempts.conflictRounds })}
      </Trans>
    </DataListItem>
  );
}
```

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 3: 의존 카드를 골라 넣는다

`card-peek.tsx`:

1. `CardForm.dependsOn`의 타입을 `readonly string[]`로 바꾼다. `formOf`의 줄을
   `dependsOn: card?.dependsOn ?? [],`로 바꾼다. `ids` 함수는 쓰임이 없어지므로 지운다.
2. `set`이 글자 항목만 받게 한다.

```tsx
/** The form's fields that hold plain text. */
type TextField = Exclude<keyof CardForm, "dependsOn" | "risk">;
```

이 타입은 `CardForm` 다음(모듈 수준)에 두고, `set`을
`const set = (key: TextField) => (value: string) => setForm({ ...form, [key]: value });`로 바꾼다. 3. `save`의 두 곳에서 `dependsOn: ids(form.dependsOn),`를 `dependsOn: form.dependsOn,`로 바꾼다. 4. `CardPeek`와 `CardEditor`에 prop을 더한다.

```tsx
  /** The Plan's cards a card can wait for, in Plan order. */
  readonly planCards: ReadonlyArray<{ readonly id: string; readonly title: string }>;
```

`CardPeek`는 `<CardEditor …>` 두 곳에 `planCards={planCards}`를 넘긴다. 5. `board-surface.tsx`의 `<CardPeek …>`에 `cardCount` 줄 다음에 더한다.

```tsx
          planCards={
            peekBoard?.view.cards.map(({ card }) => ({ id: card.id, title: card.title })) ?? []
          }
```

6. `CardEditor` 안, `executing` 다음에 고를 수 있는 카드를 만든다. 자기 자신은 뺀다. Plan에 없는
   id가 이미 의존에 있으면(다른 곳에서 지워진 카드) 지울 수 있게 id 그대로 보인다.

```tsx
const others = planCards.filter((other) => other.id !== card?.id);
const choices = [
  ...others,
  ...form.dependsOn
    .filter((id) => !others.some((other) => other.id === id))
    .map((id) => ({ id, title: id })),
];
```

7. 의존 카드 `Field`(672–686행)를 아래로 바꾼다. import에 `ToggleGroup`, `ToggleGroupItem`
   (`../../../components/ui/toggle-group`)을 더한다.

```tsx
<Field>
  <FieldLabel id="card-depends-label">
    <Trans comment="Card editor field: the cards this card waits for">의존 카드</Trans>
  </FieldLabel>
  {choices.length > 0 ? (
    <ToggleGroup
      aria-labelledby="card-depends-label"
      multiple
      size="sm"
      spacing={1}
      value={form.dependsOn}
      onValueChange={(dependsOn) => setForm({ ...form, dependsOn })}
      className="flex-wrap"
    >
      {choices.map((choice) => (
        <ToggleGroupItem key={choice.id} value={choice.id} title={choice.id}>
          {choice.title}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  ) : (
    <p className="text-muted-foreground">
      <Trans>이 Plan에 다른 카드가 없습니다.</Trans>
    </p>
  )}
  <FieldDescription>
    <Trans>고른 카드가 끝난 뒤에 이 카드를 시작합니다.</Trans>
  </FieldDescription>
</Field>
```

`FieldLabel`이 `id`를 받지 않으면 `aria-labelledby` 대신 `ToggleGroup`에
`aria-label={t({ message: "의존 카드", comment: "Card editor field: the cards this card waits for" })}`를 쓴다.

**Verify**:

- `vp run agent#typecheck` → exit 0.
- `rg -n "카드 id를 쉼표로" apps/agent/app --glob '!*.po'` → 결과 없음.
- `rg -n "const ids = " apps/agent/app/entry/chat/board/card-peek.tsx` → 결과 없음.

### Step 4: 드문 네 항목을 접는다

`card-peek.tsx`의 `CardEditor`:

1. import를 더한다: `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger`
   (`../../../components/ui/collapsible`), `ChevronRightIcon`(`lucide-react`).
2. `choices` 다음에 더한다.

```tsx
// Opened when the card already carries one of the four, so a set value is never hidden.
const hasContract =
  form.boundaries.trim().length > 0 ||
  form.risk !== "none" ||
  form.requiredEvidence.trim().length > 0 ||
  form.humanDecision.trim().length > 0;
```

`hasContract`는 접이식의 처음 열림 상태에만 쓴다. `defaultOpen`은 처음 그릴 때의 값만 읽는다. 3. `FieldGroup` 안에서 경계, 위험, 필요한 근거, 사람 판단의 네 `Field`를 잘라 낸다. `</FieldGroup>`
다음, 오류 문단 앞에 아래를 두고 네 `Field`를 그 안의 `FieldGroup`에 붙여 넣는다. `Field`의
내용은 고치지 않는다.

```tsx
<Collapsible defaultOpen={hasContract} className="mt-3">
  <CollapsibleTrigger
    render={<Button type="button" size="sm" variant="ghost" className="group -ml-2" />}
  >
    <ChevronRightIcon
      data-icon="inline-start"
      className="transition-transform group-data-[panel-open]:rotate-90"
    />
    <Trans comment="Folded part of the card editor: boundaries, risk, required evidence, human decision">
      추가 조건
    </Trans>
  </CollapsibleTrigger>
  <CollapsibleContent className="mt-2">
    <FieldGroup>{/* 경계, 위험, 필요한 근거, 사람 판단의 Field 넷 */}</FieldGroup>
  </CollapsibleContent>
</Collapsible>
```

`Collapsible`에 `className`을 주는 것이 `shadcn/no-restyle`에 걸리면 `<div className="mt-3">`로
감싼다.

**Verify**: `vp run agent#typecheck` → exit 0. `vp check` → exit 0.

### Step 5: 테스트

`apps/agent/app/entry/chat/board/card-peek.browser.tsx`를 만든다. import, `sdkCall`, `I18nProvider`와
`QueryClientProvider`로 감싸는 방식은 `project-board.browser.tsx`(1–13행, 121–145행)를 본보기로
한다. `CardPeek`는 서버를 부르지 않으므로 `fetch` 대역은 필요 없다.

props의 기본값을 상수로 둔다.

```tsx
const planCards = [
  { id: "a1", title: "토큰 저장" },
  { id: "a2", title: "결제 요청" },
];
const base = {
  loopCard: null,
  decisions: [],
  titleOf: (cardId: string) => cardId,
  outcomeOf: () => null,
  group: null,
  changePending: false,
  projectId: "project-1",
  holder: "page-1",
  disabled: false,
  closed: false,
  planVersion: 3,
  cardCount: 2,
  planCards,
  editPending: false,
  intentPending: false,
  kanbanActive: true,
  transferTargets: [],
  onTransfer: () => {},
  onEdit: () => {},
  onIntent: () => {},
  onClose: () => {},
};
```

테스트 둘:

1. **거절**: `peek={Peek.Card({ cardId: "a2", editing: false })}`, `entry`는 `status: "backlog"`이고
   `approval: {}`인 카드(`card.approval`의 필수 필드는 `packages/memory-agent/src/workflow/contracts.ts`의
   `PlanStep`에서 확인한다). `onSubmit`은 `vi.fn(() => Promise.resolve(null))`.
   - "거절" 버튼을 누른다 → `alertdialog`의 "카드 거절"을 누른다.
   - `expect(onSubmit).toHaveBeenCalledWith(BoardEdit.CancelCard({ planVersion: 3, cardId: "a2" }))`.
2. **의존 카드 고르기**: `peek={Peek.New()}`, `entry={null}`.
   - 제목 입력에 "새 카드"를 넣는다(`screen.getByRole("textbox", { name: "제목" }).fill("새 카드")`).
   - "토큰 저장" 토글을 누른다.
   - "저장"을 누른다.
   - `onSubmit`의 첫 인자가 `BoardEdit.AddCard`이고 `card.dependsOn`이 `["a1"]`, `card.title`이
     `"새 카드"`인지 단언한다(`BoardEdit.$is("AddCard")`로 좁힌다).

**Verify**: 브라우저 테스트 명령 → 2 passed.

### Step 6: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check`.
- `apps/agent/app/entry/chat/board/README.md`의 `CardPeek` 항목을 고친다: 승인 대기 카드의 승인과
  거절, 실행 기록, 의존 카드는 같은 Plan의 카드를 골라 넣는다, 경계·위험·필요한 근거·사람 판단은
  "추가 조건"에 접힌다.
- `docs/decisions.md` 끝에 항목 하나. 제목: `## 카드 패널: 바로 거절, 의존 카드 고르기, 드문 항목 접기 (오늘 날짜)`.
  내용: 계기(위 "Why"의 네 가지와 DB의 수), 결정(거절은 확인 한 번을 거쳐 카드 취소와 같은 요청을
  보낸다. 의존 카드는 토글로 고른다. 네 항목은 값이 없으면 접힌 채로 연다. 실행 기록은 0이 아닐
  때만 보인다), 버린 안(검색되는 Combobox: 같은 Plan의 카드가 많아야 20장 남짓이라 토글 목록으로
  충분하다).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 브라우저 테스트 둘: 거절이 `CancelCard`를 보낸다, 고른 의존 카드가 `AddCard`에 들어간다.
- 접이식과 실행 기록은 표시만 바꾸므로 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `rg -n "거절하려면 편집에서|카드 id를 쉼표로" apps/agent/app --glob '!*.po'` → 결과 없음
- [ ] `rg -n "planCards" apps/agent/app/entry/chat/board` → `card-peek.tsx`, `board-surface.tsx`, 테스트에 있다
- [ ] 브라우저 테스트 2 passed (브라우저를 띄울 수 없었으면 보고에 적는다)
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 012의 `board-surface.tsx` 변경은 예외).
- `ToggleGroup`이 `multiple`, `value`(문자열 배열), `onValueChange`를 받지 않는다.
- `BoardEdit.CancelCard`가 `{ planVersion, cardId }` 말고 다른 값을 요구한다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 의존 카드 토글은 Plan의 카드 수만큼 나온다. Plan 하나에 카드가 수십 장으로 늘면 검색되는 고르기로
  바꾼다(`components/ui/combobox.tsx`에 칩 입력이 있다).
- Plan 015가 이 파일의 Sheet 부품(`SheetHeader`, `SheetTitle` 등)을 일반 요소로 바꾼다. 이 계획이
  더한 블록은 그대로 남는다.
- Plan 017이 카드 상세에 작업 폴더 항목을 더한다. "실행 기록" 다음에 둔다.
- 리뷰에서 볼 곳: 거절이 진행 중인 카드에는 나오지 않는가(승인 블록은 `card.approval`이 있을 때만
  그려진다). 편집기를 열 때 값이 있는 카드의 "추가 조건"이 펼쳐져 있는가.
