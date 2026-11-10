// Only the confirmed empty ModelMessage shape is disposable. Unknown payload fields
// (including parts, attachments and tool calls) are deliberately preserved.
export const emptyUserMessageMigration = `
  WITH empty_user_messages AS (
    SELECT thread.thread_id, message.key AS message_index
    FROM chat_threads AS thread, json_each(thread.messages) AS message
    WHERE json_extract(message.value, '$.role') = 'user'
      AND json_type(message.value, '$.content') = 'text'
      AND json_extract(message.value, '$.content') = ''
      AND NOT EXISTS (
        SELECT 1 FROM json_each(message.value) AS field
        WHERE field.key NOT IN ('id', 'role', 'content', 'createdAt', 'metadata')
      )
  )
  UPDATE chat_threads
  SET messages = (
    SELECT json_group_array(json(value)) FROM (
      SELECT message.value FROM json_each(chat_threads.messages) AS message
      WHERE message.key NOT IN (
        SELECT message_index FROM empty_user_messages
        WHERE thread_id = chat_threads.thread_id
      )
      ORDER BY CAST(message.key AS INTEGER)
    )
  )
  WHERE thread_id IN (SELECT thread_id FROM empty_user_messages);
`;

/**
 * The step where startup moves the chat rows TanStack wrote to the shapes of
 * `chat-store/schema.ts`. They are JSON that SQL alone cannot rewrite, so the work is
 * `migrateTanStackRows`, which startup runs with this step (`db/database.ts`). A fixture that only
 * runs the texts has no TanStack rows to move.
 */
export const tanStackRowsMigration = `
  -- The chat rows TanStack wrote move to the Effect AI shapes (docs/effect-ai-migration.md, "DB
  -- 저장 형식과 migration"); startup runs migrateTanStackRows with this step.
`;

/**
 * The step that splits kanban human decision requests into what they ask and the facts seen when
 * asking. 0.0.17 kept the facts in the workflow payload, JSON that SQL alone cannot move, so
 * startup runs `migrateHumanDecisionRows` with this step (`db/database.ts`).
 */
export const humanDecisionFactsMigration = `
  -- The facts a kanban human decision request saw, oldest first. Asking the same occasion again
  -- adds a row when they changed; rows are never rewritten. The first row of a 0.0.17 request is
  -- the facts its payload kept (migrateHumanDecisionRows).
  CREATE TABLE human_decision_facts (
    execution_id TEXT NOT NULL REFERENCES owner_workflow_executions(execution_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    seq INTEGER NOT NULL CHECK (seq > 0),
    kind_json TEXT NOT NULL CHECK (json_valid(kind_json)),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (execution_id, seq)
  );
`;

/**
 * The step that moves each thread's transcript from the JSON array in `chat_threads.messages` to
 * one row per message, so a save rewrites only the messages that changed.
 */
export const threadMessagesMigration = `
  -- A thread's transcript is one row per message; seq numbers its messages in order from 0
  -- (decisions.md "대화 transcript를 메시지 행에 저장한다 (2026-11-04)"). A save rewrote the whole
  -- array, 42 MB for the largest conversation, while it adds a few messages. Every writer stored an
  -- array of objects; each element moves as its JSON text, which joined in order gives the array
  -- again.
  CREATE TABLE chat_thread_messages (
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    message TEXT NOT NULL CHECK (json_valid(message)),
    PRIMARY KEY (thread_id, seq)
  );
  INSERT INTO chat_thread_messages (thread_id, seq, message)
    SELECT t.thread_id, m.key,
      CASE WHEN m.type IN ('object', 'array') THEN m.value
        WHEN m.type IN ('true', 'false') THEN m.type
        ELSE json_quote(m.value) END
    FROM chat_threads AS t, json_each(t.messages) AS m
    WHERE json_type(t.messages) = 'array';
  -- A thread the secret sweep has yet to read: each of its messages is, under the new target.
  INSERT INTO secret_sweep_changes (target, row_key, writes)
    SELECT 'chat_thread_messages', m.rowid, 1 FROM secret_sweep_changes AS c
    JOIN chat_threads AS t ON t.rowid = c.row_key
    JOIN chat_thread_messages AS m ON m.thread_id = t.thread_id
    WHERE c.target = 'chat_threads';
  DELETE FROM secret_sweep_changes WHERE target = 'chat_threads';
  UPDATE secret_sweeps SET target = 'chat_thread_messages' WHERE target = 'chat_threads';
  DROP TRIGGER secret_sweep_chat_threads_insert;
  DROP TRIGGER secret_sweep_chat_threads_update;
  DROP TRIGGER chat_threads_revision_update;
  -- The history projection's triggers on the column, which the projection made: it now watches
  -- the revision. They go before the column, and the moved rows took no new revision, so the
  -- pages ready before this step stay ready.
  DROP TRIGGER IF EXISTS chat_history_invalidate_update;
  DROP TRIGGER IF EXISTS chat_history_invalidate_insert;
  ALTER TABLE chat_threads DROP COLUMN messages;
  CREATE TRIGGER chat_thread_messages_revision_insert AFTER INSERT ON chat_thread_messages BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE thread_id = NEW.thread_id;
  END;
  CREATE TRIGGER chat_thread_messages_revision_update AFTER UPDATE ON chat_thread_messages BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE thread_id = NEW.thread_id;
  END;
  CREATE TRIGGER chat_thread_messages_revision_delete AFTER DELETE ON chat_thread_messages BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE thread_id = OLD.thread_id;
  END;
  CREATE TRIGGER secret_sweep_chat_thread_messages_insert AFTER INSERT ON chat_thread_messages
  BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_thread_messages', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_chat_thread_messages_update
  AFTER UPDATE OF message ON chat_thread_messages BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_thread_messages', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
`;

/**
 * The step that replaces the history projection, a copy of every message in groups, with rows
 * that name where each shown message begins in the transcript.
 */
export const threadDisplayMessagesMigration = `
  -- What the screen shows of a thread: one row per shown message, each the run of transcript
  -- messages from its first_message_seq up to the next one's (decisions.md "화면 메시지는 transcript
  -- 구간으로 저장한다 (2026-11-04)"). The projection copied every message into its groups, 636 MB
  -- for 846 threads, and wrote the growing last group again with each save. display_revision is
  -- the thread's revision the rows were made at; they are current while it is the thread's.
  ALTER TABLE chat_threads ADD COLUMN display_revision INTEGER;
  ALTER TABLE chat_threads ADD COLUMN display_format INTEGER;
  CREATE TABLE chat_thread_display_messages (
    thread_id TEXT NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    display_id TEXT NOT NULL CHECK (display_id <> ''),
    first_message_seq INTEGER NOT NULL CHECK (first_message_seq >= 0),
    PRIMARY KEY (thread_id, seq),
    UNIQUE (thread_id, display_id)
  );
  -- The projection's tables, which the app made as it started; a database that never served has
  -- none, and gets them empty here.
  CREATE TABLE IF NOT EXISTS chat_history_projection (
    thread_id TEXT PRIMARY KEY,
    format_version INTEGER NOT NULL,
    ready INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_history_groups (
    thread_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    ui_id TEXT NOT NULL,
    messages TEXT NOT NULL,
    PRIMARY KEY (thread_id, ordinal)
  );
  -- Ready pages move with their ids, so the cursors open pages hold stay valid. They move only
  -- where the groups hold the thread's messages exactly, in order; the others are built again at
  -- startup.
  CREATE TEMP TABLE moved_groups AS
    SELECT g.thread_id, g.ordinal, g.ui_id, json_array_length(g.messages) AS length
    FROM chat_history_groups AS g JOIN chat_history_projection AS p USING (thread_id)
    WHERE p.ready = 1 AND p.format_version = 1;
  CREATE TEMP TABLE moved_threads AS
    SELECT g.thread_id FROM moved_groups AS g GROUP BY g.thread_id
    HAVING MIN(g.ordinal) = 0 AND MAX(g.ordinal) + 1 = COUNT(*)
      AND COUNT(g.length) = COUNT(*) AND MIN(g.length) > 0 AND MIN(g.ui_id <> '') = 1
      AND SUM(g.length) = (SELECT COUNT(*) FROM chat_thread_messages AS m
                           WHERE m.thread_id = g.thread_id);
  INSERT INTO chat_thread_display_messages (thread_id, seq, display_id, first_message_seq)
    SELECT thread_id, ordinal, ui_id, COALESCE(SUM(length) OVER (
      PARTITION BY thread_id ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
    FROM moved_groups WHERE thread_id IN (SELECT thread_id FROM moved_threads);
  -- A thread without messages shows nothing, which is current whatever its pages were.
  UPDATE chat_threads SET display_revision = revision, display_format = 1
    WHERE thread_id IN (SELECT thread_id FROM moved_threads) OR NOT EXISTS (
      SELECT 1 FROM chat_thread_messages AS m WHERE m.thread_id = chat_threads.thread_id);
  DROP TABLE moved_groups;
  DROP TABLE moved_threads;
  DROP TRIGGER IF EXISTS chat_history_invalidate_revision;
  DROP TRIGGER IF EXISTS chat_history_invalidate_delete;
  DROP TABLE chat_history_groups;
  DROP TABLE chat_history_projection;
  -- A change that keeps each message's role and id keeps what the screen shows: the secret sweep
  -- hides text in place, and pages read the hidden text from the row. The shown messages of such a
  -- thread stay current at its new revision.
  DROP TRIGGER chat_thread_messages_revision_update;
  CREATE TRIGGER chat_thread_messages_revision_update AFTER UPDATE ON chat_thread_messages BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET
      revision = (SELECT last_revision FROM chat_revision_counter),
      display_revision = CASE
        WHEN display_revision = revision AND NEW.thread_id = OLD.thread_id AND NEW.seq = OLD.seq
          AND json_extract(NEW.message, '$.role') IS json_extract(OLD.message, '$.role')
          AND json_extract(NEW.message, '$.id') IS json_extract(OLD.message, '$.id')
        THEN (SELECT last_revision FROM chat_revision_counter)
        ELSE display_revision END
      WHERE thread_id = NEW.thread_id;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE thread_id = OLD.thread_id AND OLD.thread_id IS NOT NEW.thread_id;
  END;
`;

/**
 * The step that keeps a session's workflow ledger once, as rows, and makes its current state the
 * latest revision instead of a copy of it.
 */
export const workflowLedgerMigration = `
  -- A workflow's ledger as rows (decisions.md "Workflow ledger는 행으로, 현재 상태는 최신 revision을
  -- 가리킨다 (2026-11-04)"). Every revision held the whole ledger, which only grows (99 events on
  -- average, half of the revisions' 30 MB), and session_workflows held the latest revision again.
  -- A revision now holds its phase, Goal and Plan and how many of the session's events it has.
  --
  -- A current state its latest revision does not hold is recorded as one first, so none is lost.
  INSERT INTO workflow_state_revisions
    (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
    SELECT w.session_id, w.state_json, json_extract(w.state_json, '$.goal.version'),
      json_extract(w.state_json, '$.plan.version'), 'legacy_current', w.updated_at,
      (SELECT goal_instance_id FROM workflow_goal_identities g WHERE g.session_id = w.session_id)
    FROM session_workflows w
    WHERE w.state_json IS NOT (SELECT r.state_json FROM workflow_state_revisions r
      WHERE r.session_id = w.session_id ORDER BY r.id DESC LIMIT 1);
  CREATE TABLE workflow_ledger_events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
  ) WITHOUT ROWID;
  INSERT INTO workflow_ledger_events (session_id, sequence, at, kind, detail)
    SELECT r.session_id, e.value ->> 'sequence', e.value ->> 'at', e.value ->> 'kind',
      e.value ->> 'detail'
    FROM workflow_state_revisions r, json_each(r.state_json, '$.ledger') e
    WHERE r.id = (SELECT max(id) FROM workflow_state_revisions x WHERE x.session_id = r.session_id);
  CREATE TRIGGER workflow_ledger_events_no_update BEFORE UPDATE ON workflow_ledger_events
    BEGIN SELECT RAISE(ABORT, 'workflow ledger events are immutable'); END;
  -- The ledger only grows, so every revision's is the start of its session's latest. One that is
  -- not, or whose sequence is not its place, stops the migration and leaves the DB as it was.
  CREATE TEMP TABLE workflow_ledger_check (valid INTEGER NOT NULL CHECK (valid = 1));
  INSERT INTO workflow_ledger_check (valid)
    SELECT 0 FROM workflow_state_revisions r, json_each(r.state_json, '$.ledger') e
    WHERE e.value ->> 'sequence' IS NOT e.key + 1 OR NOT EXISTS (
      SELECT 1 FROM workflow_ledger_events l
      WHERE l.session_id = r.session_id AND l.sequence = e.key + 1
        AND l.at = e.value ->> 'at' AND l.kind = e.value ->> 'kind'
        AND l.detail = e.value ->> 'detail')
    LIMIT 1;
  DROP TABLE workflow_ledger_check;
  DROP TRIGGER workflow_state_revisions_no_update;
  ALTER TABLE workflow_state_revisions ADD COLUMN phase TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE workflow_state_revisions ADD COLUMN goal_json TEXT
    CHECK (goal_json IS NULL OR json_valid(goal_json));
  ALTER TABLE workflow_state_revisions ADD COLUMN plan_json TEXT
    CHECK (plan_json IS NULL OR json_valid(plan_json));
  ALTER TABLE workflow_state_revisions ADD COLUMN ledger_length INTEGER NOT NULL DEFAULT 0
    CHECK (ledger_length >= 0);
  UPDATE workflow_state_revisions SET
    phase = state_json ->> 'phase',
    goal_json = NULLIF(state_json -> '$.goal', 'null'),
    plan_json = NULLIF(state_json -> '$.plan', 'null'),
    ledger_length = json_array_length(state_json, '$.ledger');
  ALTER TABLE workflow_state_revisions DROP COLUMN state_json;
  CREATE TRIGGER workflow_state_revisions_no_update BEFORE UPDATE ON workflow_state_revisions
    BEGIN SELECT RAISE(ABORT, 'workflow revisions are immutable'); END;
  -- The current state is the session's latest revision.
  CREATE TABLE session_workflows_current (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    revision_id INTEGER NOT NULL REFERENCES workflow_state_revisions(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
  );
  INSERT INTO session_workflows_current (session_id, revision_id, updated_at)
    SELECT w.session_id,
      (SELECT max(id) FROM workflow_state_revisions r WHERE r.session_id = w.session_id),
      w.updated_at
    FROM session_workflows w;
  DROP TABLE session_workflows;
  ALTER TABLE session_workflows_current RENAME TO session_workflows;
`;

/**
 * The step that keeps a bound run's output once, in a delivery log that empties after the run,
 * and drops `workflow_run_events`.
 */
export const runLogMigration = `
  -- A bound run's delivery log (decisions.md "Goal run의 출력은 delivery 로그에만 둔다
  -- (2026-11-04)"). workflow_run_events held every chunk twice, as a receipt nothing read and as
  -- the log a page reads, and kept both forever: 3.3 million rows and 1.2 GB. The log keeps one row
  -- per event; its closure marks its end, and the entries go five minutes after it, as an
  -- in-memory run log's do.
  CREATE TABLE workflow_run_log_entries (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    event_json TEXT NOT NULL CHECK (json_valid(event_json))
  );
  CREATE INDEX workflow_run_log_entries_run ON workflow_run_log_entries(run_id, cursor);
  CREATE TABLE workflow_run_log_closures (
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    closed_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- No run outlives a restart, and a page that rejoins after one reads the saved transcript, so
  -- every earlier log ends here long expired and none of its entries is kept.
  INSERT INTO workflow_run_log_closures (run_id, closed_at)
    SELECT run_id, 0 FROM workflow_run_bindings;
  -- An operator's revocation of a read recovery receipt was a workflow_run_events row. None is
  -- written any more; the ones a released version wrote still keep their receipt from admission.
  CREATE TABLE owner_read_recovery_revocations (
    receipt_id TEXT PRIMARY KEY REFERENCES owner_read_recoveries(receipt_id),
    revoked_at TEXT NOT NULL
  ) WITHOUT ROWID;
  INSERT INTO owner_read_recovery_revocations (receipt_id, revoked_at)
    SELECT rr.receipt_id, e.created_at FROM owner_read_recoveries rr
    JOIN workflow_run_events e ON e.run_id = rr.run_id
      AND e.event_key = 'operator:read-recovery:revoke:' || rr.receipt_id;
  CREATE TRIGGER owner_read_recovery_revocations_no_update
  BEFORE UPDATE ON owner_read_recovery_revocations
    BEGIN SELECT RAISE(ABORT, 'read recovery revocation is immutable'); END;
  CREATE TRIGGER owner_read_recovery_revocations_no_delete
  BEFORE DELETE ON owner_read_recovery_revocations
    BEGIN SELECT RAISE(ABORT, 'read recovery revocation is retained'); END;
  DROP TABLE workflow_run_events;
`;

/**
 * The step that keeps an owner operation's kind, tool and ending as columns and drops the JSON
 * they were read out of.
 */
export const ownerRpcLedgerMigration = `
  -- An owner operation as columns (decisions.md "owner 장부 행은 열로 둔다 (2026-11-04)"). Its
  -- fingerprint held the operation and the owner-encoded call with its arguments, and readers
  -- picked the tool's name and call id out of it; reply_json held how the call ended, and run_key
  -- the run's binding again. Nothing compares a digest since the Goal worker went, the arguments
  -- and results are the session's tool_call and tool_result nodes, and the binding is
  -- workflow_run_bindings.
  ALTER TABLE owner_rpc_operations ADD COLUMN operation TEXT;
  ALTER TABLE owner_rpc_operations ADD COLUMN tool_name TEXT;
  ALTER TABLE owner_rpc_operations ADD COLUMN tool_call_id TEXT;
  ALTER TABLE owner_rpc_operations ADD COLUMN outcome TEXT
    CHECK (outcome IN ('returned', 'failed', 'cancelled', 'refused'));
  -- A fingerprint that is not JSON names nothing; its row still counts as a tool.
  UPDATE owner_rpc_operations SET
    operation = CASE WHEN json_valid(fingerprint) THEN fingerprint ->> 'operation' END,
    tool_name = (SELECT f.value ->> '$[1][1]'
      FROM json_each(CASE WHEN json_valid(fingerprint) THEN fingerprint END, '$.input[1]') f
      WHERE f.type = 'array' AND f.value ->> '$[0]' = 'name'),
    tool_call_id = (SELECT f.value ->> '$[1][1]'
      FROM json_each(CASE WHEN json_valid(fingerprint) THEN fingerprint END, '$.input[1]') f
      WHERE f.type = 'array' AND f.value ->> '$[0]' = 'toolCallId'),
    outcome = CASE WHEN reply_json ->> 'output' IN ('returned', 'failed', 'cancelled', 'refused')
      THEN reply_json ->> 'output' END;
  -- A read recovery receipt names its two operations by their fingerprints and the run key, which
  -- never change once written. A receipt they do not match never resolved its run; it is revoked
  -- now, so admission keeps reading it the same once they are gone.
  INSERT INTO owner_read_recovery_revocations (receipt_id, revoked_at)
    SELECT rr.receipt_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM owner_read_recoveries rr
    WHERE rr.receipt_id NOT IN (SELECT receipt_id FROM owner_read_recovery_revocations)
      AND NOT EXISTS (SELECT 1 FROM owner_rpc_operations ro
        JOIN owner_rpc_operations ra ON ra.run_id = ro.run_id
          AND ra.operation_id = ro.operation_id - 1
        WHERE ro.run_id = rr.run_id AND ro.operation_id = rr.operation_id
          AND ro.fingerprint = rr.operation_fingerprint AND ro.run_key = rr.run_key
          AND ra.fingerprint = rr.authorization_fingerprint AND ra.run_key = rr.run_key);
  ALTER TABLE owner_rpc_operations DROP COLUMN run_key;
  ALTER TABLE owner_rpc_operations DROP COLUMN fingerprint;
  ALTER TABLE owner_rpc_operations DROP COLUMN reply_json;
`;

/**
 * The step that keeps whom an owner workflow execution and a card queue item belong to in app
 * tables, so app queries stop reading the engine's payloads.
 */
export const executionSubjectsMigration = `
  -- Whom an execution belongs to (decisions.md "엔진 실행의 주인은 앱 표에 둔다 (2026-11-04)").
  -- App queries found executions by session, and a Goal execution by its run, through paths into
  -- the engine's payload JSON that differ by workflow, with no index. The session is in every
  -- payload: at the top, or in a Goal execution's identity. The run is kept only for a Goal
  -- execution whose identity is its run's binding, the only one evidence ever matched.
  CREATE TABLE workflow_execution_subjects (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT
  ) WITHOUT ROWID;
  CREATE INDEX workflow_execution_subjects_session ON workflow_execution_subjects(session_id);
  CREATE INDEX workflow_execution_subjects_run ON workflow_execution_subjects(run_id);
  INSERT INTO workflow_execution_subjects (execution_id, session_id, run_id)
    SELECT e.execution_id,
      coalesce(e.payload_json ->> '$.sessionId', e.payload_json ->> '$.identity.sessionId'),
      (SELECT b.run_id FROM workflow_run_bindings b
        WHERE e.workflow_name = 'GoalExecution'
          AND b.run_id = e.payload_json ->> '$.identity.runId'
          AND b.session_id = e.payload_json ->> '$.identity.sessionId'
          AND b.goal_instance_id = e.payload_json ->> '$.identity.goalInstanceId'
          AND b.workflow_revision_id = e.payload_json ->> '$.identity.workflowRevisionId')
    FROM owner_workflow_executions e
    WHERE coalesce(e.payload_json ->> '$.sessionId', e.payload_json ->> '$.identity.sessionId')
      IS NOT NULL;
  -- A card attempt names the queue item that carries it; the item's payload named the attempt.
  ALTER TABLE kanban_card_attempts ADD COLUMN queue_item_id TEXT;
  WITH items AS (
    SELECT id, CASE WHEN json_valid(element_json) THEN element_json END AS element
    FROM persisted_queue_items WHERE queue_name = 'DurableQueue/KanbanCard')
  UPDATE kanban_card_attempts SET queue_item_id = (SELECT min(i.id) FROM items i
    WHERE i.element ->> '$.payload.goalInstanceId' = kanban_card_attempts.goal_instance_id
      AND i.element ->> '$.payload.cardId' = kanban_card_attempts.card_id
      AND i.element ->> '$.payload.attemptNo' = kanban_card_attempts.attempt_no);
  CREATE UNIQUE INDEX kanban_card_attempts_queue_item ON kanban_card_attempts(queue_item_id);
`;

/** The step that keeps an attempt's unsettled tool calls as rows instead of a JSON array. */
export const attemptPendingToolCallsMigration = `
  -- An attempt's unsettled tool calls as rows (decisions.md "시도의 미결 도구 호출은 행으로 둔다
  -- (2026-11-04)"). The JSON array was edited in place with json_insert and a json_each filter on
  -- every tool start and end. A row's rowid keeps the order calls started in; an id that is not a
  -- string was never one a tool call wrote.
  CREATE TABLE attempt_pending_tool_calls (
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    PRIMARY KEY (attempt_id, tool_call_id)
  );
  INSERT OR IGNORE INTO attempt_pending_tool_calls (attempt_id, tool_call_id)
    SELECT a.id, p.value FROM agent_run_attempts a, json_each(a.pending_tool_call_ids) p
    WHERE p.type = 'text' ORDER BY a.rowid, p.key;
  ALTER TABLE agent_run_attempts DROP COLUMN pending_tool_call_ids;
`;

/** The step that moves what tasks and sessions kept in chat_metadata to tables of their own. */
export const sessionStateTablesMigration = `
  -- What a background task, a session's workflow execution and its turn summaries keep, each in
  -- its own table (decisions.md "세션 곁 상태는 제 표에 둔다 (2026-11-04)"). They were JSON
  -- documents in chat_metadata, which no deletion followed: a value whose owner is gone is not
  -- moved, and the store reads an absent one as nothing kept.

  -- What get_background_result returns for a task. A value that does not decode failed every
  -- read; it is not moved, and the task reads as one without a saved result.
  CREATE TABLE background_task_results (
    task_id TEXT PRIMARY KEY REFERENCES work_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
    result TEXT NOT NULL
  );
  INSERT INTO background_task_results (task_id, status, result)
    SELECT m.key, json_extract(m.value, '$.status'), json_extract(m.value, '$.result')
    FROM chat_metadata m JOIN work_tasks t ON t.id = m.key
    WHERE m.namespace = 'background-task-result'
      AND json_type(m.value, '$.status') = 'text'
      AND json_extract(m.value, '$.status') IN ('completed', 'failed', 'cancelled')
      AND json_type(m.value, '$.result') = 'text';

  -- A session's automatic continuation: its case, and the fields that case has. A value whose
  -- case misses one of them failed every read; it is not moved, and the session reads as idle.
  CREATE TABLE workflow_executions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    state TEXT NOT NULL
      CHECK (state IN ('idle', 'running', 'ready', 'retrying', 'blocked', 'stopped')),
    run_id TEXT CHECK ((run_id IS NOT NULL) = (state IN ('running', 'ready', 'retrying', 'blocked'))),
    goal_version INTEGER
      CHECK ((goal_version IS NOT NULL) = (state IN ('running', 'ready', 'retrying'))),
    plan_version INTEGER
      CHECK ((plan_version IS NOT NULL) = (state IN ('running', 'ready', 'retrying'))),
    no_progress_runs INTEGER
      CHECK ((no_progress_runs IS NOT NULL) = (state IN ('running', 'ready', 'retrying'))),
    retry_at REAL CHECK ((retry_at IS NOT NULL) = (state = 'retrying')),
    reason TEXT CHECK ((reason IS NOT NULL) = (state IN ('blocked', 'stopped'))),
    detail TEXT CHECK ((detail IS NOT NULL) = (state = 'blocked'))
  );
  CREATE INDEX workflow_executions_state ON workflow_executions(state);
  -- The lists of a continuing execution's progress, or a blocked one's evidence, in order.
  CREATE TABLE workflow_execution_entries (
    session_id TEXT NOT NULL REFERENCES workflow_executions(session_id) ON DELETE CASCADE,
    list TEXT NOT NULL
      CHECK (list IN ('completed_step', 'progress_evidence', 'tool_result', 'blocker_evidence')),
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (session_id, list, position)
  );
  -- A field of its case with the wrong type is left out, so the CHECKs skip the value; a field
  -- of another case was never read.
  WITH stored AS (
    SELECT m.key, m.value, json_extract(m.value, '$._tag') AS tag
    FROM chat_metadata m JOIN sessions s ON s.id = m.key
    WHERE m.namespace = 'memory-agent/workflow-execution' AND json_type(m.value, '$._tag') = 'text'
  )
  INSERT OR IGNORE INTO workflow_executions
    (session_id, state, run_id, goal_version, plan_version, no_progress_runs, retry_at, reason,
     detail)
    SELECT key, tag,
      CASE WHEN tag IN ('running', 'ready', 'retrying', 'blocked')
        AND json_type(value, '$.runId') = 'text' THEN json_extract(value, '$.runId') END,
      CASE WHEN tag IN ('running', 'ready', 'retrying')
        AND json_type(value, '$.goalVersion') = 'integer'
        THEN json_extract(value, '$.goalVersion') END,
      CASE WHEN tag IN ('running', 'ready', 'retrying')
        AND json_type(value, '$.planVersion') = 'integer'
        THEN json_extract(value, '$.planVersion') END,
      CASE WHEN tag IN ('running', 'ready', 'retrying')
        AND json_type(value, '$.noProgressRuns') = 'integer'
        THEN json_extract(value, '$.noProgressRuns') END,
      CASE WHEN tag = 'retrying' AND json_type(value, '$.retryAt') IN ('integer', 'real')
        THEN json_extract(value, '$.retryAt') END,
      CASE WHEN tag IN ('blocked', 'stopped') AND json_type(value, '$.reason') = 'text'
        THEN json_extract(value, '$.reason') END,
      CASE WHEN tag = 'blocked' AND json_type(value, '$.detail') = 'text'
        THEN json_extract(value, '$.detail') END
    FROM stored;
  INSERT INTO workflow_execution_entries (session_id, list, position, value)
    SELECT e.session_id, l.list, i.key, i.value
    FROM workflow_executions e
    JOIN chat_metadata m ON m.namespace = 'memory-agent/workflow-execution' AND m.key = e.session_id
    JOIN (SELECT 'completed_step' AS list, '$.progress.completedSteps' AS path, 0 AS blocked
      UNION ALL SELECT 'progress_evidence', '$.progress.evidence', 0
      UNION ALL SELECT 'tool_result', '$.progress.toolResults', 0
      UNION ALL SELECT 'blocker_evidence', '$.evidence', 1) l
      ON l.blocked = (e.state = 'blocked') AND json_type(m.value, l.path) = 'array'
    JOIN json_each(m.value, l.path) i
    WHERE e.state NOT IN ('idle', 'stopped') AND i.type = 'text';

  -- A session's turn summaries, in the order compaction lines them up. A value that does not
  -- decode read as none; a block whose end is not a whole turn ended the ones that line up.
  CREATE TABLE turn_summary_blocks (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    turn_end INTEGER NOT NULL,
    next_turn_node_id TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (session_id, position)
  );
  WITH stored AS (
    SELECT m.key AS session_id, b.key AS position, m.value, b.fullkey AS path
    FROM chat_metadata m JOIN sessions s ON s.id = m.key,
      json_each(CASE WHEN json_type(m.value, '$.blocks') = 'array' THEN m.value END, '$.blocks') b
    WHERE m.namespace = 'memory-agent/turn-summaries'
  )
  INSERT INTO turn_summary_blocks (session_id, position, turn_end, next_turn_node_id, text)
    SELECT session_id, position, json_extract(value, path || '.end'),
      json_extract(value, path || '.nextTurnNodeId'), json_extract(value, path || '.text')
    FROM stored s
    WHERE NOT EXISTS (SELECT 1 FROM stored w WHERE w.session_id = s.session_id
        AND (coalesce(json_type(w.value, w.path || '.end'), '') NOT IN ('integer', 'real')
          OR json_type(w.value, w.path || '.nextTurnNodeId') IS NOT 'text'
          OR json_type(w.value, w.path || '.text') IS NOT 'text'))
      AND NOT EXISTS (SELECT 1 FROM stored w WHERE w.session_id = s.session_id
        AND w.position <= s.position AND json_type(w.value, w.path || '.end') <> 'integer');

  DELETE FROM chat_metadata WHERE namespace IN
    ('background-task-result', 'memory-agent/workflow-execution', 'memory-agent/turn-summaries');
  -- The thread state of conversations whose deletion left it behind.
  DELETE FROM chat_metadata
    WHERE namespace IN ('memory-agent/context-usage', 'memory-agent/consumed-cold-usage',
        'memory-agent/manual-compaction', 'memory-agent/model-handoff')
      AND key NOT IN (SELECT thread_id FROM chat_threads)
      AND key NOT IN (SELECT id FROM sessions);
`;

/** The step that keeps a queued message's images as rows instead of a JSON array. */
export const queuedMessageAttachmentsMigration = `
  -- Which images a queued message carries, in order (decisions.md "대기 메시지의 이미지는 행으로
  -- 둔다 (2026-11-04)"). The JSON array named them without a reference, so removing unused
  -- images could delete one a message still waited to send. Delivery left out an image that was
  -- gone and an id that was not a string never named one, so neither is moved.
  CREATE TABLE queued_message_attachments (
    message_id TEXT NOT NULL REFERENCES queued_messages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (message_id, position)
  );
  CREATE INDEX queued_message_attachments_attachment
    ON queued_message_attachments(attachment_id);
  INSERT INTO queued_message_attachments (message_id, position, attachment_id)
    SELECT q.id, i.key, i.value
    FROM queued_messages q,
      json_each(CASE WHEN json_type(q.attachment_ids) = 'array' THEN q.attachment_ids END) i
    JOIN attachments a ON a.id = i.value
    WHERE i.type = 'text';
  ALTER TABLE queued_messages DROP COLUMN attachment_ids;
  -- Whether a delivered message reached the transcript; nothing has read it.
  ALTER TABLE queued_messages DROP COLUMN in_transcript;
`;

/** The step that keeps a BTW thread's transcript as one row per message. */
export const btwThreadMessagesMigration = `
  -- A BTW thread's transcript is one row per message, as a conversation's is in
  -- chat_thread_messages (decisions.md "BTW 대화는 메시지 행으로 둔다 (2026-11-04)"). A save
  -- rewrote the whole array. Each element moves as its JSON text; a value that was not an array
  -- failed every read and now reads as no messages.
  CREATE TABLE btw_thread_messages (
    thread_id TEXT NOT NULL REFERENCES btw_threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    message TEXT NOT NULL CHECK (json_valid(message)),
    PRIMARY KEY (thread_id, seq)
  );
  INSERT INTO btw_thread_messages (thread_id, seq, message)
    SELECT t.id, m.key,
      CASE WHEN m.type IN ('object', 'array') THEN m.value
        WHEN m.type IN ('true', 'false') THEN m.type
        ELSE json_quote(m.value) END
    FROM btw_threads AS t,
      json_each(CASE WHEN json_type(t.messages) = 'array' THEN t.messages END) AS m;
  ALTER TABLE btw_threads DROP COLUMN messages;
`;

/** The step that finds a board's session and project through its Goal instance. */
export const kanbanGoalOwnersMigration = `
  -- A board, its schedule and its card attempts name their session and project through the Goal
  -- instance (decisions.md "칸반 보드의 세션과 프로젝트는 Goal instance에서 찾는다 (2026-11-04)").
  -- Nothing kept the copies equal to the session's own. A board whose Goal instance is gone
  -- belongs to no session and is not kept; deleting the instance now removes its board.
  -- project_root stays: it is where the board's worktrees were made.
  CREATE TABLE kanban_goals_v2 (
    goal_instance_id TEXT PRIMARY KEY
      REFERENCES workflow_goal_instances(goal_instance_id) ON DELETE CASCADE,
    project_root TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('worktree', 'sequential')),
    goal_version INTEGER NOT NULL,
    hold_json TEXT CHECK (hold_json IS NULL OR json_valid(hold_json)),
    status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO kanban_goals_v2
    (goal_instance_id, project_root, mode, goal_version, hold_json, status, created_at,
     updated_at)
    SELECT k.goal_instance_id, k.project_root, k.mode, k.goal_version, k.hold_json, k.status,
      k.created_at, k.updated_at
    FROM kanban_goals k JOIN workflow_goal_instances g ON g.goal_instance_id = k.goal_instance_id
    ORDER BY k.rowid;
  DROP TABLE kanban_goals;
  ALTER TABLE kanban_goals_v2 RENAME TO kanban_goals;
  DROP INDEX kanban_goal_schedules_project;
  ALTER TABLE kanban_goal_schedules DROP COLUMN project_id;
  ALTER TABLE kanban_card_attempts DROP COLUMN session_id;
`;

/** The step that reads where a conversation was imported from out of its transcript mapping. */
export const importedSessionSourceMigration = `
  -- A session's import source is its transcript mapping's (decisions.md "가져온 대화의 출처는
  -- transcript 매핑에서 읽는다 (2026-11-04)"). An import makes one session per transcript, so a
  -- session has one mapping at most; a second would only come from a damaged file and is dropped
  -- rather than stop the upgrade. A session marked imported without a mapping lost its transcript
  -- before the mapping was written; the transcript was imported again into another session.
  DELETE FROM imported_sessions WHERE rowid NOT IN
    (SELECT min(rowid) FROM imported_sessions GROUP BY session_id);
  CREATE UNIQUE INDEX imported_sessions_session ON imported_sessions(session_id);
  ALTER TABLE sessions DROP COLUMN imported_from;
`;

/** The step that keeps a promotion's decision and its candidate as one row. */
export const memoryCandidateDecisionsMigration = `
  -- A memory promotion is one row (decisions.md "메모리 승격 결정은 후보 행 하나로 둔다
  -- (2026-11-04)"). knowledge_decisions held the task, claim and authorizing turn; its text and
  -- status were copies of the candidate's resolved text and disposition. Promotion wrote both in
  -- one transaction, so a candidate without its decision, or one repeating another's decision,
  -- comes only from a damaged file: it is not kept, and its evidence and usage go with it.
  CREATE TABLE memory_candidates_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    authorized_by_user_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    authorized_by_user_node_id_snapshot TEXT NOT NULL,
    proposed_text TEXT NOT NULL CHECK (length(trim(proposed_text)) > 0),
    resolved_text TEXT NOT NULL CHECK (length(trim(resolved_text)) > 0),
    disposition TEXT NOT NULL
      CHECK (disposition IN ('saved', 'edited_saved', 'conversation_only', 'rejected')),
    memory_node_id TEXT REFERENCES nodes(id),
    created_at INTEGER NOT NULL,
    UNIQUE (claim_id, authorized_by_user_node_id, resolved_text, disposition),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE,
    CHECK ((disposition IN ('saved', 'edited_saved')) = (memory_node_id IS NOT NULL))
  );
  INSERT OR IGNORE INTO memory_candidates_v2
    (id, project_id, task_id, attempt_id, claim_id, origin_session_id, authorized_by_user_node_id,
     authorized_by_user_node_id_snapshot, proposed_text, resolved_text, disposition,
     memory_node_id, created_at)
    SELECT c.id, c.project_id, d.task_id, d.attempt_id, d.claim_id, d.origin_session_id,
      d.authorized_by_user_node_id, d.authorized_by_user_node_id_snapshot, c.proposed_text,
      c.resolved_text, c.disposition, c.memory_node_id, c.created_at
    FROM memory_candidates c JOIN knowledge_decisions d ON d.id = c.decision_id
    ORDER BY c.rowid;
  DROP TABLE memory_candidates;
  DROP TABLE knowledge_decisions;
  ALTER TABLE memory_candidates_v2 RENAME TO memory_candidates;
  CREATE INDEX memory_candidates_project ON memory_candidates(project_id, created_at, id);
  CREATE INDEX memory_candidates_task ON memory_candidates(task_id, created_at, id);
  DELETE FROM memory_candidate_evidence
    WHERE candidate_id NOT IN (SELECT id FROM memory_candidates);
  DELETE FROM memory_usage_events WHERE candidate_id NOT IN (SELECT id FROM memory_candidates);
`;

/** The step that journals every change of a node for the lexical index. */
export const lexicalJournalMigration = `
  -- The lexical index (Tantivy, in the native search worker) is derived from nodes, like the
  -- vector index. Every change that alters what it holds for a node is journaled here in the
  -- change's own transaction; the indexer applies the journal in order and deletes the rows it
  -- applied. A read drops a hit whose node has a journaled change still pending.
  CREATE TABLE lexical_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_seq INTEGER NOT NULL
  );
  CREATE INDEX lexical_changes_node ON lexical_changes(node_seq);
  -- The build of the lexical index the journal leads to. The worker's index names its build; a
  -- different or missing one is rebuilt from every node.
  CREATE TABLE lexical_index (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    instance TEXT NOT NULL
  );
  CREATE TRIGGER nodes_lexical_insert AFTER INSERT ON nodes
  BEGIN INSERT INTO lexical_changes(node_seq) VALUES (new.seq); END;
  CREATE TRIGGER nodes_lexical_update AFTER UPDATE OF text, project_id ON nodes
  BEGIN INSERT INTO lexical_changes(node_seq) VALUES (new.seq); END;
  CREATE TRIGGER nodes_lexical_delete AFTER DELETE ON nodes
  BEGIN INSERT INTO lexical_changes(node_seq) VALUES (old.seq); END;
  CREATE TRIGGER suppressed_lexical_insert AFTER INSERT ON memory_graph_suppressed_nodes
  BEGIN INSERT INTO lexical_changes(node_seq) VALUES (new.node_seq); END;
  CREATE TRIGGER suppressed_lexical_delete AFTER DELETE ON memory_graph_suppressed_nodes
  BEGIN INSERT INTO lexical_changes(node_seq) VALUES (old.node_seq); END;
`;

/** The step that drops the SQLite text indexes the lexical index replaced. */
export const textIndexDropMigration = `
  -- Trigram and morph matching read the lexical index now, so the FTS5 tables and the Kiwi morph
  -- terms have no reader. The freed pages stay in the file until a VACUUM.
  DROP TRIGGER nodes_fts_insert;
  DROP TABLE nodes_fts;
  DROP TABLE nodes_morph;
  DROP TABLE node_morphs;
`;

/**
 * The cards each workflow revision changed from the revision before it in its session, for the
 * board's history; a revision that changed no card has no row. Revisions never change, so this is
 * worked out once as a revision is stored, not from every Plan of the window on each board read.
 * `migrateBoardChanges` fills it for the stored revisions.
 */
export const boardChangesMigration = `
  CREATE TABLE workflow_board_changes (
    revision_id INTEGER PRIMARY KEY REFERENCES workflow_state_revisions(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    card_ids_json TEXT NOT NULL CHECK (json_valid(card_ids_json))
  );
  CREATE INDEX workflow_board_changes_session ON workflow_board_changes(session_id, revision_id);
`;

/**
 * Ordered schema steps. `PRAGMA user_version` records how many have been applied.
 * Append new steps; never edit an applied one.
 */
export const migrations: readonly string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    cross_recall_excluded INTEGER NOT NULL DEFAULT 0 CHECK (cross_recall_excluded IN (0, 1)),
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sessions_project ON sessions(project_id, created_at);

  -- Every message the agent sees, verbatim. seq doubles as the turbovec vector id.
  CREATE TABLE nodes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT REFERENCES sessions(id),
    run_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool_call', 'tool_result', 'file_observation', 'topic')),
    text TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
    created_at TEXT NOT NULL,
    CHECK (kind = 'topic' OR session_id IS NOT NULL)
  );
  CREATE INDEX nodes_session ON nodes(session_id, seq);
  CREATE INDEX nodes_project ON nodes(project_id, seq);
  CREATE TRIGGER nodes_immutable BEFORE UPDATE ON nodes
  BEGIN SELECT RAISE(ABORT, 'nodes are immutable evidence'); END;

  -- structure: derived by rule at write time. llm: added later by llm-interpret.
  CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK (kind IN ('next', 'reply', 'calls', 'returns', 'touches', 'about', 'corrects', 'retracts', 'related')),
    origin TEXT NOT NULL CHECK (origin IN ('structure', 'llm')),
    weight REAL NOT NULL CHECK (weight > 0 AND weight <= 1),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX edges_to ON edges(to_id, kind);

  -- Files or URLs a node refers to; nodes sharing a ref get a 'touches' edge.
  CREATE TABLE node_refs (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    ref TEXT NOT NULL,
    PRIMARY KEY (node_id, ref)
  );
  CREATE INDEX node_refs_ref ON node_refs(ref, node_id);

  -- Trigram matching works for Korean; queries shorter than 3 characters need a LIKE fallback.
  CREATE VIRTUAL TABLE nodes_fts USING fts5(text, content = 'nodes', content_rowid = 'seq', tokenize = 'trigram');
  CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes
  BEGIN INSERT INTO nodes_fts(rowid, text) VALUES (new.seq, new.text); END;

  -- Which nodes are already in the vector index built by a given embedding model.
  CREATE TABLE node_vectors (
    node_seq INTEGER NOT NULL REFERENCES nodes(seq),
    embedder TEXT NOT NULL,
    PRIMARY KEY (node_seq, embedder)
  );

  CREATE TABLE interpret_jobs (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX interpret_jobs_status ON interpret_jobs(status, updated_at);
  `,
  `
  -- ask: every approval-gated tool call asks the user. auto: a classifier decides first.
  ALTER TABLE projects ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK (permission_mode IN ('ask', 'auto'));

  -- Who allowed or refused an approval-gated tool call, and why. Append-only; the latest row wins.
  CREATE TABLE permission_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL CHECK (json_valid(input)),
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'block', 'approved', 'denied')),
    decided_by TEXT NOT NULL CHECK (decided_by IN ('classifier', 'fallback', 'user')),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX permission_reviews_call ON permission_reviews(session_id, tool_call_id, id);
  `,
  `
  -- Uploaded images, stored once by content hash under <storage>/attachments.
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY CHECK (length(id) = 64),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    created_at TEXT NOT NULL
  );

  -- Which images a message carried, in the order they were attached.
  CREATE TABLE node_attachments (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (node_id, position)
  );
  `,
  `
  -- TanStack AI chat state (@tanstack/ai-persistence): the UI transcript, run lifecycle and
  -- pending approvals of each thread. Thread ids are session ids. Nodes stay the evidence; these
  -- rows are what a reloaded page and a resumed run continue from. Times are epoch milliseconds.
  CREATE TABLE chat_threads (
    thread_id TEXT PRIMARY KEY,
    messages TEXT NOT NULL CHECK (json_valid(messages)),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE chat_runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'aborted')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    error_code TEXT,
    usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
    sandbox_key TEXT,
    detached_since INTEGER,
    cancel_requested INTEGER CHECK (cancel_requested IS NULL OR cancel_requested IN (0, 1)),
    driver_epoch INTEGER
  );
  CREATE INDEX chat_runs_thread_status ON chat_runs(thread_id, status, started_at);
  CREATE INDEX chat_runs_detached ON chat_runs(status, detached_since);

  CREATE TABLE chat_interrupts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    interrupt_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'cancelled')),
    requested_at INTEGER NOT NULL,
    resolved_at INTEGER,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    -- NULL means no response; a JSON null response is stored as the text 'null'.
    response TEXT CHECK (response IS NULL OR json_valid(response))
  );
  CREATE INDEX chat_interrupts_thread ON chat_interrupts(thread_id, requested_at, seq);
  CREATE INDEX chat_interrupts_run ON chat_interrupts(run_id, requested_at, seq);

  CREATE TABLE chat_metadata (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    PRIMARY KEY (namespace, key)
  );
  `,
  `
  -- Messages the user sent while a run was answering, in order, until they reach the agent.
  -- waiting: goes at the next tool-call boundary, or as the next turn when the run completes.
  -- editing: being edited (draft holds unsaved text); it and everything after it wait.
  -- held: restored after a restart, cancel or failure; sent only once the user confirms.
  -- Times are epoch milliseconds.
  CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    attachment_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachment_ids)),
    state TEXT NOT NULL CHECK (state IN ('waiting', 'editing', 'held', 'delivered', 'failed')),
    draft TEXT,
    delivered_via TEXT CHECK (delivered_via IN ('tool_boundary', 'steer', 'next_turn')),
    run_id TEXT,
    in_transcript INTEGER NOT NULL DEFAULT 0 CHECK (in_transcript IN (0, 1)),
    failure TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((state = 'delivered') = (delivered_via IS NOT NULL))
  );
  CREATE INDEX queued_messages_session ON queued_messages(session_id, seq);
  `,
  `
  -- What llm-interpret concluded about a statement, and why. 'applied' rows also exist as llm
  -- edges; 'unconfirmed' ones (an unclear correction target) never become edges and are shown as
  -- questions for the user instead. Times are ISO strings like nodes.
  CREATE TABLE interpretations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK (kind IN ('about', 'corrects', 'retracts', 'related')),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    status TEXT NOT NULL CHECK (status IN ('applied', 'unconfirmed')),
    reason TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX interpretations_node ON interpretations(node_id);
  CREATE INDEX interpretations_target ON interpretations(target_id, status);
  `,
  `
  -- MCP servers the user trusted enough to start. Trust covers one exact configuration
  -- (fingerprint): a changed command, URL or environment needs trusting again. Global servers use
  -- project_id ''. Starting a server never approves its tool calls. Times are ISO strings.
  CREATE TABLE mcp_trust (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    trusted_at TEXT NOT NULL,
    PRIMARY KEY (scope, project_id, name),
    CHECK ((scope = 'global') = (project_id = ''))
  );
  `,
  `
  -- Child agents a session's runs delegated to. name is NULL for a one-off run; a named child keeps
  -- its conversation (chat_threads, thread id 'subagent-<id>') for later messages in the session.
  -- A child still running when the server stops becomes 'interrupted' and is never rerun on its
  -- own. Times are epoch milliseconds.
  CREATE TABLE subagents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    name TEXT,
    instructions TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    parent_run_id TEXT NOT NULL,
    last_task TEXT NOT NULL,
    last_answer TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX subagents_name ON subagents(session_id, name) WHERE name IS NOT NULL;
  CREATE INDEX subagents_session ON subagents(session_id, created_at);
  `,
  `
  -- External ACP agents the user trusted enough to start, like mcp_trust: one exact configuration,
  -- global ones with project_id ''. Starting an agent never approves what it asks to do.
  CREATE TABLE agent_trust (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    trusted_at TEXT NOT NULL,
    PRIMARY KEY (scope, project_id, name),
    CHECK ((scope = 'global') = (project_id = ''))
  );
  `,
  `
  -- A conversation held directly with an external ACP agent instead of the app's own model.
  ALTER TABLE sessions ADD COLUMN agent TEXT;
  `,
  `
  -- Korean morpheme terms of each node (nouns, stems, roots, foreign words), space separated, so a
  -- question matches statements that use the same words with different particles and endings.
  -- rowid is the node seq. node_morphs records which analyzer produced a node's terms.
  CREATE VIRTUAL TABLE nodes_morph USING fts5(terms, tokenize = 'unicode61');
  CREATE TABLE node_morphs (
    node_seq INTEGER PRIMARY KEY REFERENCES nodes(seq),
    analyzer TEXT NOT NULL
  );
  `,
  `
  -- An archived conversation leaves the session list but keeps its messages and memory.
  ALTER TABLE sessions ADD COLUMN archived_at TEXT;
  `,
  `
  -- Conversations migrated from another coding agent's local history (Claude Code, Codex CLI).
  -- The transcripts stay where that tool wrote them; this side keeps nodes with the original times.

  -- Which tool a conversation came from; NULL for one held in this app.
  ALTER TABLE sessions ADD COLUMN imported_from TEXT;

  -- One transcript becomes one session, so a rescan never starts a second one for it.
  CREATE TABLE imported_sessions (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    PRIMARY KEY (source, external_id)
  );

  -- Lines that already became nodes. Nodes are immutable evidence, so a duplicate is contamination;
  -- this is what makes rereading a transcript add only what is new.
  CREATE TABLE imported_nodes (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    PRIMARY KEY (source, external_id)
  );

  -- How far each transcript was read. A file whose size or mtime disagrees with the cursor was
  -- truncated or rewritten: it is read from the start again and imported_nodes drops the repeats.
  -- skipped says why a file produced nothing, e.g. 'no_project'; cwd is the folder it ran in, so
  -- the settings screen can name the folders the user would have to register first.
  -- Times are ISO strings.
  CREATE TABLE import_cursors (
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    external_id TEXT,
    cwd TEXT,
    byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    imported INTEGER NOT NULL DEFAULT 0 CHECK (imported >= 0),
    skipped TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, path)
  );
  CREATE INDEX import_cursors_skipped ON import_cursors(skipped, cwd);
  `,
  `
  -- A project taken out of the sidebar. Its sessions, nodes, edges and search are untouched; this
  -- only decides whether it is offered for choosing. Migration registers folders on its own, so
  -- there has to be a way to tidy the list without losing what was remembered there.
  ALTER TABLE projects ADD COLUMN hidden_at TEXT;
  `,
  `
  -- Text stored before secrets were hidden on the way in is swept once, in place.
  --
  -- Nodes stay immutable evidence; the one exception is a sweep hiding a secret in a node's text.
  -- It writes a permit for that node, changes the text and removes the permit in one transaction.
  -- Without a permit, or when anything but the text changes, the update is refused as before.
  CREATE TABLE secret_sweep_permits (node_seq INTEGER PRIMARY KEY);
  DROP TRIGGER nodes_immutable;
  CREATE TRIGGER nodes_immutable BEFORE UPDATE ON nodes
  WHEN NOT (
    EXISTS (SELECT 1 FROM secret_sweep_permits WHERE node_seq = old.seq)
    AND new.seq = old.seq AND new.id = old.id AND new.project_id = old.project_id
    AND new.session_id IS old.session_id AND new.run_id IS old.run_id
    AND new.kind = old.kind AND new.detail = old.detail AND new.created_at = old.created_at
  )
  BEGIN SELECT RAISE(ABORT, 'nodes are immutable evidence'); END;

  -- How far the sweep of each table has got, by rowid, and whether its latest pass reached the end.
  -- Tables that only grow resume from here on the next start; tables rewritten in place are read in
  -- full every time. version names the detector: a later one that finds more starts again from the
  -- beginning. Times are ISO strings.
  CREATE TABLE secret_sweeps (
    target TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    after INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden >= 0),
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- Why a transcript could not be read on its latest pass (an unreadable file, a line that could
  -- not be written), for settings to show. One such transcript no longer stops the others. It is
  -- tried again on every pass: its size is stored as -1, so it never looks unchanged.
  ALTER TABLE import_cursors ADD COLUMN failure TEXT;
  `,
  `
  -- Only statements are embedded from now on (user, assistant, topic: embeddedKinds in the indexer).
  -- Tool calls and results are found by text match and reached from the statements around them.
  -- Their vector records go; opening the vector index then drops their vectors too.
  DELETE FROM node_vectors
  WHERE node_seq IN (SELECT seq FROM nodes WHERE kind NOT IN ('user', 'assistant', 'topic'));
  `,
  `
  -- Goal/Plan are durable workflow artifacts, not prompt text. Keeping the versioned state outside
  -- the transcript lets each run materialize only its current phase and step-sized context.
  CREATE TABLE session_workflows (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- Full mode bypasses approval prompts and the classifier, while all path and credential
  -- restrictions remain enforced. Keep the older permission_mode constraint for compatibility.
  ALTER TABLE projects ADD COLUMN permission_full INTEGER NOT NULL DEFAULT 0
    CHECK (permission_full IN (0, 1));
  `,
  `
  -- Work Trace keeps logical tasks and app-owned attempts separate from TanStack chat_runs. The SDK
  -- may create its run row after an attempt is claimed, so chat_run_id is a stable unique reference
  -- rather than a foreign key. Times are epoch milliseconds.
  CREATE TABLE work_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_task_id TEXT REFERENCES work_tasks(id),
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES subagents(id),
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting', 'blocked', 'interrupted', 'resumable', 'resuming',
      'completed', 'failed', 'cancelled'
    )),
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    active_attempt_id TEXT REFERENCES agent_run_attempts(id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX work_tasks_session ON work_tasks(session_id, created_at, id);
  CREATE INDEX work_tasks_parent ON work_tasks(parent_task_id, created_at, id);
  CREATE INDEX work_tasks_parent_call ON work_tasks(parent_run_id, parent_tool_call_id);

  CREATE TABLE agent_invocations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'steer', 'resume')),
    status TEXT NOT NULL CHECK (status IN (
      'accepted', 'steered', 'running', 'completed', 'failed', 'cancelled'
    )),
    message TEXT NOT NULL,
    target_attempt_id TEXT REFERENCES agent_run_attempts(id) DEFERRABLE INITIALLY DEFERRED,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX agent_invocations_task ON agent_invocations(task_id, created_at, id);
  CREATE INDEX agent_invocations_parent_call
    ON agent_invocations(parent_run_id, parent_tool_call_id, created_at);

  CREATE TABLE agent_run_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL UNIQUE REFERENCES agent_invocations(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    chat_run_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting', 'blocked', 'interrupted', 'completed', 'failed', 'cancelled'
    )),
    resumed_from_attempt_id TEXT REFERENCES agent_run_attempts(id),
    superseded_by_attempt_id TEXT REFERENCES agent_run_attempts(id),
    resume_reason TEXT CHECK (resume_reason IS NULL OR resume_reason IN (
      'server_restarted', 'connection_lost', 'provider_failed', 'user_cancelled',
      'approval_expired', 'unknown'
    )),
    resumability TEXT NOT NULL DEFAULT '{"state":"not_needed"}' CHECK (json_valid(resumability)),
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (task_id, attempt_number),
    UNIQUE (id, task_id),
    CHECK (resumed_from_attempt_id IS NULL OR resumed_from_attempt_id <> id),
    CHECK (superseded_by_attempt_id IS NULL OR superseded_by_attempt_id <> id)
  );
  CREATE INDEX agent_run_attempts_task ON agent_run_attempts(task_id, attempt_number);
  CREATE INDEX agent_run_attempts_thread ON agent_run_attempts(thread_id, created_at, id);
  CREATE UNIQUE INDEX agent_run_attempts_one_active
    ON agent_run_attempts(task_id)
    WHERE status IN ('queued', 'running', 'waiting', 'blocked');

  -- seq is the durable, monotonically increasing session-SSE cursor. attempt_sequence preserves
  -- order within one producer and makes retries idempotent.
  CREATE TABLE run_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
    kind TEXT NOT NULL CHECK (kind IN (
      'attempt_queued', 'attempt_started', 'activity', 'tool_requested', 'approval_waiting',
      'approval_resolved', 'tool_started', 'tool_completed', 'tool_failed', 'tool_uncertain',
      'steered', 'checkpoint_created', 'attempt_interrupted', 'attempt_completed',
      'attempt_failed', 'attempt_cancelled', 'resume_requested', 'resume_started',
      'report_returned', 'report_reviewed', 'report_used', 'report_not_used',
      'report_superseded'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'internal')),
    redaction TEXT NOT NULL CHECK (redaction IN ('clear', 'redacted', 'omitted')),
    summary TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    occurred_at INTEGER NOT NULL,
    UNIQUE (attempt_id, attempt_sequence)
  );
  CREATE INDEX run_events_session_cursor ON run_events(session_id, seq);
  CREATE INDEX run_events_task_cursor ON run_events(task_id, seq);
  CREATE INDEX run_events_attempt ON run_events(attempt_id, attempt_sequence);

  CREATE TABLE work_checkpoints (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    transcript_message_id TEXT,
    completed_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_tool_call_ids)),
    uncertain_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncertain_tool_call_ids)),
    pending_approval_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_approval_ids)),
    remaining_work TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, event_sequence)
  );
  CREATE INDEX work_checkpoints_task ON work_checkpoints(task_id, created_at, id);

  CREATE TABLE evidence_refs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message', 'tool_call', 'tool_result', 'artifact', 'checkpoint', 'memory'
    )),
    source_id TEXT NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN (
      'unverified', 'verified', 'invalidated', 'unavailable'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'internal')),
    redaction TEXT NOT NULL CHECK (redaction IN ('clear', 'redacted', 'omitted')),
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, source_kind, source_id)
  );
  CREATE INDEX evidence_refs_task ON evidence_refs(task_id, created_at, id);

  -- Append-only adoption history: returning a report is distinct from reviewing or using it.
  CREATE TABLE report_adoptions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    disposition TEXT NOT NULL CHECK (disposition IN (
      'returned', 'reviewed', 'used', 'not_used', 'superseded'
    )),
    superseded_by_attempt_id TEXT REFERENCES agent_run_attempts(id),
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX report_adoptions_task ON report_adoptions(task_id, seq);
  CREATE INDEX report_adoptions_attempt ON report_adoptions(attempt_id, seq);
  `,
  `
  -- Work Trace belongs to a project, not to the conversation that happened to start it. Rebuild the
  -- graph as one deferred-FK migration so deleting a session or its subagent identity only clears
  -- nullable origin pointers; Task/Attempt/Evidence provenance remains durable.
  PRAGMA defer_foreign_keys = ON;

  CREATE TABLE work_tasks_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_task_id TEXT REFERENCES work_tasks_v2(id),
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    agent_id TEXT REFERENCES subagents(id) ON DELETE SET NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting', 'blocked', 'interrupted', 'resumable', 'resuming',
      'completed', 'failed', 'cancelled', 'archived'
    )),
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    active_attempt_id TEXT REFERENCES agent_run_attempts_v2(id) DEFERRABLE INITIALLY DEFERRED,
    origin_deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE agent_invocations_v2 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'steer', 'resume', 'recover')),
    status TEXT NOT NULL CHECK (status IN (
      'accepted', 'steered', 'running', 'completed', 'failed', 'cancelled'
    )),
    message TEXT NOT NULL,
    target_attempt_id TEXT REFERENCES agent_run_attempts_v2(id) DEFERRABLE INITIALLY DEFERRED,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE agent_run_attempts_v2 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL UNIQUE REFERENCES agent_invocations_v2(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    chat_run_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting', 'blocked', 'interrupted', 'completed', 'failed', 'cancelled'
    )),
    resumed_from_attempt_id TEXT REFERENCES agent_run_attempts_v2(id),
    superseded_by_attempt_id TEXT REFERENCES agent_run_attempts_v2(id),
    resume_reason TEXT CHECK (resume_reason IS NULL OR resume_reason IN (
      'server_restarted', 'connection_lost', 'provider_failed', 'user_cancelled',
      'approval_expired', 'unknown'
    )),
    resumability TEXT NOT NULL DEFAULT '{"state":"not_needed"}' CHECK (json_valid(resumability)),
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (task_id, attempt_number),
    UNIQUE (id, task_id),
    CHECK (resumed_from_attempt_id IS NULL OR resumed_from_attempt_id <> id),
    CHECK (superseded_by_attempt_id IS NULL OR superseded_by_attempt_id <> id)
  );

  CREATE TABLE run_events_v2 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL REFERENCES agent_invocations_v2(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts_v2(id) ON DELETE CASCADE,
    attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
    kind TEXT NOT NULL CHECK (kind IN (
      'attempt_queued', 'attempt_started', 'activity', 'tool_requested', 'approval_waiting',
      'approval_resolved', 'tool_started', 'tool_completed', 'tool_failed', 'tool_uncertain',
      'steered', 'checkpoint_created', 'attempt_interrupted', 'attempt_completed',
      'attempt_failed', 'attempt_cancelled', 'resume_requested', 'resume_started',
      'report_returned', 'report_reviewed', 'report_used', 'report_not_used',
      'report_superseded', 'recovery_queued', 'recovery_blocked', 'parent_notified',
      'task_archived'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'internal')),
    redaction TEXT NOT NULL CHECK (redaction IN ('clear', 'redacted', 'omitted')),
    summary TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    occurred_at INTEGER NOT NULL,
    UNIQUE (attempt_id, attempt_sequence)
  );

  CREATE TABLE work_checkpoints_v2 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts_v2(id) ON DELETE CASCADE,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    transcript_message_id TEXT,
    completed_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_tool_call_ids)),
    uncertain_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncertain_tool_call_ids)),
    pending_approval_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_approval_ids)),
    remaining_work TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, event_sequence)
  );

  CREATE TABLE evidence_refs_v2 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts_v2(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message', 'tool_call', 'tool_result', 'artifact', 'checkpoint', 'memory'
    )),
    source_id TEXT NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN (
      'unverified', 'verified', 'invalidated', 'unavailable'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'internal')),
    redaction TEXT NOT NULL CHECK (redaction IN ('clear', 'redacted', 'omitted')),
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, source_kind, source_id)
  );

  CREATE TABLE report_adoptions_v2 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES work_tasks_v2(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts_v2(id) ON DELETE CASCADE,
    disposition TEXT NOT NULL CHECK (disposition IN (
      'returned', 'reviewed', 'used', 'not_used', 'superseded'
    )),
    superseded_by_attempt_id TEXT REFERENCES agent_run_attempts_v2(id),
    updated_at INTEGER NOT NULL
  );

  INSERT INTO work_tasks_v2
    (id, project_id, origin_session_id, parent_task_id, parent_run_id, parent_tool_call_id,
     agent_id, agent_name, status, title, request, active_attempt_id, origin_deleted_at,
     created_at, updated_at)
  SELECT t.id, s.project_id, t.session_id, t.parent_task_id, t.parent_run_id,
         t.parent_tool_call_id, t.agent_id, coalesce(a.name, 'deleted subagent'), t.status,
         t.title, t.request, t.active_attempt_id, NULL, t.created_at, t.updated_at
  FROM work_tasks t
  JOIN sessions s ON s.id = t.session_id
  LEFT JOIN subagents a ON a.id = t.agent_id;
  INSERT INTO agent_invocations_v2 SELECT * FROM agent_invocations;
  INSERT INTO agent_run_attempts_v2 SELECT * FROM agent_run_attempts;
  INSERT INTO run_events_v2
    (seq, id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
     visibility, redaction, summary, payload, occurred_at)
  SELECT seq, id, session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
         visibility, redaction, summary, payload, occurred_at FROM run_events;
  INSERT INTO work_checkpoints_v2 SELECT * FROM work_checkpoints;
  INSERT INTO evidence_refs_v2 SELECT * FROM evidence_refs;
  INSERT INTO report_adoptions_v2 SELECT * FROM report_adoptions;

  DROP TABLE report_adoptions;
  DROP TABLE evidence_refs;
  DROP TABLE work_checkpoints;
  DROP TABLE run_events;
  DROP TABLE agent_run_attempts;
  DROP TABLE agent_invocations;
  DROP TABLE work_tasks;

  ALTER TABLE work_tasks_v2 RENAME TO work_tasks;
  ALTER TABLE agent_invocations_v2 RENAME TO agent_invocations;
  ALTER TABLE agent_run_attempts_v2 RENAME TO agent_run_attempts;
  ALTER TABLE run_events_v2 RENAME TO run_events;
  ALTER TABLE work_checkpoints_v2 RENAME TO work_checkpoints;
  ALTER TABLE evidence_refs_v2 RENAME TO evidence_refs;
  ALTER TABLE report_adoptions_v2 RENAME TO report_adoptions;

  CREATE INDEX work_tasks_project ON work_tasks(project_id, created_at, id);
  CREATE INDEX work_tasks_origin_session ON work_tasks(origin_session_id, created_at, id);
  CREATE INDEX work_tasks_parent ON work_tasks(parent_task_id, created_at, id);
  CREATE INDEX work_tasks_parent_call ON work_tasks(parent_run_id, parent_tool_call_id);
  CREATE INDEX agent_invocations_task ON agent_invocations(task_id, created_at, id);
  CREATE INDEX agent_invocations_parent_call
    ON agent_invocations(parent_run_id, parent_tool_call_id, created_at);
  CREATE INDEX agent_run_attempts_task ON agent_run_attempts(task_id, attempt_number);
  CREATE INDEX agent_run_attempts_thread ON agent_run_attempts(thread_id, created_at, id);
  CREATE UNIQUE INDEX agent_run_attempts_one_active
    ON agent_run_attempts(task_id)
    WHERE status IN ('queued', 'running', 'waiting', 'blocked');
  CREATE INDEX run_events_origin_cursor ON run_events(origin_session_id, seq);
  CREATE INDEX run_events_task_cursor ON run_events(task_id, seq);
  CREATE INDEX run_events_attempt ON run_events(attempt_id, attempt_sequence);
  CREATE INDEX work_checkpoints_task ON work_checkpoints(task_id, created_at, id);
  CREATE INDEX evidence_refs_task ON evidence_refs(task_id, created_at, id);
  CREATE INDEX report_adoptions_task ON report_adoptions(task_id, seq);
  CREATE INDEX report_adoptions_attempt ON report_adoptions(attempt_id, seq);

  CREATE TABLE parent_notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'stopped', 'interrupted', 'archived', 'deleted', 'resume_blocked',
      'resumed', 'completed', 'failed'
    )),
    summary TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    idempotency_key TEXT NOT NULL UNIQUE,
    delivered_to_run_id TEXT,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX parent_notifications_pending
    ON parent_notifications(origin_session_id, delivered_at, seq);
  CREATE INDEX parent_notifications_task ON parent_notifications(task_id, seq);

  CREATE TABLE work_recovery_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL UNIQUE REFERENCES work_tasks(id) ON DELETE CASCADE,
    interrupted_attempt_id TEXT NOT NULL UNIQUE REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'blocked', 'claimed', 'completed', 'failed')),
    blocker TEXT CHECK (blocker IS NULL OR blocker IN (
      'missing_checkpoint', 'uncertain_side_effect', 'approval_expired', 'origin_deleted',
      'agent_deleted'
    )),
    claimed_by TEXT,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX work_recovery_jobs_status ON work_recovery_jobs(status, created_at, id);
  `,
  `
  -- A user-confirmed HTTP resume remains a durable server-owned request until a valid parent
  -- execution binding claims it. Startup-created automatic jobs keep the safe default (false).
  ALTER TABLE work_recovery_jobs
    ADD COLUMN confirm_uncertain INTEGER NOT NULL DEFAULT 0
      CHECK (confirm_uncertain IN (0, 1));
  `,
  `
  -- Archive is an orthogonal visibility/lifecycle marker. The underlying execution status stays
  -- available for unarchive and retention policy decisions added by the full lifecycle step.
  ALTER TABLE work_tasks ADD COLUMN archived_at INTEGER;
  `,
  `
  -- Earlier Work Trace builds applied the attempt table without its composite unique key.
  -- Repair those databases before copying evidence with the new task/attempt foreign key;
  -- editing an already-applied CREATE TABLE does not update an existing database.
  CREATE UNIQUE INDEX IF NOT EXISTS agent_run_attempts_id_task
    ON agent_run_attempts(id, task_id);

  -- Evidence stores typed locators rather than transcript/tool/file payloads. Explicit source
  -- deletion clears that locator atomically while preserving only Task/Attempt provenance.
  CREATE TABLE evidence_refs_v3 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message', 'tool_call', 'tool_result', 'file', 'artifact', 'checkpoint', 'memory'
    )),
    locator TEXT CHECK (locator IS NULL OR json_valid(locator)),
    verification TEXT NOT NULL CHECK (verification IN (
      'unverified', 'verified', 'invalidated', 'unavailable', 'source_deleted'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'internal')),
    redaction TEXT NOT NULL CHECK (redaction IN ('clear', 'redacted', 'omitted')),
    source_deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (attempt_id, source_kind, locator),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE,
    CHECK (
      (verification = 'source_deleted' AND locator IS NULL AND source_deleted_at IS NOT NULL)
      OR
      (verification <> 'source_deleted' AND locator IS NOT NULL AND source_deleted_at IS NULL)
    )
  );

  INSERT INTO evidence_refs_v3
    (id, task_id, attempt_id, source_kind, locator, verification, visibility, redaction,
     source_deleted_at, created_at, updated_at)
  SELECT e.id, e.task_id, e.attempt_id, e.source_kind,
         CASE e.source_kind
           WHEN 'message' THEN json_object('kind', 'message', 'threadId', a.thread_id,
                                            'messageId', e.source_id)
           WHEN 'tool_call' THEN json_object('kind', 'tool_call', 'threadId', a.thread_id,
                                              'toolCallId', e.source_id)
           WHEN 'tool_result' THEN json_object('kind', 'tool_result', 'threadId', a.thread_id,
                                                'toolCallId', e.source_id)
           WHEN 'artifact' THEN json_object('kind', 'artifact', 'artifactId', e.source_id)
           WHEN 'checkpoint' THEN json_object('kind', 'checkpoint', 'checkpointId', e.source_id)
           WHEN 'memory' THEN json_object('kind', 'memory', 'memoryId', e.source_id)
         END,
         e.verification, e.visibility, e.redaction, NULL, e.created_at, e.created_at
  FROM evidence_refs e JOIN agent_run_attempts a ON a.id = e.attempt_id;

  DROP TABLE evidence_refs;
  ALTER TABLE evidence_refs_v3 RENAME TO evidence_refs;
  CREATE INDEX evidence_refs_task ON evidence_refs(task_id, created_at, id);
  CREATE INDEX evidence_refs_attempt ON evidence_refs(attempt_id, created_at, id);

  -- Artifact rows carry only locator metadata. Their bytes/content stay in the owning file or
  -- artifact store, and a source-deleted tombstone retains no path, reference, media type or hash.
  CREATE TABLE work_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'generated', 'external')),
    locator TEXT CHECK (locator IS NULL OR json_valid(locator)),
    media_type TEXT,
    verification TEXT NOT NULL CHECK (verification IN (
      'unverified', 'verified', 'invalidated', 'unavailable', 'source_deleted'
    )),
    source_deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (attempt_id, kind, locator),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE,
    CHECK (
      (verification = 'source_deleted' AND locator IS NULL AND media_type IS NULL
       AND source_deleted_at IS NOT NULL)
      OR
      (verification <> 'source_deleted' AND locator IS NOT NULL AND source_deleted_at IS NULL)
    )
  );
  CREATE INDEX work_artifacts_task ON work_artifacts(task_id, created_at, id);
  CREATE INDEX work_artifacts_attempt ON work_artifacts(attempt_id, created_at, id);
  `,
  `
  -- Report disposition is append-only. Parent run/message locators connect review and adoption to
  -- the answer that consumed a report without copying answer or report text into Work Trace.
  ALTER TABLE report_adoptions ADD COLUMN parent_run_id TEXT;
  ALTER TABLE report_adoptions ADD COLUMN parent_message_id TEXT;
  ALTER TABLE report_adoptions ADD COLUMN claim_id TEXT;

  CREATE TABLE final_answer_claims (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_run_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (parent_run_id, parent_message_id)
  );

  -- One row per evidence ref makes every adopted final-answer claim directly traversable to the
  -- Task and Attempt that produced it. An adopted report with no evidence still gets one null row.
  CREATE TABLE final_answer_sources (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    evidence_ref_id TEXT REFERENCES evidence_refs(id) ON DELETE SET NULL,
    UNIQUE (claim_id, evidence_ref_id),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE
  );
  CREATE INDEX final_answer_sources_task ON final_answer_sources(task_id, claim_id);

  -- Operational stop/archive/delete notifications are separately linked when the parent says they
  -- affected its final answer. The notification payload remains in its existing durable inbox row.
  CREATE TABLE final_answer_notifications (
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    notification_id TEXT NOT NULL REFERENCES parent_notifications(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (claim_id, notification_id)
  );
  CREATE INDEX final_answer_notifications_task ON final_answer_notifications(task_id, claim_id);
  `,
  `
  -- User-governed knowledge promotion. Decision/candidate text is stored once here; a saved
  -- candidate is also projected as a project-owned topic node so existing recall can find it.
  CREATE TABLE knowledge_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    authorized_by_user_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    authorized_by_user_node_id_snapshot TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    status TEXT NOT NULL CHECK (status IN ('saved', 'edited_saved', 'conversation_only', 'rejected')),
    created_at INTEGER NOT NULL,
    UNIQUE (claim_id, authorized_by_user_node_id, text, status),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE
  );
  CREATE INDEX knowledge_decisions_task ON knowledge_decisions(task_id, created_at, id);

  CREATE TABLE memory_candidates (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE REFERENCES knowledge_decisions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    proposed_text TEXT NOT NULL CHECK (length(trim(proposed_text)) > 0),
    resolved_text TEXT NOT NULL CHECK (length(trim(resolved_text)) > 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('saved', 'edited_saved', 'conversation_only', 'rejected')),
    memory_node_id TEXT REFERENCES nodes(id),
    created_at INTEGER NOT NULL,
    CHECK ((disposition IN ('saved', 'edited_saved')) = (memory_node_id IS NOT NULL))
  );
  CREATE INDEX memory_candidates_project ON memory_candidates(project_id, created_at, id);

  -- Keep the source id snapshot when a later privacy purge removes the Evidence row. Locator text
  -- and report bodies are intentionally absent from this durable provenance join.
  CREATE TABLE memory_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES memory_candidates(id) ON DELETE CASCADE,
    evidence_ref_id TEXT REFERENCES evidence_refs(id) ON DELETE SET NULL,
    evidence_ref_id_snapshot TEXT NOT NULL,
    source_deleted_at INTEGER,
    PRIMARY KEY (candidate_id, evidence_ref_id_snapshot)
  );
  CREATE INDEX memory_candidate_evidence_ref ON memory_candidate_evidence(evidence_ref_id);

  -- Retrieval is distinct from actual answer use. Used rows are attached to the assistant
  -- message at run finish; retrieved-only memories remain visible as such.
  CREATE TABLE memory_usage_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES memory_candidates(id) ON DELETE CASCADE,
    memory_node_id TEXT NOT NULL REFERENCES nodes(id),
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_run_id TEXT NOT NULL,
    parent_message_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('retrieved', 'used')),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX memory_usage_once
    ON memory_usage_events(candidate_id, parent_run_id, kind, coalesce(parent_message_id, ''));
  CREATE INDEX memory_usage_task ON memory_usage_events(candidate_id, created_at, id);
  `,
  `
  -- Durable lifecycle operations make archive/delete retries and crash recovery observable.
  -- A Task is retained as a payload-free tombstone because deleting it would cascade into adopted
  -- answer and memory provenance. Receipts contain counts and categories only, never source text.
  CREATE TABLE lifecycle_operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('task', 'session')),
    target_id TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('archive', 'restore', 'delete')),
    status TEXT NOT NULL CHECK (status IN ('requested', 'cancelling', 'waiting_for_stop', 'purging', 'completed', 'blocked', 'failed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    blocker TEXT,
    requested_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE UNIQUE INDEX lifecycle_one_active_target
    ON lifecycle_operations(target_kind, target_id)
    WHERE status IN ('requested', 'cancelling', 'waiting_for_stop', 'purging');
  CREATE INDEX lifecycle_pending ON lifecycle_operations(status, updated_at, id);

  CREATE TABLE purge_receipts (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES lifecycle_operations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('task', 'session')),
    target_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    purged_counts TEXT NOT NULL CHECK (json_valid(purged_counts)),
    retained_kinds TEXT NOT NULL CHECK (json_valid(retained_kinds)),
    completed_at INTEGER NOT NULL
  );

  ALTER TABLE work_tasks ADD COLUMN delete_requested_at INTEGER;
  ALTER TABLE work_tasks ADD COLUMN deleted_at INTEGER;
  ALTER TABLE work_tasks ADD COLUMN purge_receipt_id TEXT REFERENCES purge_receipts(id);
  CREATE INDEX work_tasks_lifecycle ON work_tasks(project_id, deleted_at, archived_at, updated_at, id);
  `,
  `
  -- One row per provider response, including auxiliary calls. Counts only; never prompt content.
  -- Cache reads are a subset of input for OpenAI, but separate from input for Anthropic.
  CREATE TABLE api_usage_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_session_id TEXT NOT NULL,
    run_id TEXT,
    thread_id TEXT,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
    cache_mode TEXT NOT NULL CHECK (cache_mode IN ('included', 'separate')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX api_usage_responses_session ON api_usage_responses(root_session_id, id);
  `,
  `
  -- A cancelled or stopped session keeps child notifications for the next explicit user turn.
  -- This is workflow policy, so it survives a server restart without a process-wide Set.
  CREATE TABLE parent_notification_holds (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    held_at INTEGER NOT NULL
  );
  `,
  `
  -- Compaction asks for individual tool results; avoid scanning a session's full result history.
  CREATE INDEX nodes_tool_result_call
    ON nodes(session_id, json_extract(detail, '$.toolCallId'), seq)
    WHERE kind = 'tool_result';
  `,
  `
  -- Dedicated local report conversations are bound to one source; repeat opens reuse the same report.
  CREATE TABLE report_sessions (
    report_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    source_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    created_at TEXT NOT NULL,
    CHECK (report_session_id <> source_session_id)
  );
  `,
  `
  -- Secret-free local OAuth profiles. Tokens live only in per-profile OS keychain entries.
  CREATE TABLE oauth_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
    label TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_profiles_provider ON oauth_profiles(provider, created_at);
  CREATE UNIQUE INDEX oauth_profiles_one_selected ON oauth_profiles(provider) WHERE selected = 1;
  `,
  `
  -- Explicit account removal must not be reversed by legacy auto-import on the next auth poll.
  CREATE TABLE oauth_legacy_removed (
    provider TEXT PRIMARY KEY CHECK (provider IN ('openai', 'anthropic')),
    removed_at INTEGER NOT NULL
  );
  `,
  `
  -- Preserve workflow evidence as full immutable revisions, without guessing historical Goals.
  -- Legacy rows contribute only their last known state; earlier versions cannot be reconstructed.
  CREATE TABLE workflow_state_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    goal_version INTEGER,
    plan_version INTEGER,
    provenance TEXT NOT NULL CHECK (provenance IN ('legacy_current', 'recorded')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX workflow_state_revisions_session ON workflow_state_revisions(session_id, id);
  CREATE TRIGGER workflow_state_revisions_no_update BEFORE UPDATE ON workflow_state_revisions
    BEGIN SELECT RAISE(ABORT, 'workflow revisions are immutable'); END;
  INSERT INTO workflow_state_revisions (session_id, state_json, goal_version, plan_version, provenance, created_at)
    SELECT session_id, state_json,
      json_extract(state_json, '$.goal.version'), json_extract(state_json, '$.plan.version'),
      'legacy_current', updated_at
    FROM session_workflows;
  `,
  `
  -- Newly created Goals get a durable identity independent of their version or worker.
  -- Existing sessions are deliberately unbound until an explicit verified transition.
  CREATE TABLE workflow_goal_identities (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  ALTER TABLE workflow_state_revisions ADD COLUMN goal_instance_id TEXT;
  CREATE INDEX workflow_revisions_goal ON workflow_state_revisions(goal_instance_id, id);
  `,
  `
  -- A run's Goal/Plan identity is immutable even if the current workflow later changes.
  -- Old runs remain unbound; only newly authorized Goals may be bound by the owner.
  CREATE TABLE workflow_run_bindings (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT NOT NULL REFERENCES workflow_goal_identities(goal_instance_id),
    goal_version INTEGER NOT NULL CHECK (goal_version > 0),
    plan_version INTEGER,
    workflow_revision_id INTEGER NOT NULL REFERENCES workflow_state_revisions(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX workflow_run_bindings_session ON workflow_run_bindings(session_id, run_id);
  CREATE TRIGGER workflow_run_bindings_no_update BEFORE UPDATE ON workflow_run_bindings
    BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
  `,
  `
  -- Owner-only receipt log for bound run output. Legacy in-memory SSE is not backfilled.
  CREATE TABLE workflow_run_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('chunk', 'run_error', 'run_completed')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, event_key)
  );
  CREATE INDEX workflow_run_events_replay ON workflow_run_events(run_id, cursor);
  CREATE TRIGGER workflow_run_events_no_update BEFORE UPDATE ON workflow_run_events
    BEGIN SELECT RAISE(ABORT, 'run event is immutable'); END;
  `,
  `
  -- Earlier owner writes are checked before tightening the insert boundary. Never silently
  -- relabel or discard a bad binding: a failed migration leaves the old DB intact.
  CREATE TEMP TABLE workflow_binding_check (valid INTEGER NOT NULL CHECK (valid = 1));
  INSERT INTO workflow_binding_check (valid)
    SELECT 0 FROM workflow_run_bindings b
    LEFT JOIN workflow_goal_identities g
      ON g.session_id = b.session_id AND g.goal_instance_id = b.goal_instance_id
    LEFT JOIN workflow_state_revisions r
      ON r.id = b.workflow_revision_id AND r.session_id = b.session_id
      AND r.goal_instance_id = b.goal_instance_id AND r.goal_version = b.goal_version
      AND r.plan_version IS b.plan_version
    WHERE g.session_id IS NULL OR r.id IS NULL;
  DROP TABLE workflow_binding_check;
  CREATE TRIGGER workflow_run_bindings_owner_insert BEFORE INSERT ON workflow_run_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_goal_identities g
      JOIN workflow_state_revisions r
        ON r.id = NEW.workflow_revision_id AND r.session_id = NEW.session_id
        AND r.goal_instance_id = NEW.goal_instance_id AND r.goal_version = NEW.goal_version
        AND r.plan_version IS NEW.plan_version
      WHERE g.session_id = NEW.session_id AND g.goal_instance_id = NEW.goal_instance_id
    )
    BEGIN SELECT RAISE(ABORT, 'run binding session mismatch'); END;
  `,
  `
  -- Per-storage, resumable semantic repairs. Original nodes are never deleted or rewritten.
  CREATE TABLE memory_graph_maintenance (
    version INTEGER PRIMARY KEY,
    through_seq INTEGER NOT NULL,
    after_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    scanned INTEGER NOT NULL DEFAULT 0,
    repaired_edges INTEGER NOT NULL DEFAULT 0,
    suppressed_edges INTEGER NOT NULL DEFAULT 0,
    retired_topics INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE memory_graph_edge_repairs (
    version INTEGER NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    weight REAL NOT NULL,
    created_at TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('reverse', 'suppress')),
    replacement_added INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (version, from_id, to_id, kind)
  );
  CREATE TABLE memory_graph_interpretation_repairs (
    version INTEGER NOT NULL,
    interpretation_id INTEGER NOT NULL,
    previous_status TEXT NOT NULL,
    PRIMARY KEY (version, interpretation_id)
  );
  CREATE TABLE memory_graph_topic_candidates (
    node_seq INTEGER PRIMARY KEY REFERENCES nodes(seq)
  );
  CREATE TABLE memory_graph_suppressed_nodes (
    node_seq INTEGER PRIMARY KEY REFERENCES nodes(seq),
    version INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  -- Durable removal intent: saving an index and updating SQLite cannot be one transaction.
  CREATE TABLE memory_graph_vector_removals (
    node_seq INTEGER NOT NULL,
    embedder TEXT NOT NULL,
    PRIMARY KEY (node_seq, embedder)
  );
  `,
  `
  -- A dispatch is reserved once in the central DB before the owner issues an ephemeral worker
  -- capability. Neither worker death nor owner restart may silently dispatch the same run again.
  CREATE TABLE workflow_worker_dispatches (
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER workflow_worker_dispatches_no_update BEFORE UPDATE ON workflow_worker_dispatches
    BEGIN SELECT RAISE(ABORT, 'worker dispatch is immutable'); END;
  `,
  `
  -- Owner-only operation receipts. No legacy backfill: an old run has no provable reservation.
  -- Deploy this schema before using the durable adapter. Roll back code only with a compatible
  -- build; older builds reject the newer user_version. Never drop receipts or lower user_version
  -- to resume uncertain effects. Restore a pre-upgrade backup only in an offline, reconciled DB.
  CREATE TABLE owner_rpc_operations (
    run_id TEXT NOT NULL REFERENCES workflow_run_bindings(run_id),
    run_key TEXT NOT NULL,
    operation_id INTEGER NOT NULL CHECK (operation_id > 0 AND operation_id <= 9007199254740991),
    fingerprint TEXT NOT NULL,
    side_effect INTEGER NOT NULL CHECK (side_effect IN (0, 1)),
    reply_json TEXT NOT NULL CHECK (json_valid(reply_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'uncertain', 'rejected')),
    PRIMARY KEY (run_id, operation_id)
  );
  CREATE INDEX owner_rpc_effects ON owner_rpc_operations(run_id, side_effect, status);
  `,
  `
  -- Immutable catalog plus the unchanged, single-current legacy reader table.
  -- Run bindings keep every column/receipt; only their FK target changes.
  CREATE TABLE workflow_goal_instances (
    goal_instance_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  INSERT INTO workflow_goal_instances (goal_instance_id, session_id, created_at)
    SELECT goal_instance_id, session_id, created_at FROM workflow_goal_identities;
  CREATE TRIGGER workflow_goal_instances_no_update BEFORE UPDATE ON workflow_goal_instances
    BEGIN SELECT RAISE(ABORT, 'goal instance is immutable'); END;
  CREATE TRIGGER workflow_goal_instances_no_delete BEFORE DELETE ON workflow_goal_instances
    BEGIN SELECT RAISE(ABORT, 'goal instance is immutable'); END;
  CREATE TRIGGER workflow_goal_identity_catalog AFTER INSERT ON workflow_goal_identities
    BEGIN INSERT INTO workflow_goal_instances (goal_instance_id, session_id, created_at)
      VALUES (NEW.goal_instance_id, NEW.session_id, NEW.created_at); END;
  CREATE TRIGGER workflow_goal_identity_owner_update BEFORE UPDATE ON workflow_goal_identities
    WHEN NEW.session_id <> OLD.session_id OR NOT EXISTS (
      SELECT 1 FROM workflow_goal_instances g
      WHERE g.goal_instance_id = NEW.goal_instance_id AND g.session_id = NEW.session_id
        AND g.created_at = NEW.created_at
    )
    BEGIN SELECT RAISE(ABORT, 'goal pointer session mismatch'); END;

  CREATE TABLE workflow_run_bindings_copy (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT NOT NULL REFERENCES workflow_goal_instances(goal_instance_id),
    goal_version INTEGER NOT NULL CHECK (goal_version > 0),
    plan_version INTEGER,
    workflow_revision_id INTEGER NOT NULL REFERENCES workflow_state_revisions(id),
    created_at TEXT NOT NULL
  );
  INSERT INTO workflow_run_bindings_copy SELECT * FROM workflow_run_bindings;
  DROP TABLE workflow_run_bindings;
  ALTER TABLE workflow_run_bindings_copy RENAME TO workflow_run_bindings;
  CREATE INDEX workflow_run_bindings_session ON workflow_run_bindings(session_id, run_id);
  CREATE TRIGGER workflow_run_bindings_no_update BEFORE UPDATE ON workflow_run_bindings
    BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
  CREATE TRIGGER workflow_run_bindings_owner_insert BEFORE INSERT ON workflow_run_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_goal_identities g
      JOIN workflow_goal_instances i
        ON i.goal_instance_id = g.goal_instance_id AND i.session_id = g.session_id
      JOIN workflow_state_revisions r
        ON r.id = NEW.workflow_revision_id AND r.session_id = NEW.session_id
        AND r.goal_instance_id = NEW.goal_instance_id AND r.goal_version = NEW.goal_version
        AND r.plan_version IS NEW.plan_version
      WHERE g.session_id = NEW.session_id AND g.goal_instance_id = NEW.goal_instance_id
    )
    BEGIN SELECT RAISE(ABORT, 'run binding session mismatch'); END;
  `,
  `
  -- Source pins are separate from per-run dispatch generations. No legacy backfill:
  -- a historical dispatch cannot prove which execution assets it loaded.
  -- Rollback disables new admission without deleting source/effect evidence; compatible
  -- readers retain this table and never lower user_version to restart an uncertain run.
  CREATE TABLE workflow_goal_worker_generations (
    goal_instance_id TEXT PRIMARY KEY REFERENCES workflow_goal_instances(goal_instance_id),
    source_generation TEXT NOT NULL UNIQUE CHECK (length(source_generation) > 0),
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
    worker_url TEXT NOT NULL CHECK (substr(worker_url, 1, 5) = 'file:'),
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER workflow_goal_worker_generations_no_update BEFORE UPDATE ON workflow_goal_worker_generations
    BEGIN SELECT RAISE(ABORT, 'goal source generation is immutable'); END;
  CREATE TRIGGER workflow_goal_worker_generations_no_delete BEFORE DELETE ON workflow_goal_worker_generations
    BEGIN SELECT RAISE(ABORT, 'goal source generation is immutable'); END;
  `,
  `
  -- Additive owner-generated native registrations. No SDK-only pin backfill.
  -- Rollback retains evidence; disabling native execution never adopts replacement code.
  CREATE TABLE workflow_goal_native_artifacts (
    goal_instance_id TEXT PRIMARY KEY REFERENCES workflow_goal_instances(goal_instance_id),
    artifact_url TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER workflow_goal_native_artifacts_no_update BEFORE UPDATE ON workflow_goal_native_artifacts
    BEGIN SELECT RAISE(ABORT, 'native registration is immutable'); END;
  CREATE TRIGGER workflow_goal_native_artifacts_no_delete BEFORE DELETE ON workflow_goal_native_artifacts
    BEGIN SELECT RAISE(ABORT, 'native registration is immutable'); END;
  `,
  `
  -- A tool call records intent, not a new Goal. Only a completed run can consume it.
  -- Additive migration: do not rewrite legacy phases, run outcomes or Goal history.
  -- Compatible rollback leaves accepted requests inert until this code is restored.
  CREATE TABLE workflow_new_goal_requests (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    previous_goal_instance_id TEXT,
    source_revision_id INTEGER NOT NULL REFERENCES workflow_state_revisions(id),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'applied', 'rejected')),
    reason TEXT,
    applied_goal_instance_id TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX workflow_new_goal_requests_one_pending
    ON workflow_new_goal_requests(session_id) WHERE status = 'accepted';
  `,
  emptyUserMessageMigration,
  `
  CREATE TABLE rrsi_corpus_receipts (version TEXT PRIMARY KEY, experiment_id TEXT NOT NULL);
  CREATE TABLE rrsi_versions (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TABLE rrsi_state (id INTEGER PRIMARY KEY CHECK(id=1), version_id TEXT NOT NULL REFERENCES rrsi_versions(id), settings TEXT NOT NULL CHECK(json_valid(settings)));
  CREATE TABLE rrsi_goal_pins (goal_id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES rrsi_versions(id));
  CREATE TABLE rrsi_experiments (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE UNIQUE INDEX rrsi_one_running ON rrsi_experiments(json_extract(payload, '$.status')) WHERE json_extract(payload, '$.status') = 'running';
  CREATE TRIGGER rrsi_versions_immutable BEFORE UPDATE ON rrsi_versions BEGIN SELECT RAISE(ABORT, 'immutable harness version'); END;
  CREATE TRIGGER rrsi_versions_retained BEFORE DELETE ON rrsi_versions BEGIN SELECT RAISE(ABORT, 'harness history retained'); END;
  CREATE TRIGGER rrsi_pins_immutable BEFORE UPDATE ON rrsi_goal_pins BEGIN SELECT RAISE(ABORT, 'immutable Goal harness pin'); END;
  `,
  `
  -- Project-owned Effect WorkflowEngine state. These tables share the one owner Database
  -- connection so owner admission and the first durable request can commit atomically.
  CREATE TABLE owner_workflow_executions (
    execution_id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    parent_execution_id TEXT REFERENCES owner_workflow_executions(execution_id),
    status TEXT NOT NULL CHECK (status IN ('running', 'suspended', 'completed', 'interrupted')),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
  );
  CREATE INDEX owner_workflow_executions_parent
    ON owner_workflow_executions(parent_execution_id);

  CREATE TABLE owner_workflow_activities (
    execution_id TEXT NOT NULL REFERENCES owner_workflow_executions(execution_id) ON DELETE CASCADE,
    activity_name TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    PRIMARY KEY (execution_id, activity_name, attempt)
  );

  CREATE TABLE owner_workflow_deferreds (
    execution_id TEXT NOT NULL REFERENCES owner_workflow_executions(execution_id) ON DELETE CASCADE,
    deferred_name TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    exit_json TEXT NOT NULL CHECK (json_valid(exit_json)),
    PRIMARY KEY (execution_id, deferred_name)
  );

  CREATE TABLE owner_workflow_clocks (
    execution_id TEXT NOT NULL REFERENCES owner_workflow_executions(execution_id) ON DELETE CASCADE,
    clock_name TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    deferred_name TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'fired')),
    PRIMARY KEY (execution_id, clock_name)
  );
  CREATE INDEX owner_workflow_clocks_pending
    ON owner_workflow_clocks(status, due_at);
  `,
  `
  -- Explicit owner/operator recovery of one verified read failure. Original run/RPC/Goal
  -- failure receipts stay unchanged; this only permits a new, user-requested run.
  CREATE TABLE owner_read_recoveries (
    receipt_id TEXT NOT NULL UNIQUE,
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id),
    session_id TEXT NOT NULL,
    goal_instance_id TEXT NOT NULL,
    workflow_revision_id INTEGER NOT NULL,
    operation_id INTEGER NOT NULL,
    operation_fingerprint TEXT NOT NULL,
    authorization_fingerprint TEXT NOT NULL,
    run_key TEXT NOT NULL,
    finished_at INTEGER NOT NULL,
    execution_id TEXT NOT NULL REFERENCES owner_workflow_executions(execution_id),
    execution_result_json TEXT NOT NULL CHECK(json_valid(execution_result_json)),
    execution_payload_json TEXT NOT NULL CHECK(json_valid(execution_payload_json)),
    assessment_id TEXT NOT NULL CHECK(length(assessment_id)=64),
    policy TEXT NOT NULL CHECK(policy='background-result-read-v1'),
    confirmation TEXT NOT NULL CHECK(confirmation='confirm_read_only_and_continue_without_replay'),
    backup_reference TEXT NOT NULL CHECK(length(backup_reference) BETWEEN 1 AND 256),
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id, operation_id) REFERENCES owner_rpc_operations(run_id, operation_id)
  );
  CREATE TRIGGER owner_read_recoveries_no_update BEFORE UPDATE ON owner_read_recoveries
    BEGIN SELECT RAISE(ABORT, 'read recovery receipt is immutable'); END;
  CREATE TRIGGER owner_read_recoveries_no_delete BEFORE DELETE ON owner_read_recoveries
    BEGIN SELECT RAISE(ABORT, 'read recovery receipt is retained'); END;
  CREATE INDEX owner_read_recoveries_session ON owner_read_recoveries(session_id, run_id);
  `,
  `
  -- BTW side threads. Their messages, tool calls and tool results live only here: never in
  -- nodes, FTS, vectors, morph terms, interpretation jobs or promotions. Releases without this
  -- step ignore both tables, so a rollback can neither list nor index BTW content.
  CREATE TABLE btw_threads (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    messages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)),
    created_at TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX btw_threads_parent ON btw_threads(parent_session_id, created_at);
  CREATE TRIGGER btw_threads_binding_immutable
    BEFORE UPDATE OF id, parent_session_id, created_at ON btw_threads
    BEGIN SELECT RAISE(ABORT, 'BTW binding is immutable'); END;

  -- Images a BTW message carried. No FK to attachments: an older release's orphan purge
  -- must stay able to delete a blob only BTW still references.
  CREATE TABLE btw_attachments (
    thread_id TEXT NOT NULL REFERENCES btw_threads(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, attachment_id)
  );
  CREATE INDEX btw_attachments_attachment ON btw_attachments(attachment_id);
  `,
  `
  -- Statements that can be embedded, so every search can list vector candidates and count the
  -- unembedded ones without reading the text. The WHERE terms must stay identical to
  -- embeddedKindFilter and nonBlankTextSql for SQLite to use the index.
  CREATE INDEX nodes_embeddable ON nodes(project_id, seq)
    WHERE kind IN ('user', 'assistant', 'topic')
      AND length(trim(text, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0;
  `,
  `
  -- A steered message waits like the others but must reach the model: at the next tool-call
  -- boundary, or as a turn the server starts itself when the answer ends. Only waiting rows keep it.
  ALTER TABLE queued_messages ADD COLUMN steered INTEGER NOT NULL DEFAULT 0 CHECK (steered IN (0, 1));
  `,
  `
  -- The user saw which tools of an ended Goal run left their outcome unknown and chose to continue.
  -- Admission stops treating that run as unresolved; nothing of it is replayed.
  CREATE TABLE workflow_uncertain_acknowledgements (
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL
  );
  `,
  `
  -- A project shell skill script the user (or the auto review) approved when it was saved. run_skill
  -- runs a script only while its exact content is still one of these; any edit asks again.
  CREATE TABLE shell_skill_approvals (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    script_sha256 TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name, script_sha256)
  );
  `,
  `
  -- A conversation held in a project but run in one of its repository's git worktrees: the worktree
  -- folder and the branch, so the project stays one per repository and the session still says where.
  ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
  ALTER TABLE sessions ADD COLUMN branch TEXT;

  -- Folders a project's repository was seen making worktrees in. Kept after those worktrees are
  -- removed, so a conversation from one of them still finds its repository.
  CREATE TABLE worktree_parents (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent TEXT NOT NULL,
    PRIMARY KEY (project_id, parent)
  );
  `,
  `
  -- Chunk IDs have their own safe-integer namespace; legacy one-vector nodes keep nodes.seq.
  CREATE TABLE node_vector_chunks (
    vector_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(vector_id >= 4503599627370496 AND vector_id <= 9007199254740991),
    node_seq INTEGER NOT NULL REFERENCES nodes(seq) ON DELETE CASCADE,
    embedder TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
    UNIQUE(node_seq, embedder, ordinal)
  );
  INSERT INTO sqlite_sequence(name, seq) VALUES ('node_vector_chunks', 4503599627370495);
  CREATE INDEX node_vector_chunks_embedder ON node_vector_chunks(embedder, vector_id);
  -- Durable removal IDs survive deletion of mappings (redaction, retirement, session purge).
  CREATE TABLE memory_chunk_vector_removals (
    vector_id INTEGER NOT NULL,
    embedder TEXT NOT NULL,
    PRIMARY KEY(vector_id, embedder)
  );
  CREATE TRIGGER node_vector_chunks_removal BEFORE DELETE ON node_vector_chunks BEGIN
    INSERT OR IGNORE INTO memory_chunk_vector_removals(vector_id, embedder)
      VALUES (old.vector_id, old.embedder);
  END;
  CREATE TRIGGER node_vectors_remove_chunks BEFORE DELETE ON node_vectors BEGIN
    DELETE FROM node_vector_chunks WHERE node_seq = old.node_seq AND embedder = old.embedder;
  END;
  `,
  `
  -- PersistedQueue items (kanban card runs) on the owner connection. A claimed row names the owner
  -- process that holds it; failed rows are the dead-letter record until requeued or cleaned up.
  CREATE TABLE persisted_queue_items (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_name TEXT NOT NULL,
    id TEXT NOT NULL,
    element_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    visible_at INTEGER NOT NULL,
    acquired_by TEXT,
    last_failure TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (queue_name, id)
  );
  CREATE INDEX persisted_queue_items_pending
    ON persisted_queue_items (queue_name, visible_at, sequence) WHERE state = 'pending';
  CREATE INDEX persisted_queue_items_settled
    ON persisted_queue_items (state, updated_at) WHERE state != 'pending';
  `,
  `
  -- Kanban board changes name their author (User or Orchestrator with its run) on the revision.
  -- Older revisions and phase or lifecycle saves keep NULL: no author is guessed.
  ALTER TABLE workflow_state_revisions ADD COLUMN author_json TEXT
    CHECK (author_json IS NULL OR json_valid(author_json));

  -- A user's change to a card that is executing waits here instead of overwriting the card.
  -- The orchestrator later applies, reassigns or rejects it; until then it stays pending.
  CREATE TABLE board_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT,
    card_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    change_json TEXT NOT NULL CHECK (json_valid(change_json)),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'applied', 'reassigned', 'rejected')),
    reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX board_change_requests_session ON board_change_requests(session_id, status, id);
  `,
  `
  -- Why a kanban human_decision wait ended without an answer. The workflow interrupt is the close;
  -- this row names its cause, and at startup a row whose wait is still pending finishes the close.
  CREATE TABLE human_decision_closures (
    execution_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL
      CHECK (reason IN ('orchestrator_cancelled', 'goal_replaced', 'card_stopped')),
    closed_at TEXT NOT NULL
  );
  `,
  `
  -- A Goal instance run as a kanban board. Its orchestrator loop runs while it is active. The Goal
  -- version is the one the board was last classified against; a newer Goal holds new assignments.
  CREATE TABLE kanban_goals (
    goal_instance_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    project_root TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('worktree', 'sequential')),
    goal_version INTEGER NOT NULL,
    hold_json TEXT CHECK (hold_json IS NULL OR json_valid(hold_json)),
    status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- One card attempt is one DurableQueue item keyed goal:card:attempt. Versions are fixed when the
  -- card is assigned; the outcome is written by the queue handler and taken up by the orchestrator.
  CREATE TABLE kanban_card_attempts (
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    session_id TEXT NOT NULL,
    goal_version INTEGER NOT NULL,
    plan_version INTEGER NOT NULL,
    outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
    handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (goal_instance_id, card_id, attempt_no)
  );
  CREATE INDEX kanban_card_attempts_open ON kanban_card_attempts(goal_instance_id, handled);

  -- Agent runs each delivery of a card started. A later delivery continues only when every earlier
  -- run ended with known effects; a person clears a fenced run by acknowledging it.
  CREATE TABLE kanban_card_runs (
    run_id TEXT PRIMARY KEY,
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    trace_attempt_id TEXT,
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX kanban_card_runs_card ON kanban_card_runs(goal_instance_id, card_id);

  -- Repeated failures of a card climb retry, backoff, replan and human decision. The reason is
  -- what the board shows for a card that waits. A new generation starts a fresh agent
  -- conversation in the same worktree; a resolution card re-applies another card after a conflict.
  -- Notes are changes applied to the card that its next attempt is told about.
  CREATE TABLE kanban_cards (
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    failure_streak INTEGER NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
    replans INTEGER NOT NULL DEFAULT 0 CHECK (replans >= 0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    not_before INTEGER,
    reason TEXT,
    resolution_of TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
    PRIMARY KEY (goal_instance_id, card_id)
  );
  `,
  `
  -- Answered human_decision requests whose follow-up the orchestrator loop already did, such as
  -- clearing an uncertain run's fence or resetting a requeued card's failures. Each is done once.
  CREATE TABLE kanban_decision_followups (
    request_id TEXT PRIMARY KEY,
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX kanban_decision_followups_goal ON kanban_decision_followups(goal_instance_id);
  `,
  `
  -- How the project scheduler treats a kanban Goal: the user's priority, the branch the Goal merges
  -- into (checked out when the board started; NULL on a detached HEAD), a pending upstream change to
  -- take in, and where its merge stands. The verified head is the Goal branch commit that last
  -- passed the Goal-level check, so a wait does not verify the same commit twice.
  CREATE TABLE kanban_goal_schedules (
    goal_instance_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
    target_branch TEXT,
    upstream_pending INTEGER NOT NULL DEFAULT 0 CHECK (upstream_pending IN (0, 1)),
    merge_json TEXT CHECK (merge_json IS NULL OR json_valid(merge_json)),
    verified_head TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX kanban_goal_schedules_project ON kanban_goal_schedules(project_id);

  -- A Goal that waits for another Goal's merge before it takes card slots.
  CREATE TABLE kanban_goal_dependencies (
    goal_instance_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (goal_instance_id, depends_on)
  );

  -- Branches a project's Goals never merge into on their own. No row means main and staging.
  CREATE TABLE kanban_project_settings (
    project_id TEXT PRIMARY KEY,
    protected_branches_json TEXT NOT NULL CHECK (json_valid(protected_branches_json))
  );
  `,
  `
  -- Folding a worktree project into its repository's project moves its nodes too. Nodes stay
  -- immutable evidence; a move writes a permit for that pair of projects, changes project_id and
  -- removes the permit in one transaction. The permit lets only project_id change, and a secret
  -- sweep permit still lets only the text change. Anything else is refused as before.
  CREATE TABLE node_project_moves (
    from_project TEXT PRIMARY KEY,
    to_project TEXT NOT NULL
  );
  DROP TRIGGER nodes_immutable;
  CREATE TRIGGER nodes_immutable BEFORE UPDATE ON nodes
  WHEN NOT (
    new.seq = old.seq AND new.id = old.id
    AND new.session_id IS old.session_id AND new.run_id IS old.run_id
    AND new.kind = old.kind AND new.detail = old.detail AND new.created_at = old.created_at
    AND (
      (EXISTS (SELECT 1 FROM secret_sweep_permits WHERE node_seq = old.seq)
        AND new.project_id = old.project_id)
      OR (EXISTS (SELECT 1 FROM node_project_moves
            WHERE from_project = old.project_id AND to_project = new.project_id)
        AND new.text = old.text)
    )
  )
  BEGIN SELECT RAISE(ABORT, 'nodes are immutable evidence'); END;
  `,
  `
  -- Work Trace shows where each task is through its attempt's heartbeat and keeps why an attempt
  -- failed. A retry reruns the task. Resume checkpoints, evidence, report-adoption and
  -- recovery-job history is dropped (decided 2026-10-21).
  PRAGMA defer_foreign_keys = ON;

  ALTER TABLE agent_run_attempts ADD COLUMN heartbeat_state TEXT
    CHECK (heartbeat_state IS NULL OR heartbeat_state IN ('working', 'idle', 'waiting'));
  ALTER TABLE agent_run_attempts ADD COLUMN heartbeat_step TEXT;
  ALTER TABLE agent_run_attempts ADD COLUMN heartbeat_at INTEGER;
  -- Tool calls the attempt started and has not settled. A retry must not repeat them unasked.
  ALTER TABLE agent_run_attempts ADD COLUMN pending_tool_call_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pending_tool_call_ids));
  ALTER TABLE agent_run_attempts ADD COLUMN failure TEXT
    CHECK (failure IS NULL OR json_valid(failure));
  UPDATE agent_run_attempts SET pending_tool_call_ids = coalesce((
    SELECT json_group_array(json_extract(requested.payload, '$.toolCallId'))
    FROM run_events requested
    WHERE requested.attempt_id = agent_run_attempts.id AND requested.kind = 'tool_requested'
      AND json_extract(requested.payload, '$.toolCallId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM run_events settled
        WHERE settled.attempt_id = requested.attempt_id
          AND settled.kind IN ('tool_completed', 'tool_failed')
          AND json_extract(settled.payload, '$.toolCallId')
            = json_extract(requested.payload, '$.toolCallId'))), '[]');
  UPDATE agent_run_attempts
    SET heartbeat_at = coalesce(finished_at, started_at, created_at),
        heartbeat_state = CASE WHEN status = 'waiting' THEN 'waiting'
          WHEN status IN ('running', 'blocked') THEN 'working' ELSE 'idle' END;
  UPDATE agent_run_attempts SET failure = '{"reason":{"_tag":"ServerRestarted"},"stage":"restart"}'
    WHERE status = 'interrupted' AND resume_reason = 'server_restarted';
  DELETE FROM run_events WHERE kind NOT IN (
    'attempt_queued', 'attempt_started', 'approval_waiting', 'approval_resolved', 'steered',
    'attempt_interrupted', 'attempt_completed', 'attempt_failed', 'attempt_cancelled',
    'resume_requested'
  );

  -- A retry the user asked for waits on its task for the next parent run that can execute it.
  ALTER TABLE work_tasks ADD COLUMN retry_requested_at INTEGER;
  ALTER TABLE work_tasks ADD COLUMN retry_confirm_uncertain INTEGER NOT NULL DEFAULT 0
    CHECK (retry_confirm_uncertain IN (0, 1));
  UPDATE work_tasks SET retry_requested_at = j.created_at,
      retry_confirm_uncertain = j.confirm_uncertain
    FROM work_recovery_jobs j WHERE j.task_id = work_tasks.id AND j.status = 'queued';

  -- An adopted answer names the tasks and attempts it used; evidence rows no longer exist.
  CREATE TABLE final_answer_sources_v2 (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    UNIQUE (claim_id, task_id, attempt_id),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE
  );
  INSERT OR IGNORE INTO final_answer_sources_v2 (id, claim_id, task_id, attempt_id)
    SELECT id, claim_id, task_id, attempt_id FROM final_answer_sources ORDER BY id;
  DROP TABLE final_answer_sources;
  ALTER TABLE final_answer_sources_v2 RENAME TO final_answer_sources;
  CREATE INDEX final_answer_sources_task ON final_answer_sources(task_id, claim_id);

  -- Promoted memories keep the evidence ids they were adopted with as history only.
  CREATE TABLE memory_candidate_evidence_v2 (
    candidate_id TEXT NOT NULL REFERENCES memory_candidates(id) ON DELETE CASCADE,
    evidence_ref_id_snapshot TEXT NOT NULL,
    source_deleted_at INTEGER,
    PRIMARY KEY (candidate_id, evidence_ref_id_snapshot)
  );
  INSERT INTO memory_candidate_evidence_v2
    (candidate_id, evidence_ref_id_snapshot, source_deleted_at)
  SELECT ce.candidate_id, ce.evidence_ref_id_snapshot,
    coalesce(ce.source_deleted_at, e.source_deleted_at,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  FROM memory_candidate_evidence ce LEFT JOIN evidence_refs e ON e.id = ce.evidence_ref_id;
  DROP TABLE memory_candidate_evidence;
  ALTER TABLE memory_candidate_evidence_v2 RENAME TO memory_candidate_evidence;

  DROP TABLE IF EXISTS work_checkpoints;
  DROP TABLE IF EXISTS work_checkpoints_v2;
  DROP TABLE IF EXISTS evidence_refs;
  DROP TABLE IF EXISTS evidence_refs_v2;
  DROP TABLE IF EXISTS evidence_refs_v3;
  DROP TABLE IF EXISTS report_adoptions;
  DROP TABLE IF EXISTS report_adoptions_v2;
  DROP TABLE IF EXISTS work_recovery_jobs;
  DROP TABLE IF EXISTS work_recovery_jobs_v2;
  `,
  `
  -- Owner RPC replies name their case under _tag instead of type.
  UPDATE owner_rpc_operations
    SET reply_json = json_set(json_remove(reply_json, '$.type'),
      '$._tag', json_extract(reply_json, '$.type'))
    WHERE json_extract(reply_json, '$.type') IS NOT NULL;
  -- A tool reply's output is the worker codec's frame tree of { outcome, events }; the outcome
  -- object's first field names its case and moves from type to _tag the same way.
  UPDATE owner_rpc_operations
    SET reply_json = json_set(reply_json, '$.output[1][0][1][1][0][0]', '_tag')
    WHERE json_extract(reply_json, '$._tag') = 'succeeded'
      AND json_extract(reply_json, '$.output[0]') = 'object'
      AND json_extract(reply_json, '$.output[1][0][0]') = 'outcome'
      AND json_extract(reply_json, '$.output[1][0][1][0]') = 'object'
      AND json_extract(reply_json, '$.output[1][0][1][1][0][0]') = 'type'
      AND json_extract(reply_json, '$.output[1][0][1][1][0][1][0]') = 'string'
      AND json_extract(reply_json, '$.output[1][0][1][1][0][1][1]') IN ('succeeded', 'failed');
  `,
  `
  -- A relayed approval's requester names its case under _tag instead of kind. The engine compares
  -- a re-admitted payload by its JSON text, so the object is rebuilt in the order the payload
  -- schema encodes it: _tag first, then the case's fields.
  UPDATE owner_workflow_executions
    SET payload_json = json_set(payload_json, '$.requester',
      CASE json_extract(payload_json, '$.requester.kind')
        WHEN 'subagent' THEN json_object('_tag', 'subagent',
          'subagentId', json_extract(payload_json, '$.requester.subagentId'),
          'name', json_extract(payload_json, '$.requester.name'))
        ELSE json_object('_tag', 'external_agent',
          'agent', json_extract(payload_json, '$.requester.agent'))
      END)
    WHERE workflow_name = 'RelayedApprovalExecution'
      AND json_extract(payload_json, '$.requester.kind') IN ('subagent', 'external_agent');
  `,
  `
  -- An artifact locator names its case under _tag instead of kind. The store finds an artifact
  -- by its encoded locator text and UNIQUE (attempt_id, kind, locator) keys on it, so each text is
  -- rewritten as the locator schema encodes it: _tag first, then the case's fields in order.
  UPDATE work_artifacts
    SET locator = CASE json_extract(locator, '$.kind')
      WHEN 'file' THEN json_object('_tag', 'file',
        'path', json_extract(locator, '$.path'),
        'sha256', json_extract(locator, '$.sha256'))
      ELSE json_object('_tag', json_extract(locator, '$.kind'),
        'reference', json_extract(locator, '$.reference'))
    END
    WHERE locator IS NOT NULL
      AND json_extract(locator, '$.kind') IN ('file', 'generated', 'external');
  `,
  `
  -- A session's workflow execution state names its case under _tag instead of kind. The sessions
  -- waiting to continue are found by that field; the other fields keep their order after it.
  UPDATE chat_metadata
    SET value = json_patch(json_object('_tag', json_extract(value, '$.kind')),
      json_remove(value, '$.kind'))
    WHERE namespace = 'memory-agent/workflow-execution'
      AND json_extract(value, '$.kind') IN
        ('idle', 'running', 'ready', 'retrying', 'blocked', 'stopped');
  `,
  `
  -- The project's one order of cards across its boards (docs/kanban-orchestration.md "프로젝트
  -- 스케줄러"), as a person arranged it by dragging cards between conversations. The scheduler
  -- starts cards in this order. A card without a row follows the card before it in its Plan, and a
  -- Plan with no ranked card comes after every ranked one.
  CREATE TABLE kanban_card_ranks (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, card_id)
  );
  `,
  `
  -- The priority tree replaces the order of cards across Goals (decisions.md "우선순위 트리
  -- (2026-10-22)"): projects in one order, each project's Goals (its conversations with a Plan)
  -- in one order, cards in Plan order below. A person moves projects and Goals while boards run;
  -- one without a row comes after the placed ones, oldest first. The scheduler starts cards in
  -- this order. kanban_goal_schedules.priority stays but nothing reads it any more.
  DROP TABLE kanban_card_ranks;
  CREATE TABLE kanban_goal_ranks (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id)
  );
  CREATE TABLE kanban_project_ranks (
    project_id TEXT PRIMARY KEY,
    rank INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Deleting a node makes SQLite look in imported_nodes for a row that still references it. With
  -- no index on node_id every deleted node read the whole table, so deleting a conversation of 16
  -- thousand nodes took minutes and held the write lock the whole time.
  CREATE INDEX imported_nodes_node ON imported_nodes(node_id);
  `,
  `
  -- Deleting a conversation that ran a Goal deletes its Goal history with it (decided 2026-10-25).
  -- The history stays immutable otherwise: a delete passes only while that conversation's purge
  -- holds a permit, which it writes and removes in its own transaction.
  CREATE TABLE goal_history_purges (session_id TEXT PRIMARY KEY);
  DROP TRIGGER workflow_goal_instances_no_delete;
  CREATE TRIGGER workflow_goal_instances_no_delete BEFORE DELETE ON workflow_goal_instances
    WHEN NOT EXISTS (SELECT 1 FROM goal_history_purges WHERE session_id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'goal instance is immutable'); END;
  DROP TRIGGER workflow_goal_worker_generations_no_delete;
  CREATE TRIGGER workflow_goal_worker_generations_no_delete BEFORE DELETE ON workflow_goal_worker_generations
    WHEN NOT EXISTS (SELECT 1 FROM goal_history_purges p
      JOIN workflow_goal_instances g ON g.session_id = p.session_id
      WHERE g.goal_instance_id = OLD.goal_instance_id)
    BEGIN SELECT RAISE(ABORT, 'goal source generation is immutable'); END;
  DROP TRIGGER workflow_goal_native_artifacts_no_delete;
  CREATE TRIGGER workflow_goal_native_artifacts_no_delete BEFORE DELETE ON workflow_goal_native_artifacts
    WHEN NOT EXISTS (SELECT 1 FROM goal_history_purges p
      JOIN workflow_goal_instances g ON g.session_id = p.session_id
      WHERE g.goal_instance_id = OLD.goal_instance_id)
    BEGIN SELECT RAISE(ABORT, 'native registration is immutable'); END;
  DROP TRIGGER owner_read_recoveries_no_delete;
  CREATE TRIGGER owner_read_recoveries_no_delete BEFORE DELETE ON owner_read_recoveries
    WHEN NOT EXISTS (SELECT 1 FROM goal_history_purges WHERE session_id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'read recovery receipt is retained'); END;
  `,
  tanStackRowsMigration,
  `
  -- When an owner workflow execution was admitted and last changed, in epoch milliseconds, so a
  -- stuck or leaking execution can be measured. Rows written before this step keep both NULL.
  ALTER TABLE owner_workflow_executions ADD COLUMN created_at INTEGER;
  ALTER TABLE owner_workflow_executions ADD COLUMN updated_at INTEGER;
  `,
  humanDecisionFactsMigration,
  `
  -- The secret sweep reads only the rows of the tables rewritten in place that were written since
  -- it last read them (decisions.md "비밀 정리는 쓰인 행만 다시 읽는다 (2026-11-04)"). It read
  -- those tables in full on every start, and conversations outgrew that: 846 of them held 560 MB,
  -- checked one string at a time. writes counts a row's writes since the sweep last read it; the
  -- sweep forgets the row only while the count is still what it read, so a write in between is
  -- swept on the next start. Their progress is dropped, so the next sweep marks every row once.
  CREATE TABLE secret_sweep_changes (
    target TEXT NOT NULL,
    row_key INTEGER NOT NULL,
    writes INTEGER NOT NULL,
    PRIMARY KEY (target, row_key)
  ) WITHOUT ROWID;
  CREATE TRIGGER secret_sweep_chat_threads_insert AFTER INSERT ON chat_threads BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_threads', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_chat_threads_update AFTER UPDATE OF messages ON chat_threads BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_threads', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_chat_interrupts_insert AFTER INSERT ON chat_interrupts BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_interrupts', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_chat_interrupts_update
  AFTER UPDATE OF payload, response ON chat_interrupts BEGIN
    INSERT INTO secret_sweep_changes VALUES ('chat_interrupts', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_permission_reviews_insert AFTER INSERT ON permission_reviews BEGIN
    INSERT INTO secret_sweep_changes VALUES ('permission_reviews', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_permission_reviews_update
  AFTER UPDATE OF input ON permission_reviews BEGIN
    INSERT INTO secret_sweep_changes VALUES ('permission_reviews', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_queued_messages_insert AFTER INSERT ON queued_messages BEGIN
    INSERT INTO secret_sweep_changes VALUES ('queued_messages', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_queued_messages_update
  AFTER UPDATE OF text, draft ON queued_messages BEGIN
    INSERT INTO secret_sweep_changes VALUES ('queued_messages', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_subagents_insert AFTER INSERT ON subagents BEGIN
    INSERT INTO secret_sweep_changes VALUES ('subagents', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_subagents_update
  AFTER UPDATE OF last_task, last_answer ON subagents BEGIN
    INSERT INTO secret_sweep_changes VALUES ('subagents', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_interpretations_insert AFTER INSERT ON interpretations BEGIN
    INSERT INTO secret_sweep_changes VALUES ('interpretations', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  CREATE TRIGGER secret_sweep_interpretations_update
  AFTER UPDATE OF reason ON interpretations BEGIN
    INSERT INTO secret_sweep_changes VALUES ('interpretations', NEW.rowid, 1)
      ON CONFLICT DO UPDATE SET writes = writes + 1;
  END;
  DELETE FROM secret_sweeps WHERE target IN ('chat_threads', 'chat_interrupts',
    'permission_reviews', 'queued_messages', 'subagents', 'interpretations');
  `,
  `
  -- Every change to a thread's transcript takes a new revision, and the history projection tells
  -- its groups current by the revision instead of comparing the whole transcript (decisions.md
  -- "대화 transcript는 revision으로 최신 여부를 가린다 (2026-11-04)"). Every thread takes its
  -- revisions from one counter, so a thread deleted and saved again never repeats one: a thread id
  -- with a revision always names one transcript. Threads written before this step keep 0, which
  -- the counter never gives.
  CREATE TABLE chat_revision_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_revision INTEGER NOT NULL
  );
  INSERT INTO chat_revision_counter VALUES (1, 0);
  ALTER TABLE chat_threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
  CREATE TRIGGER chat_threads_revision_insert AFTER INSERT ON chat_threads BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER chat_threads_revision_update AFTER UPDATE OF messages ON chat_threads BEGIN
    UPDATE chat_revision_counter SET last_revision = last_revision + 1;
    UPDATE chat_threads SET revision = (SELECT last_revision FROM chat_revision_counter)
      WHERE rowid = NEW.rowid;
  END;
  `,
  threadMessagesMigration,
  threadDisplayMessagesMigration,
  runLogMigration,
  workflowLedgerMigration,
  ownerRpcLedgerMigration,
  executionSubjectsMigration,
  attemptPendingToolCallsMigration,
  sessionStateTablesMigration,
  queuedMessageAttachmentsMigration,
  btwThreadMessagesMigration,
  kanbanGoalOwnersMigration,
  importedSessionSourceMigration,
  memoryCandidateDecisionsMigration,
  lexicalJournalMigration,
  textIndexDropMigration,
  `
  -- Recording a tool result looks up the node of its call. Without this index the lookup read
  -- every node of the session, text included, because detail is stored after text.
  CREATE INDEX nodes_tool_call_call
    ON nodes(session_id, json_extract(detail, '$.toolCallId'), seq)
    WHERE kind = 'tool_call';
  `,
  boardChangesMigration,
  `
  -- The interpreter finds a topic by its label, case aside, inside the transaction that records
  -- what it concluded. Topics are a few thousand of a project's nodes; without this index the
  -- lookup read every node of the project and trimmed its text, 0.4 s each with a warm cache.
  CREATE INDEX nodes_topic_label ON nodes(project_id, lower(text)) WHERE kind = 'topic';
  `,
  `
  -- Each judgment of whether a Goal's branch meets one of its outcomes, never rewritten. The
  -- latest row of an outcome holds for the outcome text and the work of the cards it judged.
  CREATE TABLE workflow_outcome_verdicts (
    id INTEGER PRIMARY KEY,
    goal_instance_id TEXT NOT NULL
      REFERENCES workflow_goal_instances(goal_instance_id) ON DELETE CASCADE,
    outcome_id TEXT NOT NULL,
    outcome_text TEXT NOT NULL,
    met INTEGER NOT NULL CHECK (met IN (0, 1)),
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    cards_json TEXT NOT NULL CHECK (json_valid(cards_json)),
    goal_head TEXT,
    run_id TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX workflow_outcome_verdicts_outcome
    ON workflow_outcome_verdicts(goal_instance_id, outcome_id, id);
  `,
  `
  -- Who approves the cards the planner adds to a running board. Boards started before this
  -- column leave them to the user.
  ALTER TABLE kanban_goals ADD COLUMN card_approval TEXT NOT NULL DEFAULT 'user'
    CHECK (card_approval IN ('user', 'permission'));
  `,
  `
  -- How many times in a row the board woke its planner for work without a newly met outcome,
  -- and how many outcomes were met when it last counted.
  ALTER TABLE kanban_goals ADD COLUMN planner_rounds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kanban_goals ADD COLUMN planner_met INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Who approves a revision's Plan and its new cards: the user (plan) or the owner (goal).
  -- Older revisions keep NULL; their phase names the mode, or they were Plan mode.
  ALTER TABLE workflow_state_revisions ADD COLUMN mode TEXT
    CHECK (mode IS NULL OR mode IN ('plan', 'goal'));
  `,
  `
  -- The board runs an approved Plan, so a continuation no longer counts the chat's own progress.
  -- What is left of its lists is a blocked execution's evidence, in order.
  ALTER TABLE workflow_executions DROP COLUMN no_progress_runs;
  CREATE TABLE workflow_blocker_evidence (
    session_id TEXT NOT NULL REFERENCES workflow_executions(session_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (session_id, position)
  );
  INSERT INTO workflow_blocker_evidence (session_id, position, value)
    SELECT session_id, position, value FROM workflow_execution_entries
    WHERE list = 'blocker_evidence';
  DROP TABLE workflow_execution_entries;
  `,
  `
  -- The user's value for one of an MCP tool's annotation hints (the spec's ToolAnnotations:
  -- readOnly, destructive, idempotent, openWorld), which wins over what the server says. Keyed like
  -- mcp_trust; it outlives a change of trust, since it is about the tool, not the configuration.
  CREATE TABLE mcp_tool_hints (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id TEXT NOT NULL,
    server TEXT NOT NULL,
    tool TEXT NOT NULL,
    hint TEXT NOT NULL CHECK (hint IN ('readOnly', 'destructive', 'idempotent', 'openWorld')),
    value INTEGER NOT NULL CHECK (value IN (0, 1)),
    set_at TEXT NOT NULL,
    PRIMARY KEY (scope, project_id, server, tool, hint),
    CHECK ((scope = 'global') = (project_id = ''))
  );
  `,
];

/** Only this startup migration may rebuild a referenced table with FK checks suspended.
 * Older steps remain ordinary SQL transactions; never infer special handling from SQL text.
 */
export const goalHistoryMigration = {
  version: 42,
  kind: "goal-history-binding-fk-rebuild" as const,
  preservedTables: [
    "workflow_goal_identities",
    "workflow_state_revisions",
    "session_workflows",
    "workflow_run_bindings",
    "workflow_run_events",
    "workflow_worker_dispatches",
    "owner_rpc_operations",
  ],
};
