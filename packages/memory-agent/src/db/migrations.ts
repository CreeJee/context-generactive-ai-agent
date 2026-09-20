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
];
