import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { ModelMessage, TokenUsage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineInterruptStore,
  defineMessageStore,
  defineMetadataStore,
  defineRunStore,
  type ChatPersistence,
  type InterruptRecord,
  type RunRecord,
} from "@tanstack/ai-persistence";
import { Schema } from "effect";
import type { Json } from "../codex/app-server.ts";

const RunRow = Schema.Struct({
  run_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.Literal("running", "interrupted", "completed", "failed", "aborted"),
  started_at: Schema.Number,
  finished_at: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(Schema.String),
  sandbox_key: Schema.NullOr(Schema.String),
  detached_since: Schema.NullOr(Schema.Number),
  cancel_requested: Schema.NullOr(Schema.Literal(0, 1)),
  driver_epoch: Schema.NullOr(Schema.Number),
});
const decodeRunRow = Schema.decodeUnknownSync(RunRow);

const InterruptRow = Schema.Struct({
  interrupt_id: Schema.String,
  run_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.Literal("pending", "resolved", "cancelled"),
  requested_at: Schema.Number,
  resolved_at: Schema.NullOr(Schema.Number),
  payload: Schema.String,
  response: Schema.NullOr(Schema.String),
});
const decodeInterruptRow = Schema.decodeUnknownSync(InterruptRow);

const JsonText = Schema.Struct({ value: Schema.String });
const decodeJsonText = Schema.decodeUnknownSync(JsonText);

// Stored JSON was written by these stores from the same TanStack types, so parsing restores them.
const parseMessages = (text: string): ModelMessage[] => JSON.parse(text);
const parseUsage = (text: string): TokenUsage => JSON.parse(text);
const parsePayload = (text: string): Record<string, Json> => JSON.parse(text);
const parseValue = (text: string): Json => JSON.parse(text);

/** Optional record fields are left off, not set to undefined, when their column is NULL. */
function toRun(row: Record<string, SQLOutputValue>): RunRecord {
  const run = decodeRunRow(row);
  const record: RunRecord = {
    runId: run.run_id,
    threadId: run.thread_id,
    status: run.status,
    startedAt: run.started_at,
  };
  if (run.finished_at !== null) record.finishedAt = run.finished_at;
  if (run.error !== null) {
    record.error = { message: run.error };
    if (run.error_code !== null) record.error.code = run.error_code;
  }
  if (run.usage !== null) record.usage = parseUsage(run.usage);
  if (run.sandbox_key !== null) record.sandboxKey = run.sandbox_key;
  if (run.detached_since !== null) record.detachedSince = run.detached_since;
  if (run.cancel_requested !== null) record.cancelRequested = run.cancel_requested === 1;
  if (run.driver_epoch !== null) record.driverEpoch = run.driver_epoch;
  return record;
}

function toInterrupt(row: Record<string, SQLOutputValue>): InterruptRecord {
  const interrupt = decodeInterruptRow(row);
  const record: InterruptRecord = {
    interruptId: interrupt.interrupt_id,
    runId: interrupt.run_id,
    threadId: interrupt.thread_id,
    status: interrupt.status,
    requestedAt: interrupt.requested_at,
    payload: parsePayload(interrupt.payload),
  };
  if (interrupt.resolved_at !== null) record.resolvedAt = interrupt.resolved_at;
  if (interrupt.response !== null) record.response = parseValue(interrupt.response);
  return record;
}

/**
 * TanStack AI chat persistence on the app's SQLite database: the four state stores with the
 * contract's invariants (full-replace threads, insert-if-absent runs and interrupts, NULL clears
 * for durable-run fields, ordered listings).
 *
 * `fallbackThread` supplies a transcript for a thread that has never been saved, so sessions
 * recorded before chat persistence existed still open with their history.
 */
export function sqliteChatPersistence(
  sqlite: DatabaseSync,
  fallbackThread: (threadId: string) => ModelMessage[],
): ChatPersistence {
  const selectThread = sqlite.prepare(
    "SELECT messages AS value FROM chat_threads WHERE thread_id = ?",
  );
  const upsertThread = sqlite.prepare(
    "INSERT INTO chat_threads VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at",
  );

  const messages = defineMessageStore({
    async loadThread(threadId) {
      const row = selectThread.get(threadId);
      return row ? parseMessages(decodeJsonText(row).value) : fallbackThread(threadId);
    },
    async saveThread(threadId, next) {
      upsertThread.run(threadId, JSON.stringify(next), Date.now());
    },
  });

  const selectRun = sqlite.prepare("SELECT * FROM chat_runs WHERE run_id = ?");
  const insertRun = sqlite.prepare(
    "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING",
  );
  const getRun = (runId: string) => {
    const row = selectRun.get(runId);
    return row ? toRun(row) : null;
  };

  const runs = defineRunStore({
    async createOrResume({ runId, threadId, startedAt, status }) {
      insertRun.run(runId, threadId, status ?? "running", startedAt);
      const stored = getRun(runId);
      if (!stored) throw new Error(`Run ${runId} was not stored.`);
      return stored;
    },
    async update(runId, patch) {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const set = (column: string, value: string | number | null) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.status !== undefined) set("status", patch.status);
      if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
      if (patch.error !== undefined) {
        set("error", patch.error.message);
        set("error_code", patch.error.code ?? null);
      }
      if (patch.usage !== undefined) set("usage", JSON.stringify(patch.usage));
      // Durable-run fields: an explicit `undefined` clears the column, an absent key leaves it.
      if ("sandboxKey" in patch) set("sandbox_key", patch.sandboxKey ?? null);
      if ("detachedSince" in patch) set("detached_since", patch.detachedSince ?? null);
      if ("cancelRequested" in patch)
        set(
          "cancel_requested",
          patch.cancelRequested === undefined ? null : patch.cancelRequested ? 1 : 0,
        );
      if ("driverEpoch" in patch) set("driver_epoch", patch.driverEpoch ?? null);
      if (assignments.length === 0) return;
      sqlite
        .prepare(`UPDATE chat_runs SET ${assignments.join(", ")} WHERE run_id = ?`)
        .run(...values, runId);
    },
    async get(runId) {
      return getRun(runId);
    },
    async findActiveRun(threadId) {
      const row = sqlite
        .prepare(
          "SELECT * FROM chat_runs WHERE thread_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
        )
        .get(threadId);
      return row ? toRun(row) : null;
    },
    async listByThread(threadId) {
      return sqlite
        .prepare("SELECT * FROM chat_runs WHERE thread_id = ? ORDER BY started_at, run_id")
        .all(threadId)
        .map(toRun);
    },
    async listReclaimable({ now, ttlMs }) {
      return sqlite
        .prepare(
          "SELECT * FROM chat_runs WHERE status = 'running' AND detached_since IS NOT NULL AND detached_since <= ?",
        )
        .all(now - ttlMs)
        .map(toRun);
    },
  });

  const insertInterrupt = sqlite.prepare(
    "INSERT INTO chat_interrupts (interrupt_id, run_id, thread_id, status, requested_at, payload) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(interrupt_id) DO NOTHING",
  );
  const resolveInterrupt = sqlite.prepare(
    "UPDATE chat_interrupts SET status = 'resolved', resolved_at = ?, response = ? WHERE interrupt_id = ?",
  );
  const cancelInterrupt = sqlite.prepare(
    "UPDATE chat_interrupts SET status = 'cancelled', resolved_at = ? WHERE interrupt_id = ?",
  );
  const selectInterrupt = sqlite.prepare("SELECT * FROM chat_interrupts WHERE interrupt_id = ?");
  const listed = (where: string, value: string) =>
    sqlite
      .prepare(`SELECT * FROM chat_interrupts WHERE ${where} ORDER BY requested_at, seq`)
      .all(value)
      .map(toInterrupt);

  const interrupts = defineInterruptStore({
    async create(record) {
      insertInterrupt.run(
        record.interruptId,
        record.runId,
        record.threadId,
        record.requestedAt,
        JSON.stringify(record.payload),
      );
    },
    async resolve(interruptId, response) {
      // `undefined` has no JSON form: the column stays NULL, which reads back as "no response".
      resolveInterrupt.run(
        Date.now(),
        response === undefined ? null : JSON.stringify(response),
        interruptId,
      );
    },
    async cancel(interruptId) {
      cancelInterrupt.run(Date.now(), interruptId);
    },
    async commitBatch(entries) {
      const ids = new Set<string>();
      for (const entry of entries) {
        if (ids.has(entry.interruptId))
          throw new Error(`Interrupt batch contains duplicate id: ${entry.interruptId}.`);
        ids.add(entry.interruptId);
        const row = selectInterrupt.get(entry.interruptId);
        if (!row) throw new Error(`Interrupt batch references missing id: ${entry.interruptId}.`);
        if (toInterrupt(row).status !== "pending")
          throw new Error(`Interrupt batch references non-pending id: ${entry.interruptId}.`);
      }
      const resolvedAt = Date.now();
      sqlite.exec("SAVEPOINT chat_interrupt_batch");
      try {
        for (const entry of entries) {
          switch (entry.status) {
            case "resolved":
              resolveInterrupt.run(
                resolvedAt,
                entry.response === undefined ? null : JSON.stringify(entry.response),
                entry.interruptId,
              );
              break;
            case "cancelled":
              cancelInterrupt.run(resolvedAt, entry.interruptId);
              break;
          }
        }
        sqlite.exec("RELEASE chat_interrupt_batch");
      } catch (error) {
        sqlite.exec("ROLLBACK TO chat_interrupt_batch");
        sqlite.exec("RELEASE chat_interrupt_batch");
        throw error;
      }
    },
    async get(interruptId) {
      const row = selectInterrupt.get(interruptId);
      return row ? toInterrupt(row) : null;
    },
    async list(threadId) {
      return listed("thread_id = ?", threadId);
    },
    async listPending(threadId) {
      return listed("thread_id = ? AND status = 'pending'", threadId);
    },
    async listByRun(runId) {
      return listed("run_id = ?", runId);
    },
    async listPendingByRun(runId) {
      return listed("run_id = ? AND status = 'pending'", runId);
    },
  });

  const selectMetadata = sqlite.prepare(
    "SELECT value FROM chat_metadata WHERE namespace = ? AND key = ?",
  );
  const metadata = defineMetadataStore({
    async get(namespace, key) {
      const row = selectMetadata.get(namespace, key);
      return row ? parseValue(decodeJsonText(row).value) : null;
    },
    async set(namespace, key, value) {
      if (value === null || value === undefined)
        throw new TypeError("Metadata values must not be null or undefined.");
      sqlite
        .prepare(
          "INSERT INTO chat_metadata VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value",
        )
        .run(namespace, key, JSON.stringify(value));
    },
    async delete(namespace, key) {
      sqlite
        .prepare("DELETE FROM chat_metadata WHERE namespace = ? AND key = ?")
        .run(namespace, key);
    },
  });

  return defineAIPersistence({ stores: { messages, runs, interrupts, metadata } });
}
