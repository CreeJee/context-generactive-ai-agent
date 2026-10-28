# chat

## Overview

`apps/agent` 프론트엔드(React)의 채팅 화면 디렉터리다. 한 세션의 대화 패널(`SessionView`/`ChatPanel`), 입력창, 메시지 렌더링, 승인 카드, 대기열·BTW·워크플로·작업 추적·보드 패널을 맡는다.

대화 데이터는 서버가 소유한다. 페이지는 `chatRuntime`(Effect Atom runtime + `ChatApiClient`)과 `memory-agent/chat-session`의 `chatSessions`/`btwThreads` atom으로 메시지를 읽고 turn과 승인 답을 보낸다. 슬래시 명령 파싱, 승인 interrupt 변환, 전달된 대기열 메시지 대조, draft 이미지 번호 매기기 같은 순수 로직은 별도 `.ts` 파일에 있다.

## Interface

- `SessionView` — 한 세션의 진입 컴포넌트다. `useSessionLease`로 lease를 따른다. 읽기 전용 페이지는 소유 페이지가 run을 시작하거나 끝낼 때 revision 키로 `ChatPanel`을 다시 마운트한다. props: `sessionId`, `imagesSupported`, `slash`, `sendingEnabled`
- `SlashSupport` — 슬래시 명령의 `SlashContext`와, 패널 밖에서 실행할 명령(new/agent/mode/model/effort/settings/report)을 처리하는 `run`을 묶은 인터페이스
- `chatRuntime` — 페이지 전체가 공유하는 `Atom.runtime`이다. `ChatApiClient.layer`+`FetchHttpClient.layer`, `FetchHttpClient.Fetch`=`appFetch`, `Crypto.Crypto`=`browserCrypto`를 합친다
- `useAgentChat` — 한 세션 대화 훅이다. 열면 최신 메시지를 읽고 진행 중 run에 다시 붙는다. 반환: `messages`, `hasOlderMessages`, `loadOlderMessages`, `sendMessage`, `stop`, `isLoading`, `sessionGenerating`, `resuming`, `failure`, `refusal`, `unsent`, `interrupts`, `answerProblem`, `resolveInterrupts`
- `AnswerProblem` — 승인 답이 이어지지 못한 이유: `"unsent"` | `"refused"` | `"lost"`
- `useBtwThread` — BTW 스레드 하나의 훅(`btwThreads(chatRuntime)`)이다. 반환: `messages`, `ask`, `isLoading`, `failure`, `error`, `refusal`
- `PendingApproval` / `toPendingApproval` / `approvalAnswer` — 승인 대기 TaggedEnum(`tool-approval`, `permission-review`)이다. `PendingInterrupts`의 interrupt를 reason별로 바꾸고, 결정을 `ResumeEntry`로 만든다
- `missingDeliveredMessages` — 전달된 대기열 항목 중 아직 transcript에 user turn이 없는 것만 남기는 dual 함수
- `SlashCommand` / `SlashParse` / `parseSlash` / `suggest` / `commandSpecs` / `SlashContext` / `Suggestion` / `promptOf` — 슬래시 명령의 정의, 파싱(`not_command`/`incomplete`/`command`), 자동완성 제안, skill·recall 명령이 보낼 프롬프트 문구
- `useDraftImages` / `DraftImage` / `renumberReferences` / `acceptedImageTypes` — 작성 중 메시지의 이미지 업로드 상태(uploading/ready/failed)와 `#N` 참조 재번호, 허용 MIME 목록
- `ComposerMode` / `ComposerStatus` / `ComposerShortcuts` — 입력창 상태(idle/generating/editing/approval)와, 그 상태에 맞는 상태줄과 단축키 힌트
- `ChatComposer` / `ChatComposerHandle` — 입력창 컴포넌트와 그 명령형 핸들(본문은 읽지 않음)
- `ApprovalCard` — 승인 대기 호출 하나를 보여 주는 카드다. props: `approval`, `disabled`, `requester`, `decision`, `onAnswer`. permission-review이고 `askedBy`가 review일 때만 검토 사유를 보인다
- `MessageView`(memo) / `DeliveredMessageView` / `ResumeActionResult` / `ArchiveActionResult` / `DeleteActionResult` — 메시지 렌더링과 작업 추적 task 재개·보관·삭제 결과 TaggedEnum
- `WorkflowBoard` / `mergeStateLabel` / `cardStatusLabels` / `authorLabel` — 채팅 안의 보드 패널이다. 뒤의 두 심볼은 `board/`에서 다시 내보낸다
- `WorkflowArtifactPanel` / `phaseLabels` / `workflowModeLabel` / `goalStatusLabels` / `planStatusLabels` — Goal/Plan 워크플로 패널과 상태 라벨 표
- `DecisionPrompt` / `describeDecision` — 결정 요청 프롬프트와 `DecisionKind` 설명
- `BtwPanel` / `WorkTracePanel` / `QueuePanel` / `SubagentPanel` — BTW 곁질문, 작업 추적, 메시지 대기열, 하위 에이전트 패널
- 그 밖의 export(본문 미확인): `ChatApprovals`, `ChatHistory`, `ContextMeter`, `Markdown`, `ReadOnlyBar`, `SlashPalette`, `UncertainRuns`, `RunFailureText`/`runFailureOf`, `UserMessageBody`/`DrawingPicture`/`DraftImageTray`/`MessageImage`
- [`board`](./board/README.md) — 한 대화의 Plan 또는 프로젝트의 모든 실행 중 Plan을 7개 상태 열에 보여 주는 칸반 보드 UI

## Invariants

- 서버가 transcript를 소유한다. `ChatPanel`은 마운트할 때 최신 메시지와 남은 승인 대기를 함께 읽는다. 그래서 새로고침해도 같은 승인 카드가 다시 보인다.
- turn과 승인 답에는 항상 `holder`를 넣어 보낸다. 서버는 다른 페이지가 보낸 turn과 답을 거절한다(`session_in_use`).
- `readOnly = lease.state !== "mine"`이다. `mutationBlocked = readOnly || backendRestartRequired || !sendingEnabled`이다.
- `stop()`은 `Atom.Interrupt`로 이 페이지의 읽기만 끊는다. 서버의 run은 서버에서 취소할 때까지 계속 돈다.
- `resolveInterrupts`는 `interrupts !== null`일 때만 보낸다. 이때 `parentRunId`는 `interrupts.runId`다.
- `approvalAnswer`는 `{ interruptId, status: "resolved", payload: { approved } }` 모양의 `ResumeEntry`를 만든다.
- `toPendingApproval`은 `Match.discriminatorsExhaustive("reason")`으로 `tool_call`과 `permission_review`를 모두 처리해야 한다. 새 reason이 생기면 타입 오류가 난다. `askedBy`가 없으면 기본값은 `"review"`다.
- `answerProblem`의 `"lost"`는 답 전송은 성공했지만 run이 실패했고 interrupts가 아직 남은 경우다.
- `missingDeliveredMessages`는 먼저 queue id로 transcript와 맞춘다. queue id 없이 저장된 옛 turn은 텍스트와 `attachmentIds` 순서가 정확히 같을 때만 맞춘다. 이 대조는 첫 assistant turn 뒤의 user 메시지에만 하고, 각 옛 turn은 한 번만 소비한다. 첫 user 요청이 내용이 같은 follow-up을 소비하면 안 된다.
- draft 이미지의 `#N` 번호는 draft를 보내거나 비울 때까지 바뀌지 않는다. 보낼 때 `renumberReferences`로 실제 보낸 이미지의 순서에 맞춰 번호를 다시 매긴다.
- object URL은 이미지가 draft에서 빠질 때 revoke한다. remove, clear, 언마운트가 모두 해당한다. `clear`는 번호를 1로 되돌린다.
- png/jpeg/gif/webp가 아닌 이미지는 업로드하지 않고 바로 failed가 된다.
- 슬래시 명령: 같은 이름의 command가 skill보다 우선한다. 그 skill은 `/skill`로 여전히 부를 수 있다. 모르는 `/word`는 일반 메시지(`not_command`)로 둔다(예: 경로).
- `/mode` 값은 ask와 auto만 허용한다. 모델에 effort 선택지가 없으면 `/effort`는 `incomplete`를 돌려준다.
- 슬래시 오류 문구는 명령마다 완전한 문장으로 쓴다(조사 유지).
- compose draft는 `sessionDraftsAtom`에 sessionId별로 둔다. 빈 문자열이 되면 그 키를 지운다. 대기열 메시지 편집 중에는 draft를 `Composer.editing` 상태에 둔다.
- 대기열 항목은 waiting/editing/held 상태만 편집할 수 있다. delivered와 failed는 편집할 수 없다.
- task 액션은 `mutateAsync`의 동일성에 기대어 만든다. 그래서 메시지는 자기 변경이 있을 때만 다시 렌더된다(주석 근거).
- `ApprovalCard`의 승인은 그 호출을 정확히 한 번 실행한다. 읽기 전용 페이지(disabled)는 승인 요청을 보여만 주고 답할 수 없다.

## Side Effects

- 네트워크: `chatRuntime`의 `ChatApiClient`가 같은 origin으로 HTTP 요청을 보낸다(`appFetch`). 대상은 세션 열기, 이전 메시지 읽기, turn 전송, 승인 답(resume), BTW 질문이다. run은 SSE 스트림으로 읽는다(`Sse.Retry`는 `"run_stream_retry"`로 표시).
- 네트워크: `api.uploadAttachment(file)`로 이미지 첨부를 업로드한다.
- React Query mutation으로 trace task를 재개·보관·삭제하고, 세션을 compact한다(`useResumeTraceTaskMutation` 등).
- 브라우저: `URL.createObjectURL`/`URL.revokeObjectURL`로 미리보기 URL을 관리한다. `navigator.userAgent`를 읽어 수정 키(⌘/Ctrl)를 정한다.
- jotai `sessionDraftsAtom`에 세션별 draft를 쓴다. nuqs로 URL 쿼리 `board`와 `card`를 읽는다.
- `browserCrypto.randomUUIDv4()`를 `Effect.runSync`로 실행해 draft 이미지 key를 만든다.
- 편집 draft 저장 지연 상수 `editDraftSaveMs = 400`(타이머 구현부는 읽지 않음).

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
