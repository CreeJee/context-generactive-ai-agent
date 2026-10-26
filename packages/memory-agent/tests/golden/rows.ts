import { Effect, MutableHashMap, Option, Schema } from "effect";
import { JsonValue } from "../../src/json.ts";
import { sqlAll } from "../support/sql.ts";

/**
 * The rows one conversation leaves in the database, in a form that does not depend on ids, clocks
 * or TanStack's own metadata. The Effect AI migration must leave the same rows behind.
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
  /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+-\d{13}-[a-z0-9]{4,})(?:-message)?(?:-\d+)?(?![a-z0-9])/g;
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

/** TanStack's own keys: `metadata.tanstack` and keys such as `tanstack:interruptBinding`. */
const isTanStackKey = (key: string) => key === "tanstack" || key.startsWith("tanstack:");

/**
 * Drops TanStack metadata. A message keeps the `createdAt` and `model` TanStack held for it, as the
 * migration moves them to the message itself.
 */
const withoutTanStackMetadata = (value: JsonObject) => {
  const ownKeys = (object: JsonObject) =>
    Object.fromEntries(Object.entries(object).filter(([key]) => !isTanStackKey(key)));
  const { metadata, ...rest } = ownKeys(value);
  if (metadata === undefined || !isObject(metadata)) return ownKeys(value);
  const tanstack = rest["role"] === undefined ? undefined : metadata["tanstack"];
  const lifted =
    tanstack === undefined || !isObject(tanstack)
      ? []
      : (["createdAt", "model"] as const).flatMap((field) => {
          const held = tanstack[field];
          return rest[field] === undefined && held !== undefined ? [[field, held] as const] : [];
        });
  const ours = ownKeys(metadata);
  const message = { ...rest, ...Object.fromEntries(lifted) };
  return Object.keys(ours).length === 0 ? message : { ...message, metadata: ours };
};

/**
 * A JSON column is compared as JSON; a string inside it stays a string, so a value that changes
 * from encoded JSON to an object (tool call arguments, tool results) shows in the diff.
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
    return Object.fromEntries(
      Object.entries(withoutTanStackMetadata(value)).map(([name, item]) => [
        rename(name),
        walk(item, name),
      ]),
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

export const goldenRows = Effect.fnUntraced(function* (
  sessionId: string,
  /** Other values that differ per test run, such as the storage folder, and their names. */
  fixed: ReadonlyArray<readonly [string, string]>,
) {
  const threads = yield* threadsOf(sessionId);
  const ids = threads.length === 0 ? [sessionId] : threads;
  const project = yield* sqlAll("SELECT project_id FROM sessions WHERE id = ?", sessionId);
  const runs = yield* rows(
    `SELECT run_id, thread_id, status, error, error_code, usage, cancel_requested
     FROM chat_runs WHERE thread_id IN ${inList(ids.length)} ORDER BY rowid`,
    ...ids,
  );
  const runIds = runs.flatMap((run) => (isString(run["run_id"]) ? [run["run_id"]] : []));
  const runList = runIds.length === 0 ? [""] : runIds;
  const dump = {
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
  const rename = placeholders([
    ...fixed,
    [sessionId, "<session>"],
    ...project.map((row) => [String(row["project_id"]), "<project>"] as const),
  ]);
  return normalizeWith(rename)(dump, undefined);
});
