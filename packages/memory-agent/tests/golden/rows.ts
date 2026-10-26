import type { ModelMessage } from "@tanstack/ai";
import { Effect, Function as EffectFunction, MutableHashMap, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  HandoffState,
  handoffHistory,
  modelHandoffNamespace,
} from "../../src/agent/model-handoff.ts";
import {
  migrateInterruptPayload,
  migrateMessage,
  migrateTanStackRows,
  migrateUsage,
} from "../../src/chat-store/tanstack-migration.ts";
import { JsonValue } from "../../src/json.ts";
import { sqlAll, withOpenSql } from "../support/sql.ts";

/**
 * The rows one conversation leaves in the database, in a form that does not depend on ids or
 * clocks. The Effect AI migration must leave the same rows behind.
 */

const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Finite);
const isBoolean = Schema.is(Schema.Boolean);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));
const decodeRow = Schema.decodeUnknownEffect(Schema.Record(Schema.String, JsonValue));

type JsonObject = { readonly [key: string]: JsonValue };
const isObject = (value: JsonValue): value is JsonObject =>
  value !== null &&
  !isString(value) &&
  !isNumber(value) &&
  !isBoolean(value) &&
  !Array.isArray(value);

/**
 * UUIDs, and ids the SDKs make from a clock and a random suffix (`run-1793001320804-04z1p2`). An id
 * made from a run id and a counter (`…-message-3`, a discovery call's `…-3`) is one id: the counter
 * is shared by every test in the file.
 */
const volatileId =
  /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+-\d{13}-[a-z0-9]+)(?:-message)?(?:-\d+)?(?![a-z0-9])/g;
const isoTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
/** Model handoff's hash of a stored message, which holds ids and times. */
const messageFingerprint = /^v2:[0-9a-f]{64}$/;
const timeKey = /(?:_at|At|^timestamp|_since)$/;

/**
 * Ids become `<kind-n>` in the order they first appear, so two runs of the same scenario compare
 * equal while rows that share an id still visibly share it.
 */
const placeholders = (fixed: ReadonlyArray<readonly [string, string]>) => {
  const seen = MutableHashMap.fromIterable(fixed);
  let count = 0;
  const of = (id: string) =>
    Option.getOrElse(MutableHashMap.get(seen, id), () => {
      const name = `<id-${++count}>`;
      MutableHashMap.set(seen, id, name);
      return name;
    });
  return (text: string) => {
    const fixedReplaced = fixed.reduce((out, [id, name]) => out.replaceAll(id, name), text);
    return fixedReplaced.replace(volatileId, of);
  };
};

/**
 * A JSON column is compared as JSON; a string inside it stays a string, so a value that changes
 * from encoded JSON to an object (tool call arguments, tool results) shows in the diff. Keys are
 * sorted, as the order a writer puts them in means nothing.
 */
const normalizeWith = (rename: (text: string) => string) => {
  const walk = (value: JsonValue, key: string | undefined): JsonValue => {
    if (isString(value))
      return isoTime.test(value)
        ? "<time>"
        : messageFingerprint.test(value)
          ? "<fingerprint>"
          : rename(value);
    if (isNumber(value)) return key !== undefined && timeKey.test(key) ? "<time>" : value;
    if (!isObject(value)) {
      if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
      return value;
    }
    // Renamed in their stored order first, so placeholders keep that order's numbers.
    return Object.fromEntries(
      Object.entries(value)
        .map(([name, item]) => [rename(name), walk(item, name)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  return walk;
};

const column = (value: JsonValue): JsonValue =>
  isString(value) && value.length > 1 && "[{".includes(value[0]!)
    ? Option.getOrElse(decodeJson(value), () => value)
    : value;

const rows = (query: string, ...params: ReadonlyArray<string>) =>
  Effect.flatMap(sqlAll(query, ...params), (found) =>
    Effect.forEach(found, (row) =>
      Effect.map(decodeRow(row), (decoded) =>
        Object.fromEntries(Object.entries(decoded).map(([key, value]) => [key, column(value)])),
      ),
    ),
  );

/** Threads of the conversation: its own and those of its named and unnamed subagents. */
const threadsOf = (sessionId: string) =>
  Effect.map(
    sqlAll(
      `SELECT thread_id FROM chat_threads
       WHERE thread_id = ? OR thread_id IN (SELECT 'subagent-' || id FROM subagents WHERE session_id = ?)
       ORDER BY thread_id = ? DESC, thread_id`,
      sessionId,
      sessionId,
      sessionId,
    ),
    (found) => found.map((row) => String(row["thread_id"])),
  );

/** Rows of `alias` in the order their runs started; run ids are random. */
const runOrder = (alias: string) =>
  `(SELECT r.rowid FROM chat_runs r WHERE r.run_id = ${alias}.run_id)`;

const inList = (count: number) =>
  `(${Array.from({ length: Math.max(count, 1) }, () => "?").join(", ")})`;

/** The conversation's rows as stored. */
const conversationRows = Effect.fnUntraced(function* (sessionId: string) {
  const threads = yield* threadsOf(sessionId);
  const ids = threads.length === 0 ? [sessionId] : threads;
  const runs = yield* rows(
    `SELECT run_id, thread_id, status, error, error_code, usage, cancel_requested
     FROM chat_runs WHERE thread_id IN ${inList(ids.length)} ORDER BY rowid`,
    ...ids,
  );
  const runIds = runs.flatMap((run) => (isString(run["run_id"]) ? [run["run_id"]] : []));
  const runList = runIds.length === 0 ? [""] : runIds;
  return {
    threads: yield* rows(
      `SELECT thread_id, messages FROM chat_threads WHERE thread_id IN ${inList(ids.length)}
       ORDER BY thread_id = ? DESC, thread_id`,
      ...ids,
      sessionId,
    ),
    history: yield* rows(
      `SELECT g.thread_id, g.ordinal, g.ui_id, g.messages, p.format_version, p.ready
       FROM chat_history_groups g LEFT JOIN chat_history_projection p USING (thread_id)
       WHERE g.thread_id IN ${inList(ids.length)} ORDER BY g.thread_id = ? DESC, g.thread_id, g.ordinal`,
      ...ids,
      sessionId,
    ),
    runs,
    interrupts: yield* rows(
      `SELECT interrupt_id, run_id, thread_id, status, payload, response
       FROM chat_interrupts WHERE thread_id IN ${inList(ids.length)} ORDER BY seq`,
      ...ids,
    ),
    metadata: yield* rows(
      `SELECT namespace, key, value FROM chat_metadata WHERE key IN ${inList(ids.length)}
       ORDER BY namespace, key`,
      ...ids,
    ),
    nodes: yield* rows(
      "SELECT kind, run_id, text, detail FROM nodes WHERE session_id = ? ORDER BY seq",
      sessionId,
    ),
    subagents: yield* rows(
      `SELECT id, name, instructions, status, parent_run_id, last_task, last_answer, error
       FROM subagents WHERE session_id = ? ORDER BY rowid`,
      sessionId,
    ),
    tasks: yield* rows(
      `SELECT id, parent_task_id, parent_run_id, parent_tool_call_id, agent_id, agent_name, status,
         title, request FROM work_tasks WHERE origin_session_id = ? ORDER BY rowid`,
      sessionId,
    ),
    attempts: yield* rows(
      `SELECT a.task_id, a.attempt_number, a.chat_run_id, a.thread_id, a.status, a.resume_reason,
         a.resumability, a.pending_tool_call_ids, a.failure
       FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
       WHERE t.origin_session_id = ? ORDER BY a.rowid`,
      sessionId,
    ),
    artifacts: yield* rows(
      `SELECT w.task_id, w.kind, w.locator, w.media_type, w.verification
       FROM work_artifacts w JOIN work_tasks t ON t.id = w.task_id
       WHERE t.origin_session_id = ? ORDER BY w.rowid`,
      sessionId,
    ),
    notifications: yield* rows(
      `SELECT task_id, parent_run_id, kind, summary, payload, delivered_to_run_id
       FROM parent_notifications WHERE origin_session_id = ? ORDER BY seq`,
      sessionId,
    ),
    // `seq` counts across conversations, so only its order is compared.
    queue: yield* rows(
      `SELECT text, state, delivered_via, run_id, in_transcript, steered, failure
       FROM queued_messages WHERE session_id = ? ORDER BY seq`,
      sessionId,
    ),
    workflow: yield* rows(
      "SELECT state_json FROM session_workflows WHERE session_id = ?",
      sessionId,
    ),
    bindings: yield* rows(
      `SELECT b.run_id, b.goal_version, b.plan_version FROM workflow_run_bindings b
       WHERE b.session_id = ? ORDER BY ${runOrder("b")}`,
      sessionId,
    ),
    acknowledgements: yield* rows(
      `SELECT a.run_id FROM workflow_uncertain_acknowledgements a
       WHERE a.session_id = ? ORDER BY ${runOrder("a")}`,
      sessionId,
    ),
    events: yield* rows(
      `SELECT run_id, event_key, kind, payload_json FROM workflow_run_events
       WHERE run_id IN ${inList(runList.length)} ORDER BY cursor`,
      ...runList,
    ),
    // The fingerprint's digest and the inputs of model, middleware and strategy calls hash and
    // carry whole requests; the migration keeps only tool rows, so only their input is compared.
    ledger: yield* rows(
      `SELECT o.run_id, o.operation_id, o.side_effect, o.status,
         json_extract(o.fingerprint, '$.operation') AS operation,
         json_extract(o.fingerprint, '$.inputKind') AS input_kind,
         CASE WHEN json_extract(o.fingerprint, '$.operation') IN ('tool', 'toolAuthorize')
           THEN json_extract(o.fingerprint, '$.input') END AS input
       FROM owner_rpc_operations o
       WHERE o.run_id IN ${inList(runList.length)} ORDER BY ${runOrder("o")}, o.operation_id`,
      ...runList,
    ),
    usage: yield* rows(
      `SELECT run_id, thread_id, purpose, provider, model FROM api_usage_responses
       WHERE root_session_id = ? ORDER BY id`,
      sessionId,
    ),
  };
});

/**
 * `value` without ids or clocks. `names` are values that differ per test run, such as the storage
 * folder or a session id, and the names they get.
 */
export const normalized: {
  (names: ReadonlyArray<readonly [string, string]>): (value: JsonValue) => JsonValue;
} & typeof normalizedBody = EffectFunction.dual(2, normalizedBody);
function normalizedBody(value: JsonValue, names: ReadonlyArray<readonly [string, string]>) {
  return normalizeWith(placeholders(names))(value, undefined);
}

type Rows = ReadonlyArray<JsonObject>;
const migrateColumn = (rows: Rows, column: string, migrate: (value: JsonValue) => JsonValue) =>
  rows.map((row) => ({ ...row, [column]: migrate(row[column] ?? null) }));
const migrateMessages = (messages: JsonValue) =>
  Array.isArray(messages) ? messages.map(migrateMessage) : messages;
const migrateInterrupts = (interrupts: JsonValue) =>
  Array.isArray(interrupts) ? interrupts.map(migrateInterruptPayload) : interrupts;

/**
 * A stream chunk without what TanStack adds to it: its metadata, and that of the messages of a
 * snapshot and the interrupts of an outcome. Chunks become plain AG-UI 1.0 with the switch
 * (docs/effect-ai-migration.md), so only the rest of a chunk is compared.
 */
export const withoutChunkMetadata = (chunk: JsonValue): JsonValue => {
  if (!isObject(chunk)) return chunk;
  const entry = (key: string, value: JsonValue): ReadonlyArray<readonly [string, JsonValue]> => {
    if (key === "messages") return [[key, migrateMessages(value)]];
    if (key === "outcome" && isObject(value) && Object.hasOwn(value, "interrupts"))
      return [[key, { ...value, interrupts: migrateInterrupts(value["interrupts"]!) }]];
    if (key !== "metadata" || !isObject(value)) return [[key, value]];
    const kept = Object.entries(value).filter(([field]) => field !== "tanstack");
    return kept.length === 0 ? [] : [[key, Object.fromEntries(kept)]];
  };
  return Object.fromEntries(Object.entries(chunk).flatMap(([key, value]) => entry(key, value)));
};

const HandoffRow = Schema.Struct({
  messages: Schema.String,
  value: Schema.fromJsonString(HandoffState),
});
const decodeHandoffRow = Schema.decodeUnknownEffect(HandoffRow);
// The thread's text is what the message store wrote, so parsing restores its messages.
const parseMessages = (text: string): readonly ModelMessage[] => JSON.parse(text);

/**
 * The conversation's rows after the TanStack migration (src/chat-store/tanstack-migration.ts). Its
 * transforms give the rows they should become; the migration then runs on the database and must
 * leave those rows, with a saved model handoff that still finds its boundary.
 */
export const migratedRows = Effect.fnUntraced(function* (sessionId: string) {
  const stored = yield* conversationRows(sessionId);
  const expected = {
    ...stored,
    threads: migrateColumn(stored.threads, "messages", migrateMessages),
    history: migrateColumn(stored.history, "messages", migrateMessages),
    runs: migrateColumn(stored.runs, "usage", migrateUsage(false)),
    interrupts: migrateColumn(stored.interrupts, "payload", migrateInterruptPayload),
  };
  yield* withOpenSql(migrateTanStackRows());
  const migrated = yield* conversationRows(sessionId);
  // Handoff anchors are fingerprints, which normalizing hides; the replay below checks them.
  expect(normalized(migrated, [])).toEqual(normalized(expected, []));
  const handoffs = yield* sqlAll(
    `SELECT t.messages, m.value FROM chat_threads t
     JOIN chat_metadata m ON m.namespace = ? AND m.key = t.thread_id WHERE t.thread_id = ?`,
    modelHandoffNamespace,
    sessionId,
  );
  yield* Effect.forEach(handoffs, (row) =>
    Effect.flatMap(decodeHandoffRow(row), ({ messages, value }) =>
      HandoffState.match(value, {
        baseline: () => Effect.succeed([]),
        handoff: (saved) => handoffHistory(parseMessages(messages), saved, () => null),
      }),
    ),
  );
  return {
    ...migrated,
    events: migrateColumn(migrated.events, "payload_json", withoutChunkMetadata),
  };
});
