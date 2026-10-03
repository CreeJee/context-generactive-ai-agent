# Diff cleanup and test reduction (2026-10-03)

The user requested reduction of tests throughout the remaining Git diff, removal of experimental mock/probe scripts, and then one commit. Review includes changed tracked files and untracked files. Passing tests alone do not make every test necessary; dispositions below are based on actual assertions, consumers and replacement coverage.

## Actual removals and substitutions

- Deleted model-only IPC `agent-chat-worker-model.test.ts` and its exclusive `fixtures/goal-model-worker.ts`. Retained actual full-SDK worker failure, bound run persistence/reopen and owner-process recovery tests.
- Reduced `full-loop-admission-preflight.test.ts` from eight cases to one and removed the unused historical `validateFullLoopAdmission`/classification helpers. Production still imports `assertFullLoopPortable`; getter/function/cycle rejection remains.
- Removed `native-artifact-source-lifetime.test.ts`. `native-artifact-cold-execution.test.ts` performs the same recording A/B/A source edit/deletion exercise in a fresh Node process and independently reads persisted SQLite after child exit.
- Consolidated consumer-return/listener cleanup into the successful termination branch of `full-loop-execution.test.ts`. All three listener-count assertions remain, as does rejected termination retaining the lease.
- Replaced a synthetic three-table history migration test with additional exact legacy revision/provenance/reopen assertions in the actual `0.0.13` released-schema upgrade test.
- Deleted unused `makeOwnerRpcOperationIds` and its allocator-only unit case. Actual worker allocation, transport correlation and durable receipt tests remain.
- Deleted the unconnected proposed `server/dev-reload.ts` gate and its four self-tests. The real Vite pending-hook invalidation test now waits on a minimal local promise rather than claiming a toy gate provides turn/OAuth safety. All four actual Vite/watch/lazy-import hazards remain tested.
- Consolidated app report identifier checks, duplicate clipboard-denial and repeated parsing/name assertions. Kept HTTP 404 plus fail-before-evidence access, selectable fallback and actual parsing/accessibility coverage.
- Removed unused Accordion component, webhook-only `.env.example`, app-only `reportBinding` reader and unused returned OAuth `selectedId` member. Kept actual report session transaction and independently read its persisted binding in its test. The production source/project-validated report binding reader in memory-agent remains.
- Removed diagnostic logging and tautological results bookkeeping from two native tests; exact permission refusal and execution authorization assertions remain.

### Experimental scripts/workspace

Removed `tools/harness-spike` files and its sole `tools/*` workspace entry, dedicated SDK release-age exceptions and exclusive importer/dependency closure. Offline `vp install --lockfile-only --ignore-scripts --offline` previously updated only the lockfile. The app/library monorepo remains; a one-off adapter experiment does not require a permanent package.

After the user clarified “prove” as experimental mock/probe scripts, removed `scripts/probe-goal-runtime.ts` and `eval/{embed,kiwi}-worker-probe.ts`, plus two helpers and four dependent worker-only benchmark scenarios from `eval/memory.ts`. Its direct real-model profiling scenarios remain. Historical SEA observations remain records of earlier runs, not currently executable checks. Production embedding/Kiwi workers, actual test children, captures, registered artifacts and execution evidence are not deleted by filename.

## Complete changed-test dispositions

Full assertion bodies of new tests and actual diffs of tracked tests were reviewed in disjoint native, SDK-worker/RPC, workflow/OAuth and app areas. This closes the first pass's explicitly incomplete 53-new-test inventory. The table includes files removed during this review; unchanged test files are outside the requested diff.

Memory-agent names below are relative to `packages/memory-agent/tests/`, except the explicitly identified source-adjacent stream test.

| Test                                   | Disposition         | Unique risk / precise substitute                                                            |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| native-artifact-build                  | REDUCE              | Host dependency allowlist, eager acquisition, factory binding; removed logging              |
| native-artifact-capability-lifetime    | REDUCE              | Exact permission refusal and session authorization; removed redundant counter               |
| native-artifact-cold-execution         | KEEP                | Fresh process executes A/B/A after source deletion; independent durable DB read             |
| native-artifact-cold-reopen            | KEEP                | Second process preserves old run/thread evidence and starts explicit fresh turn             |
| native-artifact-loader                 | KEEP                | Untrusted/corrupt/noncanonical evaluation and stage integrity                               |
| native-artifact-memory-lifetime        | KEEP                | Bundled memory implementation and populated state isolation                                 |
| native-artifact-source-lifetime        | DELETE              | Stronger cold-execution A/B/A replacement                                                   |
| goal-native-capabilities               | KEEP                | Deferred attribution, central authorization and no raw-handle/factory bypass                |
| goal-native-implementation             | KEEP                | Goal identity, fresh client release and owner-reference retention                           |
| goal-worker-assets                     | KEEP                | Source/SDK pin, leases, capture race, adoption integrity and path validation                |
| goal-worker-generation-store           | KEEP                | Immutable provenance/reopen; no invented historical execution pin                           |
| agent-chat-native-factory              | KEEP                | Model release, successful persistence and missing-vs-failed registry behavior               |
| agent-chat-native-generation-isolation | KEEP                | Simultaneous changed-source Goals and V1 restart cannot adopt V2                            |
| agent-chat-native-registration         | KEEP                | Actual default entry registration/linkage/revalidation                                      |
| owner-native-artifacts                 | KEEP                | Registration races, tampering, interruption and uncertain-commit lease safety               |
| memory-tool-factory                    | KEEP                | Owner injection, deferred node getter and populated usage-state isolation                   |
| permission-gate-factory                | KEEP                | Session Context and exact tool/name/argument approval binding                               |
| recording-factory                      | KEEP                | Concurrent attribution, secret redaction and retained owner                                 |
| subscription-runtime-factory           | KEEP                | Account pin, abort, fresh adapter/client and release                                        |
| subscription-runtime-dependencies      | KEEP                | Real account dependency, catalog invalidation and lease release                             |
| agent-chat-goal-boundary               | KEEP                | Legacy live admission, session boundaries and durable node/replay behavior                  |
| agent-chat-goal-run-binding            | KEEP                | Finalizer failures, invalid admission and persisted SDK cursors                             |
| agent-chat-owner-process-recovery      | KEEP                | Actual OS SIGKILL partial recovery and completed SIGTERM replay                             |
| agent-chat-worker-cancellation         | KEEP                | Pending model pull, failed terminal and uncertain receipts after reopen                     |
| agent-chat-worker-failure              | KEEP                | Failure before vs after committed tool effect                                               |
| agent-chat-worker-inventory-preflight  | KEEP                | Invalid inventories rejected before creating execution evidence                             |
| agent-chat-worker-oauth-owner          | KEEP                | Worker death cannot transfer/cancel central OAuth/PKCE owner                                |
| agent-chat-worker-owner-services       | KEEP                | Single central DB/embedder and persistent vector reuse                                      |
| agent-chat-worker-rollback             | KEEP                | Byte-equivalent history and no uncertainty bypass with worker opt-out                       |
| agent-chat-worker-source-generation    | KEEP                | Pin across revision/reopen; absent vs tampered source rejection                             |
| agent-chat-worker-uncertain-admission  | KEEP                | Completed run cannot hide pending effect; valid control still admitted                      |
| chat-execution                         | KEEP                | Untyped turn cannot override capabilities; actual in-process SDK and cancel                 |
| full-loop-admission-preflight          | REDUCE (first pass) | Retained portable transport boundary; removed uncalled historical validator                 |
| full-loop-capabilities                 | KEEP                | Codec tags, owner identity, hooks/cleanup and continuation rejection                        |
| full-loop-execution                    | REDUCE              | Duplicate consumer return merged; listener, lease and hostile worker checks retained        |
| full-loop-resources                    | KEEP                | Second native port closes even when first close throws                                      |
| full-loop-worker-events                | KEEP                | Queue/listener disposal, abort/pending pull and malformed envelopes                         |
| goal-worker-authority                  | KEEP                | Immutable capability, revocation, finalization-only and persistent generation fence         |
| owner-rpc-ledger                       | KEEP                | Standalone durability, pending/uncertain reopen, cross-run and forged-key fences            |
| owner-rpc-transport                    | KEEP                | Real MessagePort cleanup, secrecy/correlation, interruption and late settlement             |
| owner-rpc                              | REDUCE              | Removed unused allocator; retained typed native core and protocol trust checks              |
| owner-tool-grants                      | KEEP                | Tampering and one-use grants rejected before false uncertain reservation                    |
| database                               | REDUCE              | Synthetic history merged into real release-prefix upgrade; FK/transaction rollback retained |
| goal-history-migration                 | KEEP                | FK retarget, old reader/reopen and corrupt-reference rollback                               |
| workflow-completion-evidence           | KEEP                | Criterion/node ownership, stale mapping and immutable completion/reopen                     |
| workflow-execution                     | KEEP                | Distinct live read/write/refusal/failure progress paths                                     |
| workflow-explicit-goal-transition      | KEEP                | Phase authorization, uncertain effects and compatible rollback                              |
| workflow-instructions                  | KEEP                | Independent planning, nonblocking questions and cross-turn rules                            |
| workflow-run-bindings                  | KEEP                | Immutable tuple, stale revision, uncertainty and cross-session rejection                    |
| workflow-run-events                    | KEEP                | Receipt content-conflict/idempotency, distinct from stream cursor replay                    |
| workflow-tool-progress                 | KEEP                | No-op/refusal/failure and normalized fingerprint                                            |
| workflow                               | KEEP                | Full evidence revisions, method-only identity and atomic rollback                           |
| oauth-account-bound                    | KEEP                | Selection pin, caching, catalog, removal and admission races                                |
| oauth-account-login                    | KEEP                | Actual callback exchange, isolated publication and pending cancellation                     |
| oauth-accounts                         | KEEP                | Secret isolation, legacy import, scoped selection and conflicting slots                     |
| oauth-validation-harness               | KEEP                | Timeout/cancel before write vs during write are different races                             |
| report-evidence-tools                  | KEEP                | Bounded bound inventory, foreign refs, revocation and redaction                             |
| agent-chat                             | KEEP                | Actual completion/early model mismatch resource release                                     |
| external-agents                        | KEEP                | Maintained TS subprocess fixture, not a throwaway mock                                      |
| mcp                                    | KEEP                | Actual trust/approval and process lifecycle with TS fixture                                 |
| shell                                  | KEEP                | Detached-child held-stdio cleanup, needs its fixture                                        |
| src/workflow/durable-stream.test.ts    | KEEP                | Atomic append/cursor namespace/snapshots; HTTP resume keeps producerCalls at one            |

App names are relative to `apps/agent/`.

| Test                                     | Disposition         | Unique risk / precise substitute                                                |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| app/.server/report-evidence              | REDUCE (first pass) | Combined HTTP missing/mismatch validation before trace access                   |
| app/.server/report-sessions              | REDUCE              | Unused reader removed; actual transaction binding read independently            |
| app/entry/navigation/account-model-panel | REDUCE (first pass) | Exact accessible name implies removed substring assertion                       |
| app/entry/report/report-draft            | REDUCE (first pass) | Evidence-free statement and clipboard fallback retained elsewhere               |
| app/entry/report/report-evidence         | KEEP                | Sensitive exclusions, selection/editing and clipboard failure/success           |
| server/dev-goal-isolation                | KEEP                | Actual dirty/untracked Git source snapshots and owner storage lock              |
| server/dev-reload                        | DELETE              | Only tested an unused proposed gate, not product ownership                      |
| server/dev-vite-lifecycle                | REDUCE              | Removed gate dependency; actual pending hotUpdate invalidation still reproduced |
| server/tests/dev-agent-chat-boundary     | KEEP                | Actual route origin/metadata/lease/run authority                                |
| server/tests/dev-hmr-api-recovery        | KEEP                | Actual two-listener proxy, contract mismatch and durable SSE reconnect          |
| app/entry/chat/slash-commands            | REDUCE (first pass) | Repeated parsing assertion retained in comprehensive command case               |
| app/entry/shared/backend-restart         | KEEP                | Header preservation, origin leakage, no retry and body preservation             |
| server/dev-safety                        | KEEP                | Fingerprint, source/build gate, OAuth/drain and owner lock                      |

## Other remaining diff: keep rationale and boundaries

- Actual UI/navigation/report/account routes remain: source/project validation, manual evidence selection/copy, separate diagnostic sessions and account operations have real consumers. Removed the unconsumed Accordion and webhook placeholder only. Reporting documentation now reflects the existing separate diagnostic session, without inventing consent or cost approval.
- Dev supervisor/build-ID proxy, storage ownership and packaging/runtime asset resolution remain; the unused reload prototype was not one of those protections. Embedding/Kiwi and MCP/ACP/repair helper `.mjs` to `.ts` conversions have actual callers and must not be mistaken for new throwaway scripts.
- DB schema additions are used durable revisions, run bindings/events, uncertain RPC effects, source generations, native registrations and account/report data. Dropping them or reverting migrations would strand evidence; release upgrade/FK/rollback checks remain.
- Central native factories, account-pinned providers, typed RPC/transport and workflow services have real entry-point consumers. Test/reference in-memory ledger and Promise adapter are kept because their consumers exercise unique trust failures; they do not demonstrate a crash-safe production ledger.
- Root/package/app/server instructions, repair skill and `.codex` MCP config are real development configuration, not deletable just because product code does not import them. Lockfile peer/runtime changes are kept with the manifest/library changes, not hand-pruned.
- Historical contract/spike/research/cleanup/session records contain distinct evidence and limitations. Deleted script names are explicitly historical rather than reproduction instructions.

This is a bounded actual diff/assertion/reference review, not a formal proof of all dynamic reachability or a guarantee that every remaining assertion can never be consolidated later. No failure expectation was weakened to get a passing suite; no owner/build-ID/uncertain-effect gate was removed. No arbitrary user database, registered Goal artifact, real credential or captured evidence was deleted.

## Fresh final verification before commit

- Repository-root `vp check`: 588 files formatted; zero lint/type warnings/errors across 533 files. Memory-agent's separate package check also passed.
- App production `vp run agent#build` passes. It reports existing large-chunk/plugin-timing notices; this is not an end-to-end SEA or cross-platform binary validation.
- Git whitespace checks pass, all 73 remaining changed/new test filenames are present in the body-review record, and removed scripts/prototypes are verified absent. Filename coverage here only checks the record's inventory completeness, not the quality of assertions.
- memory-agent entire suite: **132 files / 835 passed / 2 skipped**.
- App entire suite: **27 files / 102 passed**; package TypeScript passes.
- Parent separately verifies Vite lifecycle/report sessions: **2 files / 6 tests pass** after removing the proposed gate.
- The initial cleanup checkpoint was 848 memory-agent and 108 app passing tests. The cumulative reduction is **19 cases** (13 memory-agent, 6 app), not merely a renamed or skipped set of tests.
- No new tooling, live-provider login or generated standalone probe was run for this final pass. Earlier SEA/model-performance observations are not revalidated here.
