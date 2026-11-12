# memory

## Overview

`src/memory`는 memory-agent의 장기 기억 그래프 계층이다. 대화 메시지를 append-only `nodes`와 `edges`(구조 링크와 LLM 링크)로 SQLite에 기록하고(`Nodes`, `Recorder`), 벡터·텍스트 검색으로 찾은 결과를 그래프 탐색의 시드로 쓴다(`MemorySearch`, `Graph`).

저장된 사용자 발화는 LLM이 사후에 해석해 topic·corrects·retracts·related 관계를 붙인다(`Interpreter`, `Interpretations`). 그 결과를 바탕으로 출처 추적, 증거 읽기, 최신 결정 해석, 그래프 수리를 제공한다.

임베딩·네이티브 검색 worker는 하위 디렉터리가 맡고, 이 디렉터리는 그 위에서 저장·질의 규칙을 정한다.

## Interface

- `Nodes` — 모든 메시지를 담는 append-only 저장소 `Context.Service`(`Nodes.layer`). 쓸 때 구조 edge를 함께 만든다. `get`, `page`, `append` 등을 제공한다
- `Node` / `NodeKind` / `NodeDetail` / `NewNode` / `NodeRow` / `nodeOfRow` / `EdgeRow` / `edgeOfRow` — 노드 Schema, SQLite 행 Schema, 행을 도메인 값으로 바꾸는 변환 함수
- `NodeStoreFailed` — 노드 저장소 읽기·쓰기 실패 TaggedError
- `textWindow` / `evidencePageLength`(4000) / `EvidencePage` — surrogate pair 중간에서 끊지 않는 UTF-16 텍스트 창, read_evidence 한 페이지의 글자 수, 페이지 결과 타입
- `Edge` / `EdgeKind` / `EdgeOrigin` / `edgeWeights` / `NodeLink` — edge Schema, 종류(calls·returns·reply·touches·next·corrects·retracts·about·related·cites·supersedes; cites·supersedes는 진행 메모 node `note`가, cites는 Plan 버전 node `plan`도 쓴다)와 출처(structure·llm), 종류별 탐색 신뢰 가중치, writer가 선언할 수 있는 구조 링크(calls·returns는 새 node가 `to`, reply·cites·supersedes는 새 node가 `from`). `NewNode.inFlow: false`인 node는 대화 흐름 밖에서 적혀 세션의 마지막 node에서 `next` edge를 받지 않는다
- `Graph` — 그래프 탐색 서비스(`Graph.layer`, 키 `memory-agent/memory/graph`). `traverse(seeds, options)`는 utility 우선으로 바깥쪽을 탐색하고(`beforeSeq`가 있으면 그 seq 전에 저장된 노드만 방문), `trace(id)`는 원인 사슬과 그 사슬을 정정·철회한 노드(`challengedBy`)를 돌려준다
- `GraphReadFailed` / `Hop` / `Visit` / `TraverseOptions` / `TraverseResult` / `Provenance` — 그래프 읽기 실패 오류와 탐색·출처 결과 타입
- `MemorySearch` — 이전 메시지를 찾는 서비스(`MemorySearch.layer`, `MemorySearch.tuned(partial)`). 벡터·텍스트 매치를 시드로 그래프를 탐색한다. `rerank`가 켜진 검색은 채널마다 상위 10개를 번갈아 합친 후보를 `Reranker`로 다시 줄 세우고, 그 후보들의 fused 점수를 새 순서대로 다시 나눠 준다(점수 크기는 그대로라 그래프 탐색의 utility 하한이 같은 뜻이다). `find`, `findMatches`, `allowedProjects`를 제공한다. `find`는 매치와 함께 아직 못 덮은 수(`unindexed`, `textUnindexed`, `uninterpreted`)를 세어 모델에 알리는 검색(find_memory, CLI)이 쓴다. `findMatches`는 그 수를 세지 않고 매치만 돌려준다. 턴의 기억 보충, 외부 agent의 기억 단서, 해석 후보 검색이 쓴다. 세는 검색도 전체 수는 자기 프로젝트 읽기에서만 세고, 다른 프로젝트 읽기는 그 프로젝트들의 미해석 수만 센다
- `FindInput` / `Match` / `FoundMatches` / `SearchCoverage` / `FindResult` / `SkippedRead` / `NativeMemorySearchFailed` — 검색 입력(`beforeSeq`: 그 seq 전에 저장된 노드만 찾고 그래프로 닿는다. 지난 발언을 해석할 때 쓴다. 찾은 노드의 정정 표시는 지금 기준. `rerank`: reranker가 돌면 상위 결과를 그 순서로 둔다. find_memory, compaction의 기억 보충, 외부 agent의 기억 단서가 켜고, 해석 후보 검색은 끈다)과 결과, 실패해도 건너뛰고 진행한 읽기의 기록(reason·stage·elapsedMs), 네이티브 검색 실패 오류
- `fuseRanks` / `searchTerms` / `namesSomethingExactly` / `searchTuning` / `SearchTuning` — RRF 순위 병합, 검색어 분리(3자 이상은 lexical 색인의 trigram 구절, 두 글자는 그 글자로 시작하거나 끝나는 gram), 정확한 이름(에러 코드·경로·식별자·버전·해시·포트)이 든 질의인지 판별, 검색 튜닝 값
- `readStructuredEvidence` — `Effect.fn("Memory.readStructuredEvidence")`. 노드 원문 페이지에 출처·변경·판정(`evidenceContext`)을 붙여 돌려준다. 노드가 없거나 범위 밖이면 null
- `traceStructuredEvidence` / `EvidenceReadFailed` — 같은 범위·권한 규칙으로 출처 사슬, 적용된 변경(사유 포함), 미확정 변경을 요약한다. 저장소 읽기 실패는 stage만 담은 `EvidenceReadFailed`가 된다
- `isChangeAuthority` / `changeAuthoritySql` / `scopedChain` — 정정·철회 권한 규칙(dual 함수)과 그 SQL 버전, 허용 프로젝트 경계에서 멈추는 출처 사슬
- `Interpretations` / `Interpretation` / `InterpretedKind` / `InterpretationStoreFailed` — LLM 해석 결론 저장소(`record`, `targeting(targetIds, status)`). 상태는 applied·unconfirmed
- `Interpreter` / `InterpretationFailed` — llm-interpret 서비스(`Interpreter.layer(automatic = true)`). 저장된 발화를 topic·correction·relation edge로 바꾼다. 실패 reason은 `model_call_failed` 또는 `unreadable_answer`
- `interpretInstructions` / `normalizeTopic` — 해석 모델의 시스템 지시문, topic 라벨 정규화(한 줄, 앞뒤 공백 제거, 최대 60자)
- `Recorder` / `makeRecordingHook` / `RunBinding` — 채팅 run을 메모리 노드로 바꾸는 서비스(`Recorder.layer`)와 Effect AI run의 `RunHook`을 만드는 함수(`Nodes`·`PermissionReviews` 필요)
- `MemoryGraphMaintenance` / `MemoryGraphRepairFailed` — 이전 버전이 잘못 쓴 링크를 자동으로 고치는 로컬 수리 서비스(`MemoryGraphMaintenance.layer`)와 그 실패 오류
- `latestResolver` / `ChainReads` / `LatestEvidence` / `LatestHead` / `BranchHead` / `AppliedChange` / `ChainSource` / `ChangeRelation` — owner 저장소 읽기를 통해 한 발화에 기록된 변경이 어디서 끝나는지 해석한다
- `createResultPageReader` / `ResultPageReadFailed` — append-only 노드 텍스트를 블록 캐시·텍스트 인덱스로 페이지 단위로 읽는 리더와 그 실패 오류
- `createSupersededReads` / `supersededReadSql` — 뒤의 읽기가 대체한 파일 읽기를 판별하는 SQL과 생성 Effect(`memoryGraphRepairVersion` 사용)
- `memoryGraphRepairVersion`(3) / `hasStatementText` / `nonBlankTextSql` / `meaningfulNodeFilter` / `embeddedKinds` / `embeddedKindFilter` — 그래프 수리·검색 제외 규칙의 버전, 공백이 아닌 텍스트 판별, SQL 필터(nodes 별칭 `n`), 임베딩 대상 kind(`user`, `assistant`, `topic`)와 그 SQL 필터
- `refsInArguments` — tool call JSON 인자에서 파일·URL 참조를 뽑는다
- 문구 — Lingui 런타임 매크로 메시지(`msg`)로 쓰는 곳에 두고 `src/i18n.ts`로 푼다. `src/locales/ko.po`로 추출되고 `lint/wording`가 검사한다
- `memoryPrompts` (`prompts.ts`) — 모델이 읽는 텍스트. 임베딩·rerank 모델이 적재 직후 한 번 돌리는 준비 입력(`warmUp`)을 담고, `embedding`과 `rerank` 하위 디렉터리도 이 파일을 쓴다
- [`embedding`](./embedding/README.md) — 모델 표(`models.ts`)의 로컬 임베딩 모델(`Embedder`), 토큰 창 청킹, turbovec 위의 `VectorIndex`, nodes와 벡터 색인을 맞추는 `Indexer`
- [`native-search`](./native-search/README.md) — turbovec 벡터 인덱스와 SQLite 읽기 세션을 전용 worker thread에 가두는 `NativeOwner`
- [`rerank`](./rerank/README.md) — 검색 결과를 다시 줄 세우는 로컬 cross-encoder `Reranker`(KURE-Reranker-nano, WebGPU worker)

## Invariants

- 정정·철회 권한은 같은 프로젝트의 더 뒤(`seq`가 큰) user 노드에만 있다. find_memory, trace_evidence, read_evidence, 그리고 compaction이 빠진 턴의 사용자 말을 고르는 `Nodes.userMessages`가 모두 이 한 규칙을 쓰므로 `isChangeAuthority`와 `changeAuthoritySql`은 같은 조건을 유지해야 한다
- `scopedChain`은 허용되지 않은 프로젝트를 만나는 첫 지점에서 멈춘다(takeWhile). 중간 원인을 거르면서 그 뒤의 조상을 드러내거나, 숨은 조상의 정정을 보이는 출처에 붙이면 안 된다
- 증거 읽기의 저장소 실패는 stage만 담은 `EvidenceReadFailed`로 바꾼다. cause에는 개인 경로나 행 내용이 있을 수 있기 때문이다. 실패한 읽기를 '정정 없음'으로 돌려주면 안 된다
- `readStructuredEvidence`와 `traceStructuredEvidence`는 읽기 시점에 조립만 한다. 새 검색, 모델 호출, 해석, 영속 사실을 만들지 않는다. root·원인·변경에 같은 범위를 적용하고, 노드가 없거나 범위 밖이면 null로 성공한다. 추적할 수 없는 노드도 `untraced` 증거로 보고한다
- 그래프 탐색(`selectNode`)은 `memory_graph_suppressed_nodes`에 있는 노드를 빼지만, `trace`의 시작 노드는 억제 여부와 상관없이 읽는다. 대체된 읽기도 자기 출처는 남는다
- `traverse`에서 노드의 utility는 부모 utility에 edge 가중치를 곱한 값이다. budget(빈 bridge 노드 포함), minUtility, projectIds, beforeSeq를 지켜야 한다. budget이 남은 후보보다 먼저 떨어지면 `complete: false`를 돌려준다
- `edgeWeights` 값은 (0, 1] 범위다. writer가 선언할 수 있는 링크는 calls·returns·reply뿐이고, `next`와 `touches`는 규칙으로 파생된다
- `Interpretations.record`는 양 끝 노드가 모두 존재하고 meaningful할 때만(count === 2) 한 트랜잭션 안에서 기록한다. applied 결론만 llm edge로도 넣고(`ON CONFLICT DO NOTHING`), unconfirmed는 사실이 아닌 질문으로 남긴다
- Interpreter는 시작할 때 `running` 작업을 `pending`으로 되돌리고, assistant 노드의 pending 작업을 지운다. 사용자 발화만 해석한다. 삭제는 `EXISTS`로 조회한다. `IN (SELECT ...)` 전체 스캔이 네이티브 인덱스의 시작 deadline을 넘겨 event loop를 막았기 때문이다
- Interpreter의 배치 순서: 생성 시각(`created_at`)이 가장 늦은 pending 발화의 세션을 먼저 고르고, 그 세션 안에서는 seq 오름차순으로 처리한다. 세션 선택에는 seq 순서를 쓰지 않는다. 고정값은 batchSize 8, 실행당 5배치, 최대 3회 시도, 모델 호출 타임아웃 90초다. `Semaphore(1)`로 실행은 한 번에 하나만 돈다
- 해석 후보는 seq와 `createdAt`이 모두 앞선 user·assistant 노드로 한정한다. 검색도 `beforeSeq`로 그 발화 전에 저장된 노드만 찾아, 나중 노드가 후보 자리를 차지하지 않는다. 모델이 돌려준 link는 그 발화에 제시한 후보 id만 인정한다. 후보가 없는 발화는 모델을 부르지 않고 done으로 표시한다
- 모델 호출이 실패해(`model_call_failed`) `failed`가 된 작업은 뒤의 모델 호출이 답을 받으면 `pending`으로 돌아간다. 작업마다 3번까지(`automatic_retries`)이고, 시도 수는 그대로라 돌아갈 때마다 한 번만 더 시도한다. 답을 읽지 못한 실패는 자동으로 돌리지 않는다
- `failedCount`는 meaningful 노드의 `failed` 작업 수, `retryFailed`는 그 작업을 모두 `pending`으로 돌리고 시도 수와 `automatic_retries`를 0으로 되돌린다(설정의 다시 시도). 배치를 하나라도 돈 실행과 `retryFailed`는 global `interpretation` 이벤트를 발행한다
- 모델 답은 문장마다 따로 읽는다. 답 전체가 JSON이 아니면 배치 전체가 `unreadable_answer`로 실패하지만, 한 문장의 모양만 틀리면 그 문장만 `unreadable_answer`로, 답에 없는 문장은 `missing_from_answer`로 실패하고 나머지는 기록된다
- 해석 프롬프트는 발화 안의 텍스트를 데이터로 다루고, 그 안의 지시를 따르지 않는다. corrects·retracts는 user 발화만 할 수 있다
- API 사용량(`memory-interpretation`)은 세션이 있는 발화에 대해서만 기록한다
- Layer 요구: `Graph`와 `Interpretations`에는 `SqlClient`가 필요하다. `Interpreter`에는 `SqlClient`, `Nodes`, `MemorySearch`, `Interpretations`, `ActiveProvider`, `ApiUsage`, `AppEvents`, `SecureRandom.SecureRandom`이 필요하다. 증거 함수에는 `Nodes`, `Graph`, `Interpretations`, `MemorySearch`가 필요하다. `MemorySearch`에는 `Reranker`가 필요하다

## Side Effects

- SQLite 읽기: `nodes`, `edges`, `memory_graph_suppressed_nodes`, `interpretations`, `interpret_jobs`
- SQLite 쓰기: `interpretations` INSERT와 applied 결론의 `edges` INSERT(llm origin), `interpret_jobs` 상태 갱신(running/done/failed/pending)과 시작 시 정리(UPDATE·DELETE), topic 노드 append(`nodes.append`)
- SQLite 쓰기: `Nodes`의 append-only 노드와 구조 edge 기록, `Recorder`의 채팅 run 기록, `MemoryGraphMaintenance`의 링크 수리
- 네트워크: `Interpreter`가 `ActiveProvider`가 고른 provider의 가장 싼 effort 모델을 `singleAnswer`로 부르고, `recordUsage`로 API 사용량 ledger에 기록한다
- 네이티브 검색: `MemorySearch`는 native-search owner worker를 거쳐 벡터·controlled 읽기를 하고, 실패한 읽기를 `SkippedRead`로 남긴다
- 난수: `Interpreter`는 모델 호출 threadId에 `uuidV4`를 쓴다
- 시계: `DateTime.now`·`Clock.currentTimeMillis`로 `created_at`·`updated_at`을 기록한다
- 로그: 해석 후보 검색이 실패하면 `interpret_candidates_unavailable`를 debug 로그로 남긴다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
