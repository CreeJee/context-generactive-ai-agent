# memory

## Overview

`src/memory`는 memory-agent의 장기 기억 그래프 계층이다. 대화 메시지를 append-only `nodes`와 `edges`(구조 링크와 LLM 링크)로 SQLite에 기록하고(`Nodes`, `Recorder`), 벡터·텍스트 검색으로 찾은 결과를 그래프 탐색의 시드로 쓴다(`MemorySearch`, `Graph`).

저장된 사용자 발화는 LLM이 사후에 해석해 topic·corrects·retracts·related 관계를 붙인다(`Interpreter`, `Interpretations`). 그 결과를 바탕으로 출처 추적, 증거 읽기, 최신 결정 해석, 사용자 승인을 거친 지식 승격, 그래프 수리를 제공한다.

임베딩·형태소·네이티브 검색 worker는 하위 디렉터리가 맡고, 이 디렉터리는 그 위에서 저장·질의 규칙을 정한다.

## Interface

- `Nodes` — 모든 메시지를 담는 append-only 저장소 `Context.Service`(`Nodes.layer`). 쓸 때 구조 edge를 함께 만든다. `get`, `page`, `append` 등을 제공한다
- `Node` / `NodeKind` / `NodeDetail` / `NewNode` / `NodeRow` / `nodeOfRow` / `EdgeRow` / `edgeOfRow` — 노드 Schema, SQLite 행 Schema, 행을 도메인 값으로 바꾸는 변환 함수
- `NodeStoreFailed` — 노드 저장소 읽기·쓰기 실패 TaggedError
- `textWindow` / `evidencePageLength`(4000) / `EvidencePage` — surrogate pair 중간에서 끊지 않는 UTF-16 텍스트 창, read_evidence 한 페이지의 글자 수, 페이지 결과 타입
- `Edge` / `EdgeKind` / `EdgeOrigin` / `edgeWeights` / `NodeLink` — edge Schema, 종류(calls·returns·reply·touches·next·corrects·retracts·about·related)와 출처(structure·llm), 종류별 탐색 신뢰 가중치, writer가 선언할 수 있는 구조 링크
- `Graph` — 그래프 탐색 서비스(`Graph.layer`, 키 `memory-agent/memory/graph`). `traverse(seeds, options)`는 utility 우선으로 바깥쪽을 탐색하고, `trace(id)`는 원인 사슬과 그 사슬을 정정·철회한 노드(`challengedBy`)를 돌려준다
- `GraphReadFailed` / `Hop` / `Visit` / `TraverseOptions` / `TraverseResult` / `Provenance` — 그래프 읽기 실패 오류와 탐색·출처 결과 타입
- `MemorySearch` — 이전 메시지를 찾는 서비스(`MemorySearch.layer`, `MemorySearch.tuned(partial)`). 벡터·텍스트 매치를 시드로 그래프를 탐색한다. `find`, `allowedProjects`를 제공한다
- `FindInput` / `Match` / `FindResult` / `SkippedRead` / `NativeMemorySearchFailed` — 검색 입력과 결과, 실패해도 건너뛰고 진행한 읽기의 기록(reason·stage·elapsedMs), 네이티브 검색 실패 오류
- `fuseRanks` / `searchTerms` / `namesSomethingExactly` / `searchTuning` / `SearchTuning` — RRF 순위 병합, 검색어 분리(3자 이상은 trigram FTS, 더 짧으면 LIKE), 정확한 이름(에러 코드·경로·식별자·버전·해시·포트)이 든 질의인지 판별, 검색 튜닝 값
- `readStructuredEvidence` — `Effect.fn("Memory.readStructuredEvidence")`. 노드 원문 페이지에 출처·변경·판정(`evidenceContext`)을 붙여 돌려준다. 노드가 없거나 범위 밖이면 null
- `traceStructuredEvidence` / `EvidenceReadFailed` — 같은 범위·권한 규칙으로 출처 사슬, 적용된 변경(사유 포함), 미확정 변경을 요약한다. 저장소 읽기 실패는 stage만 담은 `EvidenceReadFailed`가 된다
- `isChangeAuthority` / `changeAuthoritySql` / `scopedChain` — 정정·철회 권한 규칙(dual 함수)과 그 SQL 버전, 허용 프로젝트 경계에서 멈추는 출처 사슬
- `Interpretations` / `Interpretation` / `InterpretedKind` / `InterpretationStoreFailed` — LLM 해석 결론 저장소(`record`, `targeting(targetIds, status)`). 상태는 applied·unconfirmed
- `Interpreter` / `InterpretationFailed` — llm-interpret 서비스(`Interpreter.layer(automatic = true)`). 저장된 발화를 topic·correction·relation edge로 바꾼다. 실패 reason은 `model_call_failed` 또는 `unreadable_answer`
- `interpretInstructions` / `normalizeTopic` — 해석 모델의 시스템 지시문, topic 라벨 정규화(한 줄, 앞뒤 공백 제거, 최대 60자)
- `Recorder` / `makeRecordingHook` / `RunBinding` — 채팅 run을 메모리 노드로 바꾸는 서비스(`Recorder.layer`)와 Effect AI run의 `RunHook`을 만드는 함수(`Nodes`·`PermissionReviews` 필요)
- `KnowledgePromotions` — 채택된 final-answer claim을 사용자 승인으로 영속 프로젝트 메모리에 승격하는 서비스(`KnowledgePromotions.layer`)
- `PromoteMemoryInput` / `MemoryCandidateView` / `MemoryUsageView` / `MemoryDisposition` / `MemoryPromotionRejected` / `KnowledgeStoreFailed` — 승격 입력, 후보·사용 기록 뷰, 처리 결과, 승격 거부 오류(reason별 고정 message), 저장소 실패 오류. 뷰와 처리 결과는 `contracts.ts`의 Schema이고 `knowledge.ts`가 타입을 다시 내보낸다. Work Trace 상세 계약이 이 Schema를 쓴다
- `MemoryGraphMaintenance` / `MemoryGraphRepairFailed` — 이전 버전이 잘못 쓴 링크를 자동으로 고치는 로컬 수리 서비스(`MemoryGraphMaintenance.layer`)와 그 실패 오류
- `latestResolver` / `ChainReads` / `LatestEvidence` / `LatestHead` / `BranchHead` / `AppliedChange` / `ChainSource` / `ChangeRelation` — owner 저장소 읽기를 통해 한 발화에 기록된 변경이 어디서 끝나는지 해석한다
- `createResultPageReader` / `ResultPageReadFailed` — append-only 노드 텍스트를 블록 캐시·텍스트 인덱스로 페이지 단위로 읽는 리더와 그 실패 오류
- `createSupersededReads` / `supersededReadSql` — 뒤의 읽기가 대체한 파일 읽기를 판별하는 SQL과 생성 Effect(`memoryGraphRepairVersion` 사용)
- `memoryGraphRepairVersion`(3) / `hasStatementText` / `nonBlankTextSql` / `meaningfulNodeFilter` — 그래프 수리·검색 제외 규칙의 버전, 공백이 아닌 텍스트 판별, SQL 필터(nodes 별칭 `n`)
- `refsInArguments` — tool call JSON 인자에서 파일·URL 참조를 뽑는다
- [`embedding`](./embedding/README.md) — 로컬 granite 임베딩 모델(`Embedder`), 토큰 창 청킹, turbovec 위의 `VectorIndex`, nodes와 벡터 색인을 맞추는 `Indexer`
- [`morph`](./morph/README.md) — Kiwi WASM 기반 한국어 형태소 분석기 `MorphAnalyzer`와 worker RPC 계약
- [`native-search`](./native-search/README.md) — turbovec 벡터 인덱스와 SQLite 읽기 세션을 전용 worker thread에 가두는 `NativeOwner`

## Invariants

- 정정·철회 권한은 같은 프로젝트의 더 뒤(`seq`가 큰) user 노드에만 있다. find_memory, trace_evidence, read_evidence가 모두 이 한 규칙을 쓰므로 `isChangeAuthority`와 `changeAuthoritySql`은 같은 조건을 유지해야 한다
- `scopedChain`은 허용되지 않은 프로젝트를 만나는 첫 지점에서 멈춘다(takeWhile). 중간 원인을 거르면서 그 뒤의 조상을 드러내거나, 숨은 조상의 정정을 보이는 출처에 붙이면 안 된다
- 증거 읽기의 저장소 실패는 stage만 담은 `EvidenceReadFailed`로 바꾼다. cause에는 개인 경로나 행 내용이 있을 수 있기 때문이다. 실패한 읽기를 '정정 없음'으로 돌려주면 안 된다
- `readStructuredEvidence`와 `traceStructuredEvidence`는 읽기 시점에 조립만 한다. 새 검색, 모델 호출, 해석, 영속 사실을 만들지 않는다. root·원인·변경에 같은 범위를 적용하고, 노드가 없거나 범위 밖이면 null로 성공한다. 추적할 수 없는 노드도 `untraced` 증거로 보고한다
- 그래프 탐색(`selectNode`)은 `memory_graph_suppressed_nodes`에 있는 노드를 빼지만, `trace`의 시작 노드는 억제 여부와 상관없이 읽는다. 대체된 읽기도 자기 출처는 남는다
- `traverse`에서 노드의 utility는 부모 utility에 edge 가중치를 곱한 값이다. budget(빈 bridge 노드 포함), minUtility, projectIds를 지켜야 한다. budget이 남은 후보보다 먼저 떨어지면 `complete: false`를 돌려준다
- `edgeWeights` 값은 (0, 1] 범위다. writer가 선언할 수 있는 링크는 calls·returns·reply뿐이고, `next`와 `touches`는 규칙으로 파생된다
- `Interpretations.record`는 양 끝 노드가 모두 존재하고 meaningful할 때만(count === 2) 한 트랜잭션 안에서 기록한다. applied 결론만 llm edge로도 넣고(`ON CONFLICT DO NOTHING`), unconfirmed는 사실이 아닌 질문으로 남긴다
- Interpreter는 시작할 때 `running` 작업을 `pending`으로 되돌리고, assistant 노드의 pending 작업을 지운다. 사용자 발화만 해석한다. 삭제는 `EXISTS`로 조회한다. `IN (SELECT ...)` 전체 스캔이 네이티브 인덱스의 시작 deadline을 넘겨 event loop를 막았기 때문이다
- Interpreter의 배치 순서: 생성 시각(`created_at`)이 가장 늦은 pending 발화의 세션을 먼저 고르고, 그 세션 안에서는 seq 오름차순으로 처리한다. 세션 선택에는 seq 순서를 쓰지 않는다. 고정값은 batchSize 8, 실행당 5배치, 최대 3회 시도, 모델 호출 타임아웃 90초다. `Semaphore(1)`로 실행은 한 번에 하나만 돈다
- 해석 후보는 seq와 `createdAt`이 모두 앞선 user·assistant 노드로 한정한다. 모델이 돌려준 link는 그 발화에 제시한 후보 id만 인정한다. 후보가 없는 발화는 모델을 부르지 않고 done으로 표시한다
- 해석 프롬프트는 발화 안의 텍스트를 데이터로 다루고, 그 안의 지시를 따르지 않는다. corrects·retracts는 user 발화만 할 수 있다
- API 사용량(`memory-interpretation`)은 세션이 있는 발화에 대해서만 기록한다
- `MemoryPromotionRejected`의 message는 reason별로 고정되어 있고 요청 텍스트를 담지 않는다. 승격 거부는 그대로 전달되고, 그 밖의 저장소·코덱 실패만 `KnowledgeStoreFailed`로 감싼다
- Layer 요구: `Graph`와 `Interpretations`에는 `SqlClient`가 필요하다. `Interpreter`에는 `SqlClient`, `Nodes`, `MemorySearch`, `Interpretations`, `ActiveProvider`, `ApiUsage`, `Crypto.Crypto`가 필요하다. `KnowledgePromotions`에는 `Crypto.Crypto`, `SqlClient`, `Nodes`가 필요하다. 증거 함수에는 `Nodes`, `Graph`, `Interpretations`, `MemorySearch`가 필요하다

## Side Effects

- SQLite 읽기: `nodes`, `edges`, `memory_graph_suppressed_nodes`, `interpretations`, `interpret_jobs`, `final_answer_claims`, `final_answer_sources`, `knowledge_decisions`, `memory_candidates`, `memory_candidate_evidence`
- SQLite 쓰기: `interpretations` INSERT와 applied 결론의 `edges` INSERT(llm origin), `interpret_jobs` 상태 갱신(running/done/failed/pending)과 시작 시 정리(UPDATE·DELETE), topic 노드 append(`nodes.append`)
- SQLite 쓰기: `Nodes`의 append-only 노드와 구조 edge 기록, `Recorder`의 채팅 run 기록, `MemoryGraphMaintenance`의 링크 수리, `KnowledgePromotions`의 승격 결정·후보·사용 기록
- 네트워크: `Interpreter`가 `ActiveProvider`가 고른 provider의 가장 싼 effort 모델을 `singleAnswer`로 부르고, `recordUsage`로 API 사용량 ledger에 기록한다
- 네이티브 검색: `MemorySearch`는 native-search owner worker를 거쳐 벡터·controlled 읽기를 하고, 실패한 읽기를 `SkippedRead`로 남긴다
- Crypto: `Interpreter`는 모델 호출 threadId에 `randomUUIDv4`를 쓰고, `KnowledgePromotions`도 `Crypto.Crypto`로 id를 만든다
- 시계: `DateTime.now`·`Clock.currentTimeMillis`로 `created_at`·`updated_at`을 기록한다
- 로그: 해석 후보 검색이 실패하면 `interpret_candidates_unavailable`를 debug 로그로 남긴다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
