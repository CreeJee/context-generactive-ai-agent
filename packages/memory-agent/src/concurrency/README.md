# concurrency

## Overview

`concurrency` 디렉터리는 memory-agent 안에서 리소스 id(세션 id 등) 단위로 작업을 직렬화하는 작은 동시성 유틸리티를 둔다. `keyed-limit.ts` 하나만 있으며, `p-limit(1)`을 키별로 쓰는 것과 같은 동작을 Effect의 `RcMap`과 `Semaphore`로 구현한다. 같은 키의 호출은 FIFO 순서로 하나씩 실행되고, 다른 키의 호출은 서로 막지 않는다.

## Interface

- `keyedSerialLimit` — `Effect.fnUntraced`로 만든 생성 함수다. 실행하면 `RcMap`을 만들고 `<A, E, R>(key: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>` 형태의 직렬화 함수를 돌려준다. 이 함수는 같은 key의 work를 permit 1개짜리 `Semaphore` 아래에서 실행한다.

## Invariants

- 같은 key의 호출은 FIFO 순서로 하나씩만 실행된다. 다른 key의 호출은 서로 독립적이다. 근거: `Semaphore.make(1)`과 `slot.withPermit(work)`.
- Semaphore permit은 성공·실패·인터럽트 어느 경우에도 Effect가 해제한다. 호출자가 permit을 직접 해제하지 않아야 한다.
- key별 slot은 작업이 실행 중이거나 permit을 기다리는 동안에만 유지된다. 호출마다 `Effect.scoped`로 `RcMap.get` 참조를 닫으므로 인터럽트 때도 참조가 풀린다. 그래서 지난 세션 id가 프로세스 수명 동안 쌓이지 않는다. 이 동작을 바꾸면 메모리가 계속 늘어날 수 있다.
- `RcMap.make`는 `Scope`가 필요하다. 따라서 `keyedSerialLimit()` 실행에는 바깥 `Scope`(예: layer 또는 `Effect.scoped`)가 있어야 한다. 반환된 함수의 slot 수명도 그 scope에 묶인다.
- 반환된 함수는 work의 `A`, `E`, `R` 타입을 바꾸지 않고 그대로 전달한다. 내부 scope는 호출 안에서 닫히므로 호출자 타입에 `Scope`가 더해지지 않는다.

## Side Effects

- 프로세스 메모리 안에 key별 `Semaphore`를 담는 `RcMap`을 만들고 바꾼다. 참조 카운트가 0이 되면 해당 항목을 없앤다.
- Semaphore permit을 얻고 놓는 in-memory 잠금을 쓴다. 같은 key의 동시 호출은 이 잠금 때문에 기다린다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
