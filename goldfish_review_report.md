# Goldfish 리뷰 처리 기록: workflow-normalization

- **대상:** `docs/designs/workflow-normalization.md` (리뷰 반영 2판)
- **입력:** `consolidated_review_report.md`의 C1–C45 (🔴8 / 🟡24 / 🟢13)
- **날짜:** 2026-10-29
- **판단:** 사용자가 기술 판단을 맡겼다("기술적인 디시전을 내가하자니 너무어려워, 핵심가치에 맞게 너가조절해줘"). 기준은 사용자가 정한 목표다: 안정성과 누수 방지, Effect 권장 방식, 실제 시나리오가 끝까지 돎, 0.0.17 사용자가 체감하지 않는 업그레이드, 끝난 worktree 정리.
- **검증:** 🔴 항목과 결정을 바꾼 항목은 코드(effect 4.0.3 포함)와 로컬 DB(`sqlite3 -readonly`)로 다시 확인했다.
- **결정 기록:** `docs/decisions.md` "Workflow 정상화 설계 리뷰 반영 (2026-10-29)"

## 1. 사용자 결정을 바꾼 항목 (거부할 수 있음)

| 결정    | 원래 사용자 결정                                                                | 바꾼 내용                                                                                                             | 근거                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D2      | 실행 status에 `failed`를 더하고 표를 다시 만든다                                | `failed`·표 재생성·`failure_json`을 뺀다. 결과 encode 실패만 `Complete{exit: die}`로 저장한다. 시각 열은 `ADD COLUMN` | 본문 결함은 라이브러리가 이미 `completed`로 저장한다(`Workflow.ts:732-734`, `:1023-1028`). 로컬 DB의 `running` 실행은 0건이다. 원안은 소비자 셋을 함께 고쳐야 한다 |
| D4      | 사람 결정에 다시 시도 버튼을 둔다                                               | 미룬다. 카드 Stop·Replace로 빠져나간다(지금 동작)                                                                     | `failed`가 없으면 되돌릴 상태가 없다. 실제 실패(답 저장 뒤 카드 이동 실패)는 `Complete{failure}`라 원안도 다루지 못했다                                            |
| D3      | payload에 occasion을 넣고, 이전 사실을 펼쳐 보는 화면을 둔다                    | payload에 key 문자열을 넣는다. 펼쳐 보는 화면은 미룬다. 핵심(분리, 쌓기, `factsSeq` 거절)은 그대로                    | key와 occasion은 같은 정보다. occasion을 decode하는 migration이 실패하면 앱이 시작하지 않는다                                                                      |
| D1      | 저장된 다섯 값(phase, Goal, Plan, 실행 상태, 새 Goal 요청)을 `GoalState` 하나로 | `GoalState`는 phase·Goal·Plan만. 나머지 둘은 시작 검사가 맞춰 본다                                                    | 세 저장소와 두 서비스에 걸치면 한 전이의 transaction 경계가 흐려진다. 실행 상태는 이미 tag union이다                                                               |
| 결정 10 | 마지막 lease 뒤 14일 TTL, `resolved` 뒤 worktree 재생성                         | 미룬다. Goal이 끝날 때의 정리는 한다                                                                                  | 사람이 폴더에서 직접 고치는 카드를 lease 없이 지울 수 있다. 재생성은 네 경로가 함께 쓰는 `presentWorktree`를 바꾼다                                                |

## 2. 항목별 처리

표기: **반영** = 제안대로 고침. **일부** = 일부만 고침. **사라짐** = 다른 결정을 바꿔 대상이 없어짐. **반박** = 고치지 않음.

### 🔴 Blocker

| #   | 처리   | 내용                                                                                                                                                                                                  |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 반영   | 도구 호출 때의 거절은 영속하지 않는다. 도구 결과·화면 문구·경고 로그로 보인다. Step 7에 회귀 테스트(거절된 중복 요청 뒤 `accepted` 요청이 그대로 적용)                                                |
| C2  | 반영   | 세 workflow 정의에 `suspendedRetrySchedule`(1초에서 2배, 상한 5분)을 둔다. G2 기준을 "재호출 0회"에서 "하루 약 300회 이하, TestClock 없이 깨어남"으로 바꿨다. hook은 NULL 결과의 `running`도 기다린다 |
| C3  | 반영   | `GoalState` tag 표(9개), 사건 표, decode의 세 결과, 화면 위치와 진행 위치를 정의했다                                                                                                                  |
| C4  | 반영   | `WorkflowStartup` marker를 owner 엔진이 의존하게 했다. janitor는 오케스트레이터가 의존한다. 순서도를 실제 layer와 맞췄다                                                                              |
| C5  | 반영   | W1의 순서(카드 settle → InUse 건너뜀 → `.goal` → 빈 부모만 비재귀 삭제)와 W2(delivery 끝 정리)를 적었다                                                                                               |
| C6  | 반영   | G4를 B3 표의 원인으로 좁혔다. provider 오류 분류 변경은 Non-Goals                                                                                                                                     |
| C7  | 사라짐 | `failed` 상태가 없다                                                                                                                                                                                  |
| C8  | 반영   | Risks & Mitigations 12개                                                                                                                                                                              |

### 🟡 Major

| #   | 처리   | 내용                                                                                                                                                                                                                               |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C9  | 반영   | R1·R2·`Unknown` 규칙, 활성 칸반 세션은 고치지 않음, 새 revision으로 이전 값 보존                                                                                                                                                   |
| C10 | 사라짐 | `failed`의 열·메서드가 없다. 시각 열은 INTEGER millis, NULL 허용                                                                                                                                                                   |
| C11 | 사라짐 | `failed`를 읽는 소비자가 없다                                                                                                                                                                                                      |
| C12 | 반영   | `appendFacts`(admission 뒤 transaction, 엔진 호출은 밖), `request` 순서, key 형식 표, 경합을 받아들이는 이유(Risks 9)                                                                                                              |
| C13 | 반영   | D2를 `Complete{exit: die}`로 바꿨다(1절)                                                                                                                                                                                           |
| C14 | 일부   | 핵심은 남기고 payload와 화면을 줄였다(1절). 분리 자체는 남긴다. 사실이 바뀐 순차 재요청을 버리지 않는 다른 방법이 없다                                                                                                             |
| C15 | 반영   | 소유는 `kanban_goals`의 goalInstanceId로 판정. 표와 표식 파일을 뺐다. 업그레이드 전 폴더도 덮는다                                                                                                                                  |
| C16 | 반영   | TTL을 미뤘다(1절)                                                                                                                                                                                                                  |
| C17 | 반영   | `stopSession`에서 `settleGoal`을 부르지 않는다. 2026-10-25 purge 결정과 맞췄다                                                                                                                                                     |
| C18 | 반영   | `CardWorkspaceJanitor` 계약, layer 위치, `CardWorktrees`에 더할 메서드 셋(Step 9)                                                                                                                                                  |
| C19 | 사라짐 | 재생성을 하지 않으므로 `presentWorktree`를 바꾸지 않는다                                                                                                                                                                           |
| C20 | 반영   | 측정은 span 숫자 속성만. metric 모듈과 histogram을 뺐다. 기존 `tools/profile`로 읽는다                                                                                                                                             |
| C21 | 반영   | 태그 `0.0.17` scratch worktree에서 한 번 만들고 SQL dump만 커밋. `tools/upgrade-fixture/`는 만들지 않는다                                                                                                                          |
| C22 | 반영   | Step 7 테스트가 G1의 세 경로를 하나씩 덮는다                                                                                                                                                                                       |
| C23 | 반영   | 새 literal: `facts_changed`(HTTP 409), `goal_completion_required`, `state_reconciled`, `result_unencodable`. `failed` 관련 literal은 사라짐                                                                                        |
| C24 | 반박   | 문서를 나누지 않는다. 부분들이 시작 순서(`WorkflowStartup` → 엔진 → janitor → 오케스트레이터), 0.0.17 fixture, S3 기준선을 함께 쓴다. 나누면 문서 사이 참조가 그만큼 는다. 제안의 최소안(Overview 범위 고침, 잠금 절 E)은 반영했다 |
| C25 | 반영   | G1–G9, D1–D4, W1–W5, S1–S4, Step 1–10. 용어 절에 엔진 실행 status·세션 실행 상태·두 lease를 나눴다. TTL을 미뤄 W6·W7은 없다                                                                                                        |
| C26 | 반영   | 경로 규칙(`src` 기준, `effect:` 접두사, `:N` 규칙), "결정 N"의 출처, 용어 정의                                                                                                                                                     |
| C27 | 일부   | Alternatives를 "안 / 뺀 이유 / 상태" 틀로 맞췄다. D4는 만들 것이 없어 Alternatives의 자기 절에 두었다. 결정을 `####` 제목으로 올리지는 않았다                                                                                      |
| C28 | 반영   | "앱에서 측정된 디스크 비용은 없다", 사용자 설명과 로컬 DB 단서, microVM은 Open Questions                                                                                                                                           |
| C29 | 반영   | README 갱신을 각 Step에 넣었다(`db/README.md:34`, `workflow/README.md:58`·`:62`, `kanban/README.md:26`·`:31`·`:48`, `docs/kanban-orchestration.md:66`). 줄 번호를 다시 확인했다                                                    |
| C30 | 반영   | G7 kill -9 기준: 큐 item·attempt가 남은 카드를 뺀 고아 항목이 모두 기록되고, 빠진 항목이 0                                                                                                                                         |
| C31 | 반영   | 칸반 phase 유지는 의도된 동작이고, 화면에 이유(`card_reclassifying`)를 보인다                                                                                                                                                      |
| C32 | 반영   | `AgentChat`이 읽어 `committedLog`에서 제공, layer는 `stores`, 테스트 context에 `RunLogSignals.layer`. `AppEvents`를 쓰지 않는 이유와 1초 poll의 이유를 적었다                                                                      |

### 🟢 Nit

| #   | 처리   | 내용                                                                                                                                                                                   |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C33 | 사라짐 | 1초 Open Question을 지웠다. B1 schedule이 정한다                                                                                                                                       |
| C34 | 반영   | 태그 시각 2026-10-21 02:04 KST(2026-10-20 17:04 UTC)                                                                                                                                   |
| C35 | 반영   | `.goal`은 scope가 닫힐 때 지워진다. W1은 남은 것만 지운다                                                                                                                              |
| C36 | 반영   | `workflow/workflow.ts`의 import(`:16`)와 `serialize`(`:470`)만 지운다                                                                                                                  |
| C37 | 반영   | 인용 범위를 하나로 맞추고, 인용을 대상 앞에 두었다                                                                                                                                     |
| C38 | 반영   | Alternatives의 중복 문장을 Technical Plan 참조로 줄였다                                                                                                                                |
| C39 | 일부   | 평가어와 hedge를 지우고 문구를 끝까지 썼다. 쌍 개수(9 × 14 = 126)의 근거를 적었다. 원 줄 번호가 문서를 다시 쓰며 없어져 줄마다 대조하지는 않았다                                       |
| C40 | 일부   | `SynchronizedRef`·`modify`를 Step 4로 옮겼다. Technical Plan에 "모든 case를 `Match.valueTags`로 다룬다"는 한 줄이 남았다. 빠진 case가 컴파일 오류라는 성질을 말하는 데 필요하다고 봤다 |
| C41 | 사라짐 | 표 재생성이 없다                                                                                                                                                                       |
| C42 | 반영   | null을 허용하는 literal decode. null은 0.0.17 이전 행에 있을 수 있다                                                                                                                   |
| C43 | 반영   | 기존 private 파서 `registered`(`git-worktrees.ts:222`)를 노출한다                                                                                                                      |
| C44 | 반영   | `docs/decisions.md`의 포인터를 `docs/designs/workflow-normalization.md`로 고쳤다                                                                                                       |
| C45 | 반영   | G1–G9마다 `합격 기준:` 줄                                                                                                                                                              |

## 3. 리뷰 뒤 새로 찾은 오류

리뷰를 확인하다가 설계 초판의 오류를 찾아 고쳤다.

- **새 Goal 정산 규칙.** 초판은 "run이 `interrupted`면 `rejected{run_outcome_uncertain}`"이었다. 프로세스 안의 `interrupted`는 승인 대기이고, run이 끝나면 `agent/chat.ts:614`가 다시 정산한다. 갇히는 경우는 재시작 뒤뿐이라, 정산을 앱 시작 검사로 옮겼다.
- **죽은 실행의 재시작 반복.** 초판 Problem 2는 이것을 증상으로 들었다. 로컬 DB에는 `running` 실행이 0건이다. 근거 없는 증상이라 Problem에서 빼고 "다루지 않는 문제"로 적었다.
- **halt 위치.** `halt`는 `stopSession`(대화 삭제)도 부른다. `settleGoal`을 `halt` 안에 두면 purge 결정을 어긴다.
- **멈춘 Goal의 진행 중 카드.** `tick`이 멈춘 Goal을 일찍 돌려보내 그 카드의 결과가 처리되지 않는다. W2(delivery 끝 정리)를 더했다.

## 4. 커밋 상태

커밋하지 않았다. 바뀐 파일: `docs/designs/workflow-normalization.md`, `docs/decisions.md`, 이 파일. 리뷰 보고서 6개와 `design_draft.md`(초판 사본)는 추적되지 않은 채 남아 있다.
