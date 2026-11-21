# Plan 026: 컨텍스트 표시가 실제로 줄이기 시작하는 지점을 기준으로 경고한다

> **Executor instructions**: 이 계획을 단계대로 따른다. 단계마다 검증 명령을 돌리고, 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 적힌 일이 생기면 멈추고 보고한다. 즉석에서 다른
> 길을 만들지 않는다. 끝나면 `plans/README.md`에서 이 계획의 행을 고친다. 단, 검토자가 보낸
> 실행이고 "색인은 검토자가 고친다"는 말을 들었다면 고치지 않는다.
>
> **Drift check (run first)**: `git diff --stat df4e066f..HEAD -- packages/memory-agent/src/agent/compaction.ts packages/memory-agent/src/agent/context-usage.ts packages/memory-agent/src/agent/run-state.ts apps/agent/app/entry/api.ts apps/agent/app/entry/chat/context-meter.tsx`
> 범위 안의 파일이 바뀌었다면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (반쯤 지운 필드 정리 + 표시 불일치)
- **Planned at**: commit `df4e066f`, 2026-11-21

## Why this matters

입력창 아래의 컨텍스트 표시는 "모델 창의 몇 %를 썼나"를 보이고 60%부터 경고 색을 켠다. 그런데 실제로
오래된 메시지를 빼기 시작하는 지점은 `leaveOutAt = min(창의 55%, 128,000 토큰)`이다. 창이 1M인
모델은 12.8%에서 이미 메시지를 빼는데 표시는 아무 경고도 하지 않는다. 사용자는 "왜 앞 대화를 잊었지"를
표시로 알 수 없다.

한편 `ContextView.compactAtTokens`는 늘 0인 옛 필드다. `Budget.compactAt`은 `@deprecated`로 남아 있고
코드 어디서도 읽지 않는다. 테스트들이 의미 없는 값(`compactAt: 3_000` 등)을 계속 적는다. 표시가 쓸
"줄이기 시작하는 지점"을 이 자리에 넣으면, 죽은 필드 하나를 걷어내면서 표시와 실제 동작을 한 기준으로
맞출 수 있다.

## Current state

- `packages/memory-agent/src/agent/compaction.ts` — compaction 예산.

```ts
// compaction.ts:118-158
/** Share past which the oldest messages are left out, whatever else was done. */
export const leaveOutAtShare = 0.55;
...
export const leaveOutAtMost = 128_000;
...
export const workingWindow = (contextWindow: number) =>
  Math.min(contextWindow, Math.floor(leaveOutAtMost / leaveOutAtShare));
...
/** Estimated leave-out ceiling; compactAt is retained as a zero-valued compatibility field. */
export interface Budget {
  /** @deprecated Validated summaries and answered tools compact without a minimum threshold. */
  readonly compactAt: number;
  readonly leaveOutAt: number;
  readonly inputCeiling: number;
}

export const budgetFor = (contextWindow: number): Budget => ({
  compactAt: 0,
  leaveOutAt: Math.min(Math.floor(contextWindow * leaveOutAtShare), leaveOutAtMost),
  inputCeiling: contextWindow - answerRoom(contextWindow),
});
```

`compactAt`를 읽는 src 코드는 없다(`grep -rn "compactAt\b" packages/memory-agent/src`로 확인하면 정의
두 줄과 `context-usage.ts:60`뿐이다). 테스트와 eval이 `Budget` 객체 리터럴에 적는다:
`src/agent/compaction.test.ts`, `tests/compaction/{run-summaries,history,fixtures,append}.test.ts`,
`tests/compaction/fixtures.ts`, `eval/compaction.ts:152`.

- `packages/memory-agent/src/agent/run-state.ts:73-91` — 서버의 `ContextView` 스키마. 끝 필드:

```ts
  /** Estimated conversation size past which earlier parts are compacted. */
  compactAtTokens: Schema.Finite,
```

- `packages/memory-agent/src/agent/context-usage.ts:39-61` — `contextView(...)`가 `ContextView`를 만든다.
  끝 줄이 `compactAtTokens: budgetFor(windowTokens).compactAt,`이다.

- `apps/agent/app/entry/api.ts:1070-1084` — 화면 쪽 `ContextEvent` 스키마. 끝 필드가
  `compactAtTokens: Schema.Finite,`다. 서버 스키마와 같은 모양을 따로 적은 것이다.

- `apps/agent/app/entry/chat/context-meter.tsx` — 표시.

```tsx
// context-meter.tsx:13-14
/** Past this share the line turns to a warning: the model is close to what it can read. */
const crowdedShare = 0.6;
```

```tsx
// context-meter.tsx:109-117
export function ContextMeter({ context }: { context: ContextView }) {
  const { t } = useLingui();
  const { usedTokens, cachedTokens, cacheRatio, compactionStage, windowTokens, windowKnown } =
    context;
  // Historical requests can exceed a catalog limit (including when older middleware sent the
  // un-compacted transcript). In that case a percentage is not a meaningful context gauge.
  const comparable = windowKnown && (usedTokens === null || usedTokens <= windowTokens);
  const share = usedTokens === null || !comparable ? 0 : usedTokens / windowTokens;
  const crowded = comparable && share >= crowdedShare;
```

카드 안에는 `Row`로 "모델 한도"(`windowLimit`) 등 값 줄이 있다(`context-meter.tsx:123-175` 근처).

- `compactAtTokens`를 적는 테스트: `packages/memory-agent/tests/compaction/agent-chat.test.ts:255`,
  `apps/agent/app/entry/chat/context-meter.browser.tsx:36,68`, `apps/agent/app/entry/chat/chat-panel.browser.tsx:66`,
  `apps/agent/app/entry/session/run-notice.test.ts:25`, `apps/agent/app/entry/session/use-run-state.test.tsx:42`.

- 화면 문구는 Lingui 메시지다(`t`, `msg`, `Trans`). 새 문구에는 다른 문구처럼 필요하면 `comment`를 단다.
  문구 문체는 기존 카드 문구와 같은 합니다체다.

## 이 계획이 정한 표시 규칙

- 막대와 % 숫자는 지금처럼 "모델 창 대비 사용량"으로 둔다(사용자가 이미 아는 값).
- 경고 색(`crowded`)은 "줄이기 시작하는 지점 대비"로 켠다: `usedTokens >= leaveOutAtTokens * 0.8`.
  상수 이름은 `crowdedShareOfLeaveOut = 0.8`로 하고 doc comment에 "오래된 메시지를 빼기 시작하는 지점의
  80%부터 경고한다"고 적는다. `windowKnown`이 거짓이면 지금처럼 경고하지 않는다.
- 카드에 줄 하나를 더한다: 라벨 "오래된 메시지 생략 시작", 값은 `tokenCount(tokens.format(leaveOutAtTokens))`.
  `windowKnown`이 거짓이면 `unknown`을 보인다.

## Commands you will need

| Purpose           | Command                                                                                               | Expected on success                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                              | exit 0, `error TS`·`warning` 없음       |
| 서버 typecheck    | 저장소 루트에서 `vp run memory-agent#typecheck`                                                       | exit 0, `error TS`·`warning` 없음       |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                            | exit 0                                  |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                           | `apps/agent/app/locales/ko.po`가 바뀐다 |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                                             | exit 0                                  |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`                  | exit 0                                  |
| 서버 테스트       | `cd packages/memory-agent && vp test --run src/agent/compaction.test.ts tests/compaction`             | all pass                                |
| agent 단위 테스트 | `cd apps/agent && vp test --run app/entry/session`                                                    | all pass                                |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/` | all pass                                |

- `vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.
- 새 worktree에서는 먼저 `pnpm install --frozen-lockfile`. `./+types/*`를 못 찾으면 `apps/agent`에서
  `react-router typegen`. 서버 테스트가 `NativeOwnerFailed: native-incompatible`로 건너뛰면 저장소
  루트에서 `vp run turbovec#build`.
- 브라우저 테스트가 브라우저를 띄우지 못하면 보고에 적고 넘어간다(STOP 아님). 첫 실행에서 페이지가
  다시 로드되며 실패하면 한 번 더 돌린다. `optimizeDeps` 설정을 더하지 않는다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/compaction.ts` (`Budget`, `budgetFor`)
- `packages/memory-agent/src/agent/run-state.ts` (`ContextView`)
- `packages/memory-agent/src/agent/context-usage.ts` (`contextView`)
- `packages/memory-agent/src/agent/compaction.test.ts`, `packages/memory-agent/tests/compaction/*.ts`,
  `packages/memory-agent/eval/compaction.ts` (`compactAt` 지우기만)
- `apps/agent/app/entry/api.ts` (`ContextEvent`)
- `apps/agent/app/entry/chat/context-meter.tsx`
- `apps/agent/app/entry/chat/context-meter.browser.tsx`, `apps/agent/app/entry/chat/chat-panel.browser.tsx`,
  `apps/agent/app/entry/session/run-notice.test.ts`, `apps/agent/app/entry/session/use-run-state.test.tsx`
- `apps/agent/app/locales/ko.po` (추출 결과)
- `packages/memory-agent/src/agent/README.md`, `docs/decisions.md`

**Out of scope**:

- `leaveOutAtShare`, `leaveOutAtMost`, `workingWindow`의 값과 compaction 동작. 바꾸지 않는다.
- 막대와 %의 분모(모델 창). 바꾸지 않는다.
- 저장된 컨텍스트 사용량(`ContextUsage` 스키마). 바꾸지 않는다. `compactAtTokens`는 저장되지 않는다.

## Git workflow

- 지금 브랜치에 commit한다. `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 각 commit은 두 typecheck와 `vp check`를 통과해야 한다. commit hook이 문구 catalog를 검사하므로 문구가
  바뀌는 commit에는 추출한 `ko.po`를 함께 올린다.
- 메시지는 한국어 conventional commit. 예: `refactor(compaction): 쓰지 않는 compactAt를 지운다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: `ContextView`가 `compactAtTokens` 대신 `leaveOutAtTokens`를 싣는다 (서버와 화면 스키마 함께)

- `run-state.ts`: `compactAtTokens` 필드를 `leaveOutAtTokens: Schema.Finite`로 바꾸고 doc comment를
  "Estimated conversation size past which the oldest messages are left out (`budgetFor(windowTokens).leaveOutAt`)."로 쓴다.
- `context-usage.ts`: `compactAtTokens: budgetFor(windowTokens).compactAt,` → `leaveOutAtTokens: budgetFor(windowTokens).leaveOutAt,`
- `apps/agent/app/entry/api.ts`: `ContextEvent`의 `compactAtTokens: Schema.Finite,` → `leaveOutAtTokens: Schema.Finite,`
- 테스트의 `compactAtTokens` 값을 바꾼다. 서버 테스트 `agent-chat.test.ts:255`는 창 200,000이므로
  `leaveOutAtTokens: 110_000`이다(200,000 × 0.55). 화면 테스트들은 각자의 `windowTokens`에서
  `min(floor(windowTokens × 0.55), 128000)`을 계산해 넣는다. 그 테스트가 값을 단언하지 않고 데이터로만
  쓰면 같은 식으로 계산한 값을 넣는다.

**Verify**: 두 typecheck exit 0. `grep -rn "compactAtTokens" packages apps --include=*.ts --include=*.tsx | grep -v node_modules` → 결과 없음.
서버 테스트 명령 all pass.

### Step 2: `Budget.compactAt`를 지운다

- `compaction.ts`: `Budget`에서 `compactAt`와 그 `@deprecated` 주석을 지우고, `Budget` 위 주석의
  "compactAt is retained as a zero-valued compatibility field"를 지운다. `budgetFor`에서 `compactAt: 0,`을 지운다.
- 테스트·eval의 `Budget` 리터럴에서 `compactAt: …,`를 지운다. 다른 값은 건드리지 않는다.
  `compactAt`에 0이 아닌 값을 넣은 테스트(`compaction.test.ts:374` 근처 `compactAt: 3_000`,
  `tests/compaction/history.test.ts:206` 근처 `compactAt: 4_000`)도 지우기만 한다. 코드가 읽지 않는 값이므로
  그 테스트의 결과는 바뀌지 않아야 한다.

**Verify**: `vp run memory-agent#typecheck` exit 0. `grep -rn "compactAt\b" packages/memory-agent` → 결과 없음.
`cd packages/memory-agent && vp test --run src/agent/compaction.test.ts tests/compaction` → all pass.

### Step 3: 표시가 줄이기 시작하는 지점으로 경고한다

`context-meter.tsx`에서 위 "이 계획이 정한 표시 규칙"을 그대로 구현한다.

- `crowdedShare`를 `crowdedShareOfLeaveOut = 0.8`로 바꾸고 doc comment를 고친다.
- `crowded = windowKnown && usedTokens !== null && usedTokens >= context.leaveOutAtTokens * crowdedShareOfLeaveOut`.
  `comparable`과 `share`(막대·% 계산)는 그대로 둔다.
- 카드의 "모델 한도" 줄 바로 아래에 "오래된 메시지 생략 시작" 줄을 더한다. 요청 전(`usedTokens === null`)
  카드와 요청 뒤 카드 양쪽에 둔다. 라벨은 `t({ message: "오래된 메시지 생략 시작", comment: "Context card row: the request size past which the oldest messages are left out" })`.
- `context-meter.browser.tsx`에 단언 하나를 더한다: 창이 1,000,000이고(`windowKnown: true`)
  `leaveOutAtTokens: 128_000`, `usedTokens: 110_000`이면 경고 색(버튼 variant `warning`)이다. 같은 파일의
  기존 테스트가 상태를 어떻게 단언하는지 본보기로 삼는다. 단언할 방법이 그 파일에 없으면 이 단언은
  만들지 말고 보고에 적는다.
- `vp run agent#i18n:extract`로 `ko.po`를 갱신하고 문구 검사 두 개를 돌린다.

**Verify**: `vp run agent#typecheck` exit 0, `vp run agent#i18n:check` exit 0, 문구 내용 검사 exit 0,
브라우저 테스트 명령 all pass, `cd apps/agent && vp test --run app/entry/session` all pass.

### Step 4: 문서

- `packages/memory-agent/src/agent/README.md`에서 `compactAt`나 `compactAtTokens`를 적은 곳이 있으면
  `leaveOutAtTokens`로 고친다(`grep -n "compactAt" packages/memory-agent/src/agent/README.md`).
- `docs/decisions.md` 끝에 새 항목:
  - 제목: `컨텍스트 표시는 오래된 메시지를 빼기 시작하는 지점으로 경고한다 (2026-11-21)`
  - 계기: 경고가 모델 창의 60%에서 켜졌는데, 실제 생략은 `min(창의 55%, 128,000 토큰)`에서 일어나 큰
    창 모델에서는 경고 없이 앞 대화가 빠졌다. `compactAtTokens`·`Budget.compactAt`는 늘 0인 옛 필드였다.
  - 결정: `ContextView.leaveOutAtTokens`를 싣고, 표시는 그 80%부터 경고하며 카드에 그 값을 보인다. 막대와
    %는 모델 창 대비로 둔다. `compactAt` 필드를 지운다.
  - 함께 적는 것: 128,000 상한(`leaveOutAtMost`)의 이유는 `compaction.ts`의 doc comment대로다. 한 run이 앞
    요청에 이어 붙이므로 큰 창에서 매 step 수십만 토큰을 다시 보내지 않게 하는 상한이다. 이 상한을 결정
    기록에 처음 적는다.
  - 확인: `context-meter.browser.tsx`(Step 3의 단언을 만들었다면), `tests/compaction/agent-chat.test.ts`.

**Verify**: `vp check` exit 0.

## Test plan

- 새 단언 1개(Step 3, 큰 창 모델의 경고). 본보기는 같은 파일의 기존 테스트.
- 나머지는 필드 이름이 바뀐 기존 테스트가 지킨다.

## Done criteria

- [ ] 두 typecheck exit 0, `error TS`·`warning` 없음
- [ ] `vp check`, `vp run agent#i18n:check`, 문구 내용 검사 exit 0
- [ ] Commands 표의 서버·agent·브라우저 테스트 all pass
- [ ] `grep -rn "compactAt" packages apps --include=*.ts --include=*.tsx | grep -v node_modules` 결과 없음
- [ ] 범위 밖 파일이 바뀌지 않았다(`git status`)

## STOP conditions

- `compactAt`나 `compactAtTokens`를 읽는 src 코드가 위에 적은 것 말고 있다.
- 화면이 `ContextView`를 다른 경로(예: snapshot endpoint 스키마)로도 decode하는데 그 스키마가 범위
  목록에 없다. `grep -rn "windowKnown" apps/agent/app --include=*.ts --include=*.tsx`로 찾아 확인한다.
- Step 2 뒤에 compaction 테스트의 결과가 바뀐다.
- 같은 검증이 한 번 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- `leaveOutAtTokens`는 메시지 추정치 기준이고 `usedTokens`는 공급자가 센 전체(system·도구 포함)다. 그래서
  경고는 조금 일찍 켜진다. 정확히 맞추려면 run이 쓴 실제 예산(`withOverhead` 뒤의 값)을 싣는 일이 따로
  필요하다.
- 화면 스키마(`api.ts`)와 서버 스키마(`run-state.ts`)가 같은 모양을 따로 적는다. 둘을 하나로 묶는 일은 이
  계획 밖이다.
