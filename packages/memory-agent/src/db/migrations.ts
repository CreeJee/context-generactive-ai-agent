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
];
