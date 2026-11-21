# Plan 014: Goal의 merge 결과를 보드 머리줄에 보이고 PR 주소를 링크로 둔다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/chat/board-panel.tsx apps/agent/app/entry/chat/board/project-board.tsx`
> Plan 012가 두 파일을 바꾼 것은 예상된 차이다(배지를 `board-surface.tsx`로 옮김, `goalDecisionCardId`를
> `board-moves.ts`로 옮김, `project-board.tsx`에 `needsUser`를 더함). 그 밖의 차이는 "Current state"의
> 발췌와 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/012-project-board-shows-stuck-states.md
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

칸반 Goal은 카드가 모두 끝나면 사용자 브랜치로 merge되거나 PR이 된다. 이것이 Goal의 끝
결과다. 그런데 그 결과는 세션 보드의 접힌 패널("Goal 스케줄 · 대기 중인 변경 · 변경 이력") 안의 한
줄에만 있다. 프로젝트 보드에는 아예 없다. PR 주소는 `PR을 만듦: https://…`라는 글자라 누를 수
없다. merge가 실패했을 때(검증 실패, push 실패, PR 생성 실패, 충돌로 멈춤)도 같은 자리에 글자로만
나온다. 로컬 DB에 `PullRequestFailed`인 Goal이 하나 있다.

이 계획 뒤에는:

- merge가 시작된 Goal은 세션 보드의 머리줄과 프로젝트 보드의 대화 줄에 상태 배지가 나온다.
  실패는 빨간 배지다.
- PR이 만들어졌으면 배지 옆에 "PR 열기" 링크가 있다.
- 프로젝트 보드는 merge가 실패한 대화를 "사람을 기다리는 대화"로 세고 상태 패널을 펼쳐 연다
  (Plan 012가 만든 규칙에 조건 하나를 더한다).

## Current state

### 관련 파일

- `apps/agent/app/entry/chat/board-panel.tsx` — `mergeStateLabel`, `stoppedMergeTexts`,
  `GoalSchedulePanel`, `BoardSheet`.
- `apps/agent/app/entry/chat/board/project-board.tsx` — `ConversationRow`, `needsUser`(Plan 012 뒤).
- `apps/agent/app/entry/chat/board/hold-reason.ts` — `verdictText`.
- `apps/agent/app/entry/shared/loop-health.tsx` — 상태에 따라 `Badge`의 `variant`를 고르는 본보기.
- `apps/agent/app/entry/chat/workflow-panel.test.tsx` — `renderToStaticMarkup`으로 그려 보는 테스트의 본보기.
- `packages/memory-agent/src/kanban/contracts.ts` — `GoalMergeState`(태그 13개), `KanbanScheduleView`.

### 발췌

`board-panel.tsx:696-737`(Plan 012 뒤에는 행 번호가 조금 앞당겨진다):

```tsx
/** Why the scheduler stopped merging a Goal on its own. */
const stoppedMergeTexts = {
  no_target: msg`detached HEAD에서 시작해 브랜치가 없으므로 자동 merge하지 않습니다`,
  target_missing: msg`대상 브랜치가 없어졌습니다`,
  conflict_stopped: msg`충돌로 자동 merge를 멈췄습니다`,
  goal_replaced: msg`Goal 변경으로 merge를 멈췄습니다`,
} satisfies Record<
  Extract<GoalMergeState, { readonly _tag: "Stopped" }>["reason"],
  MessageDescriptor
>;

/** Where a Goal's merge into its target stands, in words. */
export function mergeStateLabel(state: GoalMergeState | null): MessageDescriptor {
  if (state === null) return msg`카드가 모두 끝난 뒤 merge합니다`;
  return Match.valueTags(state, {
    ResolvingConflict: ({ files }) => {
      const count = files.length;
      return msg`대상 브랜치와 충돌한 파일 ${count}개를 에이전트가 해결하는 중`;
    },
    Verifying: () => msg`Goal 전체를 검증하는 중`,
    VerifyFailed: ({ verdict: failure }) => {
      const verdict = verdictText(failure);
      return msg`Goal 검증 실패: ${verdict}`;
    },
    WaitingWorktree: ({ worktree }) =>
      msg`작업 트리에 커밋하지 않은 변경이 있어 기다리는 중 (${worktree})`,
    TargetMoving: () => msg`대상 브랜치가 계속 바뀌어 다시 시도할 예정`,
    AwaitingDecision: () => msg`사람의 판단을 기다리는 중`,
    Merged: ({ commit: full }) => {
      const commit = full.slice(0, 8);
      return msg`merge됨 (${commit})`;
    },
    ManualMerge: () => msg`직접 merge하기로 함, Goal 브랜치를 남겨 둠`,
    PullRequestPending: () => msg`PR을 만드는 중`,
    PullRequestCreated: ({ url }) => msg`PR을 만듦: ${url}`,
    PullRequestUncertain: () =>
      msg`PR을 만들던 중 멈췄습니다. 원격 저장소에서 직접 확인해 주십시오`,
    PullRequestFailed: ({ stage }) =>
      stage === "push" ? msg`Goal 브랜치 push 실패` : msg`PR 생성 실패`,
    Stopped: ({ reason }) => stoppedMergeTexts[reason],
  });
}
```

`mergeStateLabel`은 `board-panel.tsx` 안에서만 쓰인다. 두 곳이다.

`board-panel.tsx:772-775` — Goal 스케줄 패널의 첫 줄:

```tsx
      <div className="flex flex-wrap items-center gap-3">
        <span>
          <Trans>대상 브랜치: {targetBranch}</Trans> · {t(mergeStateLabel(schedule.merge))}
        </span>
```

`board-panel.tsx:830-831` — 다른 Goal의 줄:

```tsx
                  <span className="text-foreground">{goalName(other.goalInstanceId)}</span>
                  <span className="text-xs">{t(mergeStateLabel(other.merge))}</span>
```

`board-panel.tsx:486-516` — 세션 보드 머리줄의 상태 표시(Plan 012 뒤의 모양):

```tsx
<SheetDescription>
  <span className="flex flex-wrap items-center gap-2">
    {loop !== null && <KanbanRunningBadge paused={loop.goalPaused} />}
    {loop !== null && loop.plannerStalled && <PlannerStalledBadge />}
    {loop !== null && <ReplanWaitBadge loop={loop} />}
    {loop !== null && loop.loop._tag !== "Healthy" && <LoopHealthStatus /* ... */ />}
    <span>
      <Trans comment="Board sheet tally: cards done / all cards">
        완료 {doneCount}/{cardCount}
      </Trans>
    </span>
  </span>
</SheetDescription>
```

`project-board.tsx` `ConversationRow`(Plan 012 뒤) — `LoopHealthStatus` 블록 다음에
`<span className="text-muted-foreground">…완료 n/m…</span>`가 온다. `loop`은
`const loop = surface?.loop ?? null;`이다.

`shared/loop-health.tsx:27-33` — 상태로 `variant`를 고르는 본보기:

```tsx
const variantOf = (health: LoopHealth) =>
  Match.valueTags(health, {
    Healthy: () => "secondary" as const,
    Retrying: () => "outline" as const,
    Exhausted: () => "destructive" as const,
    Defected: () => "destructive" as const,
  });
```

`packages/memory-agent/src/kanban/contracts.ts:140-149`:

```ts
export const KanbanScheduleView = Schema.Struct({
  /** The branch the Goal merges into; none when the board started on a detached HEAD. */
  targetBranch: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  waitingOn: Schema.Array(Schema.String),
  merge: Schema.NullOr(GoalMergeState),
  upstreamPending: Schema.Boolean,
  otherGoals: Schema.Array(KanbanGoalOption),
});
```

### 알아 둘 것

- `loop.schedule`은 null일 수 있다(`KanbanBoardView.schedule`). `schedule.merge`도 merge가 시작되기
  전에는 null이다. 둘 다 있을 때만 배지를 그린다.
- PR 주소는 서버가 `gh`의 출력에서 얻은 글자다. `https://`로 시작할 때만 링크로 그린다. 아니면
  지금처럼 글자로 보인다.
- merge가 끝난 것은 대화에도 알림으로 남는다(`packages/memory-agent/src/kanban/merge-queue.ts:464`의
  `announceMerge`). 이 계획은 보드 쪽 표시만 다룬다.

### 따라야 할 규칙

- UI는 `apps/agent/app/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 짧은 문구에는 `comment`를 단다.
- 태그 유니온은 `Match.valueTags`, `Predicate.isTagged`로 다룬다. `_tag`를 손으로 읽지 않는다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose           | Command                                                                              | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                             | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                           | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                          | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                            | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` | exit 0              |
| 테스트            | `cd apps/agent && vp test --run app/entry/chat/board/goal-merge.test.tsx`            | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/chat/board/goal-merge.tsx` (새 파일)
- `apps/agent/app/entry/chat/board/goal-merge.test.tsx` (새 파일)
- `apps/agent/app/entry/chat/board-panel.tsx`
- `apps/agent/app/entry/chat/board/project-board.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/board/README.md`, `apps/agent/app/entry/chat/README.md`(26행의
  `mergeStateLabel` 언급), `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 서버. 칸반이 끝난 뒤(`/api/sessions/:session/kanban`이 `{ active: false }`를 줄 때)에도 merge
  결과를 주게 하는 일은 하지 않는다. "Maintenance notes"에 적어 둔다.
- `GoalSchedulePanel`의 다른 부분(대상 브랜치 바꾸기, 먼저 merge될 Goal 스위치).
- 채팅 요약 줄(`BoardTally`, `WorkflowBoard`).

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(board): Goal의 merge 결과를 보드 머리줄에 보인다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: merge 상태의 문구와 표시를 한 파일로 옮긴다

`apps/agent/app/entry/chat/board/goal-merge.tsx`를 만든다.

1. `board-panel.tsx`에서 `stoppedMergeTexts`와 `mergeStateLabel`을 잘라 이 파일로 옮긴다. import:

```tsx
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Match, Predicate } from "effect";
import { Badge } from "../../../components/ui/badge";
import type { GoalMergeState } from "../../api";
import { verdictText } from "./hold-reason";
```

2. `mergeStateLabel`의 한 줄을 바꾼다. 주소가 링크로 따로 나올 때는 글자에 넣지 않는다.

```tsx
    PullRequestCreated: ({ url }) =>
      pullRequestLink(url) === null ? msg`PR을 만듦: ${url}` : msg`PR을 만듦`,
```

3. 같은 파일에 더한다.

```tsx
/** A pull request address as a link target; only a web address is one. */
const pullRequestLink = (url: string) => (url.startsWith("https://") ? url : null);

const mergeTone = (state: GoalMergeState) =>
  Match.valueTags(state, {
    Merged: () => "secondary" as const,
    ManualMerge: () => "secondary" as const,
    PullRequestCreated: () => "secondary" as const,
    ResolvingConflict: () => "outline" as const,
    Verifying: () => "outline" as const,
    WaitingWorktree: () => "outline" as const,
    TargetMoving: () => "outline" as const,
    AwaitingDecision: () => "outline" as const,
    PullRequestPending: () => "outline" as const,
    VerifyFailed: () => "destructive" as const,
    PullRequestUncertain: () => "destructive" as const,
    PullRequestFailed: () => "destructive" as const,
    Stopped: () => "destructive" as const,
  });

/** Whether the Goal's merge ended in a state only a person can move on from. */
export const mergeFailed = (state: GoalMergeState | null) =>
  state !== null && mergeTone(state) === "destructive";

/** Where a Goal's merge stands, as a badge; a created pull request also gets its link. */
export function GoalMergeStatus({ merge }: { readonly merge: GoalMergeState }) {
  const { t } = useLingui();
  const link = Predicate.isTagged(merge, "PullRequestCreated") ? pullRequestLink(merge.url) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="status">
      <Badge variant={mergeTone(merge)}>{t(mergeStateLabel(merge))}</Badge>
      {link !== null && (
        <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          <Trans comment="Link that opens the Goal's pull request in a new tab">PR 열기</Trans>
        </a>
      )}
    </span>
  );
}
```

`pullRequestLink`는 `mergeStateLabel`보다 위에 둔다.

4. `board-panel.tsx`: `import { GoalMergeStatus, mergeStateLabel } from "./board/goal-merge";`를
   더한다. 옮기고 나서 쓰이지 않게 된 import(`msg`, `MessageDescriptor`, `GoalMergeState`,
   `verdictText`)는 지운다. `Match`는 다른 곳이 쓰므로 남긴다. 어느 것이 남는지는 `vp check`가
   알려 준다.

**Verify**:

- `vp run agent#typecheck` → exit 0. `vp check` → exit 0.
- `rg -n "function mergeStateLabel" apps/agent/app` → `board/goal-merge.tsx` 한 줄.

### Step 2: 세 곳에 상태를 보인다

1. `board-panel.tsx`의 `GoalSchedulePanel` 첫 줄(772–775행)을 바꾼다.

```tsx
      <div className="flex flex-wrap items-center gap-3">
        <span>
          <Trans>대상 브랜치: {targetBranch}</Trans>
          {schedule.merge === null && <> · {t(mergeStateLabel(null))}</>}
        </span>
        {schedule.merge !== null && <GoalMergeStatus merge={schedule.merge} />}
```

2. `board-panel.tsx`의 세션 보드 머리줄: `LoopHealthStatus` 블록 다음, `완료` `<span>` 앞에 더한다.

```tsx
{
  loop?.schedule?.merge != null && <GoalMergeStatus merge={loop.schedule.merge} />;
}
```

3. `project-board.tsx`의 `ConversationRow`: `LoopHealthStatus` 블록 다음에 같은 줄을 더한다.
   import: `import { GoalMergeStatus, mergeFailed } from "./goal-merge";`.
4. `project-board.tsx`의 `needsUser`에 조건을 더한다.

```tsx
        loop.goalPaused ||
        mergeFailed(loop.schedule?.merge ?? null) ||
        loop.cards.some((card) => waitsForUser(card.reason))))
```

함수 위 주석의 목록에 "a merge that failed"를 더한다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 3: 테스트

`apps/agent/app/entry/chat/board/goal-merge.test.tsx`를 만든다. 그리는 방식은
`chat/workflow-panel.test.tsx:1-25`를 본보기로 한다(`renderToStaticMarkup`, `I18nProvider`).

merge 상태 값을 만드는 법: `rg -n "GoalMergeState" apps/agent/app/entry/api.ts`로 값(생성자)이
export되는지 본다. export되면 `GoalMergeState.cases.<Tag>.make({...})`를 쓴다. 타입만 export되면
테스트 파일 안에서 `const state = (value: GoalMergeState) => value;`를 두고 객체 리터럴을 넘긴다
(테스트 자료에 한해 `_tag`를 적는다).

테스트 셋:

1. `PullRequestCreated`, `url: "https://example.com/pull/1"` → 결과 HTML에
   `href="https://example.com/pull/1"`이 있고, `PR을 만듦`이 있고, `PR을 만듦: https`는 없다.
2. `PullRequestCreated`, `url: "example.com/pull/1"` → `<a`가 없고 `PR을 만듦: example.com/pull/1`이 있다.
3. `mergeFailed`: `PullRequestFailed`(`stage: "push"`)는 true, `Merged`(`commit: "0123456789abcdef"`)는
   false, null은 false.

각 상태의 필드는 `packages/memory-agent/src/kanban/contracts.ts`의 `GoalMergeState`에서 확인한다.

**Verify**: `cd apps/agent && vp test --run app/entry/chat/board/goal-merge.test.tsx` → 3 passed.

### Step 4: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/chat/board/README.md`의 Interface에 `mergeStateLabel`, `GoalMergeStatus`,
  `mergeFailed`를 더한다.
- `apps/agent/app/entry/chat/README.md` 26행에서 `mergeStateLabel`을 뺀다(`board/`로 옮겼다).
- `docs/decisions.md` 끝에 항목 하나. 제목: `## Goal의 merge 결과는 보드 머리줄에 보인다 (오늘 날짜)`.
  내용: 계기(결과가 접힌 패널 안의 글자뿐이었고 PR 주소를 누를 수 없었다), 결정(merge가 시작된
  Goal은 세션 보드 머리줄과 프로젝트 보드 대화 줄에 배지를 둔다. 실패는 빨간 배지이고 프로젝트
  보드는 그 대화를 사람을 기다리는 대화로 센다. `https://`로 시작하는 PR 주소만 링크로 그린다),
  남은 것(칸반이 끝난 뒤의 결과 표시).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 테스트 셋: 링크가 되는 주소, 링크가 되지 않는 주소, 실패 판정.
- 머리줄에 배지를 끼우는 것은 조건 한 줄이라 따로 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/chat/board/goal-merge.test.tsx` exits 0
- [ ] `rg -n "GoalMergeStatus" apps/agent/app/entry/chat --glob '!*.test.tsx'` → 정의 하나, 쓰임 셋
- [ ] `rg -n "mergeStateLabel" apps/agent/app/entry/chat/board-panel.tsx` → import와 쓰임 둘뿐, 정의 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 012의 변경은 예외).
- Plan 012가 아직 들어가지 않았다(`project-board.tsx`에 `needsUser`가 없다).
- `GoalMergeState`의 태그가 위 13개와 다르다(`Match.valueTags`가 typecheck에서 실패한다).
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 확인하지 못한 것: 칸반 Goal이 끝나 활성 보드가 아니게 되면 `/api/sessions/:session/kanban`이
  `{ active: false }`를 준다(`apps/agent/app/.server/api/sessions.ts:156-163`). 그때는 `loop`이 null이라
  이 배지도 나오지 않는다. merge된 Goal의 보드가 언제 비활성이 되는지는 읽지 않았다. 끝난 뒤에도
  결과를 보여야 한다면 서버가 `{ active: false }`에 마지막 merge 상태를 실어 주어야 한다. 별도
  계획으로 다룬다.
- `GoalMergeState`에 태그를 더하면 `mergeStateLabel`과 `mergeTone` 두 곳을 함께 고친다. 둘 다
  `Match.valueTags`라 빠뜨리면 typecheck가 실패한다.
- 리뷰에서 볼 곳: 링크에 `rel="noreferrer"`와 `target="_blank"`가 있는가. `https://`가 아닌 주소가
  링크로 그려지지 않는가.
- Plan 016이 세션 보드의 Sheet를 본문 영역의 틀로 바꾼다. 이 계획이 더한 배지는 머리줄 내용과
  함께 옮겨진다.
