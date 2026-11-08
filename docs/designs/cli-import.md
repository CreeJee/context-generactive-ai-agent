# CLI 채팅 임포트(헤드리스) 조립 설계

작성 2026-11-08. Plan M1의 산출물이다. 대상은 `context-agent memory import`(쓰기)와
`memory import-status`(읽기 전용)다.

## 왜 전체 레이어를 쓰지 않는가

`memoryAgentLayer`(`packages/memory-agent/src/layers.ts:204`)는 합성 루트라서 칸반 카드 큐
워커, 에이전트 채팅, MCP 서버, 외부 에이전트, 스킬, 프로바이더/OAuth 키체인
(`OAuthKeychain.keychain`), 비밀 스윕까지 전부 세운다. CLI 한 번 실행에 필요 없는 백그라운드
루프와 OS 키체인 접근이 함께 딸려 온다. 그래서 임포트 경로에 필요한 레이어만 조립한다.

## 임포트 패스에 실제로 필요한 것

주 프로세스:

| 레이어                               | 근거                                                                     | 비고                                                |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `nodePlatformLayer`                  | 파일시스템·경로·crypto·난수                                              | 터미널은 쓰지 않는다                                |
| `StorageRoot.layer(storage)`         | `importer.ts:200` `yield* StorageRoot`                                   |                                                     |
| `Database.layer(<storage>/agent.db)` | `layers.ts:220`                                                          | **마이그레이션을 여기서 수행**한다                  |
| `GlobalConfig.layer`                 | `importer.ts:202`, `pass.ts:517`                                         | `importsInterpret`를 읽는 주체                      |
| `AppEvents.layer`                    | `importer.ts:203`, `indexer.ts`                                          | 발행만 하고 구독자는 없다                           |
| `Projects.layer`                     | `importer.ts:205`, 패스가 프로젝트를 등록                                |                                                     |
| `Embedder.local` (또는 `localFile`)  | `indexer.ts` `yield* Embedder`                                           | 모델 파일 필요                                      |
| `ModelDownloads.layer`               | `layers.ts:223`, 모델 내려받기 보고                                      | 색인 경로에서만                                     |
| `nativeVectorIndexLayer`             | `native-vector-index.ts:438` → `NativeOwner`·`NativePublication`         | `StorageRoot`·`SqlClient`·`Embedder` 요구           |
| `Indexer.layer`                      | `indexer.ts:342`, 요구: `SqlClient`·`AppEvents`·`Embedder`·`VectorIndex` |                                                     |
| `Importer.layer(false, home)`        | `importer.ts:486`                                                        | **watching=false**: CLI는 감시 루프를 돌리지 않는다 |

워커 스레드(`imports/worker.ts`)는 자기 레이어를 따로 세운다: `Database`·`GlobalConfig`·
`StorageRoot`·`Projects`·`Sessions`·`BulkNodes`·`SecretRedactor`·`Checkouts`·`TranscriptPass`·
`WriteTurns`. 주 프로세스가 `BulkNodes`를 제공할 필요는 없다. 워커 파일은
`runtimeWorker("import-worker")`로 찾으므로 체크아웃과 실행 파일 양쪽에서 동작한다.

## 제외하는 것

칸반 전체(`cardQueueWorkerLayer`, `KanbanOrchestrator`, `CardWorkspaceJanitor` …), `AgentChat`·
`BtwChat`, 도구 계열(`FileTools`·`CodeTools`·`MemoryTools` …), 프로바이더/라우팅/이미지,
`OAuthProfiles`·`OAuthKeychain`, `McpServers`, `ExternalAgents`, `Skills`, `Subagents`,
`SecretSweep`, `Interpreter`, `Reranker`, `MemorySearch`(임포트에는 불필요; 왕복 검증은 기존
읽기 전용 조립으로 한다), HTTP/서버 계열 일체.

## 읽기 전용 조립과 달라지는 지점

`src/cli/read-only-storage.ts`는 (1) `DatabaseSync`를 `readOnly`+`query_only`로 열고
(2) `assertDatabaseSchema`로 스키마가 다르면 닫고 (3) 마이그레이션을 하지 않으며
(4) 네이티브 인덱스를 쓰기 리스 없이 읽고 (5) 쓰기 API를 전부 실패 스텁으로 둔다.
쓰기 조립은 반대로 (1) `Database.layer`로 열어 **마이그레이션을 수행**하고 (2) 네이티브
인덱스의 쓰기 경로(`writer.lock` = `CacheLease`)를 실제로 잡으며 (3) 그 전에
`<storage>/backend.lock`을 잡아 앱과 동시에 돌지 않게 한다.

## 임포트 실행 API

- `importer.runOnce`: 패스 하나를 끝까지 기다리고 쓴 노드 수를 돌려준다. `importsEnabled`
  설정과 무관하게 돈다(그 설정은 감시 루프만 본다). CLI는 이것을 쓴다.
- `importer.start`: 패스를 띄우고 즉시 반환하며 백필을 뒤에 붙인다. CLI에는 맞지 않는다.
- 색인 소진: `importer`의 내부 `backfill`과 동일하게 `indexer.lexicalAll()` +
  `indexer.indexAll()`를 CLI가 직접 부른다. 남은 양은 `indexer.pending`으로 읽는다.
- `importer.overview`: `ImportOverview`(enabled·interpret·sources·unplaced·failures·unindexed·
  activity·watch). `import-status`의 출력 재료다.

## 해석(LLM) 기본값 — M4에서 결정할 지점

`pass.ts:517`이 워커 안에서 `settings.importsInterpret ?? true`를 읽어 `migrate`에 넘긴다.
즉 설정이 없으면 기본이 **켜짐**이다. CLI 기본은 꺼짐이어야 하므로 선택지는 둘이다:

1. CLI가 패스 전에 `importsInterpret=false`로 바꾸고 끝나면 되돌린다 — 사용자 설정을 건드리고
   중간에 끊기면 남는다.
2. 패스 단위 override를 워커 프로토콜에 추가한다 — 공유 코드를 바꾸지만 설정은 건드리지 않는다.

M4에서 2안을 우선 검토하고, 고른 쪽을 `docs/decisions.md`에 남긴다. CLI는 `Interpreter`를
조립하지 않으므로 어느 쪽이든 CLI 실행 중 LLM 호출은 일어나지 않는다. 차이는 가져온 노드가
나중에 앱에서 해석 대상으로 줄 서느냐다.
