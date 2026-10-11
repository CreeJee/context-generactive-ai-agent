# 복구 후 보고서 조회 실패 재발

최신 상태(2026-10-11 05:31 UTC): 사용자 승인 후 최신 dev 서버를 재빌드·시작하고
operation 54의 복구 receipt를 적용했다. 실제 admission은 ready이며 새 실행·모델 호출 없이
원본 21개 row와 이전 receipt를 보존했다. 마지막 「승인 후 실제 적용」 절이 현재 상태다.

2026-10-11 04:37 UTC 사용자 보고를 조사했다. 이전 읽기 실패와 별개의 새 run이며
서버 프로세스 정리는 후속 사용자 요청에 따라 완료했다. 새 실패의 복구 receipt는 아직 없다.

## 실제 증거

- 새 run `run-1791693239734-l8z222`: 04:34:09.080 UTC 시작, 04:36:33.258 UTC
  `failed / worker_execution_failed` 종료. 기존 run `run-1791648153403-oeyfkb`와 operation 2501,
  receipt `7775f335-8a64-44cb-a492-fb0f0e326456`는 그대로다.
- 새 run의 operation 53은 동일 호출의 승인으로 succeeded, 마지막 54는
  `get_subagent_reports`, side_effect 1, uncertain이다. 1–53은 모두 succeeded이고 54 이후
  operation은 0개다. call ID `call_7dad309721f44252ad6d2a8d1eafd69b`의 args는 다음과 같다.

| taskId                               | attemptId                            |
| ------------------------------------ | ------------------------------------ |
| 5254f3ea-8610-405d-9d75-83644aa455fc | 19c53746-50de-43d9-a8b3-9a9ff13c8a4a |
| 21419ef4-480f-4a5b-8bed-3993bc595887 | 91083f5c-96fd-447e-b00e-4a2656669762 |
| c7853ba4-887d-4f6f-8a68-d31867c428b0 | 61f3d383-537b-4d5e-ab11-82fb7a468282 |

- 현재 실제 DB에는 위 task 세 개와 해당 attempt가 모두 없다. ID가 생성·삭제된 경위는
  이 조사에서 확정하지 않았다. 새 run에서 child dispatch를 다시 실행하지 않았다.
- durable execution `ec25a697946eb3047699e12a982a3fc0`의 exit는 Failure,
  `GoalExecutionError / SideEffectUncertain / operationId 54`다. 서버 로그의 SDK stack은
  실제 worker artifact에서 발생한 `FullLoopRpcError / owner_rejected`뿐이다.
- 당시 도구 exception/원본 stack은 RPC ledger에 저장되지 않았다. `makeOwnerRpcEffect`의
  catchCause가 해당 정보를 uncertain reply로 치환한다. 따라서 당시 exception을 확정하지 않는다.
  동일한 세 ID를 넣은 실제 Subagents 서비스의 격리 조회는
  `Error: Subagent attempt not found in this session`과 `subagents.ts`의 원본 stack을 반환한다.
  같은 tool을 실제 SDK worker로 실행하면 수정 전 두 테스트 모두 worker_failed로 실패했다.

## 수정과 실행된 코드의 구분

기존 실제 backend build `1c6fa0d1a361135fb847e9b1`의 bundle SHA-256은
`5eafbbbe604995c253332528a2d747a6a16492c99fefe03f9f881f53104d1838`이다.
번들의 owner read-only 목록에는 이전에 추가한 `get_background_result`가 있지만
`get_subagent_report`와 `get_subagent_reports`가 없다. 이전 수정은 로드됐으며 이번 도구는
그 수정 대상이 아니었다. 로그가 가리킨 worker 파일은
`goal-worker-assets-EPePuX/5f42f609573d7e344b6514216ca5f13971c3ff31704afcc4b20eb89b0eaf901c/4009851f1bbb02f09842d8469bdaca0ca87b61f15f88b1521083e57648b421a1/full-loop-worker.mjs`,
파일 SHA-256은 `9292a09d2ce511db0d6c3555e17b9676cec2ee9b281f629b9c69df3e2cf82451`이다.
disk native addon SHA-256은 이전과 같은
`77df01cb811d113a68318165ffce6601e0c58ed32ad150f323e56d9788e59563`이다.
이번 실패가 native crash라는 증거는 없다. 종료 후 native의 실제 로드 상태를 소급해서
확인했다고 주장하지 않으며 별도 native 이관 실험을 하지 않았다.

- 두 보고서 조회만 read-only 목록에 추가했다. getReport는 조회와 run-local 캐시만 수행한다.
  durable returned/reviewed disposition은 onAfterToolCall의 별도 middleware RPC가 수행한다.
  dispatch/resume/cancel/adopt, middleware의 불확실한 쓰기는 계속 차단한다.
- 제한된 background retrieval 복구 validator도 이 두 도구의 UUID task/attempt args를
  tagged union으로 검증하도록 확장했다. 승인 tool 이름과 모든 args가 일치해야 한다.
  이미 적용된 schema 49와 background retrieval policy 식별자를 유지하며 추가 DDL은 없다.
  기존 완료·실패 기록, generation/hash 계약, stale digest·다른 미해결 작업 검사는 유지한다.
- 현재 실제 DB를 readonly로 열어 수정된 service의 assess만 실행했을 때 operation 54는
  eligible이었다. 전역 active chat 0개, 이후 operation 0개, 새 receipt 0개다.
  이 평가는 현재 source에 대한 것이며 실행 중 앱의 복구 완료가 아니다.

## 서버 정리와 남은 적용

종료 직전 PID·명령·cwd·부모 관계를 다시 확인했다. supervisor 73384의 cwd는 이 저장소의
apps/agent이고 backend 73447과 UI 73463→73479→73485가 그 자식이었다. SIGTERM으로
supervisor를 정상 종료했다. wrapper와 모든 자식이 사라졌고 5173/5180 및 다른 Node dev
리스너도 남지 않았다. 이 저장소의 에디터 lint/format LSP와 CodeGraph, 다른 앱은 종료하지 않았다.
광범위한 pkill과 강제 종료는 사용하지 않았고 자동 재시작하지 않았다.

사용자가 다시 서버를 시작한 뒤 새 build/worker와 idle 상태를 확인하고, 새 run 원본의
일관된 snapshot·격리 restore 검증을 준비하여 supported recovery API를 적용해야 한다.
이미 승인된 동일 세션의 복구 범위이지만 종료 요청을 넘어 서버를 다시 시작하지 않았다.
기존 run을 replay하거나 모델 메시지를 전송하지 않았다. 이 조사의 eligible digest는 재사용하지
않고 실제 적용 직전에 fresh assessment를 받아야 한다.

```sh
vp run agent#dev --backend-port 5180 --web-port 5173 --storage /Users/creejee/.context-generactive-agent
```

## 검증

- **통과:** 실제 Subagents 서비스 + 실제 SDK worker의 보고서 단일/배치 조회 오류 회귀,
  BackgroundTasks read/write 보호를 포함한 focused 4개 파일 / 46개 테스트.
- **통과:** 마지막 복구 DTO·codec 수정 뒤 2개 파일 / 38개 테스트. 보고서 복구의 원본
  보존·새 binding preview·승인 args 변경 시 다시 차단을 확인했다.
- **통과:** `vp check --no-fmt` 716개 파일, 변경 파일 formatting, git diff --check.
- **실패:** project typecheck의 기존 TS377136 진단 117개. 초기 구현에 발견된 새 진단은
  수정했으며 최종 실행에는 기존 117개만 남았다.
- **미실행:** 이번 변경 후 전체 종합, 실제 앱 rebuild/restart, 새 receipt 적용, 모델 대화.
  사용자 요청에 따라 dev 서버를 종료했으므로 실제 재발 해결을 완료했다고 표시하지 않는다.

로그/제한된 원본 증거는 `/tmp/context-agent-recurrence-{server-preserved,before,after,focused,
final,recovery,check-final-2,types-final,readonly}.log` 및
`/tmp/context-agent-recurrence-evidence.json`이다. before는 수정 전 두 실패, after는 수정 후
네 테스트 통과 로그다. 원본 사용자의 DB를 복사하거나 수정하지 않았다.

## 오프라인 도구 분류 완전성 점검

서버를 계속 종료한 상태로 현재 source의 모든 기본 toolDefinition 등록을 대조했다.
단일 `src/tools/effects.ts` 분류표에서 병렬 조회와 owner의 확정된 읽기 실패 처리가 같은
계약을 사용한다. 이름의 read/get 접두사로 추론하지 않으며 알 수 없는 도구와 dynamic MCP는
계속 effectful로 처리한다.

| 분류 변경                                                                          | 실제 구현 근거                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| get_subagent_report, get_subagent_reports → read                                   | getReport의 scoped trace/메시지 조회와 run-local reportResults cache만 수행. returned/reviewed는 별도 onAfterToolCall RPC, adoption은 별도 tool/middleware |
| wait_subagents → read                                                              | scoped status SELECT·cursor·취소 가능한 waiter 등록만 수행. notification ack/consumption·child cancellation 없음                                           |
| list_report_evidence, read_report_item → read                                      | bound report source의 scoped SELECT·redaction만 수행. taskTree는 읽기 callback                                                                             |
| find_memory → effectful                                                            | promoted 결과가 있을 때 recordRetrieval이 memory_usage_events에 retrieved row를 INSERT                                                                     |
| kagi_search, kagi_extract → effectful                                              | 실패한 응답도 외부 과금 요청을 이미 보냈을 수 있음. paid call이나 retry를 테스트에서 실행하지 않음                                                         |
| dispatch/resume/cancel/adopt/use/promote/파일 변경/Goal·Plan 변경 → effectful 유지 | 실행·중지·사용 선언·저장·상태 변경 경계                                                                                                                    |

`tests/tool-effects.test.ts`는 새 파일을 포함해 기본 source의 현재 toolDefinition 등록
문법을 검사하며, 분류표에 없는 literal tool 이름과 검토되지 않은 새로운 등록 문법을
실패시킨다. 현재의 승인 정의 spread와 delegate 이름 참조는 실제 exported 정의와 대조한다.
모든 JS/TS alias·동적 factory를 해석하는 범용 AST 검사기는 아니며, 등록 문법이 바뀌면
테스트가 수동 계약 검토를 요구한다. Unknown 도구를 자동으로 read에 추가하지 않는다.

추가 worker 회귀는 find_memory 이름의 조회가 audit row를 쓴 뒤 실패하면 해당 row를
지우거나 확정된 read failure로 바꾸지 않고 RPC uncertain을 유지함을 확인한다. 실제
Subagents의 없는 attempt 조회는 단일·배치·wait 모두 실패 메시지가 전달되고 RPC succeeded,
tool ok=false로 끝나는지 확인한다. 실제 모델·과금 Kagi 호출은 없다.

마지막 source의 관련 3개 파일 / 42개 테스트와 `vp check --no-fmt` 718개 파일이 통과했다.
그 전 파일·증거·subagent 관련 6개 파일 / 44개 테스트도 통과했다. project typecheck는
최종 기존 TS377136 117개만 남는다. 로그는
`/tmp/context-agent-tool-effects-{tests,final-2-tests,check-final,types-final}.log`다.

오류 은폐 처리의 범위: read failure는 SDK failed tool outcome에 원래 오류 메시지를 전달하고
별도 middleware의 성공 근거로 취급하지 않는다. 과거 ledger에 저장되지 않은 원본 cause/stack은
복원하지 못한다. effectful handler의 catchCause가 uncertain reply로 바꾸면서 원본 cause를
버리는 공통 경로는 이번에 변경하지 않았다. 원본 stack을 진단에 남기려면 credential redaction과
settlement 실패·중단 경계를 포함한 별도 진단 계약이 필요하며, 이 수정이 모든 오류 원인을
보존한다고 주장하지 않는다. 실제 DB·receipt·서버 상태는 변경하지 않았다.

최종 읽기 확인에서 별도 새 서버가 발견됐다. backend PID 82042/UI PID 82054는 이 작업이
종료한 PID와 다르고 2026-10-11 04:44 UTC에 시작했다. health build ID는
`de5a28fdd5fee39a6c48d95b`, runtime instance `f6453a65-2db3-4d90-874f-c679e2efe23c`다.
이 작업에서는 서버를 시작하지 않았다. 별도 시작과 경합하지 않도록 새 PID를 종료하거나
실제 recovery API를 호출하지 않았다. 마지막 분류표 변경이 새 프로세스에 반영됐다고
주장하지 않으며, 위 테스트 결과는 오프라인 source에 대한 검증이다.

### 별도 서버의 실제 반영 상태 재확인

backend PID 82042와 UI PID 82054의 cwd는 이 저장소의 apps/agent다. 현재 bundle SHA-256은
`0930d771ee823cb75e4d3634bacf5261747a5f6afc4bb03268a717479e3072b0`이다. backend health는 위
`de5a28fdd5fee39a6c48d95b / ready`이며 보고서 조회 두 이름은 실제 bundle의 읽기 목록에 있다.
그러나 최신 builtinToolEffects가 없고 wait/report evidence 읽기 분류와 find_memory/Kagi의
effectful 구분도 없다. 복구 validator의 report args 지원은 있으나 publicAssessment는 아직
background 도구명을 고정하는 중간 구현이다. 실제 GET도 operation 54를 eligible로 반환하면서
`tool=get_background_result`로 잘못 표시하고 taskId를 생략한다. 최신 source의 올바른 tagged
report DTO와 다르므로 최신 복구 코드 반영 조건을 충족하지 않는다.

읽기 확인 시 새 run 없이 `run-1791693239734-l8z222`가 최신 failed이고 operation 54가 uncertain,
54 이후 operation 0개, 전역 active chat/task/attempt 각 0개다. receipt는 이전 2501의 한 건뿐이다.
이 조건만으로 중간 build에 새 receipt를 적용하지 않았다. 최신 source로 재빌드·재시작이
필요하다는 상태를 보고했으며 직접 서버를 종료·재시작하지 않았다. 새 run의 backup/restore와
fresh supported API 복구·실제 admission ready 검증은 이 반영 차이를 해결한 뒤 남아 있다.

## 승인 후 실제 적용 (2026-10-11 05:31 UTC)

05:25 UTC 사용자가 최신 코드 재빌드·dev 재시작·동일 세션 복구를 승인하고 기존 서버를
직접 종료했다고 알렸다. 실제 PID/포트 재확인에서 dev supervisor/backend/UI와 리스너가
없었으므로 이미 종료된 PID에 신호를 보내지 않았다. 활성 chat/task attempt/agent attempt는
각 0이고 새 run 없이 operation 54 이후 호출도 0개였다.

- 새·이전 실패 run의 관련 원본과 이전 receipt를 포함해 13개 테이블 / 21개 row를 단일
  readonly transaction으로 snapshot했다. private backup은
  `/Users/creejee/.context-generactive-agent/backups/read-recovery-originals-run-1791693239734-l8z222-5fd42b6de7ab.json`,
  231952 bytes, SHA-256 `5fd42b6de7aba79d6baacd2ca202ff8505cc35f732830cb2d8a655807ee2d418`다.
  `/tmp/context-recovery-original-restore-WseCp7`의 격리 schema 49 DB에서 모든 row 비교,
  FK·integrity가 통과했다. 전체 DB backup은 아니다. 초기 snapshot helper의 SQL 문자열
  문법 오류는 수정 후 재실행했으며 실제 DB 쓰기 전에 실패했다.
- `vp run memory-agent#build`와 통합 dev 명령의 React Router build/서버 bundle을 완료했다.
  실행 명령은 기존 UI 5173/backend 5180 및 `/Users/creejee/.context-generactive-agent` 저장소를
  지정했다. supervisor가 latest backend ready/build manifest를 확인한 뒤 UI를 시작했다.
- 실제 최신 bundle의 분류표 내용(find_memory/Kagi effectful, wait/report reads)과 올바른
  `get_subagent_reports` DTO/세 UUID args를 확인했다. 최초 적용 helper는 bundler가 분류표를
  inline한 것을 const 이름으로 검사하다 멈췄다. POST 전 실패해 receipt가 없었음을 확인하고,
  실제 분류 내용으로 검사를 고친 뒤 fresh preview·원본·전역 idle을 다시 확인했다.
- supported POST가 receipt `6b6b5774-bc80-4c32-8ce4-97343b9163cf`를 기록했다.
  GET은 `recovered / new_run_only_no_replay / admission.status=ready`다. 새 binding/run이나
  모델 요청 없이 실제 binding과 동일한 preview 검사로 입력 readiness를 확인했다.
- 적용 전후 21개 snapshot row가 모두 동일하다. 대상 run 수 161, 새 실패 run RPC 54,
  session node 16308, 모델 usage response 6143이 그대로다. 원래 uncertain 54/durable Failure와
  이전 uncertain 2501/Failure/receipt도 유지했다. 새 모델 사용과 run 추가는 0이다.
- health: build `21eb39400f732036549899e8`, runtime instance
  `edb7e4b7-2b1b-45e2-848e-c50bfc79c5a3`, startedAt `2026-10-11T05:29:22.516Z`, ready.
  UI localhost:5173 HTTP 200과 `/api/health`의 같은 build/runtime도 확인했다.
  backend PID 95050/UI PID 95063, cwd는 이 저장소 apps/agent다. 오래 열린 UI의 다른 build ID
  mutation은 기존 보호가 차단하므로 사용자는 페이지를 새로고침해야 한다.
- 실제 앱은 같은 user agent.db와 repo memory-turbovec.node를 로드했다(lsof 확인).
  readonly `assertDatabaseSchema`는 actual version/필수 column 계약 49를 통과했다. native search
  worker도 같은 함수로 actual DB를 먼저 검사하고 reader/cache 초기화 전에 mismatch를 거부한다.
  Goal worker는 DB를 독립적으로 열지 않고 owner RPC를 쓴다. 같은 Node 26.8.2 환경의 격리
  DB/native reader/concurrent migration/분류 회귀 4개 파일 / 15개 테스트가 통과했다.
  실제 사용자 DB를 대상으로 새 검색·Goal worker/model 실행을 만들지는 않았다.
- 새 server bundle SHA-256 `6210986216160fe5ac3ba20b76f9dcf912e7a718f6cdd2703fb4f5bce9b87c74`.
  runtime manifest와 native/worker bytes SHA가 각각
  `7e3d35581171563b370601e7db7668870b23ee5eec2513b2edceb6d18e7a5cd5`와
  `9292a09d2ce511db0d6c3555e17b9676cec2ee9b281f629b9c69df3e2cf82451`로 일치한다.
  addon SHA `77df01cb811d113a68318165ffce6601e0c58ed32ad150f323e56d9788e59563`는 유지했다.
  artifact manifest version 1/native-factories API와 DB schema 49를 같은 버전으로 혼동하지 않는다.

DB 추가 upgrade는 없었다. 최신 관련 테스트 42개와 lint/type-aware check 718파일 통과,
project typecheck 기존 TS377136 117개 실패는 앞 절과 같다. 이 적용 후 전체 종합/GPU/Windows
패키징과 실제 모델 대화는 미실행이다. Windows packaging은 CI 담당이다. 과거 원본 exception
유실과 effectful uncertain의 원본 cause 진단 문제는 별도 제한으로 남는다.

새 receipt의 취소 route는
`/api/sessions/3bfb5fe9-4ef1-48be-be32-6f019e35b4a2/read-recovery/run-1791693239734-l8z222/revoke`다.
기존 method/origin/build/lease 검사를 유지하고 receipt ID와
`revoke_read_recovery_without_replay` 확인을 받는다. 실제 receipt는 취소하지 않았다.

최종 로그: `/tmp/context-agent-recurrence-snapshot-verified-2.log`,
`/tmp/context-agent-recurrence-memory-build.log`, `/tmp/context-agent-recurrence-db-runtime-tests.log`,
`/tmp/context-agent-recurrence-actual-dev.log`, `/tmp/context-agent-recurrence-actual-apply-final.log`.
