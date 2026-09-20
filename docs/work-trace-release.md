# Work Trace release and rollback runbook

Work Trace migrations and runtime instrumentation are always additive and always on. The release
switch controls only user-facing API/UI exposure. This keeps shadow data available while a rollout
is paused and makes rollback non-destructive.

## Release gate

`workTraceEnabled` is an optional boolean in `<storage>/config.json`:

- absent or `true`: Work Trace session/project tree, detail, stream, resume, and archive APIs are
  exposed;
- `false`: those APIs return `404 { "error": "work_trace_disabled" }`;
- Task/Attempt/Event/Evidence/Decision/Memory writes and schema migrations continue in shadow mode.

The server reads the flag for every request, so canary enable/disable does not require a restart.
Never roll back by dropping Work Trace tables. Disable exposure first, retain the additive data, and
fix forward.

## Preflight, backup, and restore

1. Stop the app, or use SQLite's online backup API. Do not copy only `agent.db` while a WAL writer is
   active.
2. Back up `<storage>/agent.db` (and `agent.db-wal`/`agent.db-shm` if using a file copy while stopped).
3. Record `PRAGMA user_version`, `PRAGMA integrity_check`, row counts for `work_tasks`,
   `agent_run_attempts`, `run_events`, `evidence_refs`, `knowledge_decisions`, and
   `memory_candidates`.
4. Start the new build with `workTraceEnabled: false`. Verify migration completion,
   `PRAGMA foreign_key_check` returning no rows, and shadow Task/Event growth.
5. Restore rehearsal: stop the app, move the migrated files aside, restore the backup set, start the
   prior build, and verify session/transcript/subagent reads. Then return to the migrated copy.

A migration failure rolls back its own `BEGIN IMMEDIATE` transaction and does not advance
`user_version`. A binary rollback is safe only to a build whose migration count is at least the
stored `user_version`; otherwise the database intentionally refuses to open. In that case restore
the preflight backup or deploy a forward-fix build.

## Staged rollout

1. **Shadow:** deploy with exposure false; compare Task and terminal-event counts with subagent runs.
2. **Canary:** enable one local installation/project cohort; exercise parallel runs, approvals,
   reconnect, restart recovery, safe resume, archive, adoption, and memory promotion/reuse.
3. **General:** enable by default after the verification matrix and limits below pass.
4. **Rollback:** set exposure false. Keep collecting shadow records; do not delete or rewrite adopted
   provenance. Re-enable after a fixed build passes the same matrix.

## Verification matrix

| Contract                                                               | Automated evidence                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| parallel child identity/order, approval, cancellation                  | `tests/subagents.test.ts`, `tests/approval.test.ts`                                        |
| reconnect/restart and exactly-once parent notification                 | `tests/runs.test.ts`, `tests/work-trace-stream.test.ts`, `tests/work-trace-resume.test.ts` |
| legacy migration, nullable origin, redaction/tombstone                 | `tests/work-trace-migrations.test.ts`, `tests/work-trace-evidence.test.ts`                 |
| adoption and final-answer provenance                                   | `tests/work-trace-evidence.test.ts`                                                        |
| user-governed Decision/Memory, deletion survival, retrieval versus use | `tests/knowledge-promotions.test.ts`                                                       |
| exposure off/on without shadow-data loss                               | `tests/agent-chat.test.ts`                                                                 |
| indexed large-tree/replay budget                                       | `tests/work-trace-release.test.ts`                                                         |

Release verification commands:

```sh
pnpm exec vp check
pnpm typecheck
pnpm --filter memory-agent exec vp test
pnpm build
```

## Capacity criteria

The release test creates 1,000 live Tasks and 2,000 events, verifies SQLite selects
`work_tasks_project` and `run_events_origin_cursor`, and requires a warm project-tree projection plus
a bounded 500-event replay page to complete in under 1,000 ms on the test host. Replay must remain
page-bounded and cursor-resumable; the UI must not request the full event history in one response.

Before general rollout, record the observed duration and database size on the target machine. Pause
rollout if the budget fails, `foreign_key_check` reports rows, SSE reconnect gaps appear, duplicate
active attempts occur, or recovery/purge jobs remain stuck.

## Compatibility and backfill

- Existing Work Trace rows migrate in-place; origin session references become nullable while
  project-owned provenance remains.
- Historical reports are **not** automatically promoted into Decision/Memory. Promotion remains an
  explicit user-authorized action over an adopted claim and verified Evidence.
- Turning exposure off never backfills, purges, or rewrites records.
- Destructive privacy purge and retention policy are handled by the archive/delete lifecycle, not by
  the release switch.

## Archive/delete lifecycle and privacy boundary

Archive, restore, and delete are durable idempotent operations. `lifecycle_operations` records the
intent and state (`cancelling` → `waiting_for_stop` → `purging` → `completed`); startup recovery
replays unfinished operations after interrupted runs have been reconciled. A second active operation
for the same target is rejected, while retrying the same idempotency key returns the original result.

For a running Task or conversation, the parent run is cancelled first, each child is stopped through
`SubagentManager.stopTask`, and the normal cancellation path writes a checkpoint and terminal event.
No resume or steer is accepted after delete has been requested. Archive keeps all content and is
reversible. Delete is not reversible:

- Task deletion removes checkpoints and activity payloads, tombstones Evidence/Artifact locators,
  clears request/title/agent linkage, and retains a payload-free Task/Attempt identity.
- Conversation deletion first applies Task deletion to every child, then removes transcript nodes,
  queues, approvals, workflow state, chat state, subagent rows, FTS entries, and unreferenced image
  blobs. Project-owned Task tombstones, final-answer claims, adopted Decision/Memory, usage lineage,
  lifecycle operations, and count-only purge receipts remain.
- Nullable `origin_session_id` fields become `NULL`, so retained provenance explicitly says that its
  source conversation was deleted rather than pointing at a missing row.
- Parent notifications use stable operation-derived idempotency keys and distinguish `archived` from
  `deleted`.

`purge_receipts` intentionally stores only aggregate counts, retained record categories, policy
version, and completion time. It must never contain transcript text, report bodies, locators, tool
inputs/results, file paths, or secrets.

Operational checks:

```sql
SELECT status, count(*) FROM lifecycle_operations GROUP BY status;
SELECT target_kind, count(*) FROM purge_receipts GROUP BY target_kind;
SELECT id, target_kind, target_id, blocker, updated_at
FROM lifecycle_operations
WHERE status IN ('cancelling', 'waiting_for_stop', 'purging', 'blocked', 'failed')
ORDER BY updated_at;
PRAGMA foreign_key_check;
```

Pause lifecycle rollout if an operation remains `cancelling`, `waiting_for_stop`, or `purging` after
a restart and no run is alive, if any completed delete lacks a receipt, or if deleted source text is
still found in nodes, chat state, FTS, Evidence/Artifact locators, or attachment storage. Roll back UI
exposure with `workTraceEnabled: false`; never down-migrate or recreate purged private content.
