# imports

## Overview

`packages/memory-agent/src/imports`는 가져오기(import) 계층이다. 다른 코딩 에이전트(Claude Code `~/.claude/projects`, Codex CLI `~/.codex/sessions`)의 로컬 transcript를 읽어 이 앱의 메모리 노드·엣지로 옮긴다. 서버 쪽 `Importer` 서비스는 별도 worker thread(`worker.ts`)를 Effect RPC(`ImportRpcs`: `Count`, `Run`, `WriteTurns`, `Turn`)로 띄우고 5분마다 pass를 돌린다. worker 안에서는 `TranscriptPass`가 transcript를 줄 단위로 읽는다. 소스별 리더(`readClaudeCodeLine`, `codexReader`)가 `TranscriptItem`을 만든다. `Checkouts`(git 기반 worktree→본 checkout 배치)가 프로젝트를 정하고, `BulkNodes`가 SQLite에 한꺼번에 기록한다. 진행 상황은 settings 화면(앱 API `settings.imports`, `apps/agent/app/.server/api/settings.ts`)과 report bundle이 `Importer`로 읽는다.

## Interface

- `Importer` — 다른 에이전트 transcript를 가져오고 계속 따라가는 Effect 서비스. `Importer.layer(watching = true, home?)`이고 앱 API settings group과 `collectReportBundle`이 사용한다
- `ImportOverview` / `ImportFailure` / `UnplacedFolder` / `PassProgress` / `ImportWorkerFailureReason` — settings에 보여 줄 가져오기 현황 Schema(소스별 transcript·migrated·nodes·failed, unplaced 폴더, 실패 목록, unindexed, activity, watch `LoopHealth`)와 그 부품(`contracts.ts`). 서버 코드를 import하지 않아 앱 API 계약과 브라우저가 쓴다
- `ImportActivity` — `ImportOverview["activity"]`(`running`·`finished`·`crashed`)의 `Data.taggedEnum` 생성자(`importer.ts`)
- `ImportWorkerFailed` — worker 실패 TaggedError. reason은 `ImportWorkerFailureReason`(`start`·`count`·`pass`·`lost`)이고 `importer.ts`에서 re-export한다
- `ImportRpcs` / `Count` / `Run` / `WriteTurns` / `Turn` — 서버와 import worker 사이의 Effect RPC 그룹. `Count`는 소스별 transcript 수를, `Run`은 `PassEvent` stream을 돌려준다. `WriteTurns`는 차례를 청하는 조각마다 이벤트 하나를 보내고, 서버는 각각 `Turn`으로 답한다
- `WriteTurns`(`write-turns.ts`) — worker 쪽 쓰기 차례 대기열. `writing(effect)`는 서버가 차례를 줄 때까지 기다렸다 `effect`를 돌리고, `grant`는 가장 오래 기다린 조각을 쓰게 한 뒤 다 쓸 때까지 돌아오지 않는다. `asked`는 차례를 청한 조각마다 이벤트를 하나 낸다
- `PassEvent` — `Progress`(checked·total·written·failed)와 `Finished`(+`counts`)로 된 TaggedUnion
- `ImportWorkerSetup` — worker 시작 인자 스키마(`storageRoot`, `home`)
- `TranscriptPass` — worker가 돌리는 transcript 1회 pass 서비스. `TranscriptPass.layer(home)`이고 `pass.ts` 본문은 바이트 상한 때문에 읽지 않았다
- `TranscriptCounts` / `Cursor` / `ImportStoreFailed` / `ImportStoreReason` — `pass.ts`의 transcript 수·cursor·저장 실패 타입(그래프 심볼 목록 기준)
- `BulkNodes` — 옮긴 대화를 node 테이블에 바로 쓰는 서비스. `write(migration)`을 제공하고 `BulkNodes.layer`가 `NodeCrypto.layer`를 포함한다
- `Migration` / `MigrationCount` / `BulkWriteFailed` — bulk 쓰기의 입력(source, projectId, sessionId, items, interpret), 결과(written, repeated), 실패 오류
- `Checkouts` — 기록된 작업 폴더가 어느 저장소의 어느 checkout에 속하는지 git에 묻는 서비스. `Checkouts.layer`가 있고 `improve/discovery.ts`, `pass.ts`, `worker.ts`가 사용한다
- `Placement` / `Placed` / `KnownRoot` / `RepositoryEvidence` — 배치 결과(path, worktree), 등록 root와 예전 worktree 부모 폴더, transcript의 remoteUrl·commit 증거
- `remoteKey` — git remote URL을 `github.com/a/b` 꼴 키로 정규화한다
- `readClaudeCodeLine` — Claude Code JSONL 한 줄을 `TranscriptItem[]`로 읽는다
- `codexReader(transcriptId)` — Codex rollout 줄을 읽는 `TranscriptReader`를 만든다
- `TranscriptItem` / `ImportSourceName` / `TranscriptReader` / `InjectedText` / `branchOf` / `isInjectedText` — `items.ts`의 공통 항목 스키마와 도구. 태그는 `session`·`message`·`tool_call`·`tool_result`·`ignored`이다(`items.ts`는 읽지 않았고 그래프와 사용처 기준)
- `importSources` / `ImportSource` / `Transcript` / `findTranscripts(home)` / `transcriptFiles` / `codexTranscriptId` — `sources.ts`의 소스 정의와 transcript 파일 탐색(읽지 않음, 그래프 심볼 목록 기준)
- `readLinesFrom` / `readPlainLines` / `readCompressedLines` / `MaxDecompressedBytes`(Context.Reference) / `TranscriptDecompressFailed` / `LinesRead` — `lines.ts`의 offset 기반 줄 읽기와 zstd 압축 해제(읽지 않음, 그래프 심볼 목록 기준)
- `worker.ts` — import worker thread 진입점. `ImportRpcs.toLayer` handlers와 `TranscriptPass`·`Checkouts` services layer를 묶어 `runNativeEffect`로 RPC 서버를 띄운다(읽지 않음, 그래프 기준)

## Invariants

- `ImportWorkerSetup`의 모든 필드는 서버가 정한다(주석: the server owns every field).
- `ImportWorkerFailed.reason` 의미를 유지해야 한다. `count`·`pass` 실패는 worker를 유지하고 원인은 worker 로그에 남는다. `lost`는 worker나 채널이 사라진 것이며 다음 요청이 새 worker를 띄운다. `importer.ts`는 `lost`일 때만 `discard`한다.
- `Run` stream은 `Progress` 이벤트를 몇 개든 보낸 뒤 `Finished`를 정확히 하나 보낸다.
- worker는 처음 쓸 때 시작해 유지한다. 잃으면 교체하고 `Importer` layer의 Scope가 멈춘다. 시작과 교체는 `lifecycle` Semaphore(1)로 한 번에 하나씩만 하고, 살아 있는 worker로 가는 요청은 기다리지 않는다.
- `discard`는 현재 session이 잃은 그 session일 때만 비운다. 다른 요청이 이미 교체한 worker를 지우면 안 된다.
- `ScopedRef.set`은 uninterruptible하게 acquire한다. 그래서 `rpcSession`을 `Effect.interruptible`로 감싸 Scope가 닫힐 때 시작을 멈출 수 있게 한다.
- worker thread는 쉬는 동안 `unref` 상태여야 한다. 요청이 진행 중일 때만 `busy`가 in-flight 카운트로 `ref`하고, 카운트가 0이 되면 다시 `unref`한다.
- RPC worker protocol은 `size: 1, concurrency: 4`이다. pass가 stream되는 동안에도 count 요청이 슬롯을 받아야 한다.
- `BulkNodes.write`는 대화 조각 하나를 `sql.withTransaction` 하나로 쓴다. 실패하면 `BulkWriteFailed`가 되고 그 조각은 아무것도 남지 않는다.
- 조각은 항목 수가 아니라 글자 수로 자른다(`pass.ts`의 `writePiece`, `Sink.reduceWhile`). 항목을 담다가 글자 수가 256K(`writeChunkText`)에 닿으면 조각을 닫는다. 항목 하나는 쪼개지 않고, 항목마다 값을 바인딩한 한 행 INSERT로 쓰므로 조각 크기는 SQL 문장과 무관하다. trigram 색인 비용은 글자 수를 따르고, 그동안 worker가 쓰기 잠금을 쥐어 서버의 쓰기가 기다린다.
- 조각은 서버가 준 차례 안에서만 쓴다(`WriteTurns`). 서버는 차례마다 자기 연결을 `sql.reserve`로 쥐고 `Turn`이 돌아올 때까지 놓지 않는다. 서버의 statement와 조각이 같은 semaphore에서 FIFO로 줄을 서므로, 두 연결은 SQLite 쓰기 잠금을 두고 서로 기다리지 않고 서버의 쓰기는 길어야 앞선 조각 하나만큼 기다린다. 30초 안에 차례를 받지 못한 조각은 그냥 쓴다. 그때는 SQLite 잠금이 두 연결을 가르고 순서만 잃는다. 대화마다 한 번인 cursor·제목·보관 같은 작은 쓰기는 차례 없이 쓰고, 잠금이 겹치면 client가 다시 시도한다.
- bulk 경로는 일부러 `Nodes.append`를 쓰지 않는다. `Nodes.append`는 현재 시각을 찍고 node마다 transaction을 연다. bulk 경로는 다른 도구가 기록한 시각(`created_at: at`)을 유지한다. node는 불변 evidence이고 live node와 같은 구조 edge를 받는다.
- 중간부터 이어 쓸 때(다음 pass, 긴 transcript의 다음 조각) turn 상태(previous, user, 열린 turn의 assistant)는 배치가 아니라 session의 DB 행에서 가져와야 한다.
- 중복 방지 키는 `imported_nodes(source, external_id)`이다. 이미 node가 된 줄은 다시 쓰지 않고 `repeated`로만 센다. transcript를 다시 읽어도 비용이 없어야 한다.
- `run_id` 규칙: user node는 `imported:<id>`, 나머지는 `imported:<userNodeId ?? sessionId>`이다. `history.ts`가 run id로 turn을 묶는다.
- `interpret_jobs`는 `migration.interpret`가 참이고, kind가 `user`이고, `hasStatementText`일 때만 넣는다. 빈 답은 model 호출을 낭비하지 않도록 넣지 않는다.
- assistant 말 없이 나온 tool call에는 빈 assistant node를 만들어 `reply` edge로 user에 잇는다. live recorder와 같은 모양이라 `trace_evidence`에서 똑같이 보여야 한다.
- `Checkouts`: 폴더의 저장소 소속은 git이나 transcript의 git 기록만 결정한다. 이름이 비슷하다는 이유로 폴더를 매칭하지 않는다.
- `Checkouts` 증거 판정: remote가 한 저장소만 가리키면 그 저장소를 쓴다. clone이 여럿이거나 remote가 없으면 `/^[0-9a-f]{7,64}$/`에 맞는 commit을 `git cat-file -e`로 확인해 정확히 하나일 때만 정한다.
- 다른 폴더도 함께 담은 worktree 부모 폴더(`holdsOnly`가 거짓)나 checkout 자신을 담은 폴더는 사라진 worktree의 근거가 될 수 없다. 후보는 하나(`single`)일 때만 채택한다.
- git을 실행할 수 없는 폴더(git 없음, 저장소 아님, 폴더 없음)는 기록된 그대로 둔다. `PlatformError`는 `none`으로 바꾼다.
- git 호출은 `extendEnv: false`와 `gitEnvironment(git)`으로 환경을 제한하고 stderr를 버린다. 저장소 동시 조회는 `gitConcurrency = 4`이다. 저장소 목록은 pass당 `Effect.cached`로 한 번만 읽는다.
- Claude Code 줄: `isSidechain`·`isMeta` 줄과 `<\system-reminder>` 블록, CLI 주입 텍스트(command 태그, interrupt·continuation 접두어)는 버린다. part가 여럿인 줄의 externalId는 `${uuid}#${index}`이다.
- Codex 줄: externalId는 `${transcriptId}:${ordinal}`이다. 파일 중간부터 이어 읽을 때 `session_meta`를 봤는지에 의존하면 안 된다. tool 결과는 항상 `ok: true`이고 주입 텍스트 필터는 user 역할에만 적용한다.

## Side Effects

- SQLite 쓰기(`bulk.ts`): `nodes`, `edges`(`ON CONFLICT DO NOTHING`), `node_refs`, `interpret_jobs`(`pending`), `imported_nodes`에 INSERT한다. 대화 조각마다 transaction 하나를 쓴다.
- SQLite 읽기: `bulk.ts`는 `nodes`, `node_refs`, `imported_nodes`를 읽고, `importer.ts`는 `import_cursors`에서 소스별 집계, skipped 폴더, 실패 transcript를 `LIMIT 20`으로 읽는다. `pass.ts`의 `Cursor`·`ImportStoreFailed` 저장 동작은 읽지 않았다.
- worker thread: `importer.ts`가 `runtimeWorker("import-worker")` 파일로 `node:worker_threads` `Worker`를 `NodeWorker.layer`로 띄우고 `ref`/`unref`를 조절한다. layer Scope가 닫히면 멈춘다.
- child process: `Checkouts`가 `ChildProcessSpawner`로 `git rev-parse`, `git config --get remote.origin.url`, `git worktree list --porcelain`, `git cat-file -e`를 실행한다.
- 파일 시스템: `Checkouts`가 `readDirectory`·`stat`·`exists`·canonical path를 읽는다. `sources.ts`와 `lines.ts`(읽지 않음)는 그래프 심볼 기준으로 home 아래 transcript 파일을 찾고, offset부터 읽고, zstd를 푼다.
- 이벤트: `Importer`가 진행 상태가 바뀔 때 `AppEvents.publishGlobal("imports")`를 발행한다.
- 타이머: `Importer`의 watcher는 `pollEvery = "5 minutes"` 간격으로 pass를 돌린다. `worker.ts`에는 `progressEveryMs` 상수가 있다.
- Crypto: `BulkNodes`가 node id를 `Crypto.randomUUIDv4`로 만든다.
- 환경/홈: `Importer.layer`는 home을 주지 않으면 `homeDirectory`를 쓰고, worker 시작 인자로 `storageRoot`와 `home`을 넘긴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
