# RRSI Effect refactor

## Scope and acceptance

Refactor the complete RRSI host execution path and evaluator orchestration without
changing adoption thresholds, corpus membership, credential isolation or automatic
code adoption. Expected failures have tagged types; ordinary `throw new Error`
does not implement domain failure. Promise/callback conversion stays at actual
Node/HTTP/SDK boundaries. Pure selection calculations may remain pure functions.

The existing live evaluation owns an immutable Docker image and already-running
backend. Do not restart it while changing source. The original checkout is read
only during this work. PR #4 also contains the independently verified diagnostics
and settings loading/error fix.

## Responsibility boundaries

- `failure.ts`: typed failures and safe persisted reason mapping. Cancellation is
  a lifecycle outcome, distinct from model, protocol, database and process failure.
- `store.ts`: synchronous SQLite interoperability, typed operations and atomic
  version adoption / Goal pin / sealed-corpus receipt transitions.
- `model-gateway.ts`: Effect model requests and scoped account lease release;
  provider callbacks remain SDK interoperability only.
- `sandbox.ts`: scoped Docker process, stdin/stdout/stderr ownership, decoded
  frame stream, request correlation and usage/measurement collection. Interruption
  terminates both transport and container before finalization returns.
- `code-candidate.ts`: Effect command execution, typed edit validation, retained
  review artifacts and isolated candidate build/checks.
- `evolution.ts`: proposal, critique, evaluation, selection, validation and adoption.
  No independently owned timer, controller, task Promise or runtime invocation.
- `service.ts`: one active run, Ref state, start reservation, service-owned Fiber,
  deadline, cancellation reasons and Schedule-based activity/idle polling. A single
  run does not need a task-manager Map or FiberMap.
- `eval/rrsi-worker.ts`: Effect trial lifecycle and verification. Infrastructure
  failure must prevent incomplete measurement from being adopted. ManagedRuntime
  bridges only actual SDK/framework interfaces.

## Concurrency and evidence

Independent work is composed with bounded `Effect.all` / `forEach`. Evaluation
concurrency remains conservative for the configured local server's observed memory
limit. Shared experiment usage/history updates and adoption remain atomic; request
completion order does not identify a task. Baseline repetition and round-to-round
selection preserve their existing dependency order.

Checks cover overlapping start requests, reversed reply order, cancellation and
Scope shutdown, deadline, typed provider/process/protocol failures, safe records,
Goal pinning and adoption guard. Use gates/Deferred rather than sleeps. Run focused
checks and the real scripted Docker protocol before any new authenticated trial.

## Progress

- [x] Inventory module responsibilities and synchronous Goal-pin caller.
- [x] Move typed-error guidance into memory-agent; clarify generic Error prohibition.
- [x] Diagnose settings blank page and expose loading/query errors/retry.
- [ ] Convert model, process and store boundaries to typed Effects.
- [ ] Extract evolution and replace service task/controller/timers with scoped Fibers.
- [ ] Convert evaluator lifecycle; audit generic Error and arbitrary runtime calls.
- [ ] Verify contracts, build worker image, update PR with measured outcomes.
