# Effect 경계 검토 (2026-09-24)

## 반영한 변경

- 채팅, 요약, 압축, 이미지 저장·미리보기, MCP, 외부 에이전트, 서브에이전트, 비밀 가리기의 거부 가능한 Promise에 작업별 tagged error를 붙였다. 턴 요약의 저장소 실패는 이제 `"failed"`로 복구되어 다음 회차에 재시도된다.
- `/compact` 내부의 `Effect.runPromise` → Promise → Effect 왕복을 없애고 `compactByHand`를 generator 기반 Effect로 바꿨다. Promise는 TanStack AI·MCP·파일·저장소 API 경계에서만 사용한다.
- transcript 하나의 오류를 격리하는 가져오기 회차는 순수 중단을 실패 기록으로 바꾸지 않고 전파한다. 경로 검사에서는 `Either.match`, `Either.flatMap`을 사용한다.
- `.at(-1)` 사용처를 검토했다. 요약 블록·redaction span·provider 메시지처럼 전체 순서가 실제로 필요한 배열은 마지막 값이 없는 경우를 처리한다. 서브에이전트 완료 시 전체 활성 목록을 배열로 복사한 뒤 마지막 값을 뽑던 코드는 순회로 바꿨다.
- 서비스 범위의 keyed semaphore와 세션 lease에서 만료된 항목을 회수하고, 대기 중인 승인 요청은 서비스 종료 때 해제한다. 이미지 변환의 수동 FIFO 대기열은 Effect semaphore로 교체했다.
- 외부 ACP 에이전트와 MCP 서버의 설정·신뢰 상태를 다시 읽을 때 연결 지문을 대조한다. 제거되거나 변경된 설정의 연결을 닫고, 진행 중이던 ACP 연결 시도는 완료 시 즉시 닫아 재연결되지 않게 했다. 연결 제한 시간이 끝나기 전에 성공하면 타이머를 바로 해제한다. ACP 편집기 연결 종료 때 세션 Map도 비운다.
- 나머지 `Map`을 수명에 따라 확인했다. 상수 표와 한 함수 안에서 끝나는 인덱스는 Map이 적절하며 배열 `find` 반복으로 바꾸지 않는다. 파일 목록·읽기·규칙 벡터 캐시는 크기 제한이 있다. 서브에이전트의 세 중복 실행 Map은 Effect `FiberMap` 하나로 옮겼고, 이미지 변환의 진행 중 Promise Map은 제거했다. 연결 단위의 ACP 세션 대응은 아래 스펙 과제로 남겼다.
- 압축 경로의 `toolResultIds`는 세션 전체 결과를 담는 Map을 반환하면서 실제로는 일부 키만 읽었다. `toolResultId(sessionId, toolCallId)` 단건 조회와 부분 인덱스로 바꿔 Map이 함수 경계를 넘지 않게 했다. 중복 결과가 있으면 기존처럼 첫 기록을 사용한다.
- 일반 상태 클래스였던 `LiveRuns`, `Snapshots`, `AppApi`, OAuth 클라이언트·키체인 저장소와 셸 출력 캡처를 생성 함수로 바꿨다. `Context.Tag` 서비스와 typed error 클래스는 Effect의 계약이므로 유지한다. OAuth HTTP·키체인과 셸 프로세스 API의 반환 형식은 아직 외부 Promise 경계다.
- 오류 채널을 추가 점검해 메모리 해석 모델 호출과 응답, 큐 steering, SVG 미리보기 읽기를 tagged error로 바꿨다. ACP 요청, OAuth, provider 기능 거절, MCP 환경 변수 오류도 `_tag`가 있는 오류가 되었다. `Object.hasOwn`으로 동적 키를 강제로 조회하던 변경은 철회했다.

## 스펙 수정 제안

1. `.agents/skills/effect-ts/SKILL.md`는 v4 RC 설치와 해당 패키지의 `AGENTS.md` 읽기를 요구한다. 사용자 결정에 따라 v4 이전을 목표로 한다. v3.22.2에서 v4 RC.117로 의존성만 바꾼 시험 빌드는 약 3,786줄의 타입 진단을 냈다. `Context.Tag` 66곳, `Data.TaggedError` 71곳, `Schema.decodeUnknownSync` 113곳을 포함해 96개 소스 파일에 주요 변경 API가 있다. 이 상태의 의존성 교체는 되돌렸고 v3 타입 검사가 다시 통과했다. 서비스 정의와 호출부, Schema 계약, 오류·fiber API, 앱·테스트 순서로 이전하고 각 단계에서 타입 검사와 테스트를 통과시킨 뒤 버전을 고정한다. 완료 시 루트 `AGENTS.md`에 스킬이 요구하는 v4 문서 읽기 지침을 추가한다.
2. `docs/decisions.md`의 기존 “타입 있는 오류” 문구에는 어떤 실패가 typed error이고 어떤 실패가 defect인지 기준이 없다. 위의 “Effect 오류와 내부 흐름” 결정을 기준으로 각 서비스의 I/O 실패를 도메인 오류로 정리하고, 상위 API에서 `catchTag`별 HTTP 결과와 재시도 정책을 명시한다. SQLite 예외를 현재처럼 defect로 둘지, `StorageFailed`로 승격할지는 영속성 장애 계약과 함께 결정해야 한다.
3. 기존 가져오기 스펙은 `catchAllCause`로 transcript별 모든 원인을 격리한다고 적는다. 중단까지 실패 횟수로 기록하면 종료가 늦어지고 가짜 실패가 남는다. **typed 실패·defect는 기록, 순수 중단은 전파**로 문구를 고친다.
4. Workflow 상태의 `ledger`는 전체 이벤트를 단일 `state_json` 배열에 누적하고 다음 sequence를 `ledger.at(-1)`에서 읽는다. 이벤트가 쌓일수록 상태 조회·갱신마다 전체 이력을 읽고 다시 쓴다. 스펙에서 이력 조회 범위를 정한 뒤 `workflow_events(session_id, sequence, ...)`로 분리하고, 현재 상태와 최신 sequence만 `session_workflows`에 둔다. 이력이 필요한 화면·도구에는 커서 페이지를 제공한다. 이 변경은 저장 형식과 API 계약의 마이그레이션이 필요하다.
5. ACP 연결의 `sessions` Map과 외부 에이전트 프로세스의 세션 대응 Map은 연결이 살아 있는 동안 새 세션마다 늘어난다. 현재 ACP 프로토콜 흐름에는 개별 세션 해제 계약이 없다. 스펙에 세션 종료·삭제 시 외부 세션 대응을 해제하는 동작을 추가하고, 편집기 연결에서 오래된 세션을 재사용할지 별도 수명 기준을 정해야 한다. 임의 크기 제한은 이어지는 대화의 세션 일관성을 깨뜨릴 수 있다.
6. 취소 뒤 자동 후속 실행을 억제하는 계약은 `parent_notification_holds`로 Work Trace에 저장한다. 보관·취소 뒤에는 hold를 유지하고, 다음 명시적 사용자 턴이 run을 점유하면 해제한다. 삭제 시에는 세션 외래 키로 함께 제거된다. 이 규칙을 기존 알림 스펙에 명시하고, 보관 해제만으로 자동 실행을 재개하지 않는다고 적어야 한다.
7. `LiveRuns`의 실행 권한과 메시지 큐의 예약은 현재 프로세스 내부에서만 유일하다. Effect semaphore도 같은 런타임 안에서만 직렬화한다. 서버를 여러 프로세스로 띄우는 스펙이 생기면 run 점유와 예약을 SQLite의 조건부 갱신·유일성 제약 또는 외부 lease로 옮겨야 한다. 현재 단일 서버 프로세스 전제를 배포 스펙에 명시한다.
8. OAuth는 로그인 시 로컬 HTTP callback 서버를 열고 `LoginAttempt`가 Promise와 `cancel()`을 반환한다. 도메인 스펙에 로그인 시도 수명과 서버 종료 시 취소를 정의한 뒤, 내부를 `Effect.acquireUseRelease`와 `Deferred`로 옮기고 provider 경계에서만 Promise로 변환하는 것이 적절하다. 현재는 시도 완료·취소·시간 만료 때 서버를 닫지만 서비스 종료가 개별 시도를 취소한다는 계약은 없다.
9. 셸 명령의 프로세스 전역 `Set`은 `process.exit`에서 동기적으로 자식 프로세스를 정리하려는 안전망이다. 실행 소유권을 Effect scope에 두려면 서버 종료가 모든 shell fiber를 중단하고 자식 종료까지 기다린다는 스펙이 필요하다. 즉시 `process.exit`를 호출하는 경로까지 포함해 종료 계약을 정한 뒤 전역 등록부를 제거해야 한다.
10. `anti-slop-effect/no-service-constructor-imports`는 이름이 `makeX`이면 실제 `Context` 의존성이 없어도 서비스 생성자로 판정한다. 지역 객체 팩토리는 `createX`로 명명했다. 규칙은 추후 이름만 보지 말고 서비스 태그·레이어의 실제 생성자나 명시적 표시를 검사하도록 좁혀야 한다.
11. 세션 lease는 현재 활성 창의 조작 권한을 확인하는 짧은 TTL이다. DB에 보관해도 모델 실행은 재개되지 않고, 재시작 뒤 사라진 창의 소유권만 남을 수 있다. lease의 DB 이전 제안은 철회한다. 실제 재개가 필요한 run·승인·도구 실행의 checkpoint와 재시작 정책을 별도 스펙으로 정의해야 한다.

## 검증 범위

- `memory-agent` 전체 75개 테스트 파일, 518개 테스트와 `vp check`, 전체 workspace 타입 검사가 통과했다. 설정 제거 시 ACP/MCP 프로세스 종료, 동일 MCP 연결의 동시 조회 합치기, 재시작 뒤 알림 hold 유지를 확인하는 테스트를 포함한다.

## Map·Set과 동시성 후속 검토

| 상태                       | 실제 역할                                 | 동시성·수명 처리                                                                                                                                                  |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 이름별 서브에이전트 직렬화 | 같은 자식의 실행 순서                     | 별도 semaphore Map을 없애고 `keyedSerialLimit`의 `Effect.acquireUseRelease`와 semaphore를 사용한다. 대기자 중단까지 사용 횟수에 반영한다.                         |
| 활성 run                   | 세션별 단일 실행 권한과 완료 신호         | Map은 실행 중인 run만 보유하고, 내부 완료 신호는 Promise 대신 Effect `Deferred`로 둔다. AsyncIterable 종료에서 항목과 완료 신호를 함께 해제한다.                  |
| MCP 도구 발견              | 동일 연결의 중복 요청 합치기              | 연결에 진행 중인 발견 작업을 보관해 동시 요청이 공유한다. 설정 변경으로 연결이 제거되면 늦게 도착한 결과를 버린다.                                                |
| 큐 예약과 보류             | 메시지 선택 중 편집 차단, 중단 시 보류    | Map과 Set에 갈라져 있던 상태를 하나의 예약 레코드로 합쳤다. SQLite와 이 상태의 동기 갱신 구간에는 추가 semaphore가 필요 없다.                                     |
| 완료 알림 실행과 재요청    | 세션별 후속 실행 순서                     | Effect Queue가 깨우고, 세션별 keyed semaphore가 scoped fiber를 직렬화한다. 영속 알림이 비어 있으면 뒤따른 작업은 즉시 끝난다. 실행 중 상태 Map·Set은 두지 않는다. |
| 취소 뒤 알림 보류          | 명시적 사용자 턴까지 자동 실행 금지       | Work Trace의 `parent_notification_holds`가 소유한다. 서버 재시작 뒤에도 유지되고, 사용자 run 점유 때 해제된다.                                                    |
| 이미지 변환                | 같은 이미지 중복 변환과 전체 변환 수 제한 | 진행 중 Promise Map은 제거했다. 서로 다른 임시 파일로 변환하고 원자적 rename으로 같은 결과를 게시한다. 실제 변환 수는 Effect semaphore가 제한한다.                |
| 서브에이전트 실행 자원     | 활성 자식의 취소·종료 대기                | 중복 `busy`·`runningHandles` Map을 없앴다. 서비스 scope의 `FiberMap`이 살아 있는 작업을 자동 회수하며, 재시작 뒤 판단은 Work Trace checkpoint를 읽는다.           |
| 파일·벡터 캐시             | 재사용 가능한 완료 값                     | 크기 제한을 유지한다. 캐시 멤버십 자체에는 Effect 동시성 도구를 쓰지 않는다.                                                                                      |
| 셸 명령·이벤트 구독 Set    | OS 종료 안전망과 구독자 목록              | 명령은 종료·오류에서 제거하며 `process.exit`의 동기 안전망이 필요하다. 이벤트 구독자는 응답·중단·heartbeat에 제거된다.                                            |
| 순수 멤버십 Set            | 도구 허용 목록, 중복 제거, 한 run의 계산  | 비동기 작업의 소유권이 없으므로 읽기 전용 Set이나 지역 Set으로 유지한다.                                                                                          |

초기의 두 알림 Set을 상태 Map으로 합친 변경은 실행 상태를 전역 컬렉션에 옮겨 놓았을 뿐이라 철회했다. 대기, 취소, 완료에는 `Deferred`, `Semaphore`, `Queue`, scoped fiber를 쓴다. 재시작 뒤에도 필요한 워크플로우 판단은 Work Trace에 둔다. ID로 살아 있는 외부 자원을 찾아야 할 때만 서비스 범위의 registry를 두고, 작업 종료·설정 변경에서 지운다.

## 남은 재시작 계약과 오류 채널

- `LiveRuns`는 현재 SSE stream을 취소하고 종료를 기다리기 위한 프로세스 자원 색인이다. 저장된 chat run은 재시작 뒤 실패로 종결된다. 진짜 자동 재개를 요구한다면 마지막 안전 checkpoint, 이미 실행한 도구 호출의 식별자, provider 요청 재발행 조건을 먼저 정의해야 한다. Map을 `FiberMap`으로 바꾸는 것만으로 재개되지는 않는다.
- ACP·MCP 연결과 worker의 요청 ID별 콜백은 프로세스가 소유하는 소켓·프로세스 핸들이다. 재시작 시 연결은 새로 열 수 있지만, 요청 자체를 재시도할지와 중복 도구 실행을 어떻게 피할지는 영속 작업 원장에 적어야 한다. 임시 상수·함수 지역 Map과 이런 실행 핸들을 동일하게 취급하지 않는다.
- Effect의 거부 가능한 Promise 경계는 `tryPromise`에서 tagged error로 바꿨다. 남은 `Effect.promise`는 worker·연결 종료 finalizer와 서브에이전트 checkpoint 대기 경계다. 이 정리 작업의 실패를 로그·재시도·defect 중 무엇으로 처리할지 서비스 종료 계약에 명시해야 한다.
- `KnowledgePromotions.promote`의 사용자 승인·근거 거절은 `MemoryPromotionRejected` 오류 채널로 옮겼다. `WorkTraceStore`의 사용자 거절 조건, SDK 도구 진입점과 provider stream parser에는 여전히 동기 `throw new Error`가 있다. 이 중 사용자 입력 거절은 도메인 tagged error를 반환하는 Effect API로 바꾸고, 저장소 불변식 위반만 defect로 남기는 후속 API 변경이 필요하다. 겉의 `Error` 클래스만 tagged error로 바꾸는 것은 오류 채널을 만들지 않는다.

## v4 이전 준비: Effect tsgo

- 기준 변경을 `6b03ea6`으로 커밋한 뒤 `@effect/tsgo` 0.45.0을 설치했다. TypeScript 7.0.2의 `tsc`를 설치 시 패치하고 memory-agent와 앱의 `tsconfig`에 Effect 언어 서비스를 연결했다.
- Effect 진단의 오류 1건은 generator의 `return yield*`로, 경고 2건은 Kagi 도구와 JSON 요청 파서의 typed Schema 오류 경계로 정리했다. 전체 타입 검사는 통과하며 남은 출력은 제안 수준이다.
- v4 이전에서는 `Context.Tag` 서비스 66곳과 호출부를 함께 옮기고, Schema 생성·디코딩과 tagged error를 v4 계약으로 바꾼다. 그 뒤 fiber·scope·런타임 경계와 앱·테스트를 이전한다. 의존성만 v4로 바꾼 상태는 빌드되지 않으므로 각 단계마다 타입 검사, 관련 테스트, 전체 테스트와 빌드를 확인한다.

## v4 적용 후 남은 수명 스펙 (2026-09-25)

- 위의 v4 이전 계획은 완료됐다. 현재는 Effect v4 RC와 권장 tsconfig 옵션을 사용한다. `Effect.orDie`가 예상 가능한 provider 오류를 defect로 보내던 경로를 제거했고, 채팅 UI는 503 오류 코드를 받아 안내한다. 워크플로 규칙의 벡터 캐시는 Effect Cache가 동시 조회와 만료를 관리한다.
- `createSnapshots`의 파일 목록 snapshot은 최대 32개를 서버 메모리에 보관한다. 재시작 뒤 기존 페이지 토큰은 복구되지 않으므로 “고정된 목록을 페이지마다 본다”는 현재 설명에는 수명 조건이 빠졌다. 재시작 뒤에도 같은 목록을 보장할 제품 요구가 있다면 snapshot 행과 파일 경로를 SQLite에 저장하고 생성 시각과 만료 시각을 둔다. 재시작 뒤 복구가 불필요하다면 API 계약에 토큰 만료를 명시하고 클라이언트가 첫 페이지부터 다시 읽도록 한다.
- `RelayedApprovals.pending`은 진행 중인 Promise와 브라우저의 응답을 연결한다. 재시작 시 기다리던 실행 자체가 없어진다. 승인 요청을 복구하려면 요청 ID, 대상 작업, 만료, 승인 결과를 Work Trace에 먼저 기록하고, 재개 가능한 작업의 체크포인트에서 승인 결과를 읽게 해야 한다. Map만 DB로 옮기면 기다리던 실행은 살아나지 않는다.
- MCP·ACP 연결, importer/embedder worker 콜백, keyed semaphore의 Map은 열린 프로세스 자원을 찾는 색인이다. 종료 시 항목을 회수하거나 scope를 닫는다. 재시작 뒤 동일 작업을 자동 재개하려면 각 작업의 재시도 가능 여부와 중복 실행 방지 키를 영속 원장에 먼저 정의해야 한다.
- 타입 검사에 남은 `AbortController` 제안은 요청 fiber보다 오래 사는 stream과 SDK 취소 경계에 해당한다. 벡터 인덱스의 동기 Schema 디코드는 `Effect.try`에서 `VectorIndexError`로 변환한다. 이 경계는 Effect 범위 안의 일반 실패와 달리 실행 시점 및 자원 소유권을 확인한 뒤 바꿔야 한다.
