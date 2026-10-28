# sessions

## Overview

`sessions` 디렉터리는 프로젝트 안의 대화(세션) 레코드를 SQLite `sessions` 테이블에 만들고, 조회하고, 보관(archive)하는 `Sessions` Effect 서비스를 담는다. 어느 브라우저 페이지가 세션을 바꿀 수 있는지 메모리 안에서 정하는 `SessionLeases` 서비스도 함께 둔다. `lease-state.ts`는 브라우저에서도 쓰는 lease 모양 타입과 `X-Session-Holder` 헤더 이름을 두고, `title.ts`는 첫 사용자 메시지로 제목을 만든다. `Sessions`는 `Projects` 서비스와 `SqlClient`에 기대며, 라우터와 워커가 세션 생성, 가져오기(import), 소유권 검사에 쓴다.

## Interface

- `Session` — 세션 Schema.Struct(id, projectId, title, createdAt, agent, archivedAt, importedFrom, worktreePath, branch)와 같은 이름의 타입
- `SessionOrigin` — 대화가 실행된 worktreePath·branch(둘 다 nullable) 인터페이스
- `SessionNotFound` — id를 가진 Schema.TaggedError, get·setArchived가 행이 없을 때 실패로 냄
- `Sessions` — Context.Service("memory-agent/sessions/sessions"); `Sessions.layer`는 NodeCrypto.layer를 제공하고 SqlClient·Projects를 요구
- `Sessions.get(id)` — id로 세션 조회, 없으면 SessionNotFound, 제목 없으면 첫 메시지로 채움
- `Sessions.create(projectId, title?, agent?)` — 프로젝트 존재 확인(ProjectNotFound) 뒤 UUIDv4 id·현재 ISO 시각으로 INSERT
- `Sessions.createImported(projectId, title, createdAt, source, origin)` — 다른 도구 transcript에서 옮긴 대화를 원래 시작 시각과 importedFrom으로 INSERT (프로젝트 확인 없음)
- `Sessions.recordOrigin(id, origin)` — worktree_path·branch를 coalesce로 비어 있을 때만 채움
- `Sessions.list(projectId, archived = false)` — created_at DESC, id 순; archived=true면 보관된 것만
- `Sessions.setArchived(id, archived)` — archived_at을 현재 시각 또는 null로 바꾸고 세션 반환
- `SessionLeases` — Context.Service("memory-agent/sessions/leases/SessionLeases"); `SessionLeases.layer(ttlMs = defaultLeaseTtlMs)`는 주기 sweep fiber를 forkScoped로 띄움
- `makeLeases(ttlMs)` — Ref 기반 lease 저장소 생성; sweepExpired·onExpired·view·claim·release·permits 반환
- `defaultLeaseTtlMs` — 기본 lease TTL 90_000ms
- `sessionHolderHeader` — 페이지가 세션 변경 요청마다 보내는 헤더 이름 "X-Session-Holder"
- `LeaseView` — 한 페이지 기준 소유 상태 union: mine / other(since) / free
- `ClaimResult` — claim 결과 union: { claimed: true } | { claimed: false, heldSince }
- `firstMessageTitle(text)` — 공백을 접고 60자(code point)를 넘으면 잘라 "…"을 붙이며, 빈 문자열이면 "이미지 대화"

## Invariants

- 제목은 이미 redact된 저장 메시지 텍스트로만 만들고 새 모델 요청을 하지 않는다 (`title.ts` 주석).
- 제목 보정(`withTitle`)은 title이 null이고 importedFrom도 null인 세션에만 한다; 가져온 세션은 첫 메시지로 제목을 채우지 않는다.
- `createImported`는 원 도구가 시작한 createdAt을 그대로 쓴다; 목록이 created_at DESC로 정렬되므로 실제 일어난 자리에 놓이게 하기 위함이다.
- `recordOrigin`은 이미 기록된 worktree_path·branch를 덮어쓰지 않는다 (coalesce).
- `setArchived`는 메시지·메모리·검색을 건드리지 않고 archived_at만 바꾼다; 보관된 세션도 메모리의 일부로 남는다.
- `list`는 archived 여부로 서로 배타적인 집합을 돌려준다: 기본은 보관 안 된 것만, archived=true면 보관된 것만.
- `create`는 `projects.get`으로 프로젝트 등록 여부를 먼저 확인한다; `createImported`는 확인하지 않는다.
- 세션 id는 `Crypto.randomUUIDv4`로 만들고 시각은 `Clock.currentTimeMillis`에서 ISO 문자열로 만든다 (`Date.now` 직접 사용 없음).
- lease는 메모리(`Ref<HashMap>`)에만 있다; 재시작 뒤에는 세션을 연 페이지가 다음 갱신 때 다시 claim한다.
- claim은 `Ref.modify` 한 번으로 원자적으로 판정한다: 다른 holder의 live lease가 있으면 거절되어 동시에 두 페이지가 이길 수 없다.
- lease는 now - renewedAt < ttlMs일 때만 live이다; 만료 lease는 `live()` 조회 때 지워진다.
- release는 같은 holder의 lease만 지운다.
- permits는 lease가 없으면 true(holder 없는 테스트·스크립트 허용), 있으면 holder가 일치할 때만 true이다.
- sweepExpired는 만료 세션마다 등록 순서대로 listener를 차례로 실행한다.
- sweep 주기는 max(1_000, min(ttlMs, 5_000))ms이다; 읽기 전용 페이지가 빈 세션을 빨리 알게 하기 위함이다.
- `lease-state.ts`는 브라우저에서도 import하므로 Node·Effect 의존 없이 타입·상수만 둔다 ("Browser-safe shapes" 주석).

## Side Effects

- SQLite `sessions` 테이블 INSERT (create, createImported; RETURNING *)
- SQLite `sessions` 테이블 UPDATE: archived_at (setArchived), worktree_path·branch coalesce (recordOrigin)
- SQLite `sessions` SELECT (get, list) 및 `nodes` 테이블에서 kind='user' 첫 메시지 SELECT (제목 보정)
- `Projects.get` 호출로 프로젝트 조회
- NodeCrypto로 UUIDv4 난수 생성
- `Clock.currentTimeMillis`로 현재 시각 읽기
- SessionLeases: 프로세스 메모리 `Ref<HashMap>` lease 상태와 만료 listener 목록 변경
- `SessionLeases.layer`: scope에 묶인 forever 타이머 fiber(`Effect.sleep` 반복)를 forkScoped로 띄워 sweepExpired 실행, 만료 listener 호출

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
