# Plan 027: 칸반 검증자가 카드 에이전트와 같은 도구를 받고, 검사는 프로젝트 명령으로 돌린다

> **Executor instructions**: 이 계획을 단계대로 따른다. 단계마다 검증 명령을 돌리고, 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 적힌 일이 생기면 멈추고 보고한다. 즉석에서 다른
> 길을 만들지 않는다. 끝나면 `plans/README.md`에서 이 계획의 행을 고친다. 단, 검토자가 보낸
> 실행이고 "색인은 검토자가 고친다"는 말을 들었다면 고치지 않는다.
>
> **Drift check (run first)**: `git diff --stat df4e066f..HEAD -- packages/memory-agent/src/workflow/card-capabilities.ts packages/memory-agent/src/kanban/subagent-card-agent.ts packages/memory-agent/src/kanban/failures.ts packages/memory-agent/tests/kanban-skills.test.ts`
> 범위 안의 파일이 바뀌었다면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug + tech-debt
- **Planned at**: commit `df4e066f`, 2026-11-21
- **사용자 결정 (2026-11-21)**: "검증자가 실행자보다 작은 권한을 가질 이유는 없다."

## Why this matters

지금 카드 쪽 지침과 코드가 서로 모순이라, 테스트가 필요한 카드의 검사가 "실행 안 됨"으로 남을 수 있다.

1. 카드 지침은 "검사(테스트, 빌드, lint)에 코드 스킬이 없으면 `save_code_skill`로 저장하라. 검증자는
   스킬을 저장하지 못하고 네가 저장한 것을 돌린다"고 한다(`subagent-card-agent.ts:66`).
2. 그런데 `save_code_skill`은 권한 모드가 `ask`가 아니면, 모든 단계가 프로젝트 명령 목록의 명령인 sh
   스킬을 `project_command`로 거부한다(`skills/code-skills.ts:505-520`). `vp test`가 목록에 있으면 카드는
   그 검사를 스킬로 저장할 수 없다.
3. 검증자는 `run_command`가 없고(`card-capabilities.ts:31-39`) 스킬도 저장할 수 없다. 그래서 그 검사를
   돌릴 길이 없다.
4. 카드와 검증자 모두 `find_skill`이 없다. 스킬 지침은 "find_skill로 찾으라"고 하는데 도구 목록에서
   걸러진다.

사용자는 검증자가 실행자보다 권한이 작을 이유가 없다고 정했다. 이 계획이 끝나면:

- 카드 에이전트와 검증자는 같은 도구 이름 집합 하나(`cardToolNames`)를 쓴다. 여기에 `find_skill`이 든다.
- 검사는 프로젝트 명령 목록의 줄을 `run_command`로 돌린다. 목록에 없는 검사 명령은
  `save_project_commands`로 목록에 넣는다. 코드 스킬은 목록 한 줄로 담을 수 없는 여러 단계 프로그램에만
  쓴다. 그래서 2번의 거부와 부딪히지 않는다.
- 검증자가 판정 대상인 작업을 고치면 그 판정은 통과가 아니다. 카드의 작업은 검증 전에 이미 카드
  브랜치에 commit되므로(`kanban/card-attempts.ts:32`의 주석 "The agent finished; its work is committed
  to the card branch when there was any."), 검증자가 고친 내용은 통합되지 않는다. 고친 채로 통과하면
  통과한 것과 합쳐지는 것이 달라진다. 그래서 owner가 검증 전후의 추적 파일 내용을 비교한다.

## Current state

- `packages/memory-agent/src/workflow/card-capabilities.ts` — 카드 에이전트·검증자가 받을 도구 이름과
  계획자에게 보이는 설명.

```ts
// card-capabilities.ts:9-39
export const cardAgentToolNames = HashSet.fromIterable([
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "list_outside_files",
  "read_outside_file",
  "search_outside_file",
  "write_outside_file",
  "delete_outside_file",
  "save_code_skill",
  "run_skill",
  "run_command",
  "save_project_commands",
  "read_skill",
  "read_evidence",
  "read_tool_result",
]);

/** A verifier reads the work and runs the project's saved code skills; it changes nothing. */
export const verifierToolNames = HashSet.fromIterable([
  "list_files",
  "search_files",
  "read_file",
  "run_skill",
  "read_skill",
  "read_evidence",
  "read_tool_result",
]);
```

(실제 파일은 한 줄에 이름 하나씩이다.) 같은 파일 42-56행의 `cardCapabilities`가 계획자에게 보이는
설명 문장 목록이다. 그중 바꿀 줄:

- `"- It runs host commands in a sandbox. … or once for a code skill it saves with save_code_skill and then runs with run_skill. …"`
- `"- It starts with the project's command list … A verifier reads the same list."`
- `"- It reads the project's skill catalog with read_skill, …"`
- `"- A verifier reads the card's files, reads the same skill catalog with read_skill, runs code skills that are already saved, including one the card saved, and calls the same read-only MCP tools. It cannot write files or save a skill."`
- `"- Word each acceptance criterion so a verifier can check it by reading files or running a code skill. When a check needs a command no code skill of the project runs yet, say in that card that its agent saves one, so the verifier can run it."`

- `packages/memory-agent/src/kanban/subagent-card-agent.ts`
  - 지침 문자열: `cardInstructions`(62-71행), `verifierInstructions`(73-76행 근처), `goalVerifierInstructions`(78-82행),
    `outcomeVerifierInstructions`(84-88행), `conflictResolverInstructions`(90-97행).
    - `cardInstructions`의 `"- When a check the card needs (tests, a build, a lint) has no code skill yet, save one with save_code_skill and run it: the card's verifier cannot save skills and runs the one you saved."`
    - 세 검증자 지침의 `"…read its files and run its checks, but change nothing."`과 `"…run them with the code skill that runs them; when no saved skill covers a check, report it as not run, since you cannot save skills."`
    - `conflictResolverInstructions`의 `"- When the project's checks (tests, a build, a lint) have code skills that cover the files you changed, run them."`
  - 카드 에이전트의 도구(309-323행):

```ts
/** The tools a working subagent gets in `project`: the card agent's, which the planner was told. */
const workTools = (
  project: Project,
  projectId: string,
  sessionId: string,
  mcp: { readonly tools: readonly RunTool[] },
  skills: SkillToolset,
) => [
  ...allowed(cardAgentToolNames)([
    ...fileTools.toolsFor(project),
    ...outsideTools.toolsFor(project),
    ...approvedTools.toolsFor(project, sessionId, "gate"),
    ...evidenceTools(projectId, sessionId),
    ...skills.tools,
    projectCommands.toolFor(projectId),
  ]),
  ...mcp.tools,
];
```

- 검증자의 도구(`runVerifier` 안, 414-424행):

```ts
const tools: RunTool[] = [
  ...allowed(verifierToolNames)([
    ...fileTools.toolsFor(project),
    ...approvedTools.toolsFor(project, input.sessionId, "gate"),
    ...evidenceTools(input.projectId, input.sessionId),
    ...skills.tools,
  ]),
  ...mcp.tools,
  recorder.runTool,
];
```

- `runVerifier`는 카드 검증(`verify`), Goal 검증(`verifyGoal`), outcome 검증(`verifyOutcome`)이 함께 쓴다
  (475, 494, 516행 근처). 결과는 `recorder.verdict`이거나, 없으면 `rejected(VerdictFailure.cases.NoVerdict.make({}))`
  등이다.
- 280행 근처 주석 `// Skills as the chat offers them: a catalog of the card's own folder, or none.`은 낡았다
  (스킬 목록은 더 이상 지침에 나열되지 않는다).
- `packages/memory-agent/src/kanban/failures.ts:15-34` — `VerdictFailure` TaggedUnion
  (`Rejected { note }`, `NoVerdict`, `NotFinished`, `ModelSelectionRequired`, `Unavailable`)과 그 `match`.
- 카드 작업 폴더(`CardWorktree`, `kanban/worktree.ts`)는 `toolRoot`를 가진다. 카드를 한 번에 하나씩 돌리는
  프로젝트에서는 `toolRoot`가 프로젝트 폴더 자체다(`worktree.ts:372-375`의 `projectItself`). 그때는 사용자
  자신의 커밋하지 않은 변경이 이미 있을 수 있다. 그래서 "검증 전후의 차이"로 비교해야 하고, "변경이
  있나"로 비교하면 안 된다.
- git을 부르는 기존 코드: `kanban/git-worktrees.ts`(카드 worktree의 git 구현). 테스트는
  `src/kanban/git-worktrees.test.ts`가 `git(root, "status", "--porcelain")` 같은 지원 함수를 쓴다.
- `packages/memory-agent/tests/kanban-skills.test.ts:121-158` — "a verifier gets read_skill and still no
  write tools, with and without skills". `noWrite = ["write_file", "edit_file", "delete_file", "save_code_skill"]`가
  검증자 도구에 없다고 단언한다. 같은 파일 114-115행 주석은 "find_skill … which the card's tool list does not include"라고 적는다.
  이 테스트들은 2026-11-13 결정("검증자는 읽기 전용")을 지킨 것이다. 이 계획은 사용자 결정으로 그 의도를
  바꾸므로, 테스트를 새 의도에 맞게 고치고 결정 기록에 그 사실을 적는다.
- 이 저장소의 규칙(루트 `CLAUDE.md`): Effect v4 표준 방식, tagged union은 생성자·`match`·guard로만 다룬다,
  `let`/`while` 금지, lint 비활성 주석 금지. 모델에게 보내는 형식(도구 결과 등)에는 `_tag`를 쓰지 않는다.
  화면 문구는 Lingui 메시지다.

## Commands you will need

| Purpose              | Command                                                                                         | Expected on success               |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| 서버 typecheck       | 저장소 루트에서 `vp run memory-agent#typecheck`                                                 | exit 0, `error TS`·`warning` 없음 |
| agent typecheck      | 저장소 루트에서 `vp run agent#typecheck`                                                        | exit 0, `error TS`·`warning` 없음 |
| 포맷·lint            | 저장소 루트에서 `vp check`                                                                      | exit 0                            |
| 서버 문구 검사       | 저장소 루트에서 `vp run memory-agent#i18n:check`                                                | exit 0                            |
| agent 문구 갱신·검사 | `vp run agent#i18n:extract` 뒤 `vp run agent#i18n:check`                                        | exit 0                            |
| 서버 테스트          | `cd packages/memory-agent && vp test --run tests/kanban-skills.test.ts src/kanban src/workflow` | all pass                          |

- 새 worktree에서는 먼저 `pnpm install --frozen-lockfile`. 서버 테스트가 `NativeOwnerFailed: native-incompatible`로
  건너뛰면 저장소 루트에서 `vp run turbovec#build`. `./+types/*`를 못 찾으면 `apps/agent`에서 `pnpm exec react-router typegen`.
- `vp run dev`, `vp pack`을 돌리지 않는다. lint는 저장소 루트에서 돌린다.

## Scope

**In scope**:

- `packages/memory-agent/src/workflow/card-capabilities.ts`
- `packages/memory-agent/src/kanban/subagent-card-agent.ts`
- `packages/memory-agent/src/kanban/failures.ts` (새 `VerdictFailure` case 하나)
- `VerdictFailure`의 새 case 때문에 typecheck가 가리키는 match·문구 자리(서버와 `apps/agent/app`)만
- `packages/memory-agent/src/kanban/git-worktrees.ts` 또는 `kanban/worktree.ts` (추적 파일 내용을 읽는 함수 하나가 필요할 때만)
- `packages/memory-agent/tests/kanban-skills.test.ts`, `packages/memory-agent/src/kanban/kanban-flow.test.ts`
- `packages/memory-agent/src/workflow/instructions.test.ts` (cardCapabilities 문장이 바뀌어 깨질 때만)
- `packages/memory-agent/src/kanban/README.md`, `packages/memory-agent/src/workflow/README.md`, `docs/decisions.md`
- 문구 catalog(`packages/memory-agent/src/locales/ko.po`, `apps/agent/app/locales/ko.po`) 추출 결과

**Out of scope**:

- `skills/code-skills.ts`의 `project_command` 거부 규칙. 바꾸지 않는다(검사를 목록 명령으로 돌리면 부딪히지 않는다).
- `run_command`의 샌드박스·승인 규칙. 검증자도 카드 에이전트와 같은 승인(프로젝트 권한 모드)을 받는다.
- 채팅의 `[Project commands]` 문단(`agent/chat.ts:300-305` 근처). 다른 계획에서 다룬다.
- 카드 승인, 판단 대기 함, Plan/Goal 모드.

## Git workflow

- 지금 브랜치에 commit한다. `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다. 문구가 바뀌는 commit에는
  추출한 `ko.po`를 함께 올린다.
- 메시지는 한국어 conventional commit. 예: `feat(kanban): 검증자가 카드 에이전트와 같은 도구를 받는다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 도구 이름 집합을 하나로 만든다

- `card-capabilities.ts`: `cardAgentToolNames`를 `cardToolNames`로 이름을 바꾸고 `"find_skill"`을 더한다.
  `verifierToolNames`를 지운다. doc comment는 "카드 에이전트와 검증자가 같은 도구를 받는다. 검증자는
  여기에 `record_card_verdict`를 더 받는다"로 고친다. 파일 첫 doc comment도 맞게 고친다.
- `subagent-card-agent.ts`: import를 고친다. `workTools`가 `cardToolNames`를 쓰게 하고, `runVerifier`의
  `tools`를 `[...workTools(project, input.projectId, input.sessionId, mcp, skills), recorder.runTool]`로 바꾼다.
  280행 근처 낡은 주석을 "Skills as the chat offers them: find_skill and read_skill over the catalog of the
  card's folder."로 고친다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `grep -rn "verifierToolNames\|cardAgentToolNames" packages/memory-agent` → 결과 없음.

### Step 2: 지침과 계획자 설명을 새 규칙으로 바꾼다

영어 문장으로 쓴다(모델에게 보내는 문장이다). 뜻은 아래와 같아야 한다. 문장을 다듬는 것은 괜찮다.

- `cardInstructions`의 검사 줄을 바꾼다: 검사(테스트, 빌드, lint)는 프로젝트 명령 목록의 줄을
  `run_command`(access "write")로 돌린다. 목록에 그 검사가 없으면 명령을 찾아 `save_project_commands`로
  목록에 넣고 돌린다. 검증자도 같은 목록을 읽고 같은 방식으로 돌린다. 코드 스킬은 목록 한 줄로 담을 수 없는
  여러 단계 프로그램에만 저장한다.
- 세 검증자 지침(`verifierInstructions`, `goalVerifierInstructions`, `outcomeVerifierInstructions`):
  - "change nothing"과 "since you cannot save skills"를 지운다.
  - 대신: 검사는 프로젝트 명령 목록의 줄을 `run_command`로, 또는 그것을 돌리는 코드 스킬로 돌린다. 목록에
    없으면 찾아서 목록에 넣고 돌린다. 판정 대상인 작업 파일은 고치지 않는다. 고쳐야 할 것이 있으면 통과시키지
    말고 무엇을 고쳐야 하는지를 이유로 적는다. 검증 중에 작업 파일을 고치면 그 판정은 통과가 되지 않는다.
- `conflictResolverInstructions`의 검사 줄: "바꾼 파일을 다루는 프로젝트 검사가 목록에 있으면 `run_command`로
  돌린다"로 바꾼다.
- `cardCapabilities`(계획자가 읽는 설명)의 위 다섯 줄을 새 규칙에 맞게 고친다.
  - 검증자: 카드 에이전트와 같은 도구를 가진다. 판정 대상을 고치지 않으며, 고치면 통과가 아니다.
  - 검사 기준: 수용 기준은 파일을 읽거나 프로젝트 명령(목록의 줄)을 돌려 확인할 수 있게 쓴다. 목록에 없는
    검사 명령이 필요하면 그 카드에 "목록에 넣는다"를 적는다.
  - 스킬: `find_skill`로 찾고 `read_skill`로 읽는다.
- `instructions.test.ts`가 문장 그대로를 단언해 깨지면, 새 문장에 맞게만 고친다.

**Verify**: `vp run memory-agent#typecheck` exit 0. `grep -n "cannot save skills\|change nothing" packages/memory-agent/src/kanban/subagent-card-agent.ts` → 결과 없음.
`cd packages/memory-agent && vp test --run src/workflow` → all pass.

### Step 3: 검증자가 작업을 고치면 통과가 아니다

- `failures.ts`의 `VerdictFailure`에 case 하나를 더한다:
  `/** The verifier changed tracked files of the work it judged; what it changed would not be integrated. */ ChangedWork: { files: Schema.Array(Schema.String) }`.
  `verdictFailureName` 등 이 union의 `match`를 모두 채운다. typecheck가 가리키는 서버·화면의 match와 문구
  자리를 채운다. 화면 문구 예: "검증자가 작업 파일을 고쳐 판정을 인정하지 않았습니다: {files}". 다른 실패
  문구와 같은 문체(합니다체)로 쓴다.
- `runVerifier`에서 검증자 run 전후로 `toolRoot`의 추적 파일 상태를 읽어 비교한다.
  - 읽는 값: 추적 파일 중 HEAD와 다른 파일의 이름과 그 내용의 해시. 예를 들어 `git diff HEAD --name-only`와
    `git diff HEAD --binary`의 결과(또는 그 해시)다. 추적하지 않는 새 파일은 비교에 넣지 않는다(테스트가
    만드는 산출물 때문이다).
  - 전과 후가 다르면, recorder의 판정과 관계없이 결과는 `rejected(VerdictFailure.cases.ChangedWork.make({ files }))`다.
    `files`는 전후에 내용이 달라진 파일 이름이다.
  - 검증자가 고친 내용을 되돌리지 않는다. 프로젝트 폴더 자체에서 도는 경우 사용자 변경과 섞여 있을 수 있기 때문이다.
  - git을 부를 때는 이 패키지가 이미 쓰는 방식(`kanban/git-worktrees.ts`의 실행 경로)을 재사용한다. 필요하면
    그 파일의 서비스에 함수 하나(예: `trackedChanges(root)`)를 더한다.
  - 상태를 읽지 못하면(예: git 실패) 지금처럼 recorder의 판정을 쓰고 `logFailure`로 남긴다. 판정을 막지 않는다.

**Verify**: 두 typecheck exit 0, `vp run memory-agent#i18n:check` exit 0, `vp run agent#i18n:extract` 뒤
`vp run agent#i18n:check` exit 0.

### Step 4: 테스트

- `tests/kanban-skills.test.ts`:
  - 검증자 테스트를 고친다. 이름: `"a verifier gets the card agent's tools, find_skill and record_card_verdict"`.
    검증자의 `toolNames`가 카드 에이전트의 `toolNames`(같은 파일의 카드 테스트처럼 `CardAgent.run`으로 얻는다)를
    모두 포함하고, `record_card_verdict`도 포함함을 단언한다. `find_skill`, `run_command`, `save_code_skill`이
    들어 있음을 명시적으로 단언한다.
  - 카드 테스트 두 개에 `expect(child?.toolNames).toContain("find_skill")`을 더하고, 114-115행의 낡은 주석을 고친다.
- `src/kanban/kanban-flow.test.ts`(이 파일은 card agent와 verifier만 스크립트로 두고 실제 DB·큐·엔진을 쓴다):
  스크립트 검증자가 판정으로 passed를 기록하면서 작업 폴더의 추적 파일 하나를 고치면, 그 카드의 검증 결과가
  `ChangedWork`가 되어 통과하지 않는 테스트를 하나 더한다. 같은 파일의 "gives the card's next attempt the reason
  its verifier did not pass the work" 테스트(217행 근처)를 본보기로 삼는다. 스크립트 검증자가 파일을 고칠 수
  없는 구조이거나 `runVerifier`를 거치지 않는 구조라면 이 테스트는 만들지 말고 보고에 적는다(STOP 아님).

**Verify**: `cd packages/memory-agent && vp test --run tests/kanban-skills.test.ts src/kanban src/workflow` → all pass.

### Step 5: 문서

- `src/kanban/README.md`, `src/workflow/README.md`에서 `verifierToolNames`·"검증자는 읽기 전용"·"검증자는
  run_command가 없다"를 적은 줄을 새 규칙으로 고친다(`grep -n "verifier\|검증자" ` 로 찾는다).
- `docs/decisions.md` 끝에 새 항목:
  - 제목: `검증자는 카드 에이전트와 같은 도구를 받고, 검사는 프로젝트 명령으로 돌린다 (2026-11-21)`
  - 계기: 카드 지침은 검사를 코드 스킬로 저장하라 했지만, `ask`가 아닌 모드는 목록 명령만 부르는 sh 스킬을
    `project_command`로 거부했고, 검증자는 `run_command`도 스킬 저장도 없어 테스트가 "실행 안 됨"으로 남을 수
    있었다. 카드와 검증자의 스킬 지침은 `find_skill`을 말했지만 도구가 없었다.
  - 결정(사용자: "검증자가 실행자보다 작은 권한을 가질 이유는 없다"): 카드 에이전트와 검증자는 같은 도구 집합
    (`cardToolNames`, `find_skill` 포함)을 받는다. 검사는 프로젝트 명령 목록의 줄을 `run_command`로 돌리고, 없는
    검사 명령은 목록에 넣는다. 코드 스킬은 여러 단계 프로그램에만 쓴다. 검증자가 판정 대상의 추적 파일을 바꾸면
    판정은 `ChangedWork`로 통과하지 않는다(카드 작업은 검증 전에 commit되어, 검증자가 고친 것은 통합되지 않기 때문이다).
  - 대체하는 결정: "카드 에이전트와 검증자도 스킬 카탈로그와 read_skill을 받는다 (2026-11-13)"의 "검증자는 쓰기
    도구가 없다", "스킬은 목록으로 보이지 않고 find_skill로 찾는다 (2026-11-13)"의 "카드 에이전트와 검증자는 스킬
    도구가 없고 run_skill만 쓴다", "호스트 명령은 접근 수준을 정해 run_command로 실행한다 (2026-11-14)"의 "검증자는
    받지 않는다".
  - 확인: `tests/kanban-skills.test.ts`, `src/kanban/kanban-flow.test.ts`(Step 4에서 만들었다면).

**Verify**: `vp check` exit 0.

## Test plan

- 고친 테스트 1개, 단언 2개 추가(`tests/kanban-skills.test.ts`), 새 흐름 테스트 1개(`kanban-flow.test.ts`, 가능할 때).
- `cd packages/memory-agent && vp test --run tests/kanban-skills.test.ts src/kanban src/workflow` → all pass.

## Done criteria

- [ ] 두 typecheck exit 0, `error TS`·`warning` 없음
- [ ] `vp check`, `vp run memory-agent#i18n:check`, `vp run agent#i18n:check` exit 0
- [ ] 서버 테스트 명령 all pass
- [ ] `grep -rn "verifierToolNames\|cardAgentToolNames" packages/memory-agent` 결과 없음
- [ ] `grep -n "cannot save skills" packages/memory-agent/src` 결과 없음
- [ ] 범위 밖 파일이 바뀌지 않았다(`git status`)

## STOP conditions

- 카드 작업이 검증 전에 commit된다는 전제가 틀렸다(예: `card-attempts.ts`나 orchestrator에서 commit이 검증 뒤에
  일어난다). 그러면 Step 3의 근거가 달라지므로 멈추고 보고한다.
- `runVerifier`를 거치지 않는 검증 경로가 있다.
- 추적 파일 상태를 읽으려면 새 프로세스 실행 기반을 만들어야 한다(기존 git 실행 경로를 재사용할 수 없다).
- `VerdictFailure`의 새 case가 DB에 저장된 값의 decode를 깨뜨린다(옛 행이 새 스키마로 읽히지 않는다).
- 같은 검증이 한 번 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 검증자의 `run_command` 쓰기 호출도 카드 에이전트처럼 권한 모드에 따라 승인을 묻는다. `ask` 모드에서는 검증마다
  승인 창이 늘 수 있다. 목록 명령을 한 번 승인하는 일은 2026-11-14 결정의 "하지 않은 것"에 이미 열려 있다.
- 검사 산출물이 추적 파일을 바꾸는 프로젝트(예: 스냅샷을 다시 쓰는 테스트)는 `ChangedWork`로 실패할 수 있다.
  그런 사례가 보이면 비교 대상에서 뺄 규칙을 따로 정한다.
