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
];
