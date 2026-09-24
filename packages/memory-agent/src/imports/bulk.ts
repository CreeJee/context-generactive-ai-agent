import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { edgeWeights, type EdgeKind } from "../memory/edges.ts";
import type { NodeDetail, NodeKind } from "../memory/nodes.ts";
import type { ImportSourceName, TranscriptItem } from "./items.ts";

/** One conversation's worth of items, already tied to a project and a session. */
export interface Migration {
  readonly source: ImportSourceName;
  readonly projectId: string;
  readonly sessionId: string;
  /** In the order the other tool wrote them. */
  readonly items: readonly TranscriptItem[];
  /** Queue migrated statements for llm-interpret, as statements said here are queued. */
  readonly interpret: boolean;
}

export interface MigrationCount {
  readonly written: number;
  /** Items whose line had already become a node; rereading a transcript is meant to be free. */
  readonly repeated: number;
}

const decodeId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));
const idOf = (row: Record<string, SQLOutputValue> | undefined) => (row ? decodeId(row).id : null);
const decodeCall = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, tool_name: Schema.NullOr(Schema.String) }),
);

/** Statements worth interpreting, the same rule live nodes follow: tool output is not a claim. */
const interpretedKinds: ReadonlySet<NodeKind> = new Set(["user", "assistant"]);

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;

  const insertNode = sqlite.prepare(
    "INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = sqlite.prepare(
    "INSERT INTO edges VALUES (?, ?, ?, 'structure', ?, ?) ON CONFLICT DO NOTHING",
  );
  const insertRef = sqlite.prepare("INSERT INTO node_refs VALUES (?, ?) ON CONFLICT DO NOTHING");
  const latestWithRef = sqlite.prepare(`
    SELECT r.node_id AS id FROM node_refs r JOIN nodes n ON n.id = r.node_id
    WHERE r.ref = ? AND n.project_id = ? ORDER BY n.seq DESC LIMIT 1`);
  const insertJob = sqlite.prepare(
    "INSERT INTO interpret_jobs (node_id, status, updated_at) VALUES (?, 'pending', ?)",
  );
  const lastInSession = sqlite.prepare(
    "SELECT id FROM nodes WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
  );
  const lastUser = sqlite.prepare(
    "SELECT id FROM nodes WHERE session_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT 1",
  );
  // Only an answer in the turn still open: after a user message nothing has answered yet.
  const answerInOpenTurn = sqlite.prepare(`
    SELECT id FROM nodes WHERE session_id = ? AND kind = 'assistant'
    AND seq > coalesce((SELECT max(seq) FROM nodes WHERE session_id = ? AND kind = 'user'), 0)
    ORDER BY seq DESC LIMIT 1`);
  const callNode = sqlite.prepare(`
    SELECT id, json_extract(detail, '$.toolName') AS tool_name FROM nodes
    WHERE session_id = ? AND kind = 'tool_call'
    AND json_extract(detail, '$.toolCallId') = ? ORDER BY seq LIMIT 1`);
  const markImported = sqlite.prepare(
    "INSERT INTO imported_nodes (source, external_id, node_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const alreadyImported = sqlite.prepare(
    "SELECT node_id AS id FROM imported_nodes WHERE source = ? AND external_id = ?",
  );

  /**
   * Writes one conversation as nodes, keeping the times the other tool recorded. This is the bulk
   * path on purpose: `Nodes.append` stamps the present and opens a transaction per node, which is
   * right for a live turn and wrong for a transcript of thousands of lines.
   */
  const write = (migration: Migration): MigrationCount =>
    atomic(() => {
      const { source, projectId, sessionId } = migration;
      // Resuming mid-transcript (a later pass, or the next piece of a long one) must continue the
      // turn it stopped in, so the state comes from the session rather than from this batch.
      let previousId = idOf(lastInSession.get(sessionId));
      let userNodeId = idOf(lastUser.get(sessionId));
      let assistantNodeId = idOf(answerInOpenTurn.get(sessionId, sessionId));
      let written = 0;
      let repeated = 0;

      const link = (fromId: string, toId: string, kind: EdgeKind, at: string) =>
        insertEdge.run(fromId, toId, kind, edgeWeights[kind], at);

      const append = (
        kind: NodeKind,
        text: string,
        at: string,
        externalId: string | null,
        detail: NodeDetail,
      ) => {
        const id = randomUUID();
        // A user turn opens its own run, and what answers it joins that run. `history.ts` groups a
        // transcript by run id, so this is what makes a migrated conversation render as turns.
        const runId = kind === "user" ? `imported:${id}` : `imported:${userNodeId ?? sessionId}`;
        insertNode.run(
          id,
          projectId,
          sessionId,
          runId,
          kind,
          text,
          JSON.stringify({ ...detail, importedFrom: source }),
          at,
        );
        if (previousId) link(previousId, id, "next", at);
        previousId = id;
        // An empty answer is not a statement; interpreting it would cost a model call for nothing.
        if (migration.interpret && interpretedKinds.has(kind) && text.length > 0)
          insertJob.run(id, at);
        if (externalId !== null) markImported.run(source, externalId, id);
        written += 1;
        return id;
      };

      /**
       * The assistant turn a tool call belongs to. When the assistant called a tool without saying
       * anything, there is no statement to hang the call on, so an empty one stands in — the same
       * node the live recorder writes in that case, so both look alike to `trace_evidence`.
       */
      const assistantFor = (at: string) => {
        if (assistantNodeId) return assistantNodeId;
        const id = append("assistant", "", at, null, {});
        if (userNodeId) link(id, userNodeId, "reply", at);
        assistantNodeId = id;
        return id;
      };

      for (const item of migration.items) {
        if (item.kind === "session" || item.kind === "ignored") continue;
        if (alreadyImported.get(source, item.externalId)) {
          repeated += 1;
          continue;
        }
        switch (item.kind) {
          case "message": {
            const id = append(item.role, item.text, item.at, item.externalId, {});
            if (item.role === "user") {
              userNodeId = id;
              assistantNodeId = null;
              continue;
            }
            if (userNodeId) link(id, userNodeId, "reply", item.at);
            assistantNodeId = id;
            continue;
          }
          case "tool_call": {
            const calledBy = assistantFor(item.at);
            const id = append("tool_call", item.text, item.at, item.externalId, {
              toolName: item.toolName,
              toolCallId: item.toolCallId,
            });
            link(calledBy, id, "calls", item.at);
            for (const ref of new Set(item.refs)) {
              const earlier = idOf(latestWithRef.get(ref, projectId));
              insertRef.run(id, ref);
              if (earlier) link(id, earlier, "touches", item.at);
            }
            continue;
          }
          case "tool_result": {
            const row = callNode.get(sessionId, item.toolCallId);
            const called = row ? decodeCall(row) : null;
            const id = append("tool_result", item.text, item.at, item.externalId, {
              toolName: called?.tool_name ?? undefined,
              toolCallId: item.toolCallId,
              ok: item.ok,
            });
            if (called) link(id, called.id, "returns", item.at);
          }
        }
      }
      return { written, repeated };
    });

  return { write };
});

/**
 * Writes a migrated conversation straight into the node tables. Nodes stay immutable evidence and
 * get the same structural edges live ones do; only the clock differs.
 */
export class BulkNodes extends Context.Service<BulkNodes, Effect.Success<typeof make>>()(
  "memory-agent/BulkNodes",
) {
  static readonly layer = Layer.effect(BulkNodes, make);
}
