-- A database written by memory-agent at git tag 0.0.17 (d70b1453), the last non-draft release.
-- Made once; the script that made it is not kept. How it was made:
--   1. `git worktree add --detach <scratch> 0.0.17`, then `vp install`, `node build-turbovec.ts`
--      in packages/turbovec and `vp run build` in packages/memory-agent.
--   2. A test in that checkout opened `testAgent()` and, through 0.0.17's own services, made:
--      - session 5b3d4c6f-953d-4654-a2f2-2cbfbee89c25: Goal with a ready Plan. Its bound run
--        `<session>:invoking` asked for a new independent Goal (`Workflows.requestNewGoal`,
--        accepted) and was left `running`. A relayed approval for that run is pending
--        (`RelayedApprovals.ask`), and a provider retry wait (`ProviderRetries.wait`, retry 10)
--        has its clock unfired.
--      - session 9983e6ce-47c3-4f53-ad7f-9a6a172d9470: the same accepted request, with the run
--        then set to `interrupted`.
--      - session 4c0244eb-ffed-4073-98a2-8f5c55d41bb9: Execute with every step done, then
--        `updateProgress` with the Goal and the Plan completed. The phase stays `execute`.
--      - session fea8e2f8-9f91-4381-835f-d1f2308b3445: the same progress without the Goal status.
--        The Plan is completed and the Goal stays active.
--      `chat_runs` rows were inserted with SQL, as 0.0.17's own tests do.
--   3. `VACUUM INTO` copied the open database and `sqlite3 <copy> .dump` wrote the rest of this file.
-- To load it, run it on a connection with defensive mode off, then open a new connection: the FTS5
-- tables come back through `writable_schema` and only a new connection sees them.
/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
INSERT INTO effect_sql_migrations VALUES(1,'2026-10-29 04:53:10','schema_1');
INSERT INTO effect_sql_migrations VALUES(2,'2026-10-29 04:53:10','schema_2');
INSERT INTO effect_sql_migrations VALUES(3,'2026-10-29 04:53:10','schema_3');
INSERT INTO effect_sql_migrations VALUES(4,'2026-10-29 04:53:10','schema_4');
INSERT INTO effect_sql_migrations VALUES(5,'2026-10-29 04:53:10','schema_5');
INSERT INTO effect_sql_migrations VALUES(6,'2026-10-29 04:53:10','schema_6');
INSERT INTO effect_sql_migrations VALUES(7,'2026-10-29 04:53:10','schema_7');
INSERT INTO effect_sql_migrations VALUES(8,'2026-10-29 04:53:10','schema_8');
INSERT INTO effect_sql_migrations VALUES(9,'2026-10-29 04:53:10','schema_9');
INSERT INTO effect_sql_migrations VALUES(10,'2026-10-29 04:53:10','schema_10');
INSERT INTO effect_sql_migrations VALUES(11,'2026-10-29 04:53:10','schema_11');
INSERT INTO effect_sql_migrations VALUES(12,'2026-10-29 04:53:10','schema_12');
INSERT INTO effect_sql_migrations VALUES(13,'2026-10-29 04:53:10','schema_13');
INSERT INTO effect_sql_migrations VALUES(14,'2026-10-29 04:53:10','schema_14');
INSERT INTO effect_sql_migrations VALUES(15,'2026-10-29 04:53:10','schema_15');
INSERT INTO effect_sql_migrations VALUES(16,'2026-10-29 04:53:10','schema_16');
INSERT INTO effect_sql_migrations VALUES(17,'2026-10-29 04:53:10','schema_17');
INSERT INTO effect_sql_migrations VALUES(18,'2026-10-29 04:53:10','schema_18');
INSERT INTO effect_sql_migrations VALUES(19,'2026-10-29 04:53:10','schema_19');
INSERT INTO effect_sql_migrations VALUES(20,'2026-10-29 04:53:10','schema_20');
INSERT INTO effect_sql_migrations VALUES(21,'2026-10-29 04:53:10','schema_21');
INSERT INTO effect_sql_migrations VALUES(22,'2026-10-29 04:53:10','schema_22');
INSERT INTO effect_sql_migrations VALUES(23,'2026-10-29 04:53:10','schema_23');
INSERT INTO effect_sql_migrations VALUES(24,'2026-10-29 04:53:10','schema_24');
INSERT INTO effect_sql_migrations VALUES(25,'2026-10-29 04:53:10','schema_25');
INSERT INTO effect_sql_migrations VALUES(26,'2026-10-29 04:53:10','schema_26');
INSERT INTO effect_sql_migrations VALUES(27,'2026-10-29 04:53:10','schema_27');
INSERT INTO effect_sql_migrations VALUES(28,'2026-10-29 04:53:10','schema_28');
INSERT INTO effect_sql_migrations VALUES(29,'2026-10-29 04:53:10','schema_29');
INSERT INTO effect_sql_migrations VALUES(30,'2026-10-29 04:53:10','schema_30');
INSERT INTO effect_sql_migrations VALUES(31,'2026-10-29 04:53:10','schema_31');
INSERT INTO effect_sql_migrations VALUES(32,'2026-10-29 04:53:10','schema_32');
INSERT INTO effect_sql_migrations VALUES(33,'2026-10-29 04:53:10','schema_33');
INSERT INTO effect_sql_migrations VALUES(34,'2026-10-29 04:53:10','schema_34');
INSERT INTO effect_sql_migrations VALUES(35,'2026-10-29 04:53:10','schema_35');
INSERT INTO effect_sql_migrations VALUES(36,'2026-10-29 04:53:10','schema_36');
INSERT INTO effect_sql_migrations VALUES(37,'2026-10-29 04:53:10','schema_37');
INSERT INTO effect_sql_migrations VALUES(38,'2026-10-29 04:53:10','schema_38');
INSERT INTO effect_sql_migrations VALUES(39,'2026-10-29 04:53:10','schema_39');
INSERT INTO effect_sql_migrations VALUES(40,'2026-10-29 04:53:10','schema_40');
INSERT INTO effect_sql_migrations VALUES(41,'2026-10-29 04:53:10','schema_41');
INSERT INTO effect_sql_migrations VALUES(42,'2026-10-29 04:53:10','schema_42');
INSERT INTO effect_sql_migrations VALUES(43,'2026-10-29 04:53:10','schema_43');
INSERT INTO effect_sql_migrations VALUES(44,'2026-10-29 04:53:10','schema_44');
INSERT INTO effect_sql_migrations VALUES(45,'2026-10-29 04:53:10','schema_45');
INSERT INTO effect_sql_migrations VALUES(46,'2026-10-29 04:53:10','schema_46');
INSERT INTO effect_sql_migrations VALUES(47,'2026-10-29 04:53:10','schema_47');
INSERT INTO effect_sql_migrations VALUES(48,'2026-10-29 04:53:10','schema_48');
INSERT INTO effect_sql_migrations VALUES(49,'2026-10-29 04:53:10','schema_49');
INSERT INTO effect_sql_migrations VALUES(50,'2026-10-29 04:53:10','schema_50');
INSERT INTO effect_sql_migrations VALUES(51,'2026-10-29 04:53:10','schema_51');
INSERT INTO effect_sql_migrations VALUES(52,'2026-10-29 04:53:10','schema_52');
INSERT INTO effect_sql_migrations VALUES(53,'2026-10-29 04:53:10','schema_53');
INSERT INTO effect_sql_migrations VALUES(54,'2026-10-29 04:53:10','schema_54');
INSERT INTO effect_sql_migrations VALUES(55,'2026-10-29 04:53:10','schema_55');
INSERT INTO effect_sql_migrations VALUES(56,'2026-10-29 04:53:10','schema_56');
INSERT INTO effect_sql_migrations VALUES(57,'2026-10-29 04:53:10','schema_57');
INSERT INTO effect_sql_migrations VALUES(58,'2026-10-29 04:53:10','schema_58');
INSERT INTO effect_sql_migrations VALUES(59,'2026-10-29 04:53:10','schema_59');
INSERT INTO effect_sql_migrations VALUES(60,'2026-10-29 04:53:10','schema_60');
INSERT INTO effect_sql_migrations VALUES(61,'2026-10-29 04:53:10','schema_61');
INSERT INTO effect_sql_migrations VALUES(62,'2026-10-29 04:53:10','schema_62');
INSERT INTO effect_sql_migrations VALUES(63,'2026-10-29 04:53:10','schema_63');
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    cross_recall_excluded INTEGER NOT NULL DEFAULT 0 CHECK (cross_recall_excluded IN (0, 1)),
    created_at TEXT NOT NULL
  , permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK (permission_mode IN ('ask', 'auto')), hidden_at TEXT, permission_full INTEGER NOT NULL DEFAULT 0
    CHECK (permission_full IN (0, 1)));
INSERT INTO projects VALUES('b8b85f6b-ebb7-426b-a140-a2f9cdbe4363','/private/var/folders/_4/y1b42m452sx0slywvdlhf5tw0000gp/T/memory-agent-R4TvRS/project','project',0,'2026-10-29T04:53:10.640Z','ask',NULL,0);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT,
    created_at TEXT NOT NULL
  , agent TEXT, archived_at TEXT, imported_from TEXT, worktree_path TEXT, branch TEXT);
INSERT INTO sessions VALUES('e827e45c-2855-4ee8-a375-aff29a2a2fcf','b8b85f6b-ebb7-426b-a140-a2f9cdbe4363',NULL,'2026-10-29T04:53:10.641Z',NULL,NULL,NULL,NULL,NULL);
INSERT INTO sessions VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','b8b85f6b-ebb7-426b-a140-a2f9cdbe4363',NULL,'2026-10-29T04:53:10.643Z',NULL,NULL,NULL,NULL,NULL);
INSERT INTO sessions VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470','b8b85f6b-ebb7-426b-a140-a2f9cdbe4363',NULL,'2026-10-29T04:53:10.654Z',NULL,NULL,NULL,NULL,NULL);
INSERT INTO sessions VALUES('4c0244eb-ffed-4073-98a2-8f5c55d41bb9','b8b85f6b-ebb7-426b-a140-a2f9cdbe4363',NULL,'2026-10-29T04:53:10.659Z',NULL,NULL,NULL,NULL,NULL);
INSERT INTO sessions VALUES('fea8e2f8-9f91-4381-835f-d1f2308b3445','b8b85f6b-ebb7-426b-a140-a2f9cdbe4363',NULL,'2026-10-29T04:53:10.663Z',NULL,NULL,NULL,NULL,NULL);
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
CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK (kind IN ('next', 'reply', 'calls', 'returns', 'touches', 'about', 'corrects', 'retracts', 'related')),
    origin TEXT NOT NULL CHECK (origin IN ('structure', 'llm')),
    weight REAL NOT NULL CHECK (weight > 0 AND weight <= 1),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
CREATE TABLE node_refs (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    ref TEXT NOT NULL,
    PRIMARY KEY (node_id, ref)
  );
CREATE TABLE IF NOT EXISTS 'nodes_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO nodes_fts_data VALUES(1,x'');
INSERT INTO nodes_fts_data VALUES(10,x'00000000000000');
CREATE TABLE IF NOT EXISTS 'nodes_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'nodes_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'nodes_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO nodes_fts_config VALUES('version',4);
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
CREATE TABLE attachments (
    id TEXT PRIMARY KEY CHECK (length(id) = 64),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    created_at TEXT NOT NULL
  );
CREATE TABLE node_attachments (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (node_id, position)
  );
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
INSERT INTO chat_runs VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25:invoking','5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','running',1793249590651,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO chat_runs VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470:invoking','9983e6ce-47c3-4f53-ad7f-9a6a172d9470','interrupted',1793249590657,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
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
CREATE TABLE chat_metadata (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    PRIMARY KEY (namespace, key)
  );
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
    updated_at INTEGER NOT NULL, steered INTEGER NOT NULL DEFAULT 0 CHECK (steered IN (0, 1)),
    CHECK ((state = 'delivered') = (delivered_via IS NOT NULL))
  );
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
CREATE TABLE mcp_trust (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    trusted_at TEXT NOT NULL,
    PRIMARY KEY (scope, project_id, name),
    CHECK ((scope = 'global') = (project_id = ''))
  );
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
CREATE TABLE agent_trust (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    trusted_at TEXT NOT NULL,
    PRIMARY KEY (scope, project_id, name),
    CHECK ((scope = 'global') = (project_id = ''))
  );
CREATE TABLE IF NOT EXISTS 'nodes_morph_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO nodes_morph_data VALUES(1,x'');
INSERT INTO nodes_morph_data VALUES(10,x'00000000000000');
CREATE TABLE IF NOT EXISTS 'nodes_morph_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'nodes_morph_content'(id INTEGER PRIMARY KEY, c0);
CREATE TABLE IF NOT EXISTS 'nodes_morph_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'nodes_morph_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO nodes_morph_config VALUES('version',4);
CREATE TABLE node_morphs (
    node_seq INTEGER PRIMARY KEY REFERENCES nodes(seq),
    analyzer TEXT NOT NULL
  );
CREATE TABLE imported_sessions (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    PRIMARY KEY (source, external_id)
  );
CREATE TABLE imported_nodes (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    PRIMARY KEY (source, external_id)
  );
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
    updated_at TEXT NOT NULL, failure TEXT,
    PRIMARY KEY (source, path)
  );
CREATE TABLE secret_sweep_permits (node_seq INTEGER PRIMARY KEY);
CREATE TABLE secret_sweeps (
    target TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    after INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden >= 0),
    updated_at TEXT NOT NULL
  );
CREATE TABLE session_workflows (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    updated_at TEXT NOT NULL
  );
INSERT INTO session_workflows VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.646Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.648Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.644Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.646Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":3,"at":"2026-10-29T04:53:10.648Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}','2026-10-29T04:53:10.648Z');
INSERT INTO session_workflows VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.655Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.656Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.655Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.655Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":3,"at":"2026-10-29T04:53:10.656Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}','2026-10-29T04:53:10.656Z');
INSERT INTO session_workflows VALUES('4c0244eb-ffed-4073-98a2-8f5c55d41bb9','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":["goal proof"],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.662Z"},"updatedAt":"2026-10-29T04:53:10.663Z","status":"completed"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"done","evidence":["step proof"]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.662Z"},"updatedAt":"2026-10-29T04:53:10.663Z","status":"completed"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.660Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.661Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.661Z","kind":"phase_changed","detail":"chat -> execute"},{"sequence":4,"at":"2026-10-29T04:53:10.663Z","kind":"verification_recorded","detail":"done"}]}','2026-10-29T04:53:10.663Z');
INSERT INTO session_workflows VALUES('fea8e2f8-9f91-4381-835f-d1f2308b3445','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":["goal proof"],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.666Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"done","evidence":["step proof"]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.666Z"},"updatedAt":"2026-10-29T04:53:10.666Z","status":"completed"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.664Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.664Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.665Z","kind":"phase_changed","detail":"chat -> execute"},{"sequence":4,"at":"2026-10-29T04:53:10.666Z","kind":"verification_recorded","detail":"done"}]}','2026-10-29T04:53:10.666Z');
CREATE TABLE IF NOT EXISTS "work_tasks" (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_task_id TEXT REFERENCES "work_tasks"(id),
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
    active_attempt_id TEXT REFERENCES "agent_run_attempts"(id) DEFERRABLE INITIALLY DEFERRED,
    origin_deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , archived_at INTEGER, delete_requested_at INTEGER, deleted_at INTEGER, purge_receipt_id TEXT REFERENCES purge_receipts(id));
CREATE TABLE IF NOT EXISTS "agent_invocations" (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES "work_tasks"(id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'steer', 'resume', 'recover')),
    status TEXT NOT NULL CHECK (status IN (
      'accepted', 'steered', 'running', 'completed', 'failed', 'cancelled'
    )),
    message TEXT NOT NULL,
    target_attempt_id TEXT REFERENCES "agent_run_attempts"(id) DEFERRABLE INITIALLY DEFERRED,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
CREATE TABLE IF NOT EXISTS "agent_run_attempts" (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES "work_tasks"(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL UNIQUE REFERENCES "agent_invocations"(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    chat_run_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting', 'blocked', 'interrupted', 'completed', 'failed', 'cancelled'
    )),
    resumed_from_attempt_id TEXT REFERENCES "agent_run_attempts"(id),
    superseded_by_attempt_id TEXT REFERENCES "agent_run_attempts"(id),
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
CREATE TABLE IF NOT EXISTS "run_events" (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    task_id TEXT NOT NULL REFERENCES "work_tasks"(id) ON DELETE CASCADE,
    invocation_id TEXT NOT NULL REFERENCES "agent_invocations"(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES "agent_run_attempts"(id) ON DELETE CASCADE,
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
CREATE TABLE IF NOT EXISTS "work_checkpoints" (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES "work_tasks"(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES "agent_run_attempts"(id) ON DELETE CASCADE,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    transcript_message_id TEXT,
    completed_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_tool_call_ids)),
    uncertain_tool_call_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncertain_tool_call_ids)),
    pending_approval_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_approval_ids)),
    remaining_work TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, event_sequence)
  );
CREATE TABLE IF NOT EXISTS "report_adoptions" (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES "work_tasks"(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES "agent_run_attempts"(id) ON DELETE CASCADE,
    disposition TEXT NOT NULL CHECK (disposition IN (
      'returned', 'reviewed', 'used', 'not_used', 'superseded'
    )),
    superseded_by_attempt_id TEXT REFERENCES "agent_run_attempts"(id),
    updated_at INTEGER NOT NULL
  , parent_run_id TEXT, parent_message_id TEXT, claim_id TEXT);
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
  , confirm_uncertain INTEGER NOT NULL DEFAULT 0
      CHECK (confirm_uncertain IN (0, 1)));
CREATE TABLE IF NOT EXISTS "evidence_refs" (
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
CREATE TABLE final_answer_claims (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_run_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (parent_run_id, parent_message_id)
  );
CREATE TABLE final_answer_sources (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES agent_run_attempts(id) ON DELETE CASCADE,
    evidence_ref_id TEXT REFERENCES evidence_refs(id) ON DELETE SET NULL,
    UNIQUE (claim_id, evidence_ref_id),
    FOREIGN KEY (attempt_id, task_id) REFERENCES agent_run_attempts(id, task_id) ON DELETE CASCADE
  );
CREATE TABLE final_answer_notifications (
    claim_id TEXT NOT NULL REFERENCES final_answer_claims(id) ON DELETE CASCADE,
    notification_id TEXT NOT NULL REFERENCES parent_notifications(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (claim_id, notification_id)
  );
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
CREATE TABLE memory_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES memory_candidates(id) ON DELETE CASCADE,
    evidence_ref_id TEXT REFERENCES evidence_refs(id) ON DELETE SET NULL,
    evidence_ref_id_snapshot TEXT NOT NULL,
    source_deleted_at INTEGER,
    PRIMARY KEY (candidate_id, evidence_ref_id_snapshot)
  );
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
CREATE TABLE parent_notification_holds (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    held_at INTEGER NOT NULL
  );
CREATE TABLE report_sessions (
    report_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    source_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    created_at TEXT NOT NULL,
    CHECK (report_session_id <> source_session_id)
  );
CREATE TABLE oauth_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
    label TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at INTEGER NOT NULL
  );
CREATE TABLE oauth_legacy_removed (
    provider TEXT PRIMARY KEY CHECK (provider IN ('openai', 'anthropic')),
    removed_at INTEGER NOT NULL
  );
CREATE TABLE workflow_state_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    goal_version INTEGER,
    plan_version INTEGER,
    provenance TEXT NOT NULL CHECK (provenance IN ('legacy_current', 'recorded')),
    created_at TEXT NOT NULL
  , goal_instance_id TEXT, author_json TEXT
    CHECK (author_json IS NULL OR json_valid(author_json)));
INSERT INTO workflow_state_revisions VALUES(1,'5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','{"phase":"goal","goal":null,"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.644Z","kind":"phase_changed","detail":"chat -> goal"}]}',NULL,NULL,'recorded','2026-10-29T04:53:10.644Z',NULL,NULL);
INSERT INTO workflow_state_revisions VALUES(2,'5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.646Z","status":"active"},"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.644Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.646Z","kind":"goal_updated","detail":"goal v1 (active)"}]}',1,NULL,'recorded','2026-10-29T04:53:10.646Z','b0d6382e-9310-4514-bd75-1f0cd3b117d2',NULL);
INSERT INTO workflow_state_revisions VALUES(3,'5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.646Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.648Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.644Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.646Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":3,"at":"2026-10-29T04:53:10.648Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}',1,1,'recorded','2026-10-29T04:53:10.648Z','b0d6382e-9310-4514-bd75-1f0cd3b117d2',NULL);
INSERT INTO workflow_state_revisions VALUES(4,'9983e6ce-47c3-4f53-ad7f-9a6a172d9470','{"phase":"goal","goal":null,"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.655Z","kind":"phase_changed","detail":"chat -> goal"}]}',NULL,NULL,'recorded','2026-10-29T04:53:10.655Z',NULL,NULL);
INSERT INTO workflow_state_revisions VALUES(5,'9983e6ce-47c3-4f53-ad7f-9a6a172d9470','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.655Z","status":"active"},"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.655Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.655Z","kind":"goal_updated","detail":"goal v1 (active)"}]}',1,NULL,'recorded','2026-10-29T04:53:10.655Z','4b8845cf-3ec3-4b21-b951-bd1d183fe107',NULL);
INSERT INTO workflow_state_revisions VALUES(6,'9983e6ce-47c3-4f53-ad7f-9a6a172d9470','{"phase":"goal","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.655Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.656Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.655Z","kind":"phase_changed","detail":"chat -> goal"},{"sequence":2,"at":"2026-10-29T04:53:10.655Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":3,"at":"2026-10-29T04:53:10.656Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}',1,1,'recorded','2026-10-29T04:53:10.656Z','4b8845cf-3ec3-4b21-b951-bd1d183fe107',NULL);
INSERT INTO workflow_state_revisions VALUES(7,'4c0244eb-ffed-4073-98a2-8f5c55d41bb9','{"phase":"chat","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.660Z","status":"active"},"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.660Z","kind":"goal_updated","detail":"goal v1 (active)"}]}',1,NULL,'recorded','2026-10-29T04:53:10.660Z','cfeb959c-5999-4abf-b049-7d30e543c0b1',NULL);
INSERT INTO workflow_state_revisions VALUES(8,'4c0244eb-ffed-4073-98a2-8f5c55d41bb9','{"phase":"chat","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.660Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.661Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.660Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.661Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}',1,1,'recorded','2026-10-29T04:53:10.661Z','cfeb959c-5999-4abf-b049-7d30e543c0b1',NULL);
INSERT INTO workflow_state_revisions VALUES(9,'4c0244eb-ffed-4073-98a2-8f5c55d41bb9','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.660Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.661Z","status":"executing"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.660Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.661Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.661Z","kind":"phase_changed","detail":"chat -> execute"}]}',1,1,'recorded','2026-10-29T04:53:10.661Z','cfeb959c-5999-4abf-b049-7d30e543c0b1',NULL);
INSERT INTO workflow_state_revisions VALUES(10,'4c0244eb-ffed-4073-98a2-8f5c55d41bb9','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":["goal proof"],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.662Z"},"updatedAt":"2026-10-29T04:53:10.663Z","status":"completed"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"done","evidence":["step proof"]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.662Z"},"updatedAt":"2026-10-29T04:53:10.663Z","status":"completed"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.660Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.661Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.661Z","kind":"phase_changed","detail":"chat -> execute"},{"sequence":4,"at":"2026-10-29T04:53:10.663Z","kind":"verification_recorded","detail":"done"}]}',1,1,'recorded','2026-10-29T04:53:10.663Z','cfeb959c-5999-4abf-b049-7d30e543c0b1',NULL);
INSERT INTO workflow_state_revisions VALUES(11,'fea8e2f8-9f91-4381-835f-d1f2308b3445','{"phase":"chat","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.664Z","status":"active"},"plan":null,"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.664Z","kind":"goal_updated","detail":"goal v1 (active)"}]}',1,NULL,'recorded','2026-10-29T04:53:10.664Z','5f5b46fa-0381-4f59-877f-b4e19f400199',NULL);
INSERT INTO workflow_state_revisions VALUES(12,'fea8e2f8-9f91-4381-835f-d1f2308b3445','{"phase":"chat","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.664Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.664Z","status":"ready"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.664Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.664Z","kind":"plan_updated","detail":"plan v1 (ready)"}]}',1,1,'recorded','2026-10-29T04:53:10.664Z','5f5b46fa-0381-4f59-877f-b4e19f400199',NULL);
INSERT INTO workflow_state_revisions VALUES(13,'fea8e2f8-9f91-4381-835f-d1f2308b3445','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.664Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"ready","evidence":[]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.665Z","status":"executing"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.664Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.664Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.665Z","kind":"phase_changed","detail":"chat -> execute"}]}',1,1,'recorded','2026-10-29T04:53:10.665Z','5f5b46fa-0381-4f59-877f-b4e19f400199',NULL);
INSERT INTO workflow_state_revisions VALUES(14,'fea8e2f8-9f91-4381-835f-d1f2308b3445','{"phase":"execute","goal":{"version":1,"statement":"fixture goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"evidence":["goal proof"],"verification":{"status":"not_run","summary":"","evidence":[],"recoveryPhase":null,"updatedAt":null},"updatedAt":"2026-10-29T04:53:10.666Z","status":"active"},"plan":{"version":1,"goalVersion":1,"summary":"fixture plan","steps":[{"id":"store","title":"Store","description":"Do the step","dependsOn":[],"acceptanceCriteria":["step done"],"ruleRefs":[],"status":"done","evidence":["step proof"]}],"risks":[],"openQuestions":[],"evidence":[],"verification":{"status":"passed","summary":"verified","evidence":["goal proof"],"recoveryPhase":null,"updatedAt":"2026-10-29T04:53:10.666Z"},"updatedAt":"2026-10-29T04:53:10.666Z","status":"completed"},"ledger":[{"sequence":1,"at":"2026-10-29T04:53:10.664Z","kind":"goal_updated","detail":"goal v1 (active)"},{"sequence":2,"at":"2026-10-29T04:53:10.664Z","kind":"plan_updated","detail":"plan v1 (ready)"},{"sequence":3,"at":"2026-10-29T04:53:10.665Z","kind":"phase_changed","detail":"chat -> execute"},{"sequence":4,"at":"2026-10-29T04:53:10.666Z","kind":"verification_recorded","detail":"done"}]}',1,1,'recorded','2026-10-29T04:53:10.666Z','5f5b46fa-0381-4f59-877f-b4e19f400199',NULL);
CREATE TABLE workflow_goal_identities (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
INSERT INTO workflow_goal_identities VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','b0d6382e-9310-4514-bd75-1f0cd3b117d2','2026-10-29T04:53:10.646Z');
INSERT INTO workflow_goal_identities VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470','4b8845cf-3ec3-4b21-b951-bd1d183fe107','2026-10-29T04:53:10.655Z');
INSERT INTO workflow_goal_identities VALUES('4c0244eb-ffed-4073-98a2-8f5c55d41bb9','cfeb959c-5999-4abf-b049-7d30e543c0b1','2026-10-29T04:53:10.660Z');
INSERT INTO workflow_goal_identities VALUES('fea8e2f8-9f91-4381-835f-d1f2308b3445','5f5b46fa-0381-4f59-877f-b4e19f400199','2026-10-29T04:53:10.664Z');
CREATE TABLE workflow_run_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('chunk', 'run_error', 'run_completed')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, event_key)
  );
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
INSERT INTO memory_graph_maintenance VALUES(3,0,0,'completed',0,0,0,0,NULL);
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
CREATE TABLE memory_graph_vector_removals (
    node_seq INTEGER NOT NULL,
    embedder TEXT NOT NULL,
    PRIMARY KEY (node_seq, embedder)
  );
CREATE TABLE workflow_worker_dispatches (
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
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
CREATE TABLE workflow_goal_instances (
    goal_instance_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
INSERT INTO workflow_goal_instances VALUES('b0d6382e-9310-4514-bd75-1f0cd3b117d2','5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','2026-10-29T04:53:10.646Z');
INSERT INTO workflow_goal_instances VALUES('4b8845cf-3ec3-4b21-b951-bd1d183fe107','9983e6ce-47c3-4f53-ad7f-9a6a172d9470','2026-10-29T04:53:10.655Z');
INSERT INTO workflow_goal_instances VALUES('cfeb959c-5999-4abf-b049-7d30e543c0b1','4c0244eb-ffed-4073-98a2-8f5c55d41bb9','2026-10-29T04:53:10.660Z');
INSERT INTO workflow_goal_instances VALUES('5f5b46fa-0381-4f59-877f-b4e19f400199','fea8e2f8-9f91-4381-835f-d1f2308b3445','2026-10-29T04:53:10.664Z');
CREATE TABLE IF NOT EXISTS "workflow_run_bindings" (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal_instance_id TEXT NOT NULL REFERENCES workflow_goal_instances(goal_instance_id),
    goal_version INTEGER NOT NULL CHECK (goal_version > 0),
    plan_version INTEGER,
    workflow_revision_id INTEGER NOT NULL REFERENCES workflow_state_revisions(id),
    created_at TEXT NOT NULL
  );
INSERT INTO workflow_run_bindings VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25:invoking','5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','b0d6382e-9310-4514-bd75-1f0cd3b117d2',1,1,3,'2026-10-29T04:53:10.650Z');
INSERT INTO workflow_run_bindings VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470:invoking','9983e6ce-47c3-4f53-ad7f-9a6a172d9470','4b8845cf-3ec3-4b21-b951-bd1d183fe107',1,1,6,'2026-10-29T04:53:10.657Z');
CREATE TABLE workflow_goal_worker_generations (
    goal_instance_id TEXT PRIMARY KEY REFERENCES workflow_goal_instances(goal_instance_id),
    source_generation TEXT NOT NULL UNIQUE CHECK (length(source_generation) > 0),
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
    worker_url TEXT NOT NULL CHECK (substr(worker_url, 1, 5) = 'file:'),
    created_at TEXT NOT NULL
  );
CREATE TABLE workflow_goal_native_artifacts (
    goal_instance_id TEXT PRIMARY KEY REFERENCES workflow_goal_instances(goal_instance_id),
    artifact_url TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
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
INSERT INTO workflow_new_goal_requests VALUES('5b3d4c6f-953d-4654-a2f2-2cbfbee89c25:invoking','5b3d4c6f-953d-4654-a2f2-2cbfbee89c25','b0d6382e-9310-4514-bd75-1f0cd3b117d2',3,'{"action":"new_independent_goal","previousGoalInstanceId":"b0d6382e-9310-4514-bd75-1f0cd3b117d2","reason":"fixture independent task","goal":{"statement":"fixture next goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"status":"active"}}','accepted',NULL,NULL,'2026-10-29T04:53:10.653Z',NULL);
INSERT INTO workflow_new_goal_requests VALUES('9983e6ce-47c3-4f53-ad7f-9a6a172d9470:invoking','9983e6ce-47c3-4f53-ad7f-9a6a172d9470','4b8845cf-3ec3-4b21-b951-bd1d183fe107',6,'{"action":"new_independent_goal","previousGoalInstanceId":"4b8845cf-3ec3-4b21-b951-bd1d183fe107","reason":"fixture independent task","goal":{"statement":"fixture next goal","outcomes":["fixture outcome"],"constraints":[],"nonGoals":[],"assumptions":[],"openQuestions":[],"status":"active"}}','accepted',NULL,NULL,'2026-10-29T04:53:10.659Z',NULL);
CREATE TABLE rrsi_corpus_receipts (version TEXT PRIMARY KEY, experiment_id TEXT NOT NULL);
CREATE TABLE rrsi_versions (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE rrsi_state (id INTEGER PRIMARY KEY CHECK(id=1), version_id TEXT NOT NULL REFERENCES rrsi_versions(id), settings TEXT NOT NULL CHECK(json_valid(settings)));
CREATE TABLE rrsi_goal_pins (goal_id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES rrsi_versions(id));
CREATE TABLE rrsi_experiments (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE owner_workflow_executions (
    execution_id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    parent_execution_id TEXT REFERENCES owner_workflow_executions(execution_id),
    status TEXT NOT NULL CHECK (status IN ('running', 'suspended', 'completed', 'interrupted')),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
  );
INSERT INTO owner_workflow_executions VALUES('0382ff15140f667581c3ad594ed45d08','RelayedApprovalExecution','{"approvalId":"44560059-4796-4827-9a49-c121f7a5ed93","sessionId":"5b3d4c6f-953d-4654-a2f2-2cbfbee89c25","runId":"5b3d4c6f-953d-4654-a2f2-2cbfbee89c25:invoking","requester":{"kind":"subagent","subagentId":"fixture-child","name":null},"toolName":"write_file","argumentsJson":"{}","reason":"Approve this write","askedBy":"every_call","createdAt":1793249590666,"timeoutMs":86400000}',NULL,'suspended','{"_tag":"Suspended"}');
INSERT INTO owner_workflow_executions VALUES('8c1cde35f78a6dcc05e7f876ec8fda58','ProviderRetryWait','{"sessionId":"5b3d4c6f-953d-4654-a2f2-2cbfbee89c25","runId":"5b3d4c6f-953d-4654-a2f2-2cbfbee89c25:invoking","sequence":0,"retry":10,"stage":"connect","firstFailedAt":1793249590690,"retryAt":1793250776518}',NULL,'suspended','{"_tag":"Suspended"}');
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
INSERT INTO owner_workflow_clocks VALUES('0382ff15140f667581c3ad594ed45d08','RelayedApproval/Timeout','RelayedApprovalExecution','DurableClock/RelayedApproval/Timeout',1793335990671,'scheduled');
INSERT INTO owner_workflow_clocks VALUES('8c1cde35f78a6dcc05e7f876ec8fda58','ProviderRetry/Wait','ProviderRetryWait','DurableClock/ProviderRetry/Wait',1793250776519,'scheduled');
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
CREATE TABLE btw_threads (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    messages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)),
    created_at TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE TABLE btw_attachments (
    thread_id TEXT NOT NULL REFERENCES btw_threads(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, attachment_id)
  );
CREATE TABLE workflow_uncertain_acknowledgements (
    run_id TEXT PRIMARY KEY REFERENCES workflow_run_bindings(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL
  );
CREATE TABLE shell_skill_approvals (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    script_sha256 TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name, script_sha256)
  );
CREATE TABLE worktree_parents (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent TEXT NOT NULL,
    PRIMARY KEY (project_id, parent)
  );
CREATE TABLE node_vector_chunks (
    vector_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(vector_id >= 4503599627370496 AND vector_id <= 9007199254740991),
    node_seq INTEGER NOT NULL REFERENCES nodes(seq) ON DELETE CASCADE,
    embedder TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
    UNIQUE(node_seq, embedder, ordinal)
  );
CREATE TABLE memory_chunk_vector_removals (
    vector_id INTEGER NOT NULL,
    embedder TEXT NOT NULL,
    PRIMARY KEY(vector_id, embedder)
  );
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
CREATE TABLE human_decision_closures (
    execution_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL
      CHECK (reason IN ('orchestrator_cancelled', 'goal_replaced', 'card_stopped')),
    closed_at TEXT NOT NULL
  );
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
CREATE TABLE kanban_card_runs (
    run_id TEXT PRIMARY KEY,
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    trace_attempt_id TEXT,
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL
  );
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
CREATE TABLE kanban_decision_followups (
    request_id TEXT PRIMARY KEY,
    goal_instance_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
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
CREATE TABLE kanban_goal_dependencies (
    goal_instance_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (goal_instance_id, depends_on)
  );
CREATE TABLE kanban_project_settings (
    project_id TEXT PRIMARY KEY,
    protected_branches_json TEXT NOT NULL CHECK (json_valid(protected_branches_json))
  );
CREATE TABLE node_project_moves (
    from_project TEXT PRIMARY KEY,
    to_project TEXT NOT NULL
  );
CREATE TABLE chat_history_projection (
  thread_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1))
);
CREATE TABLE chat_history_groups (
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  ui_id TEXT NOT NULL,
  messages TEXT NOT NULL CHECK (json_valid(messages) AND json_type(messages) = 'array'),
  PRIMARY KEY (thread_id, ordinal),
  UNIQUE (thread_id, ui_id)
);
PRAGMA writable_schema=ON;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','nodes_fts','nodes_fts',0,'CREATE VIRTUAL TABLE nodes_fts USING fts5(text, content = ''nodes'', content_rowid = ''seq'', tokenize = ''trigram'')');
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','nodes_morph','nodes_morph',0,'CREATE VIRTUAL TABLE nodes_morph USING fts5(terms, tokenize = ''unicode61'')');
CREATE TABLE IF NOT EXISTS sqlite_sequence(name,seq);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('run_events',0);
INSERT INTO sqlite_sequence VALUES('report_adoptions',0);
INSERT INTO sqlite_sequence VALUES('workflow_state_revisions',14);
INSERT INTO sqlite_sequence VALUES('node_vector_chunks',4503599627370495);
CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes
  BEGIN INSERT INTO nodes_fts(rowid, text) VALUES (new.seq, new.text); END;
CREATE TRIGGER workflow_state_revisions_no_update BEFORE UPDATE ON workflow_state_revisions
    BEGIN SELECT RAISE(ABORT, 'workflow revisions are immutable'); END;
CREATE TRIGGER workflow_run_events_no_update BEFORE UPDATE ON workflow_run_events
    BEGIN SELECT RAISE(ABORT, 'run event is immutable'); END;
CREATE TRIGGER workflow_worker_dispatches_no_update BEFORE UPDATE ON workflow_worker_dispatches
    BEGIN SELECT RAISE(ABORT, 'worker dispatch is immutable'); END;
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
CREATE TRIGGER workflow_goal_worker_generations_no_update BEFORE UPDATE ON workflow_goal_worker_generations
    BEGIN SELECT RAISE(ABORT, 'goal source generation is immutable'); END;
CREATE TRIGGER workflow_goal_worker_generations_no_delete BEFORE DELETE ON workflow_goal_worker_generations
    BEGIN SELECT RAISE(ABORT, 'goal source generation is immutable'); END;
CREATE TRIGGER workflow_goal_native_artifacts_no_update BEFORE UPDATE ON workflow_goal_native_artifacts
    BEGIN SELECT RAISE(ABORT, 'native registration is immutable'); END;
CREATE TRIGGER workflow_goal_native_artifacts_no_delete BEFORE DELETE ON workflow_goal_native_artifacts
    BEGIN SELECT RAISE(ABORT, 'native registration is immutable'); END;
CREATE TRIGGER rrsi_versions_immutable BEFORE UPDATE ON rrsi_versions BEGIN SELECT RAISE(ABORT, 'immutable harness version'); END;
CREATE TRIGGER rrsi_versions_retained BEFORE DELETE ON rrsi_versions BEGIN SELECT RAISE(ABORT, 'harness history retained'); END;
CREATE TRIGGER rrsi_pins_immutable BEFORE UPDATE ON rrsi_goal_pins BEGIN SELECT RAISE(ABORT, 'immutable Goal harness pin'); END;
CREATE TRIGGER owner_read_recoveries_no_update BEFORE UPDATE ON owner_read_recoveries
    BEGIN SELECT RAISE(ABORT, 'read recovery receipt is immutable'); END;
CREATE TRIGGER owner_read_recoveries_no_delete BEFORE DELETE ON owner_read_recoveries
    BEGIN SELECT RAISE(ABORT, 'read recovery receipt is retained'); END;
CREATE TRIGGER btw_threads_binding_immutable
    BEFORE UPDATE OF id, parent_session_id, created_at ON btw_threads
    BEGIN SELECT RAISE(ABORT, 'BTW binding is immutable'); END;
CREATE TRIGGER node_vector_chunks_removal BEFORE DELETE ON node_vector_chunks BEGIN
    INSERT OR IGNORE INTO memory_chunk_vector_removals(vector_id, embedder)
      VALUES (old.vector_id, old.embedder);
  END;
CREATE TRIGGER node_vectors_remove_chunks BEFORE DELETE ON node_vectors BEGIN
    DELETE FROM node_vector_chunks WHERE node_seq = old.node_seq AND embedder = old.embedder;
  END;
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
CREATE TRIGGER chat_history_invalidate_update
AFTER UPDATE OF messages ON chat_threads
BEGIN
  UPDATE chat_history_projection SET ready = 0 WHERE thread_id = NEW.thread_id;
END;
CREATE TRIGGER chat_history_invalidate_insert
AFTER INSERT ON chat_threads
BEGIN
  UPDATE chat_history_projection SET ready = 0 WHERE thread_id = NEW.thread_id;
END;
CREATE TRIGGER chat_history_invalidate_delete
AFTER DELETE ON chat_threads
BEGIN
  DELETE FROM chat_history_groups WHERE thread_id = OLD.thread_id;
  DELETE FROM chat_history_projection WHERE thread_id = OLD.thread_id;
END;
CREATE INDEX sessions_project ON sessions(project_id, created_at);
CREATE INDEX nodes_session ON nodes(session_id, seq);
CREATE INDEX nodes_project ON nodes(project_id, seq);
CREATE INDEX edges_to ON edges(to_id, kind);
CREATE INDEX node_refs_ref ON node_refs(ref, node_id);
CREATE INDEX interpret_jobs_status ON interpret_jobs(status, updated_at);
CREATE INDEX permission_reviews_call ON permission_reviews(session_id, tool_call_id, id);
CREATE INDEX chat_runs_thread_status ON chat_runs(thread_id, status, started_at);
CREATE INDEX chat_runs_detached ON chat_runs(status, detached_since);
CREATE INDEX chat_interrupts_thread ON chat_interrupts(thread_id, requested_at, seq);
CREATE INDEX chat_interrupts_run ON chat_interrupts(run_id, requested_at, seq);
CREATE INDEX queued_messages_session ON queued_messages(session_id, seq);
CREATE INDEX interpretations_node ON interpretations(node_id);
CREATE INDEX interpretations_target ON interpretations(target_id, status);
CREATE UNIQUE INDEX subagents_name ON subagents(session_id, name) WHERE name IS NOT NULL;
CREATE INDEX subagents_session ON subagents(session_id, created_at);
CREATE INDEX import_cursors_skipped ON import_cursors(skipped, cwd);
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
CREATE INDEX report_adoptions_task ON report_adoptions(task_id, seq);
CREATE INDEX report_adoptions_attempt ON report_adoptions(attempt_id, seq);
CREATE INDEX parent_notifications_pending
    ON parent_notifications(origin_session_id, delivered_at, seq);
CREATE INDEX parent_notifications_task ON parent_notifications(task_id, seq);
CREATE INDEX work_recovery_jobs_status ON work_recovery_jobs(status, created_at, id);
CREATE UNIQUE INDEX agent_run_attempts_id_task
    ON agent_run_attempts(id, task_id);
CREATE INDEX evidence_refs_task ON evidence_refs(task_id, created_at, id);
CREATE INDEX evidence_refs_attempt ON evidence_refs(attempt_id, created_at, id);
CREATE INDEX work_artifacts_task ON work_artifacts(task_id, created_at, id);
CREATE INDEX work_artifacts_attempt ON work_artifacts(attempt_id, created_at, id);
CREATE INDEX final_answer_sources_task ON final_answer_sources(task_id, claim_id);
CREATE INDEX final_answer_notifications_task ON final_answer_notifications(task_id, claim_id);
CREATE INDEX knowledge_decisions_task ON knowledge_decisions(task_id, created_at, id);
CREATE INDEX memory_candidates_project ON memory_candidates(project_id, created_at, id);
CREATE INDEX memory_candidate_evidence_ref ON memory_candidate_evidence(evidence_ref_id);
CREATE UNIQUE INDEX memory_usage_once
    ON memory_usage_events(candidate_id, parent_run_id, kind, coalesce(parent_message_id, ''));
CREATE INDEX memory_usage_task ON memory_usage_events(candidate_id, created_at, id);
CREATE UNIQUE INDEX lifecycle_one_active_target
    ON lifecycle_operations(target_kind, target_id)
    WHERE status IN ('requested', 'cancelling', 'waiting_for_stop', 'purging');
CREATE INDEX lifecycle_pending ON lifecycle_operations(status, updated_at, id);
CREATE INDEX work_tasks_lifecycle ON work_tasks(project_id, deleted_at, archived_at, updated_at, id);
CREATE INDEX api_usage_responses_session ON api_usage_responses(root_session_id, id);
CREATE INDEX nodes_tool_result_call
    ON nodes(session_id, json_extract(detail, '$.toolCallId'), seq)
    WHERE kind = 'tool_result';
CREATE INDEX oauth_profiles_provider ON oauth_profiles(provider, created_at);
CREATE UNIQUE INDEX oauth_profiles_one_selected ON oauth_profiles(provider) WHERE selected = 1;
CREATE INDEX workflow_state_revisions_session ON workflow_state_revisions(session_id, id);
CREATE INDEX workflow_revisions_goal ON workflow_state_revisions(goal_instance_id, id);
CREATE INDEX workflow_run_events_replay ON workflow_run_events(run_id, cursor);
CREATE INDEX owner_rpc_effects ON owner_rpc_operations(run_id, side_effect, status);
CREATE INDEX workflow_run_bindings_session ON workflow_run_bindings(session_id, run_id);
CREATE UNIQUE INDEX workflow_new_goal_requests_one_pending
    ON workflow_new_goal_requests(session_id) WHERE status = 'accepted';
CREATE UNIQUE INDEX rrsi_one_running ON rrsi_experiments(json_extract(payload, '$.status')) WHERE json_extract(payload, '$.status') = 'running';
CREATE INDEX owner_workflow_executions_parent
    ON owner_workflow_executions(parent_execution_id);
CREATE INDEX owner_workflow_clocks_pending
    ON owner_workflow_clocks(status, due_at);
CREATE INDEX owner_read_recoveries_session ON owner_read_recoveries(session_id, run_id);
CREATE INDEX btw_threads_parent ON btw_threads(parent_session_id, created_at);
CREATE INDEX btw_attachments_attachment ON btw_attachments(attachment_id);
CREATE INDEX nodes_embeddable ON nodes(project_id, seq)
    WHERE kind IN ('user', 'assistant', 'topic')
      AND length(trim(text, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0;
CREATE INDEX node_vector_chunks_embedder ON node_vector_chunks(embedder, vector_id);
CREATE INDEX persisted_queue_items_pending
    ON persisted_queue_items (queue_name, visible_at, sequence) WHERE state = 'pending';
CREATE INDEX persisted_queue_items_settled
    ON persisted_queue_items (state, updated_at) WHERE state != 'pending';
CREATE INDEX board_change_requests_session ON board_change_requests(session_id, status, id);
CREATE INDEX kanban_card_attempts_open ON kanban_card_attempts(goal_instance_id, handled);
CREATE INDEX kanban_card_runs_card ON kanban_card_runs(goal_instance_id, card_id);
CREATE INDEX kanban_decision_followups_goal ON kanban_decision_followups(goal_instance_id);
CREATE INDEX kanban_goal_schedules_project ON kanban_goal_schedules(project_id);
PRAGMA writable_schema=OFF;
COMMIT;
-- `.dump` leaves out the schema version the release wrote.
PRAGMA user_version=63;
