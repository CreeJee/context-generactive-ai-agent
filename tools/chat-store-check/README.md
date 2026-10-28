# chat-store-check

## Overview

`tools/chat-store-check`는 일회성 개발용 CLI(`main.ts`, 명령 이름 `chat-store-check`)입니다. TanStack 채팅 행 마이그레이션(`docs/effect-ai-migration.md` 1·2단계)을 출시 전에 로컬 DB 복사본에서 검증합니다. 원본 SQLite를 읽기 전용으로 열고 `VACUUM INTO`로 복사합니다. 복사본에는 `packages/memory-agent`의 `migrationClient`와 `migrateTanStackRows`를 실행합니다. 그런 다음 원본(`original.` 스키마)과 마이그레이션 결과를 비교합니다. 비교 대상은 메시지 내용, 히스토리 화면 표시, Effect AI 프롬프트 왕복(`toPrompt`/`fromPrompt`), Schema 디코드, usage, interrupt, handoff 앵커입니다. 결과는 횟수와 실패 위치만 담은 보고서로 콘솔에 출력합니다.

## Interface

- `main` — `Command.make("chat-store-check", ...)` CLI 진입점입니다. `copy`, `open`, `migrationClient`, `migrateTanStackRows`를 차례로 호출하고 `NodeRuntime`으로 실행됩니다.
- (export 없음) 이 디렉터리는 다른 코드가 import하는 공개 심볼이 없는 독립 실행 도구입니다. 아래는 내부 핵심 심볼입니다.
- `check` — `Effect.fn("chat-store-check")(function* (sql: SqlClient.SqlClient))`. 마이그레이션된 DB와 `original` DB의 스레드, 히스토리 그룹, 실행 usage, interrupt, handoff를 비교하고 보고서를 만듭니다.
- `changeLog` — 마이그레이션을 두 번째로 돌렸을 때 바뀐 행입니다. 이미 마이그레이션된 행은 그대로 통과해야 합니다.
- `CheckFailed` — `Schema.TaggedError` 실패 타입입니다. 필드는 `message`와 선택적 `cause`(Defect)입니다.
- `makeReport` — `MutableHashMap` 기반 보고서입니다. `count`, `fail`(종류별 실패 위치 최대 10개 보관), `decoded`(Schema 디코드 결과 집계), `print`(이름순 콘솔 출력)를 제공합니다.
- `open` / `copy` — `node:sqlite` `DatabaseSync`를 `Effect.acquireRelease`로 엽니다. `copy`는 원본을 읽기 전용으로 열고 `VACUUM INTO ?`로 WAL까지 포함한 일관된 복사본을 만듭니다.
- `said` — 비교용 메시지 정규화입니다. `metadata`와 `toolCalls` 항목의 metadata를 뺍니다. lifted 필드는 메시지에서, 없으면 `metadata.tanstack`에서 가져옵니다.
- `shown` / `screenDifference` — 히스토리 화면이 보는 형태(message와 parts의 metadata 제외)를 만듭니다. 차이 나는 JSON 경로의 인덱스를 `[]`로 바꾸고 정렬합니다.
- `differingPaths` — 두 JSON 값이 다른 JSON 경로만 돌려줍니다. 값은 돌려주지 않으며, `fingerprint`로 비교합니다.
- `anchored` — 저장된 handoff(`SavedHandoff`)가 `messages`에서 경계를 다시 찾는지 검사합니다. 경계는 `anchorId`가 있으면 그 id로, 없으면 `through`로 찾습니다. 앵커가 `v2:`로 시작하면 `fingerprint`, 아니면 `legacyFingerprint`로 비교합니다.
- `issuePaths` — `Schema.SchemaError`에서 실패 경로만 뽑습니다. 메시지는 빼고, 경로가 비면 `(root)`를 씁니다.
- `liftedFields` — 마이그레이션이 `metadata.tanstack`에서 끌어올리는 필드입니다: `createdAt`, `model`, `source`, `finishReason`, `stopReason`.
- `decodeMessage`/`decodeHistory`/`decodeGroup`/`decodeUsage`/`decodePayload`/`decodeResponse`/`decodeHandoff` — `StoredMessage`, `StoredHistoryGroup`, `StoredUsage`, `StoredInterruptPayload`, `StoredInterruptResponse`, `Schema.fromJsonString(HandoffState)`의 디코더입니다. `exact`(`onExcessProperty: "error"`)는 메시지 디코드에 쓰입니다.
- `ThreadPair`/`GroupPair`/`RunPair`/`InterruptRow`/`HandoffPair` — SQL 결과 행 Schema입니다. 각각 스레드 before/after, 그룹 ordinal·before(null 가능)·after, run_id·before·after·anthropic·after_fix(0/1), interrupt_id·payload·response, handoff key·before·after·before_messages·after_messages를 담습니다.
- `anthropicInputFix` — `1_792_904_536_000`. Anthropic 어댑터가 cache read를 input으로 세도록 바꾼 커밋 456191fe의 시각입니다.

## Invariants

- DB 복사본에는 사용자 대화가 들어 있습니다. 복사본은 저장소 밖에 둡니다.
- 보고서에는 횟수, id, Schema 경로, JSON 경로만 남기고 행 내용은 절대 남기지 않습니다. 그래서 `differingPaths`와 `issuePaths`는 값과 Schema 메시지를 일부러 뺍니다.
- `@effect/platform-node`는 서브모듈(`NodeRuntime`, `NodeServices`)로만 import합니다. 패키지 엔트리는 NodeRedis와 그 클라이언트까지 로드하기 때문입니다.
- 원본 DB는 `readOnly`로 엽니다. 복사는 파일 복사가 아니라 SQLite `VACUUM INTO`로 해서 WAL까지 포함한 일관된 사본을 만듭니다.
- DB 핸들은 `Effect.acquireRelease`로 열고, 스코프가 끝나면 `db.close()`로 닫습니다.
- 이미 마이그레이션된 행은 마이그레이션을 다시 돌려도 바뀌지 않아야 합니다(`changeLog`). 이는 마이그레이션 멱등성 검사입니다.
- 메시지 비교는 `metadata`를 무시합니다. lifted 필드(`createdAt`, `model`, `source`, `finishReason`, `stopReason`)는 메시지 본체와 `metadata.tanstack` 중 어디에 있어도 같은 것으로 봅니다.
- 화면 비교는 message와 parts의 `metadata`를 무시합니다. 페이지가 metadata를 읽지 않기 때문입니다.
- handoff 앵커 형식은 두 가지입니다. `v2:` 접두사는 `fingerprint`로, 나머지는 `legacyFingerprint`로 비교합니다. 경계는 `anchorId`가 있으면 id 위치로, 없으면 `through`로 찾습니다.
- `StoredMessage` 디코드에는 `onExcessProperty: "error"`를 써서 남는 필드를 실패로 처리합니다.
- SQLite의 JSON 텍스트는 저장소가 JSON 값에서 쓴 것으로 보고 `JSON.parse` 결과를 `JsonValue`로 다룹니다.
- 이 도구는 `packages/memory-agent/tests/support/history-screen.ts`(`historyScreen`)와 `packages/memory-agent/tests/support/requests.ts`(`system`) 테스트 지원 모듈에 의존합니다. 그 모듈들을 바꾸면 이 도구에도 영향이 갑니다.
- `tsconfig.json`은 `../../packages/memory-agent/tsconfig.json`을 상속합니다. `typeRoots`는 memory-agent의 `node_modules/@types`를 가리키고, `include`는 이 디렉터리의 `*.ts`만 잡습니다.

## Side Effects

- `node:sqlite` `DatabaseSync`로 원본 SQLite DB 파일을 읽기 전용으로 엽니다.
- SQLite `VACUUM INTO`로 DB 복사본 파일을 디스크에 씁니다.
- 복사본에 `migrationClient(open(...))`로 SqlClient를 만들고 `migrateTanStackRows`를 실행해 복사본 행을 바꿉니다. 멱등성 확인을 위해 마이그레이션은 두 번 실행됩니다.
- SQL SELECT를 실행합니다. 대상은 `chat_threads`, `chat_history_groups` 등이며, `original.` 스키마(원본 DB attach)와 JOIN합니다.
- `Console.log`로 검사별 횟수와 실패 위치(종류당 최대 10개)를 표준 출력에 씁니다.
- `NodeRuntime`으로 CLI 프로세스를 실행합니다. `Clock`, `FileSystem`, `Path` 서비스를 사용합니다.

## Verification

- Run: `tsc -p tools/chat-store-check/tsconfig.json` (저장소 루트)
