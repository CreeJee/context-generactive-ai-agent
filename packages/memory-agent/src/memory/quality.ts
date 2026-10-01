/** Empty tool-phase assistant nodes remain evidence, but are not semantic statements. */
export const hasStatementText = (text: string) => text.trim().length > 0;

/** Only internal column names are passed here; user input must never become SQL. */
export const nonBlankTextSql = (column: string) =>
  `length(trim(${column}, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0`;

/** SQL counterpart used with the nodes table aliased as n. */
export const meaningfulNodeFilter = `${nonBlankTextSql("n.text")}
  AND NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)`;
