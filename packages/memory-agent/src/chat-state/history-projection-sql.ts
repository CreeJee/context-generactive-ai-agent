/**
 * Disposable history projection. Does not alter chat_threads or user_version.
 * Install/backfill/rollback and SDK adapter wiring are separate rollout steps.
 * SQL is kept here so the bounded read and invalidation contracts are testable
 * without opening or changing an application's live database.
 */
export const historyProjectionSchema = `
CREATE TABLE IF NOT EXISTS chat_history_projection (
  thread_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1))
);
CREATE TABLE IF NOT EXISTS chat_history_groups (
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  ui_id TEXT NOT NULL,
  messages TEXT NOT NULL CHECK (json_valid(messages) AND json_type(messages) = 'array'),
  PRIMARY KEY (thread_id, ordinal),
  UNIQUE (thread_id, ui_id)
);
CREATE TRIGGER IF NOT EXISTS chat_history_invalidate_update
AFTER UPDATE OF messages ON chat_threads
BEGIN
  UPDATE chat_history_projection SET ready = 0 WHERE thread_id = NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS chat_history_invalidate_insert
AFTER INSERT ON chat_threads
BEGIN
  UPDATE chat_history_projection SET ready = 0 WHERE thread_id = NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS chat_history_invalidate_delete
AFTER DELETE ON chat_threads
BEGIN
  DELETE FROM chat_history_groups WHERE thread_id = OLD.thread_id;
  DELETE FROM chat_history_projection WHERE thread_id = OLD.thread_id;
END;
`;

export const historyProjectionRollback = `
DROP TRIGGER IF EXISTS chat_history_invalidate_update;
DROP TRIGGER IF EXISTS chat_history_invalidate_insert;
DROP TRIGGER IF EXISTS chat_history_invalidate_delete;
DROP TABLE IF EXISTS chat_history_groups;
DROP TABLE IF EXISTS chat_history_projection;
`;

export const historyProjectionSql = {
  // Readiness is a prerequisite, never a reason to parse the complete transcript here.
  readiness: "SELECT ready, format_version FROM chat_history_projection WHERE thread_id = ?",
  cursor: "SELECT ordinal FROM chat_history_groups WHERE thread_id = ? AND ui_id = ?",
  initial:
    "SELECT ordinal, ui_id, messages FROM chat_history_groups WHERE thread_id = ?1 AND (SELECT ready FROM chat_history_projection WHERE thread_id = ?1 AND format_version = 1) = 1 ORDER BY ordinal DESC LIMIT ?2",
  older:
    "SELECT ordinal, ui_id, messages FROM chat_history_groups WHERE thread_id = ?1 AND ordinal < ?2 AND (SELECT ready FROM chat_history_projection WHERE thread_id = ?1 AND format_version = 1) = 1 ORDER BY ordinal DESC LIMIT ?3",
  // Separate metadata-only probe: do not fetch a potentially huge sentinel group's JSON.
  hasEarlier:
    "SELECT EXISTS (SELECT 1 FROM chat_history_groups WHERE thread_id = ? AND ordinal < ?) AS has_earlier",
  // Preparation-only: stage invalidation, row replacement and conditional publish
  // inside one savepoint; rollback all of it when publishIfCurrent.changes is 0.
  markUnready: "UPDATE chat_history_projection SET ready = 0 WHERE thread_id = ?",
  publishIfCurrent:
    "INSERT INTO chat_history_projection (thread_id, format_version, ready) SELECT thread_id, 1, 1 FROM chat_threads WHERE thread_id = ? AND messages = ? ON CONFLICT(thread_id) DO UPDATE SET format_version = 1, ready = 1",
  removeGroups: "DELETE FROM chat_history_groups WHERE thread_id = ?",
  insertGroup:
    "INSERT INTO chat_history_groups (thread_id, ordinal, ui_id, messages) VALUES (?, ?, ?, ?)",
  groupIdentities: "SELECT ordinal, ui_id FROM chat_history_groups WHERE thread_id = ?",
  removeInvalidOrdinals:
    "DELETE FROM chat_history_groups WHERE thread_id = ? AND (typeof(ordinal)<>'integer' OR ordinal<0)",
  removeOrdinal: "DELETE FROM chat_history_groups WHERE thread_id = ? AND ordinal = ?",
  removeTail: "DELETE FROM chat_history_groups WHERE thread_id = ? AND ordinal >= ?",
  updateGroup:
    "INSERT INTO chat_history_groups (thread_id, ordinal, ui_id, messages) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS(SELECT 1 FROM chat_history_groups WHERE thread_id=?1 AND ordinal=?2 AND ui_id=?3 AND messages=?4) ON CONFLICT(thread_id, ordinal) DO UPDATE SET ui_id=excluded.ui_id, messages=excluded.messages",
  // Modern writer only: replace the authoritative transcript and these groups
  // in the same savepoint. Backfill must use publishIfCurrent instead.
  publish:
    "INSERT INTO chat_history_projection (thread_id, format_version, ready) VALUES (?, 1, 1) ON CONFLICT(thread_id) DO UPDATE SET format_version = 1, ready = 1",
} as const;

// One statement owns the read snapshot. The materialized page contains only the
// requested group payloads; the earlier-page probe reads index metadata only.
// Empty/non-ready/unknown-cursor reads still return one state row with null page
// columns, so the adapter cannot confuse them with a valid empty transcript.
// Consumers order selected groups by ordinal; no unbounded SQL sort is needed.
const snapshotResult = `
SELECT state.ready, state.format_version, state.cursor_valid,
       page.ordinal, page.ui_id, page.messages,
       EXISTS (SELECT 1 FROM chat_history_groups
               WHERE thread_id = ?1 AND ordinal < (SELECT MIN(ordinal) FROM page)) AS has_earlier
FROM state LEFT JOIN page ON 1 = 1
`;

export const historyProjectionSnapshots = {
  initial: `
WITH state AS (
  SELECT COALESCE(ready, 0) AS ready, COALESCE(format_version, 0) AS format_version,
         1 AS cursor_valid
  FROM (SELECT ?1 AS thread_id) AS input
  LEFT JOIN chat_history_projection USING (thread_id)
), page AS MATERIALIZED (
  SELECT ordinal, ui_id, messages FROM chat_history_groups
  WHERE thread_id = ?1 AND (SELECT ready FROM state) = 1
    AND (SELECT format_version FROM state) = 1
  ORDER BY ordinal DESC LIMIT ?2
)
${snapshotResult}`,
  older: `
WITH state AS (
  SELECT COALESCE(projection.ready, 0) AS ready,
         COALESCE(projection.format_version, 0) AS format_version,
         cursor.ordinal IS NOT NULL AS cursor_valid, cursor.ordinal AS cursor_ordinal
  FROM (SELECT ?1 AS thread_id) AS input
  LEFT JOIN chat_history_projection AS projection USING (thread_id)
  LEFT JOIN chat_history_groups AS cursor
    ON cursor.thread_id = input.thread_id AND cursor.ui_id = ?2
), page AS MATERIALIZED (
  SELECT ordinal, ui_id, messages FROM chat_history_groups
  WHERE thread_id = ?1 AND ordinal < (SELECT cursor_ordinal FROM state)
    AND (SELECT ready FROM state) = 1 AND (SELECT format_version FROM state) = 1
  ORDER BY ordinal DESC LIMIT ?3
)
${snapshotResult}`,
} as const;
