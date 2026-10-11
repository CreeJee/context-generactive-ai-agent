# Native read-session implementation workbook

2026-10-08; implementation record for approved step 04. Inspected old behavior and actual private-boundary implementation/verification are separated below; the application path is not yet switched.

## Exact source behavior to retain

- `memory/search.ts` vector ranking selects node seqs by embedder identity, allowed projects and the meaningful-node predicate, calls the existing engine once, then maps hits back to node IDs. The new native session must keep that candidate list and ID mapping inside native execution. Map bounded hit seqs with a batch query, not a SELECT per hit.
- Meaningful means the exact existing Unicode whitespace `trim` predicate plus exclusion by `memory_graph_suppressed_nodes`. Do not replace it with ASCII trim, application-only string trim, or delete/interpret status heuristics.
- Morph terms are host-analyzed, stable deduplicated nonempty strings. Quote each term by doubling double-quotes and join with OR. Current FTS order is `f.rank`, filtered by authorized project and meaningful predicate before LIMIT.
- Text trigram ranking uses the same quoting/OR and project-before-LIMIT behavior. Every short term adds its own `textK` newest-seq-desc substring result; append only previously absent IDs. Do not cap the combined list at textK or change term iteration order.
- Current host search terms are based on JavaScript UTF-16 length. Keep host term preparation rather than substituting Rust Unicode scalar-length splitting.
- Coverage `unindexed` is global over meaningful embedded kinds (`user`, `assistant`, `topic`) missing the selected embedder vector, even for a single-project search. `uninterpreted` is allowed-project-scoped, non-done interpret jobs over meaningful nodes. Keep the asymmetry.
- RRF/list priority, graph traversal, correction/retraction/unconfirmed metadata and snippet UTF-16 policy remain host responsibilities. Step 04 returns bounded channel lists/coverage/metrics, not a reduced public MemorySearch result.

## Ownership and execution constraints

Use the existing worker's native index/CacheLease, not another persistent writer or second index. An additive read-only SQLite session belongs to that worker. Search performs one read snapshot and generation checks; write publication/caller wiring belongs to step 05. There are no operational DB/metadata writes in this layer.

Keep request project IDs and embedder identity as bound values. SQL structure is static; do not accept arbitrary SQL as transport input. Empty authorized-project lists return no channels. Batch-hit mapping remains constrained by the same snapshot and project predicate; no top-k-then-project-filter shortcut.

Pinned vector primitive policy is still measured-envelope only: <=50k index, 384 dimensions/4-bit/k<=48, remaining >=12ms. Native result discard after synchronous scoring is not mid-scan cancellation. SQLite progress checks must be implemented separately and cannot retroactively make the vector call preemptible. Default activation remains gated by later paired performance and quality evidence.

## Minimal verification to carry into implementation

Use existing fixed search/morph/embedding fixtures. Compare old/new ordered channels and coverage on a scoped temporary file/WAL DB, including short-term append/dedupe, suppression/whitespace, empty projects and equal-score engine results. Verify constant batch mapping calls and bounded transport response as candidates grow. Verify the actual SQLite build supports FTS5 trigram and matches the existing query behavior; do not add a broad unrelated SQL suite or installation checks.

## Implemented and verified — private boundary only

`read_session.rs` now provides additive `MemoryReadSession`, with pinned rusqlite 0.37.0 bundled/hooks, one read-only/query-only connection and one per-call read snapshot. It enumerates native u64 candidates, calls the unchanged pinned engine with that native list, maps bounded hits in one query, and executes FTS/morph/coverage inside the worker. The progress hook holds the cancellation root through its RAII guard and is cleared before root release/rollback. No new writer, persistent format or schema is added.

`read-protocol.ts`, OwnerSetup.databasePath and the memory-search/memory-result transport expose one typed request/response. Input is bounded before cloning; worker owns the trusted DB path and no candidate allowlist is present in the high request. Old API remains intact. The local addon was rebuilt and actual worker calls used it; the running app/default path is not switched.

Parent differential tests matched old vector IDs/scores and ordered text/morph/coverage, including short-term append beyond textK, whitespace/suppression, project-before-k, empty projects and output-budget discard. Candidate growth 2→52 held input bytes and SQL executions constant, retained two vector hits and output below 512 logical bytes. A pre-aborted shared flag returned empty cancelled channels. Native tests exercised bundled trigram/quote/Unicode and file/WAL readonly snapshots. Final seven-file TS check and four-file/seven-test suite passed; native three-test/release build passed after the parent empty-scope guard fix.

Not yet proved: public MemorySearch/provenance integration, publication/generation gate, full-sized recall and paired performance/default eligibility. Per-stage milliseconds are wall durations, not pure native CPU. Candidate transfer removal and batch-call structure do not prove CPU speedup or bounded internal FTS match work. Preserve those distinctions through steps 05–07.
