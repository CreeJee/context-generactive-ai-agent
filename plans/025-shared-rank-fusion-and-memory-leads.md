# Plan 025: 순위 병합(RRF)과 기억 단서 만들기를 한 곳에 둔다

> **Executor instructions**: 이 계획을 단계대로 따른다. 단계마다 검증 명령을 돌리고, 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 적힌 일이 생기면 멈추고 보고한다. 즉석에서 다른
> 길을 만들지 않는다. 끝나면 `plans/README.md`에서 이 계획의 행을 고친다. 단, 검토자가 보낸
> 실행이고 "색인은 검토자가 고친다"는 말을 들었다면 고치지 않는다.
>
> **Drift check (run first)**: `git diff --stat df4e066f..HEAD -- packages/memory-agent/src/memory/search.ts packages/memory-agent/src/memory/search.test.ts packages/memory-agent/src/skills/skill-search.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/agent/compaction-policy.ts`
> 범위 안의 파일이 바뀌었다면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (024와 같은 `chat.ts`를 고치지만 다른 함수다. 024 뒤에 하면 충돌이 없다)
- **Category**: tech-debt
- **Planned at**: commit `df4e066f`, 2026-11-21

## Why this matters

같은 일을 하는 코드가 두 벌씩 있다.

1. Reciprocal Rank Fusion(RRF)이 두 번 구현돼 있다. 기억 검색의 `fuseRanks`(`memory/search.ts`)와
   스킬 검색의 `rankSkills` 안 fold(`skills/skill-search.ts`)가 각자 `fusionK = 60`을 정의한다.
   한쪽의 상수나 동점 규칙을 바꾸면 다른 쪽은 그대로 남는다.
2. 모델에게 기억 단서를 붙이는 곳이 두 군데다. compaction이 뺀 내용을 대신하는 retrieval appendix와
   외부 에이전트에게 주는 memory preamble(`chat.ts`)이다. 둘 다 "출처가 붙은 단서 최대 5개, topic
   제외"인데 출처 표기를 각자 문자열로 만든다. 그리고 정책 상수 `retrievalLeadLimit`(5)·
   `retrievalTokenLimit`(600)이 `compaction-policy.ts`에 있는데, `chat.ts`는 이것을 쓰지 않고 같은
   값을 `retrievalAppendixLimits`로 다시 정의한다. eval(`eval/compaction.ts`)은 정책 상수로 채점하므로,
   한쪽만 바꾸면 eval이 실제와 다른 값을 잰다.

이 계획이 끝나면 RRF는 작은 순수 모듈 하나에, 단서의 출처 표기와 상한은 한 곳에 있다. 동작은 바뀌지
않는다.

## Current state

- `packages/memory-agent/src/memory/search.ts` — 기억 검색. 무거운 모듈이다(네이티브 worker, SQL).

```ts
// search.ts:163-193
/** Standard Reciprocal Rank Fusion constant; damps the gap between neighbouring ranks. */
const fusionK = 60;

/**
 * Merges ranked id lists by Reciprocal Rank Fusion. Cosine and BM25 scores are not comparable,
 * so only ranks are used. A node first in every list gets 1; first in one of two equally weighted
 * lists gets 0.5. Equal scores keep the order of the lists: a node the first list holds comes out
 * ahead.
 */
export function fuseRanks(input: {
  readonly lists: readonly (readonly string[])[];
  readonly weights?: readonly number[];
}): MutableHashMap.MutableHashMap<string, number> {
  ...
}
```

`fuseRanks`는 `search.ts:764`, `:768`에서 쓰이고, `src/memory/search.test.ts:3`이 `./search.ts`에서
가져와 테스트한다. `src/memory/README.md:22`가 이것을 search의 공개 이름으로 적는다.

- `packages/memory-agent/src/skills/skill-search.ts` — 스킬 검색.

```ts
// skill-search.ts:27-31
/**
 * Reciprocal rank fusion's constant (Cormack et al., 2009): a skill's score from each ranking is
 * 1 / (k + rank), so the word match and the meaning match add up without comparing their scores.
 */
const fusionK = 60;
```

```ts
// skill-search.ts:108-128 (rankSkills 안)
const fused = [byWords(catalog, query), byMeaning].reduce(
  (scores, ranking) =>
    EffectArray.sort(ranking, byScore).reduce(
      (sum, { skill }, index) =>
        HashMap.set(
          sum,
          skill.name,
          Option.getOrElse(HashMap.get(sum, skill.name), () => 0) + 1 / (fusionK + index + 1),
        ),
      scores,
    ),
  HashMap.empty<string, number>(),
);
return EffectArray.sort(
  catalog.flatMap((skill) =>
    Option.toArray(Option.map(HashMap.get(fused, skill.name), (score) => ({ skill, score }))),
  ),
  byScore,
)
  .slice(0, limit)
  .map(({ skill }) => skill);
```

`fuseRanks`는 점수를 가장 높을 수 있는 점수로 나눠 0–1로 맞춘다. 순서는 나누기 전과 같다. 스킬은
순서만 쓰므로 `fuseRanks`로 바꿔도 결과가 같다. 동점은 `EffectArray.sort`가 안정 정렬이라
`catalog` 순서를 지킨다. 바꾼 뒤에도 같은 `catalog.flatMap` → 안정 정렬 흐름을 유지한다.

- `packages/memory-agent/src/agent/compaction-policy.ts:15-18`:

```ts
/** Maximum memory leads added after compaction omitted original content. */
export const retrievalLeadLimit = 5;
/** Estimated-token ceiling for the variable retrieval appendix. */
export const retrievalTokenLimit = 600;
```

- `packages/memory-agent/src/agent/chat.ts` — 두 단서 경로.

```ts
// chat.ts:776-777
/** How much recalled memory a compacted history gets back: lines, then a token budget. */
const retrievalAppendixLimits = { lines: 5, tokens: 600 } as const;
```

```ts
// chat.ts:836-847 (retrievalAppendix 안)
const [, leads] = EffectArray.mapAccum(
  candidates,
  { lines: 0, tokens: estimateTokens({ role: "assistant", content: "" }) },
  (kept: AppendixSize, match): readonly [AppendixSize, Option.Option<string>] => {
    const provenance = `${match.createdAt.slice(0, 10)} · ${match.projectName} · ${match.kind} · ${match.foundBy}`;
    const line = `- node ${match.id} (${provenance}): ${match.snippet.replace(/\s+/g, " ")}`;
    const tokens = kept.tokens + estimateTokens({ role: "assistant", content: line });
    return kept.lines < retrievalAppendixLimits.lines && tokens <= retrievalAppendixLimits.tokens
      ? [{ lines: kept.lines + 1, tokens }, Option.some(line)]
      : [kept, Option.none()];
  },
);
```

```ts
// chat.ts:1067-1090 (externalMemoryLeads)
    search
      .findMatches({ query: text, projectId: project.id, limit: 6, crossProject, rerank: true })
      .pipe(
        Effect.map((found) => {
          const leads = found.matches
            .filter((match) => match.id !== userNodeId && match.kind !== "topic")
            .slice(0, 5)
            .map((match) => {
              const corrected =
                match.supersededBy.length > 0 ? " (later corrected by the user)" : "";
              return `- ${match.createdAt.slice(0, 10)} · ${match.projectName} · ${match.kind}${corrected}: ${match.snippet.replace(/\s+/g, " ")}`;
            });
```

두 경로의 차이는 의도된 것이다. 외부 에이전트는 `read_evidence`를 부를 수 없어 node id와
`foundBy`를 받지 않고, 대신 "나중에 정정됨" 표시를 받는다. appendix는 정정된 것(`supersededBy`)을
아예 뺀다. 이 차이는 남긴다. 합치는 것은 출처 표기(`날짜 · 프로젝트 · 종류`), 공백 정리, 줄 수 상한이다.

- 검색 결과 한 건의 타입은 `Match`이고 `memory/search.ts:55`에서 export한다.
- 이 저장소의 규칙(루트 `CLAUDE.md`, lint): Effect v4 표준 방식, `let`/`while` 금지, Effect 컬렉션
  사용, 의미 없는 `(x) => f(x)` 감싸기 금지, lint 비활성 주석 금지.

## Commands you will need

| Purpose        | Command                                                                                                                                               | Expected on success               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 서버 typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                                                                                                       | exit 0, `error TS`·`warning` 없음 |
| 포맷·lint      | 저장소 루트에서 `vp check`                                                                                                                            | exit 0                            |
| 서버 테스트    | `cd packages/memory-agent && vp test --run src/memory/search.test.ts src/memory/rank-fusion.test.ts src/skills/skill-search.test.ts tests/compaction` | all pass                          |

- 새 worktree에서는 먼저 `pnpm install --frozen-lockfile`을 한다. 테스트가
  `NativeOwnerFailed: native-incompatible`로 건너뛰면 저장소 루트에서 `vp run turbovec#build`를 한다.
- lint는 저장소 루트에서 돌린다.

## Scope

**In scope**:

- `packages/memory-agent/src/memory/rank-fusion.ts` (새 파일)
- `packages/memory-agent/src/memory/rank-fusion.test.ts` (새 파일, `search.test.ts`의 `fuseRanks` 테스트를 옮긴다)
- `packages/memory-agent/src/memory/search.ts`
- `packages/memory-agent/src/memory/search.test.ts`
- `packages/memory-agent/src/memory/README.md`
- `packages/memory-agent/src/skills/skill-search.ts`
- `packages/memory-agent/src/agent/memory-leads.ts` (새 파일)
- `packages/memory-agent/src/agent/chat.ts` (`retrievalAppendixLimits`, `retrievalAppendix`의 줄 만들기, `externalMemoryLeads`만)
- `packages/memory-agent/src/agent/README.md`

**Out of scope**:

- 단서를 고르는 규칙(정렬, 세션 우선, 정정 제외, 질의). 바꾸지 않는다.
- 외부 에이전트에게 node id를 보내는 것. 보내지 않는다.
- 스킬 router(LLM)와 로컬 reranker의 관계. 이 계획에서 다루지 않는다.
- 모델에게 보내는 머리말 문장(`[Retrieval appendix …]`, `[Memory from …]`). 한 글자도 바꾸지 않는다.

## Git workflow

- 지금 브랜치에 commit한다. `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit. 예: `refactor(memory): RRF를 순수 모듈 하나로 옮긴다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: `fuseRanks`를 순수 모듈로 옮긴다

- `src/memory/rank-fusion.ts`를 만든다. `search.ts`의 `fusionK` 상수와 `fuseRanks` 함수(doc comment
  포함)를 그대로 옮긴다. 필요한 import(`MutableHashMap`, `Option`, `Iterable` 등 `effect`)만 가져간다.
- `search.ts`에서 두 정의를 지우고 `./rank-fusion.ts`에서 `fuseRanks`를 import한다. `search.ts`가 쓰지
  않게 된 import를 지운다.
- `search.test.ts`의 `describe("fuseRanks", …)` 블록을 `rank-fusion.test.ts`로 옮기고, 그 파일이
  `./rank-fusion.ts`에서 가져오게 한다. `search.test.ts`에는 나머지(`namesSomethingExactly`,
  `searchTerms`)만 남긴다.
- `src/memory/README.md:22`의 `fuseRanks` 설명을 `rank-fusion.ts`로 옮겨 적는다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `cd packages/memory-agent && vp test --run src/memory/search.test.ts src/memory/rank-fusion.test.ts` → all pass(옮긴 테스트 수가 전과 같다).

### Step 2: 스킬 검색이 같은 `fuseRanks`를 쓴다

`skill-search.ts`의 `rankSkills`에서:

- 두 순위(`byWords(catalog, query)`, `byMeaning`)를 각각 `EffectArray.sort(…, byScore)`로 정렬한 뒤
  스킬 이름 목록으로 만든다.
- `fuseRanks({ lists: [wordNames, meaningNames] })`로 점수를 얻는다(가중치는 주지 않는다. 지금도 둘이
  같은 무게다).
- 이어지는 `catalog.flatMap(…)` → `EffectArray.sort(…, byScore)` → `.slice(0, limit)` 흐름은 그대로 두고,
  점수만 `MutableHashMap.get(fused, skill.name)`에서 읽는다.
- 지역 `fusionK`와 그 doc comment를 지운다. 쓰지 않게 된 import를 지운다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `cd packages/memory-agent && vp test --run src/skills/skill-search.test.ts` → all pass, 테스트 파일을 고치지 않고 통과한다.

### Step 3: 기억 단서의 출처 표기와 상한을 한 곳에 둔다

- `src/agent/memory-leads.ts`를 만든다. 두 경로가 함께 쓰는 것만 둔다.
  - `leadSource(match: Match): string` — `` `${match.createdAt.slice(0, 10)} · ${match.projectName} · ${match.kind}` ``
  - `leadSnippet(match: Match): string` — `match.snippet.replace(/\s+/g, " ")`
  - 각 함수에 한 줄 doc comment를 단다. `Match`는 `../memory/search.ts`에서 type import한다.
- `chat.ts`:
  - `retrievalAppendixLimits`를 지우고, 그 자리를 쓰던 곳이 `compaction-policy.ts`의
    `retrievalLeadLimit`, `retrievalTokenLimit`를 쓰게 한다.
  - appendix의 줄: `` `- node ${match.id} (${leadSource(match)} · ${match.foundBy}): ${leadSnippet(match)}` ``.
    결과 문자열은 지금과 한 글자도 다르지 않아야 한다.
  - 외부 단서: `.slice(0, 5)` → `.slice(0, retrievalLeadLimit)`, 줄은
    `` `- ${leadSource(match)}${corrected}: ${leadSnippet(match)}` ``. 역시 지금과 같은 문자열이다.
- `src/agent/README.md`의 정책 상수 줄(29번 줄 근처)에 "`retrievalLeadLimit`은 외부 에이전트 단서
  수에도 쓴다"를 더하고, `memory-leads.ts`를 Interface 목록에 한 줄로 더한다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `grep -n "retrievalAppendixLimits" packages/memory-agent/src` → 결과 없음.
`cd packages/memory-agent && vp test --run tests/compaction` → all pass.

## Test plan

- 새 테스트는 만들지 않는다. 동작이 같아야 하는 리팩터링이고, 옮긴 `fuseRanks` 테스트와 기존
  `skill-search.test.ts`, `tests/compaction`이 그것을 지킨다.
- 위 세 테스트 명령이 모두 통과한다.

## Done criteria

- [ ] `vp run memory-agent#typecheck` exit 0, `error TS`·`warning` 없음
- [ ] `vp check` exit 0
- [ ] Commands 표의 서버 테스트 명령 all pass
- [ ] `grep -rn "fusionK" packages/memory-agent/src` 결과가 `memory/rank-fusion.ts` 한 파일뿐이다
- [ ] `grep -rn "retrievalAppendixLimits" packages/memory-agent/src` 결과 없음
- [ ] 범위 밖 파일이 바뀌지 않았다(`git status`)

## STOP conditions

- `skill-search.test.ts`가 Step 2 뒤에 실패한다. 순서가 바뀐 것이다. 테스트를 고치지 말고 멈춘다.
- `fuseRanks`를 `search.ts` 밖에서 이미 가져다 쓰는 곳이 위에 적은 것 말고 있다.
- 단서 문자열이 바뀌어야만 공통 함수로 묶을 수 있다.
- 같은 검증이 한 번 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 새 하이브리드 검색(예: 다른 카탈로그 검색)을 만들면 `rank-fusion.ts`를 쓴다.
- 단서의 출처 표기를 바꾸면 두 경로가 함께 바뀐다. 외부 에이전트에게 주는 정보는 의도적으로 적다
  (node id 없음). 그 차이는 `memory-leads.ts`에 넣지 않는다.
