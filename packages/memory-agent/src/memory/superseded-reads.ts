// Native host/SDK boundary uses synchronous SQLite contracts.
import type { DatabaseSync } from "node:sqlite";
import { memoryGraphRepairVersion } from "./quality.ts";

/** The app's own reads; their results are JSON carrying the file's sha256. */
const readTools = "'read_file', 'read_outside_file'";

/** Only internal column names are passed here. A result that is not JSON has no sha256. */
const shaOf = (column: string) =>
  `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.sha256') END`;

/**
 * Search leaves out a read result once a later read of the same file in the project saw other
 * content: it shows a file that is no longer there. The node itself stays, as evidence of what was
 * read then, and `read_evidence` and the transcript still show it.
 */
export function createSupersededReads(sqlite: DatabaseSync) {
  // The file is the one the calls named: `returns` runs from a call to its result.
  const suppress = sqlite.prepare(`
    INSERT INTO memory_graph_suppressed_nodes (node_seq, version, reason)
    SELECT DISTINCT old.seq, ?, 'superseded_read' FROM nodes cur
    JOIN edges ce ON ce.to_id = cur.id AND ce.kind = 'returns'
    JOIN node_refs cr ON cr.node_id = ce.from_id
    JOIN node_refs pr ON pr.ref = cr.ref AND pr.node_id <> cr.node_id
    JOIN nodes pc ON pc.id = pr.node_id AND pc.kind = 'tool_call' AND pc.project_id = cur.project_id
    JOIN edges pe ON pe.from_id = pc.id AND pe.kind = 'returns'
    JOIN nodes old ON old.id = pe.to_id AND old.kind = 'tool_result' AND old.seq < cur.seq
    WHERE cur.id = ? AND cur.kind = 'tool_result'
      AND json_extract(cur.detail, '$.toolName') IN (${readTools})
      AND json_extract(old.detail, '$.toolName') = json_extract(cur.detail, '$.toolName')
      AND NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = old.seq)
      AND ${shaOf("old.text")} <> ${shaOf("cur.text")}
    ON CONFLICT DO NOTHING`);
  /** Applies the rule for one newly recorded result. Call inside the transaction that wrote it. */
  return (resultId: string) => {
    suppress.run(memoryGraphRepairVersion, resultId);
  };
}
