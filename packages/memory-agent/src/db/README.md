# db

## Overview

`packages/memory-agent/src/db`는 memory-agent 모듈 전체가 함께 쓰는 로컬 SQLite 데이터베이스(`node:sqlite`의 `DatabaseSync`) 하나를 열고, 마이그레이션한 뒤, Effect `SqlClient`로 감싸 Layer로 제공하는 계층이다. `migrations.ts`는 순서가 정해진 스키마 SQL 단계 목록이고, `PRAGMA user_version`이 적용한 단계 수를 기록한다. `database.ts`는 시작 시점 마이그레이션 트랜잭션과 읽기 전용 워커의 스키마 검사를 담당한다. `sql-client.ts`와 `migration-client.ts`는 같은 연결 위에 Effect `SqlClient` 어댑터를 만든다. 런타임용 어댑터는 Semaphore로 연결을 임대하고, 마이그레이션용 어댑터는 SAVEPOINT를 쓴다.

## Interface

- `Database` — `Database.layer(file, open?)`: 디렉터리 생성, 연결 열기, PRAGMA 설정, 마이그레이션 후 `SqlClient.SqlClient`를 제공하는 Layer(NodeFileSystem·NodePath 포함). `Database.over(effect)`: 호출자가 열고 마이그레이션한 연결 위의 Layer(fixture용)
- `connectionContext(sqlite)` — 이미 열리고 마이그레이션된 연결 하나를 `Semaphore.make(1)`과 함께 `SqlClient` Context로 감싼다
- `migrateDatabase(sqlite)` — 시작 전용 마이그레이션 Effect. BEGIN IMMEDIATE 안에서 대기 중인 단계, version cursor, 스키마 검사를 함께 커밋한다
- `assertDatabaseSchema(sqlite)` — 읽기 전용 워커 진입 검사. user_version이 빌드와 다르면 `DatabaseSchemaRejected`를 동기로 throw하고, 핵심 테이블 컬럼을 prepare로 확인한 뒤 버전을 반환한다
- `databaseSchemaVersion(sqlite)` — `PRAGMA user_version`을 Schema로 디코드해 숫자로 반환한다
- `DatabaseOpenError` — Schema.TaggedError `{ file, cause }`. 디렉터리 생성, 열기, PRAGMA, 마이그레이션 실패를 감싼다
- `DatabaseSchemaRejected` / `DatabaseSchemaRejectedReason` — TaggedError와 TaggedUnion. 사유는 InsideTransaction, NewerThanBuild{actual,supported}, MigrationPending{actual,supported}, MetadataMismatch, PreservedRowsChanged, InvalidForeignKeys
- `sqlClientOver(sqlite, semaphore)` — 앱의 단일 연결 위 런타임 `SqlClient`. prepared statement Cache, `makeSqliteAcquirers`, `BEGIN IMMEDIATE`, `RELEASE SAVEPOINT`를 쓴다
- `migrationClient(sqlite)` — 시작 마이그레이션 전용 `SqlClient` 어댑터. 트랜잭션은 `SAVEPOINT effect_migrate`로 연다
- `migrations` — `readonly string[]` 순서형 스키마 SQL 단계. projects, sessions, nodes, edges, nodes_fts, chat_threads, chat_runs, queued_messages, subagents, mcp_trust, agent_trust 등을 정의한다
- `goalHistoryMigration` — `{ version: 42, kind: "goal-history-binding-fk-rebuild", preservedTables }`. FK 검사를 멈춘 채 참조되는 테이블을 재구성할 수 있는 유일한 단계
- `tanStackRowsMigration` — SQL 주석뿐인 단계. 시작 시 이 단계와 함께 `migrateTanStackRows`가 실행된다
- `emptyUserMessageMigration` — chat_threads.messages에서 빈 user ModelMessage만 제거하는 SQL 단계
- `humanDecisionFactsMigration` — `human_decision_facts` 테이블을 만드는 단계. 시작 시 이 단계와 함께 `migrateHumanDecisionRows`가 실행된다
- 하위 디렉터리 없음

## Invariants

- `migrations`에는 새 단계를 뒤에 덧붙이기만 한다. 이미 적용된 단계는 절대 고치지 않는다. `PRAGMA user_version`은 적용한 단계 수와 같다.
- `migrateDatabase`는 시작 시점에만, 연결을 서비스나 writer에 넘기기 전에 실행한다. 이미 트랜잭션 안이면 `InsideTransaction`으로 거부한다.
- 마이그레이션 중에는 `PRAGMA foreign_keys = OFF`로 둔다. 원래 값은 `Effect.ensuring`으로 복원한다. 실패하면 ROLLBACK하고, 메타데이터 adopt, 대기 단계, cursor가 함께 롤백된다.
- 적용 버전은 마이그레이션 잠금(BEGIN IMMEDIATE)을 잡은 뒤에 읽는다. 다른 starter가 먼저 끝냈을 수 있기 때문이다.
- user_version이 `migrations.length`보다 크면 `NewerThanBuild`로 거부한다. reader에서 더 작으면 `MigrationPending`으로 거부한다. reader는 마이그레이션하지 않으며 캐시된 스키마 버전을 가정하지 않는다.
- `effect_sql_migrations`가 없으면 1..applied를 `schema_N` 이름으로 adopt한다. 과거 SQL은 다시 실행하지 않는다. 기록이 1..applied와 연속으로 맞지 않으면 `MetadataMismatch`로 거부한다.
- FK를 멈춘 채 참조 테이블을 재구성할 수 있는 단계는 `goalHistoryMigration`(version 42)뿐이다. 이 단계 전후로 `preservedTables`의 rowid 순 스냅샷이 같아야 하고, `PRAGMA foreign_key_check`가 비어 있어야 한다.
- 대기 단계가 있었다면 COMMIT 전에 `PRAGMA foreign_key_check`를 통과하고 `assertDatabaseSchema`를 통과해야 한다.
- `assertDatabaseSchema`는 chat_runs(run_id,thread_id,status), workflow_run_bindings(run_id,workflow_revision_id,goal_instance_id), owner_read_recoveries(receipt_id,authorization_fingerprint,execution_payload_json), owner_workflow_executions(execution_id,created_at,updated_at), nodes(id,seq,project_id,session_id,kind,text) 컬럼을 prepare로 검사한다. version cursor만으로 런타임 계약을 보장하지 않는다.
- Migrator는 단계 실패를 일반 defect로 바꾼다. 그래서 단계 안에서는 `DatabaseSchemaRejected`를 throw해 사유를 보존하고, `catchDefect`에서 `migrationFailure`로 되돌린다.
- 앱은 SQLite 연결을 하나만 쓴다. 두 번째 연결을 열면 한 연결에서 멈춘 트랜잭션이 다른 연결의 동기 `BEGIN IMMEDIATE`를 이벤트 루프에서 막는다. 모든 statement와 트랜잭션은 `semaphore`(크기 1)로 연결을 임대한다.
- 가져오기 worker는 같은 파일에 자기 연결을 연다. 그 연결이 쓰기 잠금을 쥔 동안 `BEGIN IMMEDIATE`와 트랜잭션 밖의 statement는 SQLite 안에서 20ms만 기다리고 실패한다. client가 sleep한 뒤 다시 시도한다(처음엔 10ms, 늘려 가며 최대 250ms 간격, 30초까지). 그동안 이벤트 루프는 계속 돈다. 둘 다 실패할 때 바꾼 것이 없어서 다시 시도해도 된다. 트랜잭션 안의 statement와 여러 문장 스크립트는 다시 시도하지 않는다.
- node:sqlite 오류는 SQLite 결과 코드를 `errcode`에 싣는다. `classifySqliteError`는 `code`·`errno`만 읽어 잠금 대기를 `UnknownError`로 분류하므로, client가 `errcode`의 `SQLITE_BUSY`를 `LockTimeoutError`로 바꾼다.
- `migrationClient`는 바깥 BEGIN IMMEDIATE가 이미 잡혀 있다고 가정한다. 그래서 `SAVEPOINT effect_migrate`, `RELEASE effect_migrate`, `ROLLBACK TO effect_migrate; RELEASE effect_migrate`를 쓰고, 두 번째 DB를 열지 않는다.
- 바인딩 파라미터는 string, finite number, bigint, null, Uint8Array만 허용한다(Schema 디코드). BigInt 읽기 모드는 fiber의 `SqlClient.SafeIntegers` 값을 따른다.
- prepared statement 캐시는 용량 200이다. 성공한 prepare만 10분 동안 캐시하고, 실패한 prepare는 즉시 만료한다.
- `nodes`는 불변이다(`nodes_immutable` 트리거가 UPDATE를 막는다). `nodes.seq`는 turbovec 벡터 id로도 쓰인다. nodes_fts(trigram)는 INSERT 트리거로 채워진다.
- 연결 PRAGMA는 `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `cache_size = -65536`(64 MiB, `docs/decisions.md` 근거)이다. `busy_timeout = 5000`은 열 때의 마이그레이션에만 쓰고, `sqlClientOver`가 20으로 낮춘다.
- DB 디렉터리는 `:memory:`가 아닐 때 mode `0o700`으로 recursive 생성한다.

## Side Effects

- `fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })`로 DB 디렉터리를 만든다.
- `new DatabaseSync(file)`로 SQLite 파일을 연다. Layer scope가 끝나면 `sqlite.close()`로 닫는다.
- 연결에 PRAGMA를 쓴다(journal_mode WAL, foreign_keys, busy_timeout, cache_size, user_version).
- 마이그레이션 DDL과 DML을 실행한다. 테이블, 인덱스, 트리거, FTS를 생성하고 chat_threads 메시지 정리 등을 한다.
- `effect_sql_migrations` 테이블을 만들고 INSERT OR IGNORE로 기록한다(Migrator 메타데이터).
- `tanStackRowsMigration` 단계에서 `migrateTanStackRows()`를 실행해 TanStack이 쓴 chat 행을 Effect AI 형태로 다시 쓴다.
- `humanDecisionFactsMigration` 단계에서 `migrateHumanDecisionRows()`를 실행해 0.0.17이 payload에 넣은 사람 결정의 사실과 시각을 `human_decision_facts` 첫 행과 `created_at`으로 옮기고 payload를 다시 encode한다. 읽지 못하는 행은 그대로 둔다.
- `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, SAVEPOINT로 트랜잭션을 제어하고 SQLite 쓰기 잠금을 잡는다.
- 런타임 `SqlClient`로 모든 SQLite 읽기·쓰기를 실행한다. Semaphore 임대와 prepared statement Cache를 쓴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
