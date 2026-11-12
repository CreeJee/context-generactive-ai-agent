# chat

## Overview

`apps/agent` 프론트엔드(React)의 채팅 화면 디렉터리다. 한 세션의 대화 패널(`SessionView`/`ChatPanel`), 입력창, 메시지 렌더링, 승인 카드, 대기열·BTW·워크플로·작업 추적·보드 패널을 맡는다.

대화 데이터는 서버가 소유한다. 페이지는 `chatRuntime`(Effect Atom runtime + `ChatApiClient`)과 `memory-agent/chat-session`의 `chatSessions`/`btwThreads` atom으로 메시지를 읽고 turn과 승인 답을 보낸다. 슬래시 명령 파싱, 승인 interrupt 변환, 전달된 대기열 메시지 대조, draft 이미지 번호 매기기 같은 순수 로직은 별도 `.ts` 파일에 있다.

## Interface

- `SessionView` — 한 세션의 진입 컴포넌트다. `useSessionLease`로 lease를 따른다. 읽기 전용 페이지는 소유 페이지가 run을 시작하거나 끝낼 때 revision 키로 `ChatPanel`을 다시 마운트한다. props: `sessionId`, `imagesSupported`, `slash`, `sendingEnabled`
- `SlashSupport` — 슬래시 명령의 `SlashContext`와, 패널 밖에서 실행할 명령(new/agent/mode/model/effort/settings/report)을 처리하는 `run`을 묶은 인터페이스
- `chatRuntime` — 페이지 전체가 공유하는 `Atom.runtime`이다. `ChatApiClient.layer`+`FetchHttpClient.layer`, `FetchHttpClient.Fetch`=`appFetch`, `SecureRandom.SecureRandom`=`browserCrypto`를 합친다
- `useAgentChat` — 한 세션 대화 훅이다. 열면 최신 메시지를 읽고 진행 중 run에 다시 붙는다. 그 뒤 다른 탭이나 서버가 시작한 run도 따라 읽는다. run 상태의 최신 run id를 세션 Atom `latest`에 넘기고, 판단은 `chatSessions`의 `follow`가 한다. `onNotTaken`은 서버가 거절했거나 받지 못한 turn을 받는다. ChatPanel은 보낸 글과 이미지를 입력창에 되돌리고, `run_in_progress` 거절이면 대기열에 넣는다. 반환: `messages`, `opened`(세션을 한 번 읽었는지. `ChatHistory`는 읽기 전에는 "새 대화" 대신 로딩을 보인다), `openFailed`·`reopen`(처음 읽기가 실패했을 때 오류와 다시 시도), `hasOlderMessages`, `loadOlderMessages`, `sendMessage`, `stop`, `isLoading`, `sessionGenerating`, `resuming`, `failure`, `refusal`, `dismissRefusal`, `unsent`, `interrupts`, `answerProblem`, `resolveInterrupts`
- `AnswerProblem` — 승인 답이 이어지지 못한 이유 TaggedEnum: `unsent` | `refused{refusal}` | `lost`. `ChatApprovals`는 `refused`를 거절 코드로 나눈다: `no_user_turn`·`empty_message`는 승인 목록이 바뀐 것이고, 나머지는 `refusalTexts` 문구를 보인다
- `useBtwThread` — BTW 스레드 하나의 훅(`btwThreads(chatRuntime)`)이다. `onNotTaken`은 서버가 받지 않은 질문을 받는다. 반환: `messages`, `ask`, `isLoading`, `failure`, `error`, `refusal`
- `PendingApproval` / `toPendingApproval` / `approvalAnswer` — 승인 대기 TaggedEnum(`tool-approval`, `permission-review`)이다. `PendingInterrupts`의 interrupt를 reason별로 바꾸고, 결정을 `ResumeEntry`로 만든다
- `missingDeliveredMessages` — 전달된 대기열 항목 중 아직 transcript에 user turn이 없는 것만 남기는 dual 함수
- `SlashCommand` / `SlashParse` / `parseSlash` / `suggest` / `commandSpecs` / `SlashContext` / `Suggestion` / `promptOf` — 슬래시 명령의 정의, 파싱(`not_command`/`incomplete`/`command`), 자동완성 제안, skill·recall 명령이 보낼 프롬프트 문구
- `useDraftImages` / `DraftImage` / `renumberReferences` / `acceptedImageTypes` — 작성 중 메시지의 이미지 업로드 상태(uploading/ready/failed)와 `#N` 참조 재번호, 허용 MIME 목록
- `ComposerMode` / `ComposerStatus` / `ComposerShortcuts` — 입력창 상태(idle/generating/editing/approval)와, 그 상태에 맞는 상태줄과 단축키 힌트
- `ChatComposer` / `ChatComposerHandle` — 입력창 컴포넌트와 그 명령형 핸들(본문은 읽지 않음)
- `ApprovalCard` — 승인 대기 호출 하나를 보여 주는 카드다. props: `approval`, `disabled`, `requester`, `decision`, `onAnswer`. permission-review이고 `askedBy`가 review일 때만 검토 사유를 보인다
- `ChatHistory` — 대화 기록 스크롤 영역이다. shadcn `MessageScroller` 위에 있어, 맨 아래에서 120px 안이면 새 내용을 따라 내려가고 아래로 가는 단추를 띄운다. 위쪽 200px 안으로 올라가면 이전 페이지를 불러오고, 위에 끼운 페이지가 읽던 자리를 밀지 않는다. 불러오기에 실패하면 위쪽에 다시 시도 단추를 띄운다. 메시지마다 `MessageScrollerItem`이고 `children`(패널·상태 표시)은 메시지 뒤에 온다
- `MessageView`(memo) / `DeliveredMessageView` / `ResumeActionResult` / `ArchiveActionResult` / `DeleteActionResult` — 메시지 렌더링과 작업 추적 task 재개·보관·삭제 결과 TaggedEnum
- `WorkflowBoard` / `BoardTally` / `OpenBoardButton` / `mergeStateLabel` / `authorLabel` — 워크플로 바에 들어가는 보드 조각이다. `BoardTally`는 바의 한 줄에 카드 완료·outcome 충족 수와 판단 대기를, `OpenBoardButton`은 보드 버튼과 보드 시트(`?board=1`, 카드 peek는 `?card=…`)를 맡아 바를 접어도 보드가 열린다. `WorkflowBoard`는 펼친 바의 본문으로 칸반 루프 상태, outcome, 카드를 한 줄씩 보인다. 승인 전 Plan(draft·ready)의 카드는 Plan 순서로, 실행 중에는 판단 필요·막힘·진행 중이 앞에 온다. 카드 줄은 보드 peek를 여는 링크다. `authorLabel`은 `board/`에서 다시 내보낸다
- `OutcomeChecklist` / `metOutcomes` — Goal의 outcome마다 장부 상태(카드 없음·진행 중·확인 대기·충족·미충족)와 판정을 한 줄씩 보이는 목록. 충족 수가 Goal의 진척이다
- `WorkflowRows` / `WorkflowRow` — 워크플로 바의 제목 달린 한 줄 목록과 그 줄이다. 줄은 24px 한 줄로 잘리고 전체 글은 `title`에 둔다. `render`로 링크가 되면 hover가 표시된다
- `WorkflowArtifactPanel` / `stageLabels` / `modeLabels` / `composerModeOf` / `workflowModeLabel` / `goalStatusLabels` / `planStatusLabels` — 입력창 위의 워크플로 바와 라벨 표. 접으면 한 줄로 모드·단계(계획 중·실행 중·완료), Goal 문장, 보드 수치와 다음 동작(Plan 모드의 승인하고 실행, 일시 중지된 Goal의 계속, 보드)을 보이고, 서버 알림은 그 아래 한 줄씩 붙는다. 펼치면 안내, Goal·Plan 요약, 보드, Plan의 열린 질문과 위험을 제 높이(최대 24rem·40dvh) 안에서 스크롤하고, 바닥에 Plan 수정·일시 중지·중단을 둔다. 승인 전 Plan은 펼친 채로 열리고 Plan 버전이 바뀌면 다시 펼친다. 펼침 영역은 접혀도 마운트된 채라 동작 버튼이 늘 있다
- `DecisionPrompt` / `describeDecision` — 결정 요청 프롬프트와 `DecisionKind` 설명
- `BtwPanel` / `WorkTracePanel` / `QueuePanel` / `SubagentPanel` — BTW 곁질문, 작업 추적, 메시지 대기열, 하위 에이전트 패널
- `BackgroundTaskIndicator` — 입력창 아래 상태줄 왼쪽(컨텍스트 표시 반대편)의 `백그라운드 N개`. 누르면 팝오버로 현재 세션의 실행 중 백그라운드 작업 목록(종류, 경과 시간)을 보여 준다. 목록은 run-state의 `background`에서 읽는다
- 문구 — 채팅 화면의 문구는 쓰이는 자리에 Lingui 메시지(`<Trans>`, `` t`…` ``, `msg`)로 쓴다. `app/locales/ko.po`로 추출되고 `lint/wording`이 검사한다
- `refusalTexts` — chat API가 거절하는 모든 코드의 문구 표(`Record<Refusal["error"], MessageDescriptor>`). 코드가 늘면 문구가 생길 때까지 컴파일되지 않는다. 보내기 거절과 승인 답 거절이 같은 문구를 쓴다
- 그 밖의 export(본문 미확인): `ChatApprovals`, `ContextMeter`, `Markdown`, `ReadOnlyBar`, `SlashPalette`, `UncertainRuns`, `RunFailureText`/`runFailureOf`, `UserMessageBody`/`DrawingPicture`/`DraftImageTray`/`MessageImage`
- [`board`](./board/README.md) — 한 대화의 Plan 또는 프로젝트의 모든 실행 중 Plan을 7개 상태 열에 보여 주는 칸반 보드 UI

## Invariants

- 서버가 transcript를 소유한다. `ChatPanel`은 마운트할 때 최신 메시지와 남은 승인 대기를 함께 읽는다. 그래서 새로고침해도 같은 승인 카드가 다시 보인다.
- turn과 승인 답에는 항상 `holder`를 넣어 보낸다. 서버는 다른 페이지가 보낸 turn과 답을 거절한다(`session_in_use`).
- 실행 중인 보드에서 입력창의 모드 전환이나 "Plan 수정"으로 running을 떠나면 먼저 확인한다. 떠나면 보드가 새 카드를 맡기지 않기 때문이다. 직접 입력한 slash 명령은 묻지 않는다.
- `readOnly = lease.state !== "mine"`이다. `mutationBlocked = readOnly || backendRestartRequired || !sendingEnabled`이다.
- `stop()`은 `Atom.Interrupt`로 이 페이지의 읽기만 끊는다. 서버의 run은 서버에서 취소할 때까지 계속 돈다.
- `resolveInterrupts`는 `interrupts !== null`일 때만 보낸다. 이때 `parentRunId`는 `interrupts.runId`다.
- `approvalAnswer`는 `{ interruptId, status: "resolved", payload: { approved } }` 모양의 `ResumeEntry`를 만든다.
- `toPendingApproval`은 `Match.discriminatorsExhaustive("reason")`으로 `tool_call`과 `permission_review`를 모두 처리해야 한다. 새 reason이 생기면 타입 오류가 난다. `askedBy`가 없으면 기본값은 `"review"`다.
- `answerProblem`의 `"lost"`는 답 전송은 성공했지만 run이 실패했고 interrupts가 아직 남은 경우다.
- `missingDeliveredMessages`는 queue id로만 transcript와 맞춘다. 전달된 user turn은 0.0.11부터 queue id를 담는다.
- draft 이미지의 `#N` 번호는 draft를 보내거나 비울 때까지 바뀌지 않는다. 보낼 때 `renumberReferences`로 실제 보낸 이미지의 순서에 맞춰 번호를 다시 매긴다.
- object URL은 이미지가 draft에서 빠질 때 revoke한다. remove, clear, 언마운트가 모두 해당한다. `clear`는 번호를 1로 되돌린다.
- png/jpeg/gif/webp가 아닌 이미지는 업로드하지 않고 바로 failed가 된다.
- 슬래시 명령: 같은 이름의 command가 skill보다 우선한다. 그 skill은 `/skill`로 여전히 부를 수 있다. 모르는 `/word`는 일반 메시지(`not_command`)로 둔다(예: 경로).
- `/mode` 값은 ask와 auto만 허용한다. 모델에 effort 선택지가 없으면 `/effort`는 `incomplete`를 돌려준다.
- 슬래시 오류 문구는 명령마다 완전한 문장으로 쓴다(조사 유지).
- compose draft는 `sessionDrafts(sessionId)`의 `text` atom에 둔다. 빈 문자열이 되면 그 세션의 키를 지운다. ChatPanel은 `follow`를 마운트해 마운트할 때와 탭이 다시 보일 때 저장값을 읽는다. 대기열 메시지를 편집하는 동안의 글은 `Composer.editing`이 가진 atom에 둔다.
- 입력 중인 글(compose draft와 편집 글)은 입력창(`DraftComposer`)만 구독한다. ChatPanel은 draft를 쓰기만 하고, 보낼 때 입력창이 넘긴 글을 받는다. 그래서 글자를 칠 때 대화 기록과 패널은 다시 렌더되지 않는다(`chat-panel.browser.tsx`).
- 대기열 항목은 waiting/editing/held 상태만 편집할 수 있다. delivered와 failed는 편집할 수 없다.
- task 액션은 `mutateAsync`의 동일성에 기대어 만든다. 그래서 메시지는 자기 변경이 있을 때만 다시 렌더된다(주석 근거).
- `ApprovalCard`의 승인은 그 호출을 정확히 한 번 실행한다. 읽기 전용 페이지(disabled)는 승인 요청을 보여만 주고 답할 수 없다.

## Side Effects

- 네트워크: `chatRuntime`의 `ChatApiClient`가 같은 origin으로 HTTP 요청을 보낸다(`appFetch`). 대상은 세션 열기, 이전 메시지 읽기, turn 전송, 승인 답(resume), BTW 질문이다. run은 SSE 스트림으로 읽는다(`Sse.Retry`는 `"run_stream_retry"`로 표시).
- 네트워크: `api.uploadAttachment(file)`로 이미지 첨부를 업로드한다.
- React Query mutation으로 trace task를 재개·보관·삭제하고, 세션을 compact한다(`useResumeTraceTaskMutation` 등).
- 브라우저: `URL.createObjectURL`/`URL.revokeObjectURL`로 미리보기 URL을 관리한다. `navigator.userAgent`를 읽어 수정 키(⌘/Ctrl)를 정한다.
- `sessionDrafts`로 세션별 draft를 localStorage에 쓴다. nuqs로 URL 쿼리 `board`와 `card`를 읽는다.
- `browserCrypto.uuidV4()`를 `Effect.runSync`로 실행해 draft 이미지 key를 만든다.
- 편집 draft 저장 지연 상수 `editDraftSaveMs = 400`(타이머 구현부는 읽지 않음).

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
