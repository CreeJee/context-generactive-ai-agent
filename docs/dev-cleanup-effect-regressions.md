# Dev cleanup, Effect lifetime and regression review

## Scope

Plan v15 preserves Codex endpoint changes, the owner lock/build-ID gate, registered Goal artifacts and run evidence. Test count is not a success criterion. A removed test must have a concrete invalid premise or redundant self-mock assertion and named actual replacement coverage.

## C01: temporary files

Deleted only the following closed, completed logs under `/private/tmp/`, after reading each file, checking its SHA-256, searching project references and checking open handles:

| File                           | Content                           |
| ------------------------------ | --------------------------------- |
| `context-native-tests.log`     | Completed native test summary     |
| `context-worker-ts-tests.log`  | Completed worker test summary     |
| `context-dev-safety-tests.log` | Completed dev-safety test summary |
| `context-dev-check.log`        | Completed static-check summary    |
| `context-all-ts-check.log`     | Completed static-check summary    |
| `context-conversion-check.log` | Completed static-check summary    |

These six files total 2,671 bytes. Exact-name reference searches cover 661 project files with no matches or skipped files. Direct `lsof` checks find no handles. Hash-checked deletion and post-deletion absence were confirmed. No storage root, registered artifact, project code or running process was changed. Restart behavior was not retested to prove a log deletion.

At C01 completion, 41 remaining items (34 files, seven directories) were retained conservatively; three helpers among them were later removed after T01 review below: patches, helpers not proved obsolete, owner/RPC/agent/OAuth investigation captures, failed or unclassified logs, build/dev logs and baseline/maintenance directories. The read `context-owned-tsc-final.log` contains a TS1005 failure and is retained as failure evidence. Existing `.verified-native-*`, `.native-test-*` and `.native-build-*` project staging-directory search returns no entries.

## C02: native resource lifetime

Implementation is present in `owner-native-artifacts.ts` and the new private `OwnerNativeFiles`, `OwnerNativeBuilder` and shared registration-error modules. Fresh parent execution passes 4 files / 14 tests (registration, failure/interruption/conflict/commit retention, changed-source Goal isolation and native cold reopen). C02 is complete after the user-approved repair: the conflict test translates the nested acquisition error with `Effect.mapError` to the filesystem adapter's `NativeRegistrationError`, retaining its cause. The earlier TS2375/TS377003 failure is resolved without weakening the service contract or deleting the regression. Fresh native tests (4 files / 14 cases), package typecheck and changed-file lint pass. Whole-suite results are recorded below after final verification.

The misleading `load` fault is now named `integrity`: it tampers bytes and exercises **integrity rejection**, not dynamic-module evaluation failure. No claim of evaluation-failure coverage is derived from this case. Implemented guarantees:

- Filesystem/build dependencies are services; expected errors are typed.
- An unregistered generation has a Scope-owned lease before its bytes are written.
- Write, load, provenance-fence and interruption failures clean only that unregistered generation.
- The atomic registration transition retains committed bytes even if interruption or a post-commit error occurs before the caller resumes.
- Registered artifacts are never deleted by ordinary acquisition cleanup or by tampering rejection.
- Vite's finite `write:false` build and native module evaluation remain narrow Promise interoperability boundaries. Native evaluation is not cancellable and must settle before staged bytes are removed.
- Existing owner atomic historical fences, source hashes, realpath origin checks and V1/V2 semantics are unchanged.

## T01: removed, corrected and retained regressions

Removed `apps/agent/server/dev-goal-worker-contract.test.ts` (one spike case) and its sole-use `fixtures/dev-goal-worker.ts` after C02 completed and fresh actual replacement tests passed (8 memory-agent files / 48 cases and 3 app files / 8 cases). These files implement their own owner map/token/counters rather than production admission, storage, embedding or OAuth services. Their historical spike document remains evidence of the experiment, marked superseded rather than treated as current product behavior.

| Spike assertion / premise                  | Problem                                                                              | Actual replacement coverage (freshly passing)                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Wrong session/token and run capability     | Local string comparison, not HTTP/session ownership or product login                 | `dev-agent-chat-boundary`, `goal-worker-authority`, `full-loop-execution` tampered RPC assertions                      |
| Duplicate run and accepted state           | Test-local Map insertion, no durable admission                                       | `agent-chat-goal-boundary`, real dev proxy duplicate-request checks                                                    |
| Change active Goal during an accepted turn | Manual owner field replacement skips current explicit transition/quiescence contract | `workflow-explicit-goal-transition` active-run refusal, durable revision/binding preservation                          |
| Old/new late imports and per-run RPC       | Toy child source and local child/run comparison                                      | `agent-chat-worker-source-generation`, `goal-worker-assets`, real full-loop RPC authorization                          |
| Event arrays and reconnect                 | Local array pushes, no durable journal                                               | Source-generation reopen/event invariance and `dev-hmr-api-recovery` Last-Event-ID replay                              |
| One embedding engine / OAuth listener      | Counters are initialized to one and never construct either production service        | `agent-chat-worker-owner-services`, `agent-chat-worker-oauth-owner` actual worker/central service/callback/PKCE checks |
| Exactly two embedding calls                | Local increment count is not a product requirement                                   | Owner-services real embedding/vector persistence and reopen without re-embedding                                       |

Pre-deletion reference search found only the candidate test's executable fixture reference. Post-deletion references are historical/cleanup documents only. Preserve real local/page-lease authorization coverage without relabeling it as authenticated-login principal coverage.

All four actual Vite SSR lifecycle hazard reproductions are retained: real source edits/SSR reloads demonstrate mixed old/new imports and why watcher settings alone do not pin a Goal. An obsolete mitigation does not make its hazard detector useless.

## Useless probe / helper cleanup

Deleted only the following closed temporary files after reading, checking references and hashes, and parent `lsof` confirmation:

| File under `/private/tmp/`               | Removal reason                                                                                                                     | Preserved substitute / evidence                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `context-owner-rpc-trace.mjs`            | Preload subscriber to deleted `context-agent:test:owner-rpc-failure` publisher; project-wide search returns no publisher/reference | Existing `context-owner-rpc-trace.jsonl` failure capture and real RPC/worker regression tests |
| `context-owner-rpc-capture-20261002.mjs` | Same inactive diagnostics subscriber with dated capture output                                                                     | Existing dated JSONL failure evidence                                                         |
| `context-repair-pr.ts`                   | Byte-identical unused temporary copy (`cmp` exit 0), not a unique probe                                                            | `.agents/skills/repair-pr/scripts/repair-pr.ts` unchanged                                     |

These three files total 19,616 bytes. No helper was executed. This cleanup does not delete captured results, patches, directories or registered artifacts.

At this checkpoint, retained `dev-goal-isolation.test.ts` (real dirty/untracked Git and storage-lock hazard), manual SEA/evaluator probe scripts, `tools/harness-spike`, and graph maintenance replay/validation helpers (different real datasets). The user subsequently requested removal of experimental scripts: `scripts/probe-goal-runtime.ts`, `eval/{embed,kiwi}-worker-probe.ts` and `tools/harness-spike` have now been removed; the evaluator's dependent worker-only scenarios were also removed. See [diff-test reduction](diff-test-reduction.md). Historical captures and conclusions are preserved, but these deleted scripts are no longer executable checks. Already-deleted `.mjs` evaluator probes in the incoming worktree are not counted as this task's changes.

## C03: final verification (2026-10-03)

- `packages/memory-agent`: `vp test --maxWorkers=4` passes 134 files / 848 tests, with 2 skipped (850 total).
- `apps/agent`: `vp test --maxWorkers=4` passes 28 files / 108 tests; `vp exec tsc --noEmit -p tsconfig.json` passes.
- memory-agent package typecheck passes after the single narrow repair. Changed native implementation/test lint passes with zero warnings and errors (existing Effect advisory suggestions outside the changed target still appear in compiler output).
- Seven changed implementation/test/documentation files pass `vp fmt --check`; `git diff --check` passes.
- Deleted fixture has no remaining executable references; removed temporary probes/helper are absent while capture files and skill source remain.

No build or tool installation was required for this cleanup. Native resource services/Scope are the completed Effect boundary; Vite build/native module evaluation and SDK interfaces remain deliberately narrow interoperability adapters. This is not a claim that all backend code or arbitrary native evaluation can be interrupted or unloaded safely. Codex endpoint changes and owner/build-ID/uncertain-effect protections were not edited.
