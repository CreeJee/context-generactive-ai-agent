# secrets

## Overview

`packages/memory-agent/src/secrets`는 모델이 텍스트를 읽거나 메모리가 텍스트를 저장하기 전에 그 안의 비밀(API 키, 비밀번호 등)을 가리는 계층이다. `redactor.ts`의 `SecretRedactor` 서비스는 탐지기 두 개를 함께 쓴다. 하나는 secretlint 권장 preset이고, 다른 하나는 자격 증명 이름 옆의 값을 잡는 정규식이다. 찾은 값은 `[redacted:kind]` placeholder로 바꾼다. 이 서비스는 도구 결과와 오류를 감싸는 `withHiddenResults`도 제공한다. `restore.ts`는 모델이 가려진 view를 기준으로 편집한 텍스트를 실제 파일 텍스트에 적용한다. `sweep.ts`의 `SecretSweep`는 시작할 때 worker thread(`redact-worker.ts`, RPC 계약은 `redact-protocol.ts`)에서 기존 DB 행(`nodes`, `node_refs`, 여러 JSON·텍스트 컬럼)을 배치 단위로 다시 가린다. 진행 상황은 `secret_sweeps`에 기록한다.

## Interface

- `SecretRedactor` — `Context.Service`(`memory-agent/secrets/redactor/SecretRedactor`). `SecretRedactor.layer`(`Layer.effect`)로 제공한다. 멤버는 `redactText`, `redactView`, `redactJson`, `redactResult`, `shownDetail`, `hideDetail`, `withHiddenResults`이다.
- `SecretRedactor.redactText` — 텍스트의 비밀을 가리고 `Redaction { text, hidden }`을 돌려준다. 실패하면 `SecretRedactionFailed`를 낸다.
- `SecretRedactor.redactView` — `RedactedView`를 돌려준다. 여기에는 가려진 텍스트와 각 placeholder가 대신하는 원래 값(`HiddenSpan[]`)이 함께 담긴다.
- `SecretRedactor.redactJson` / `redactResult` — JSON 구조는 유지하고 문자열 안의 비밀만 가린다. `redactResult`는 JSON이 아닌 값을 그대로 통과시킨다.
- `SecretRedactor.shownDetail` / `hideDetail` — 외부 프로그램 실패 텍스트의 비밀을 가리고 1000자에서 자른다. 가리기에 실패하면 `null`(표시 안 함)을 돌려준다.
- `SecretRedactor.withHiddenResults` — `RunTool[]`의 `prepare`를 감싸 결과와 `ToolFailed.detail`의 비밀을 가린다. 가리기에 실패하면 `redaction_failed` `ToolFailed`로 대체한다.
- `SecretRedactionFailed` — `Schema.TaggedError`. 탐지기(secretlint) 실패를 나타낸다.
- `Redaction` — `{ text, hidden }` 인터페이스. `hidden`은 가린 비밀 수이고, 0이면 원문 그대로이다.
- `mergeFindings` — 겹치는 finding을 하나로 합친다. 공급자 kind가 `credential`보다 우선한다.
- `HiddenSpan` / `RedactedView` — 가려진 값과 redacted 텍스트 안 placeholder 위치를 나타내는 타입.
- `placeholderOf` — `kind`를 `[redacted:${kind}]` 문자열로 만든다.
- `mentionsHidden` — 텍스트에 `[redacted:`가 들어 있는지 확인한다.
- `replaceKeepingHidden` — 가려진 view 기준 find/replace를 실제 텍스트에 적용한다. 결과는 `Result<{ text, replacements }, HiddenReplaceFailure>`이다.
- `HiddenReplaceFailure` — `Data.TaggedEnum`: `no_match`, `ambiguous { occurrences }`, `cuts_hidden`.
- `RedactKind` — `Schema.Literals(["text", "json"])`.
- `RedactionFailed` — `Schema.TaggedError`, `reason: "redaction-failed" | "worker-lost"`. `sweep.ts`에서도 re-export한다.
- `Redact` / `RedactRpcs` — `Rpc.make("Redact")`(payload `{ kind, texts }`, success는 텍스트 순서대로 `{ text, hidden }[]`)와 그 `RpcGroup`.
- `redact-worker.ts` — worker thread 진입 모듈. `RpcServer.layer(RedactRpcs, { concurrency: 1 })`를 `NodeWorkerRunner`로 띄운다. `runtimeWorker("redact-worker")`로 로드한다.
- `SecretSweep` — `Context.Service`(`memory-agent/secrets/sweep/SecretSweep`). `SecretSweep.layer(running = true)`로 제공한다. 서비스 멤버는 `make`(171-431행)가 돌려주며, scan은 300행 이후를 읽지 않았다.
- `SweepProgress` — `{ target, done, hidden }` 인터페이스.
- `SweepStoreFailed` — `Schema.TaggedError`. sweep이 진행 상황을 읽거나 기록하지 못했음을 나타낸다.
- `sweepVersion` — 탐지기 버전(현재 1). 올리면 모든 테이블을 처음부터 다시 sweep한다.

## Invariants

- `placeholderOf`의 형식 `[redacted:kind]`는 `restore.ts`의 정규식 `/\[redacted:([^\]\s]+)\]/gu`, `mentionsHidden`, `notASecret`의 `/^\[redacted:/u`와 맞아야 한다. redactor가 쓰는 텍스트를 restore가 그대로 읽는다.
- 탐지 규칙이 이전에 찾지 못한 것을 찾게 되면 `sweepVersion`을 올려야 한다. 버전이 다른 진행 기록은 시작하지 않은 것으로 본다(`progressOf`).
- `replaceFindings`에 넘기기 전에 `mergeFindings`로 겹치는 span을 합쳐야 한다. 그러지 않으면 앞선 치환으로 위치가 바뀐 텍스트를 잘못 자른다.
- 이름만으로는 비밀로 판단하지 않는다. 실제로 출력된 값만 가린다. `environmentAssignment`는 대소문자를 구분하고, 소문자 설정 키는 따옴표로 감싼 값만 잡는다. 값은 8자 이상이어야 한다.
- 가리기에 실패하면 내용을 보이지 않는다. 도구 결과와 오류는 `withheld` `ToolFailed`(`redaction_failed`)로 바꾸고, `shownDetail`은 `null`을 돌려준다.
- `secretLintProfiler.setEnabled(false)`를 유지해야 한다. 프로파일러를 켜 두면 performance buffer가 누수되고 `MaxPerformanceEntryBufferExceededWarning`이 난다.
- redaction worker는 한 번에 한 배치만 처리한다(`RpcServer` `concurrency: 1`, client `size: 1, concurrency: 1`). secretlint는 동기로 돌아 이벤트 루프를 막으므로 main thread가 아닌 worker에서 실행한다.
- `Redact` 응답은 보낸 텍스트 하나에 하나씩, 보낸 순서대로 돌려준다. `redactCells`는 `null` 셀을 보내지 않고 `null`로 남긴다.
- `redact-worker.ts`는 package index가 아닌 `@effect/platform-node/NodeWorkerRunner` 모듈을 직접 import해야 한다. index는 시작을 느리게 한다.
- node 재작성 순서는 `secret_sweep_permits` insert, `nodes_fts` delete, `nodes` update, `nodes_fts` insert, permit delete, 그다음 `nodes_morph`/`node_morphs`/`node_vectors` 파생 데이터 삭제이다. 모두 한 `sql.withTransaction` 안에서 실행한다.
- node sweep은 `indexer.exclusive` 아래에서 실행한다. 벡터 제거, `vectors.save`, `nodes.invalidateResultPages`는 DB 커밋 전에 한다. 그 사이에 크래시가 나면 다시 열 때 크기 불일치로 감지해 재구축한다.
- redaction은 트랜잭션 전에 실행해 DB를 잠깐만 잡는다(`batchSize = 200`). sweep pass는 `Semaphore.make(1)`로 한 번에 하나만 돈다.
- `node_refs`는 `UPDATE OR REPLACE`로 갱신한다. 이미 가려진 같은 ref와 충돌하면 그 행을 남긴다.
- JSON 컬럼의 텍스트가 JSON이 아니면 건너뛰지 않고 일반 텍스트로 가린다(`hideJson`).

## Side Effects

- `node:worker_threads` `Worker`로 `redact-worker` thread를 띄운다. thread는 sweep 하나 동안만 살아 있고 sweep이 끝나면 멈춘다.
- SQLite 읽기: `secret_sweeps`, `nodes`, `node_refs`, `chat_threads`, `chat_interrupts`, `permission_reviews`, `queued_messages`, `subagents`, `interpretations` 컬럼.
- SQLite 쓰기: `secret_sweeps` upsert(`updated_at`는 `DateTime.now`), `nodes` update, `nodes_fts` delete/insert, `secret_sweep_permits` insert/delete, `nodes_morph`/`node_morphs`/`node_vectors` delete, `node_refs` `UPDATE OR REPLACE`, 컬럼 테이블 update.
- `VectorIndex.remove`와 `vectors.save`로 벡터 인덱스를 바꾸고 파일에 저장한다. `Nodes.invalidateResultPages`를 호출한다.
- `secretLintProfiler.setEnabled(false)`로 secretlint의 전역 profiler 상태를 바꾼다.
- `fallbackLogged`/`ignoreLogged`로 실패를 로그에 남긴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
