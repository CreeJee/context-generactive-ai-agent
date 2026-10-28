# code

## Overview

`packages/memory-agent/src/code`는 모델이 쓴 TypeScript 프로그램을 QuickJS(WASM) 안에서 실행하는 코드 샌드박스다. 프로그램마다 worker thread를 새로 띄운다. 호스트 쪽 `sandbox.ts`의 `CodeSandbox` 서비스가 worker를 띄우고, Effect RPC(`protocol.ts`의 `CodeRpcs`)로 프로그램을 보낸다. 프로그램의 `external_<name>` 호출은 스트림 이벤트로 들어온다. 호스트는 이를 `ProgramFunction`으로 처리하고 `Reply`로 결과를 돌려준다. `worker.ts`는 worker 진입 모듈이다. sucrase로 TS를 변환하고 QuickJS에서 실행한 뒤 결과를 `Outcome`(Returned/Threw/TimedOut)으로 돌려준다. 프로그램은 `console`과 주어진 함수 말고는 파일·네트워크·프로세스·타이머에 닿지 못한다.

## Interface

- `CodeSandbox` — `Context.Service` (키 `memory-agent/code/sandbox/CodeSandbox`). 멤버는 `run` 하나다. `CodeSandbox.layer`는 `Layer.succeed`로 만든다.
- `CodeSandbox.run(program: { code, input: JsonValue }, functions: Record<string, ProgramFunction>, timeout: Duration)` — worker 하나를 띄워 프로그램을 실행한다. 결과는 `Outcome`, 실패는 `CodeSandboxFailed`다. `Effect.scoped`라서 끝나면 worker를 정리한다.
- `ProgramFunction` — `(args: JsonValue) => Effect<unknown, ProgramCallFailed>`. 프로그램이 `external_<name>`으로 부르는 호스트 함수 타입이다.
- `ProgramCallFailed` — `Schema.TaggedError { message }`. 프로그램 안에서 이 message를 가진 에러로 throw된다.
- `CodeSandboxFailed` — `Schema.TaggedError { reason: "start" | "engine" | "lost" }`. 각각 worker 시작 실패, QuickJS 로드 실패, 실행 중 worker 유실이다.
- `ProgramOutcome` — `protocol.ts`의 `Outcome`을 `sandbox.ts`가 이 이름으로 다시 내보낸다.
- `Program` (`protocol.ts`) — `{ code, input: JsonValue, functions: string[], timeoutMs }` 스키마다. code는 async 함수 본문이다.
- `CallReply` (`protocol.ts`) — 호출 결과 `TaggedUnion`. `Returned { value?: JSON 텍스트 }` 또는 `Failed { message }`다.
- `Outcome` (`protocol.ts`) — 프로그램 종료 상태 `TaggedUnion`이다. `Returned { value?, logs, dropped }`, `Threw { name, message, line?, logs, dropped }`, `TimedOut { logs, dropped }` 셋이다.
- `RunEvent` (`protocol.ts`) — `Run` 스트림 이벤트다. `Call { id, name, args }`가 여러 번 온 뒤 `Finished { outcome }`가 한 번 온다.
- `CodeEngineFailed` (`protocol.ts`) — worker가 QuickJS 엔진을 못 불러왔을 때의 `TaggedError`다. 원인은 worker 로그에만 남는다.
- `Run` / `Reply` / `CodeRpcs` (`protocol.ts`) — `Rpc.make`와 `RpcGroup`이다. `Run`은 `stream: true`로 `RunEvent`를 흘리고, `Reply`는 `{ id, reply: CallReply }`로 호출 하나에 답한다.
- `worker.ts` — export가 없는 worker thread 진입 모듈이다. `runtimeWorker("code-worker")`로 실행된다. 내부의 `handlers`(`CodeRpcs.toLayer`), `protocol`, `server`를 모듈 최상위에서 `runNativeEffect`로 실행한다.
- 하위 디렉터리 없음.

## Invariants

- worker 하나는 프로그램 하나만 실행하고 그 뒤 정지된다. 그래서 한 프로그램이 남긴 것이 다음 프로그램에 닿지 않는다.
- `worker.ts`는 QuickJS runtime·context·handle을 해제하지 않는다. 호출이 기다리는 중에 runtime을 해제하면 엔진이 abort되기 때문이다. 해제는 worker 정지에 맡긴다.
- 프로그램 코드는 `async function __program() {` 바로 아래 줄부터 들어간다. 그래서 스크립트 줄 번호는 코드 줄 번호 + 1이다. `syntaxOutcome`과 `lineOf`가 1을 빼서 보정하므로, 래퍼 구조를 바꾸면 이 보정도 함께 고쳐야 한다.
- `input`은 JSON 텍스트를 문자열 리터럴로 넣고 `JSON.parse`한다. 객체 리터럴로 넣으면 `__proto__` 키가 prototype을 바꾼다.
- 호출 인자와 결과는 양방향 모두 JSON 텍스트로 경계를 넘는다. 인자가 `undefined`면 `{}`로 보낸다. 결과를 JSON으로 표현할 수 없으면 `value` 없는 `Returned`가 된다.
- `ProgramFunction`이 받는 인자는 프로그램이 넘긴 값이다. 그래서 모델 입력과 같은 방식으로 decode해야 한다. 인자가 JSON이 아니면 `Failed` 응답을 준다. 등록되지 않은 이름에는 `external_<name> is not available here.`로 답한다.
- RPC 클라이언트 프로토콜은 `size: 1`, `concurrency: callConcurrency + 1`(8 + 1)이다. `Run` 스트림 하나와 `Reply` 슬롯 8개를 위한 값이다.
- `Run` 스트림의 `Call` 처리는 `concurrency: 8, unordered: true`로 돈다. 첫 `Finished`에서 스트림이 끝나고, 대기 중인 호출도 함께 중단된다. `Finished` 없이 스트림이 끝나면 `CodeSandboxFailed(lost)`다.
- 타임아웃은 두 겹이다. worker가 `shouldInterruptAfterDeadline`으로 먼저 `TimedOut`을 보고한다. 호스트는 `timeout + 2s`(`reportGrace`)가 지나면 빈 로그로 `TimedOut`을 만든다.
- 프로그램이 끝난 뒤(`ended` Ref가 true)에 도착한 호출 응답은 settle·pump하지 않는다.
- 실행 제한: 힙 128MiB, QuickJS 스택 256KiB(더 크면 thread 스택이 먼저 넘친다), 콘솔 로그 200줄·16,000자(초과분은 `dropped`로 셈), 반환 JSON 64,000자(초과하면 `RangeError` Threw).
- `worker.ts`는 `@effect/platform-node/NodeWorkerRunner` 모듈을 직접 import한다. 패키지 index는 모든 Node 서비스를 불러와 시작이 느려진다. checkout에서는 TS 그대로 실행하고, 실행 파일에서는 `scripts/package.ts`로 번들한다.
- QuickJS 엔진 모듈은 `Effect.cached`로 worker당 한 번만 불러온다.

## Side Effects

- `node:worker_threads` `Worker`를 프로그램마다 새로 띄운다. 파일은 `runtimeWorker("code-worker")`, 옵션은 `runtimeWorkerOptions({})`이고, scope가 끝나면 정리된다.
- worker 안에서 QuickJS WASM 모듈(`@jitl/quickjs-singlefile-mjs-release-sync`)을 불러온다. 실패하면 `Effect.logError("Code engine failed to load")`로 로그를 남긴다.
- `worker.ts` 모듈 최상위에서 `runNativeEffect`로 RPC 서버 레이어를 실행한다. 모듈을 불러오는 것만으로 서버가 기동한다.
- `Clock.currentTimeMillis`로 deadline을 계산해 QuickJS interrupt handler에 건다.
- worker 내부 상태를 바꾼다: `Ref`(`waiting` HashMap의 Deferred, `nextCall` 카운터, `ended`)와 `Queue`(RunEvent).
- 호스트 쪽에서 프로그램 호출마다 호출자가 넘긴 `ProgramFunction` Effect를 실행한다. 이 Effect는 임의의 외부 효과를 낼 수 있다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
