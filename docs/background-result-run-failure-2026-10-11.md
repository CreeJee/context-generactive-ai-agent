# Background 결과 조회 뒤 Goal 실행 실패 조사

05:31 UTC 후속 적용 완료: 최신 dev 코드로 시작하고 새 보고서 조회 실패 operation 54에도
원본 보존·백업 복원 검증 후 별도 receipt를 적용했다. 두 실패 원본과 이전 receipt가 유지되고
실제 입력 admission은 ready다. [최신 적용 기록](subagent-report-run-failure-2026-10-11.md#승인-후-실제-적용-2026-10-11-0531-utc)을 따른다.

04:37 UTC 후속: 이전 run의 복구는 유지됐지만 새 run의 `get_subagent_reports` 조회에서 별도
실패가 발생했다. 사용자 요청으로 dev 서버를 정상 종료했다. 새 수정·제한된 복구 평가는
검증했으나 새 receipt 적용은 아직 남아 있다. [새 실패 조사](subagent-report-run-failure-2026-10-11.md)를 따른다.

최신 상태(2026-10-11 04:20 UTC): 사용자 승인 후 대상 세션의 읽기 복구를 적용했다.
원본 failed/uncertain/Failure는 보존했고 새 입력의 admission은 ready다. 아래 초기 조사와
적용 전 제한은 당시 기록이며, 마지막 「실제 적용과 DB 단일 기준」 절이 최신 결론이다.

2026-10-11, 대상 앱 세션 `3bfb5fe9-4ef1-48be-be32-6f019e35b4a2`를 읽기 전용으로 조사했다.
세션에 메시지를 보내거나 실행을 재시도하지 않았으며 사용자 DB와 기존 서버를 변경하지 않았다.

## 확인한 실패와 원인 범위

- 마지막 실행은 `run-1791648153403-oeyfkb`이며 2026-10-10 16:02:45 UTC에 시작해
  17:21:16 UTC에 `failed/worker_execution_failed`로 끝났다. 이후 해당 세션의 새 실행은 없다.
- GoalExecution `495a5d48193d4253f467bf2b8c2fb45c`의 저장된 Failure는
  `GoalExecutionError / SideEffectUncertain`, operationId `2501`, state `uncertain`이다.
  `owner_workflow_executions.status=completed`와 이벤트 `run_completed`는 workflow/producer의
  종료를 뜻하며 실행 성공을 뜻하지 않는다. 저장된 exit와 chat_runs는 실패다.
- 해당 operation은 `get_background_result`, taskId
  `a9b98290-d47c-4b13-b325-08c95ca2a409`, offset 0이다. 현재 이 task의 work_tasks,
  agent_run_attempts, background 결과 metadata가 없다. 바로 앞 authorize operation까지 성공했다.
- 원래 tool exception과 stack은 ledger의 uncertain 응답과 일반화된 RUN_ERROR에 저장되지 않았다.
  따라서 당시 exception을 `BackgroundTaskNotFound`로 확정할 수는 없다. 현재 데이터와 실제 서비스의
  격리 재현은 이 경로를 지지한다. SDK가 RPC 거절을 도구 오류로 받은 뒤 응답을 마칠 수 있어도,
  durable Goal 완료 검사는 남은 uncertain operation을 확인하고 실행을 실패시킨다.
- 오늘 실행 중인 backend는 2026-10-11 02:59:20.917 UTC에 시작했다.
  backend build ID `301e02588255b1cefabc8692`, runtime instance
  `25709530-b735-4ecf-a386-84b7c93a65e3`는 오늘 manifest와 일치하고 health는 ready다.
  이는 어제 실패한 프로세스의 stack/exit 증거가 아니다. 이 run에 대해 SQLite SIGBUS를 입증하는
  저장된 증거는 찾지 못했다.
- 현재 addon SHA-256은 `77df01cb811d113a68318165ffce6601e0c58ed32ad150f323e56d9788e59563`이다.
  readonly lsof에서 backend가 해당 addon을 로드한 것을 확인했다. 교체하지 않았다.
- I/O 변경 commit `e899e2a`는 실패 실행 도중인 17:08:25 UTC에 만들어졌지만 background 도구와
  read-only 목록을 수정하지 않았다. 파일 범위 I/O 변경은 보존했다.

## 최소 변경

`src/tools/parallel-reads.ts`의 읽기 도구 목록에 `get_background_result`를 추가했다.
현재 owner RPC는 이 목록의 도구 예외를 tagged failed outcome으로 반환하고 SDK의 실패 도구 결과로
기록한다. ledger의 RPC는 정상적으로 종료되므로 읽기 실패가 uncertain side effect로 남지 않는다.
실패한 결과를 완료 근거로 사용하는 것은 허용하지 않는다.

실제 BackgroundTasks 서비스와 임시 DB, scripted provider, 실제 SDK worker를 사용한 회귀를
`tests/full-loop-execution.test.ts`에 추가했다. 없는 task의 조회 오류가 원래 메시지와 함께 후속 모델에
전달되고 ledger가 종료되는지 확인한다. 취소 도구의 같은 오류는 여전히 uncertain으로 남는지도 확인한다.
사용자 DB, keychain, 실제 모델 호출은 사용하지 않는다.

## 기존 세션의 복구 제한

기존 operation 2501은 그대로 uncertain이다. ledger는 같은 session/Goal의 다음 side effect를
차단하며 이미 uncertain인 row를 일반 settle API로 변경하지 않는다. 코드 수정이나 서버 재시작은
이 기록을 해결하지 않는다. worker generation을 회전하거나 실패 실행을 자동 재생해서도 안 된다.

안전한 후속 복구에는 일관된 DB backup과 operation 2501의 읽기 전용 계약·실제 실행 경계를 확인한
명시적 reconciliation 설계가 필요하다. 원래 반환값을 모르는 채 성공 receipt를 만들거나 과거 기록을
삭제하지 않는다. 별도 사용자 승인과 감사 가능한 복구 절차 없이 실제 row를 수정하지 않았다.
새 코드의 적용도 현재 backend 재빌드·재시작이 필요하므로 이번 읽기 조사에서는 실행하지 않았다.

## 검증

- 변경 전 격리 재현에서 없는 task의 `get_background_result` 호출은 ledger에 uncertain으로 남고,
  SDK에는 `Goal worker RPC owner_rejected`만 전달됐다. 변경 후에는 task-not-found 도구 오류가 전달되고
  RPC row가 succeeded로 종료됐다. 이것은 도구 성공이 아니라 확정된 실패 응답의 전달 성공이다.
- 관련 테스트 6개 파일, 60개 통과. 마지막 cancellation-controller 위치 정리 후 추가한 두 회귀를
  재실행하여 2개 통과, 필터로 나머지 15개 미실행. 전체 종합 테스트는 이번 한 줄 변경 뒤 재실행하지 않았다.
- `vp check --no-fmt`: 708개 파일 통과. 변경한 4개 파일의 formatting check 통과.
- `vp check`: 기존 별도 JSON `docs/native-search-public-service-2026-10-09.json` formatting 문제로 실패.
  그 파일은 수정하지 않았다.
- `vp run typecheck`: 기존 TS377136 진단 117개로 실패. 이전 기준선과 경로·진단 문구가 동일하며,
  이번 변경의 일반 TypeScript error와 추가 error는 없다. 진단을 숨기지 않았다.
- Windows 패키징은 로컬 미실행/CI 검증 범위이며, 사용자 DB 호환성 재검증이나 실제 실행 재시도는 하지 않았다.

로그: `/tmp/context-agent-background-failure-before-debug.log`,
`/tmp/context-agent-background-goal-regression.log`, `/tmp/context-agent-background-focused-final.log`,
`/tmp/context-agent-background-{check,full-check,types-final}.log`.

격리 dev 시작 예시는 `vp run agent#dev --backend-port 15180 --web-port 15173 --storage /tmp/context-agent-dev`다.
기존 서버와 다른 포트·storage를 사용하며, 기존 세션의 uncertain을 해제하는 명령은 아니다.

## 복구 가능성 추가 확인

### 조회의 부작용과 실패 시점

`get_background_result`는 `owned -> WorkTraceStore.taskDetail -> taskTree/SELECT`와
`readResult -> metadata.get/SELECT`를 사용한다. schema decode와 문자열 페이지 계산 외에
ack·소비·삭제·작업 실행·notification 변경은 없다. `waitResult(milliseconds > 0)`의
notification 전달 표시와 `cancel_background_task`의 Fiber 중단은 별도 경로이며 이 조회는 호출하지 않는다.
background.ts의 마지막 Git 변경은 2026-10-07의 `9308bbd`이며 이번 I/O commit으로 바뀌지 않았다.

추가 회귀에서 실제 BackgroundTasks를 SQLite `PRAGMA query_only=ON`으로 조회했다.
같은 완료 결과를 두 번 읽고 없는 task의 오류도 확인했으며 `total_changes()`가 증가하지 않았다.
fixture의 query_only는 finally에서 해제하며 실제 DB에는 설정하지 않았다.

owner RPC는 reservation을 commit한 다음 handler를 실행한다. handler/출력 인코딩의
비중단 Failure 또는 Defect를 uncertain으로 만들고 pending row를 settle한다.
따라서 이번 uncertain은 commit된 reservation 뒤의 실패 분기다. 단순 interruption이면
pending을 남기는 경로와 다르다. 원래 exception과 exact settle timestamp는 저장되지 않았다.
확인 가능한 종료 시각은 2026-10-10 17:21:16 UTC이며 원본 stack의 한계는 그대로다.

operation 2501 뒤의 owner operation 수는 0이다. 앞의 2500개는 모두 succeeded다.
연결된 27개 task/attempt는 모두 completed이며 마지막 완료 시각은 17:19:51.683 UTC로 실패 전이다.
연결된 notification 27개는 delivered_at이 null이다. 이는 완료 알림의 미전달 상태이며,
결과 조회가 notification을 소비하지 않는 것과 일치한다. 다음 정상 입력에서 알림을 받을 수 있으나
그 자체로 shell/agent 재실행을 요청하지 않는다.

### 재시작만으로 해결되지 않는 별도 입장 차단

차단은 두 곳이다. `AgentChat`의 unresolvedBinding 조회와 `workflowRunBindings.previous`는
bound run의 chat_runs.status가 failed인 경우 다음 run을 거부한다. 별도로 unresolved owner
operation도 차단한다. 따라서 operation 2501만 바꿔도 failed run에 의한 409가 남는다.
추가 회귀는 **모든 owner receipt가 succeeded인 failed run도 새 입력을 409로 거부하고,
모델 호출과 DB 변경을 하지 않음**을 확인했다.

현재 이 세션의 non-completed bound run은 해당 실패 run 하나이며 unresolved owner operation도
2501 하나다. 과거 legacy/unbound 실패 run을 성공 처리하거나 삭제할 필요는 없다.
새 Goal은 다른 추가 제한까지 확인하므로 기존 Goal/Plan을 유지한 새 입력과 구분해야 한다.

`Workflows.reconcile`은 stale phase만 정리하며 owner ledger를 해결하지 않는다.
WorkTrace의 requestResume API/UI는 checkpoint가 있는 하위 에이전트 task를 다음 parent run에
예약하는 기능이다. 존재하지 않는 background task와 failed 최상위 Goal run에 적용할 수 없다.
이 세션에 pending SDK interrupt는 0개이므로 승인 continuation도 복구 수단이 아니다.
GoalExecution의 durable body는 완료 Deferred만 기다리므로 workflow body replay는 모델/tool을
재실행하지 않는다. 이미 저장된 Failure를 성공으로 바꾸거나 새 SDK 실행을 복구하는 기능도 없다.

### 제안하는 최소 복구와 실행 전 확인

조사 당시 기존 구현에 이 run을 해결하는 감사 가능한 API는 없었다. 다음은 당시 제안이며,
이후 구현 결과와 실제 적용의 제한은 아래 「복구 API 구현」에 기록한다. 실제 적용은 하지 않았다.
실제 DB의 UPDATE나 완료 receipt 위조를 즉시 실행하는 절차가 아니다.

1. owner가 명시적인 `read_without_side_effect` 복구 receipt를 별도 append-only 기록으로 저장하는
   좁은 경로를 추가한다. run/session/Goal binding, operation ID와 fingerprint, 사용자 확인,
   판단 근거, 시간, 코드 버전을 기록한다. 대상은 terminal failed run의 검증된 built-in
   get_background_result뿐이다. 다른 pending/uncertain, active 실행, 뒤따른 operation, stale
   fingerprint가 있으면 거부한다. 두 입장 검사와 owner-effect fence가 이 receipt를 검증해야 한다.
   기존 chat_runs.failed, owner_rpc_operations.uncertain, GoalExecution Failure와 이벤트는 보존한다.
   도구 성공이나 과거 반환값을 만들어내지 않는다.
2. receipt가 있는 run만 새 run의 입장 차단에서 제외하고, 기존 run ID 재사용은 계속 거부한다.
   잘못된 종류·session·fingerprint, 중복 승인, 원자적 적용, restart 후 보존, 다른 쓰기 불확실성
   차단을 격리 DB로 검증한다. 기존 실패는 완료 근거로 사용하지 않는다.
3. 사용자 확인 후 실제 dev 재시작과 복구 적용을 한 maintenance 단계로 묶는다. 직전에
   active chat/attempt, queued message, pending interrupt와 PID/포트 소유자를 다시 검사한다.
   상태가 바뀌면 중단한다. 기존 dev supervisor를 정상 종료하고 자식 backend/UI 및 DB lock
   해제를 확인한다. 일관된 SQLite backup과 충분한 여유 공간을 먼저 확보한 뒤 빌드/시작하고,
   health/build ID가 맞으면 지원되는 경로로 승인된 receipt를 정확히 한 번 적용한다.
4. UI를 다시 읽어 새 입력 가능 여부만 확인한다. 원래 실행을 replay하거나 새 메시지를
   자동 전송하지 않는다. 다음 사용자가 요청한 새 run은 기존 코드·결과를 확인해 남은 작업을
   이어가며, 완료된 shell/agent 작업을 자동으로 재생하지 않는다. 새 모델이 다시 같은 명령을
   선택할 가능성은 이 복구 receipt 자체로 막을 수 없으므로 기존 결과 확인이 필요하다.

관찰한 재시작 대상은 supervisor PID 30659(vp parent 30653), backend 30710/127.0.0.1:5180,
UI pnpm 30720와 React Router 30736/localhost:5173이다. 같은 shared storage를 쓰는 모든 앱 세션의
HTTP/SSE가 잠시 끊긴다. 조사 시 running chat/attempt는 0개, 이 세션 queued message는 모두 delivered,
pending interrupt는 0개였다. 기존 dev shutdown에는 5초 timeout 뒤 강제 종료 경로가 있으므로
이 숫자를 재확인하고 정상 종료·lock 해제를 확인해야 한다.

동일 포트/storage 재시작 명령은
`vp run agent#dev --backend-port 5180 --web-port 5173 --storage /Users/creejee/.context-generactive-agent`다.
이 명령은 재빌드/서버 반영이며 그 자체가 복구 승인을 뜻하지 않는다.

추가 검증: 관련 2개 파일 14개 테스트 통과, lint/type check(`vp check --no-fmt`) 708개 파일 통과.
project typecheck는 기존 TS377136 117개로 실패하며 이전 경로·진단 문구와 동일하다.
로그 `/tmp/context-agent-read-recovery-{assessment,check,types}.log`.
이번 추가 단계에서도 실제 DB 변경·backup·실행 재생·모델 호출·서버 재시작은 하지 않았다.

backup 준비에도 제한이 있다. 실제 DB 파일은 89,442,066,432 bytes(약 83.3 GiB)이며
현재 데이터 볼륨의 여유 공간은 18,000,000 KiB(약 17.2 GiB)다.
같은 볼륨에 일반 전체 backup을 만들 공간이 부족하다. 충분한 별도 backup 목적지 또는
검증된 일관된 백업 전략이 필요하다. 같은 볼륨의 COW clone은 일관성·복원·독립성이
확인되지 않아 현재 사용할 수 있는 대안으로 간주하지 않았다.
hard link는 원본 변경으로 backup도 바뀌므로 사용할 수 없다. 실제 DB의 clone/copy나 공간 정리는 하지 않았다.

## 복구 API 구현 — 2026-10-11

`GET /api/sessions/:session/read-recovery/:run`은 `eligible`·`blocked`·`recovered`와
assessment digest를 반환한다. 조회는 DB를 바꾸지 않고 모델·도구·agent를 실행하지 않는다.
`POST`는 같은 digest와 아래 명시적 확인을 요구한다. 기존 HTTP cross-site 검사와 세션 lease도 적용한다.

```json
{
  "assessmentId": "GET에서 받은 64자리 SHA-256",
  "confirmation": "confirm_read_only_and_continue_without_replay",
  "backup": {
    "reference": "운영자가 복원 검증한 일관된 백업의 식별자",
    "verification": "operator_verified_consistent_restore"
  }
}
```

백업 필드는 **운영자의 검증 확인 기록**이며 서버가 백업 파일의 존재·내용·복원을 검증하는 기능은 아니다.
실제 백업을 검증하지 않고 이 값을 제출하면 안 된다. API를 모델 도구 목록에 등록하지 않았다.
확인은 모델 실행이나 사용자 메시지 입력을 겸하지 않는다.

허용 대상은 현재 Goal에 연결된 terminal `failed/worker_execution_failed` run이며,
마지막 owner operation 하나만 `uncertain`이고 앞의 모든 operation이 succeeded여야 한다.
그 operation은 검증된 built-in `get_background_result`이고 직전 toolAuthorize의 ID·run key·인수가
맞아야 한다. UUID task와 비음수 offset, session/project/Goal/revision binding, 같은 operation을
가리키는 단 하나의 durable GoalExecution Failure도 검증한다. pending·다른 uncertain·후속
operation·실행 중/대기 중 작업·승인 interrupt·새 큐 입력이 있으면 거부한다.
원본 exception이 남지 않았다는 제한은 preview의 `originalExceptionAvailable:false`로 표시한다.

확인 시 standalone transaction에서 다시 평가하고 digest 변경을 거부한다. migration 49의
`owner_read_recoveries`에 정책 `background-result-read-v1`, binding, operation/authorization fingerprint,
run key, 원본 durable payload/Failure, 종료 시각, 확인 문구, 백업 식별자와 확인 시각을 append한다.
UPDATE/DELETE는 금지되며 동일 확인은 멱등이다. 다른 digest/백업 확인은 충돌로 거부한다.
`chat_runs.failed`, RPC uncertain, GoalExecution Failure, 원본 이벤트는 수정하지 않는다.

AgentChat의 unresolvedBinding, workflowRunBindings와 owner effect fence는 receipt와 원본을
대조하여 해당 과거 run만 새 실행의 차단에서 제외한다. receipt 이후 원본 fingerprint·authorization·
payload·Failure·종료 시각이 달라지거나 후속 operation이 생기면 다시 차단한다.
기존 run ID를 다시 입장시키거나 그 run에 새 read/write RPC를 예약하는 것은 계속 거부한다.
새 Goal의 별도 보호, 완료 근거 검사와 다른 쓰기 uncertain의 차단은 유지한다.

변경 파일은 `src/agent/owner-read-recovery.ts`, `chat.ts`, `owner-rpc-ledger.ts`,
`src/workflow/run-bindings.ts`, `src/db/migrations.ts`, `src/layers.ts`, `src/index.ts`,
앱의 `.server/read-recovery-handlers.ts`와 `sessions.$session.read-recovery.$run.tsx`다.
복구·DB 테스트와 앱 HTTP 경계 테스트를 추가했다. 실제 DB의 schema는 아직 48이다.

### 백업 준비의 읽기 전용 조사

현재 DB는 89,442,066,432 bytes, WAL은 157,894,912 bytes, SHM은 32,768 bytes다.
SQLite page_size=4096, page_count=21836442, freelist_count=9691로 대부분이 사용 중인 페이지다.
VACUUM이나 압축으로 현재 공간에 전체 백업이 들어간다고 추정하지 않는다.
attachments/vector/native artifact/Goal worker asset은 각각 약 524/4304/984/1028 KiB다.

백업 폴더에는 `agent-before-empty-user-cleanup-20261004-202543.db` 한 개가 있으며
1,325,924,352 bytes, 마지막 수정은 2026-10-04 11:25:50.979 UTC다. immutable/read-only opener로
user_version=45와 `quick_check(1)=ok`를 확인했다. 전체 integrity/FK와 복원 리허설은 하지 않았다.
이번 실패와 10월 4일 이후 변경을 보존하는 최신 백업으로 사용할 수 없다.

현재 APFS data 볼륨은 조사 시 약 17–19 GiB 여유였으며 system/VM/preboot가 같은 container를 공유한다.
OrbStack 가상 마운트도 약 16 GiB로 부족하며 독립된 물리 백업 공간임을 확인할 수 없다.
다른 recovery 볼륨은 read-only이고 약 2.6 GiB다. 충분한 다른 local mounted volume은 없다.
DB+WAL 원시 크기와 여유를 고려해 **100 GiB 이상 여유가 있는 목적지**를 권장하며,
별도 전체 복원 리허설 복제본까지 보관하려면 그만큼 추가 공간이 필요하다.

[SQLite online backup API](https://sqlite.org/backup.html)나 정상 종료·lock 해제 후의 일관된 백업을
사용해야 한다. 활성 DB만 복사하면 [WAL에 남은 상태](https://sqlite.org/wal.html)를 잃을 수 있다.
자세한 integrity/FK/count와 동일 버전 opener 복원 절차는 `docs/work-trace-release.md`를 따른다.
실제 백업 생성·clone·압축·삭제·외부 전송·볼륨 준비는 하지 않았다.

### 실제 적용 전 절차와 남은 결정

1. 사용자와 충분한 백업 목적지를 결정한다. 백업 생성과 공유 서버의 일시 중단·재시작·receipt
   적용을 승인받는다. 현재 포트/PID와 모든 세션의 active chat/attempt, 이 세션의 queue/interrupt를
   다시 확인한다. 조사 이후 새 작업이 생겼으면 중단하고 영향을 재평가한다.
2. 정상 종료와 자식 프로세스/DB lock 해제를 확인하고 현재 schema 48의 DB 및 필요한 대응 assets를
   일관되게 백업한다. 별도 복원에서 integrity/FK/count 및 같은 버전 opener를 검증한다.
3. 새 코드로 빌드·시작하면 migration 49가 적용된다. schema 49는 이전 build에서 열 수 없으므로
   rollback은 검증된 업그레이드 전 백업과 대응 build/assets로 한다. 이후 새 데이터가 생긴 뒤
   오래된 백업을 덮어 복원하는 것은 별도 결정이다.
4. health/build ID를 확인하고 실제 run `run-1791648153403-oeyfkb`의 GET preview를 다시 읽는다.
   operation 2501와 현재 Goal을 대조한 다음 fresh digest 및 검증한 백업 식별자로 POST한다.
   GET recovered·receipt 1개·과거 failed/uncertain/Failure 보존·새 agent 실행 0개를 확인한다.
5. 앱을 다시 읽는다. 원래 실행 replay나 새 메시지 자동 입력은 하지 않는다. 이후 사용자 요청의
   새 run만 기존 결과를 확인하며 이어갈 수 있다. 완료된 shell/agent의 중복 선택까지 이 receipt가
   막는 것은 아니며, 새 실행은 기존 결과를 먼저 확인해야 한다.

격리 개발 명령: `vp run agent#dev --backend-port 15180 --web-port 15173 --storage /tmp/context-agent-dev`.
실제 shared storage 재시작 명령은 앞 절의 5180/5173 명령이며 아직 실행하지 않았다.

### 최종 검증 결과

- **통과:** 최종 전체 회귀 240개 파일, 1337개 테스트, 3 skip. GPU 임베딩 파일은 제외했다.
  명령은 기존 SQLite bridge preload/config와 `--maxWorkers=2 --testTimeout=20000`을 사용했다.
  첫 종합 실행은 1335 pass/2 fail이었다. 외부 ACP 승인 대기의 내부 6초 timeout과 하위 에이전트
  취소 직후 상태/cleanup hook 검사였으며, 관련 파일 단독 49개 및 동시 빌드 없이 실행한
  최종 전체 회귀가 통과했다. 첫 실패를 최종 통과와 구분하여 로그를 보존한다.
- **통과:** 복구 이후 원본 authorization fingerprint를 바꾸면 preview와 새 binding이 다시
  차단되는 추가 검사까지 포함하여 최종 receipt 테스트 14개 통과. 원래 run에 새 read/write
  RPC 예약 거부, 불변/멱등 receipt, standalone transaction, reopen, 실제 AgentChat 새 입력,
  다른 쓰기/pending/후속 operation/활성 작업/stale digest 거부와 HTTP origin/lease를 검증했다.
- **통과:** schema 48→49의 읽기 전용 upgrade 실패가 48과 증거를 보존하고, 정상 upgrade는
  nodes 원본·FK·integrity를 보존한다. 릴리스 0.0.13의 실제 source opener/30 migration prefix를
  새 임시 DB에서 다시 사용하여 30→49 데이터 보존, 이전 opener의 49 거부, 실패한 upgrade와
  업그레이드 전 백업의 재열기를 확인했다. 실제 릴리스 바이너리를 실행한 검증은 아니다.
- **통과:** `vp check --no-fmt` 713개 파일, 변경 파일 formatting과 `git diff --check`.
- **실패:** `vp check`는 별도 작업의 JSON formatting 1개가 남는다.
  `vp run typecheck`는 기존 TS377136 error 117개로 실패한다. 이전 기준선과 경로·진단 문구가
  동일하고 이번 변경의 새 error는 없다. 진단을 숨기거나 수준을 바꾸지 않았다.
- **통과:** `/tmp` checkout 사본의 최신 React Router build와 `vp pack` 서버 번들.
  독립 dev-backend의 HTTP route 등록, GET preview, 400/403/409 거부, schema 49, integrity,
  두 번의 SIGTERM exit 0와 reopen을 검증했다. 임시 DB nodes/chat_runs/receipt는 모두 0개이며
  모델과 실제 user storage는 사용하지 않았다. actual `apps/agent/dist/context-agent.mjs`와
  native addon SHA는 기존 값 그대로다.
- `vp env doctor`는 설치/지정 runtime 확인에 통과했다. shell의 `/opt/homebrew/bin/node` 26.4가
  Vite+ shim보다 앞서 있으며 프로젝트 지정 Node는 26.8.2다. 임시 smoke harness의 초기 cwd가
  storage 상위 경로와 겹친 문제 및 일반 launch의 자동 프로젝트 등록 경쟁을 피하고,
  `vp exec node`와 실제 `--dev-backend` 모드로 최종 HTTP 검증했다. 초기 harness 실패 로그도 보존한다.
- **미실행:** 실제 user DB migration/receipt 적용/backup/restore/서버 재시작/메시지 전송과
  Windows 패키징. Windows 패키징은 사용자 지정대로 CI에서 검증한다.

로그는 `/tmp/context-agent-read-recovery-{comprehensive,comprehensive-final,focused-final,receipt-final,
db-compat,check-latest,full-check-final,types-latest,app-build-latest,bundle-latest,bundle-smoke-final-3}.log`.
격리 compatibility DB는 `/tmp/context-release-db-1mzqNU`, HTTP fixture는
`/tmp/context-agent-read-recovery-http-YCdima`다. 임시 서버는 종료했다.

## 실제 적용과 DB 단일 기준 (2026-10-11 04:20 UTC)

사용자가 세션 복구와 필요한 DB 변경·최소 서버 재시작을 승인했다. 재시작 직전 전역
running/interrupted chat, active task attempt, queued/running/waiting agent attempt는 모두 0이었다.
기존 5173/5180 감독 프로세스를 정상 종료하고 다음 명령으로 같은 저장소에서 다시 시작했다.

```sh
vp run agent#dev --backend-port 5180 --web-port 5173 --storage /Users/creejee/.context-generactive-agent
```

- 적용 직전 실제 DB는 이미 schema 49였다. 이번 적용에서 migration을 추가하거나 DB 버전을
  올리지 않았다. 49 도입이 유일한 가능한 설계는 아니다. 기존 48의 불변 workflow event도
  operator audit를 표현할 수 있지만 이미 적용된 전용 receipt table을 유지했다.
- 전체 DB 약 83.3 GiB와 남은 공간 약 20.4 GiB를 재검토했다. 한 건의 append-only receipt와
  검증된 revoke 경로에는 전체 복사본이 필수라는 초기 판단을 철회했다. 원본 13개 row를
  하나의 읽기 transaction으로 224826-byte snapshot에 저장하고 격리 DB에서 복원·원본 비교·FK·
  integrity를 검증했다. 이는 전체 사용자 DB backup이 아니다.
- 검증된 파일은
  `/Users/creejee/.context-generactive-agent/backups/read-recovery-originals-run-1791648153403-oeyfkb-b5d3d89e40fa.json`,
  SHA-256 `b5d3d89e40fa589e94b2dc2df21b43813e3fce94d8768f1d4c886ab5a8e458a6`다.
  API에는 `operator_verified_original_records` assertion과 파일·SHA 참조를 전달했다.
- supported POST API가 receipt `7775f335-8a64-44cb-a492-fb0f0e326456`를 남겼다. 이후 GET은
  `recovered`, `new_run_only_no_replay`, `admission.status=ready`다. admission은 실제 binding과
  동일한 검사 함수를 쓰는 preview이며 새 binding/run을 만들지 않는다.
- 적용 전후 13개 원본 row가 모두 동일하다. 대상 chat run 160개, 기존 run RPC 2501개,
  session node 16307개, 모델 usage response 6141개가 그대로다. 모델 메시지·재실행·과금 호출은 없다.
  원래 실패 배너와 durable Failure는 과거 기록으로 남는다.
- rollback은 receipt를 삭제하거나 원본을 수정하지 않는다. 같은 route의 `/revoke`에
  `{"confirmation":"revoke_read_recovery_without_replay","receiptId":"7775f335-8a64-44cb-a492-fb0f0e326456"}`를
  POST하면 기존 불변 workflow event에 취소를 기록하고 admission 차단을 복원한다.
  method/origin/build ID/lease 검사를 거친다. 취소는 격리 테스트에서 검증했으며 실제 receipt는 취소하지 않았다.
- 새 backend build ID `1c6fa0d1a361135fb847e9b1`, runtime instance
  `3583f543-69bb-4fae-9ac3-594d13b5fe45`, startedAt `2026-10-11T04:20:41.897Z`.
  localhost:5173 HTTP 200 및 UI의 `/api/health`가 같은 ready backend를 가리킨다.

DB는 `user_version`을 실제 적용 migration prefix의 기준으로 사용한다. 소유 app의 단일
`BEGIN IMMEDIATE`에서 lock 획득 후 버전을 다시 읽고 모든 pending migration과 cursor를 함께
commit한다. 중간 DDL 실패는 전체 upgrade를 rollback한다. 기존 migration 42의 보존·FK 검사는
유지한다. readonly native worker는 cache/native 초기화 전에 실제 DB version과 필요한 SQL
column 계약을 검증하며 자체 migration을 하지 않는다. stale/newer/damaged schema는 실행 전에
명확한 오류로 거부한다. 별도 hashed migration history가 있다고 주장하지 않는다.

역사적인 failed/blocked task 세 개는 active attempt가 없으므로 복구의 실행 중 작업으로
취급하지 않는다. queued/running/waiting/resuming 및 active attempt는 계속 차단한다.
사용자가 아직 릴리스하지 않았다고 확인했으므로 구 release/downgrade 설치 검증은 완료 조건에서 제외한다.

최신 검증:

- **통과:** 전체 회귀 241개 파일 / 1344개 테스트 / 3 skip (GPU 제외), 실제 2-process
  migration race, 47→49 중간 실패 rollback, native stale schema 거부, 원본 보존·revoke.
- **통과:** 마지막 admission preview 변경 후 관련 3개 파일 / 26개 테스트. 전체 회귀는 이
  마지막 변경 이전이며 이후 관련 회귀로 검증했다.
- **통과:** `vp check --no-fmt` 716개 파일, 실제 memory-agent build, React Router build,
  서버 bundle, 위 API 적용·원본 비교·health/UI proxy.
- **실패:** project typecheck의 기존 TS377136 진단 117개, `vp check`의 별도 작업 JSON
  formatting 1개. 진단 수준을 낮추거나 병행 파일을 수정하지 않았다.
- **미실행:** GPU 테스트, Windows packaging(CI 담당), 실제 모델 대화·기존 run 재실행.

근거 로그: `/tmp/context-agent-live-ssot-comprehensive.log`,
`/tmp/context-agent-recovery-admission-preview.log`, `/tmp/context-agent-ssot-admission-check.log`,
`/tmp/context-agent-ssot-admission-types.log`, `/tmp/context-agent-recovery-original-snapshot-verified.log`,
`/tmp/context-agent-live-recovery-apply.log`, `/tmp/context-agent-live-recovery-dev.log`.
