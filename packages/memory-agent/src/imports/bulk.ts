import { Array as EffectArray, HashSet, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import { Context, Crypto, Effect, Layer, Match, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { edgeWeights, type EdgeKind } from "../memory/edges.ts";
import { hasStatementText } from "../memory/quality.ts";
import { NodeDetail, type NodeKind } from "../memory/nodes.ts";
import { TranscriptItem, type ImportSourceName } from "./items.ts";

/** Statements worth interpreting, the same rule live nodes follow (`interpretedKinds` in nodes.ts). */
const interpretedKinds = HashSet.fromIterable<NodeKind>(["user"]);

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

/** A migrated conversation could not be written; nothing of that piece was kept. */
export class BulkWriteFailed extends Schema.TaggedError<BulkWriteFailed>()("BulkWriteFailed", {
  cause: Schema.Defect(),
}) {}

const IdRow = Schema.Struct({ id: Schema.String });
const encodeDetail = Schema.encodeEffect(Schema.fromJsonString(NodeDetail));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const idOf = Effect.map(
    Option.match({ onNone: () => null, onSome: (row: typeof IdRow.Type) => row.id }),
  );

  const latestWithRef = SqlSchema.findOneOption({
    Request: Schema.Struct({ ref: Schema.String, projectId: Schema.String }),
    Result: IdRow,
    execute: ({ ref, projectId }) => sql`
      SELECT r.node_id AS id FROM node_refs r JOIN nodes n ON n.id = r.node_id
      WHERE r.ref = ${ref} AND n.project_id = ${projectId} ORDER BY n.seq DESC LIMIT 1`,
  });
  const lastInSession = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IdRow,
    execute: (sessionId) =>
      sql`SELECT id FROM nodes WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1`,
  });
  const lastUser = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IdRow,
    execute: (sessionId) => sql`SELECT id FROM nodes WHERE session_id = ${sessionId}
      AND kind = 'user' ORDER BY seq DESC LIMIT 1`,
  });
  // Only an answer in the turn still open: after a user message nothing has answered yet.
  const answerInOpenTurn = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IdRow,
    execute: (sessionId) => sql`
      SELECT id FROM nodes WHERE session_id = ${sessionId} AND kind = 'assistant'
      AND seq > coalesce((SELECT max(seq) FROM nodes
        WHERE session_id = ${sessionId} AND kind = 'user'), 0)
      ORDER BY seq DESC LIMIT 1`,
  });
  const callNode = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, toolCallId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String, tool_name: Schema.NullOr(Schema.String) }),
    execute: ({ sessionId, toolCallId }) => sql`
      SELECT id, json_extract(detail, '$.toolName') AS tool_name FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'tool_call'
      AND json_extract(detail, '$.toolCallId') = ${toolCallId} ORDER BY seq LIMIT 1`,
  });
  const alreadyImported = SqlSchema.findOneOption({
    Request: Schema.Struct({ source: Schema.String, externalId: Schema.String }),
    Result: IdRow,
    execute: ({ source, externalId }) => sql`SELECT node_id AS id FROM imported_nodes
      WHERE source = ${source} AND external_id = ${externalId}`,
  });

  const link = (fromId: string, toId: string, kind: EdgeKind, at: string) =>
    sql`INSERT INTO edges VALUES (${fromId}, ${toId}, ${kind}, 'structure', ${edgeWeights[kind]},
      ${at}) ON CONFLICT DO NOTHING`;

  /**
   * Writes one conversation as nodes, keeping the times the other tool recorded. This is the bulk
   * path on purpose: `Nodes.append` stamps the present and opens a transaction per node, which is
   * right for a live turn and wrong for a transcript of thousands of lines.
   */
  const write = (migration: Migration) =>
    Effect.gen(function* () {
      const { source, projectId, sessionId } = migration;
      // Resuming mid-transcript (a later pass, or the next piece of a long one) must continue the
      // turn it stopped in, so the state comes from the session rather than from this batch.
      let previousId = yield* idOf(lastInSession(sessionId));
      let userNodeId = yield* idOf(lastUser(sessionId));
      let assistantNodeId = yield* idOf(answerInOpenTurn(sessionId));
      let written = 0;
      let repeated = 0;

      const append = Effect.fnUntraced(function* (
        kind: NodeKind,
        text: string,
        at: string,
        externalId: string | null,
        detail: NodeDetail,
      ) {
        const id = yield* crypto.randomUUIDv4();
        // A user turn opens its own run, and what answers it joins that run. `history.ts` groups a
        // transcript by run id, so this is what makes a migrated conversation render as turns.
        const runId = kind === "user" ? `imported:${id}` : `imported:${userNodeId ?? sessionId}`;
        yield* sql`INSERT INTO nodes ${sql.insert({
          id,
          project_id: projectId,
          session_id: sessionId,
          run_id: runId,
          kind,
          text,
          detail: yield* encodeDetail({ ...detail, importedFrom: source }),
          created_at: at,
        })}`;
        if (isTruthy(previousId)) yield* link(previousId, id, "next", at);
        previousId = id;
        // An empty answer is not a statement; interpreting it would cost a model call for nothing.
        if (migration.interpret && HashSet.has(interpretedKinds, kind) && hasStatementText(text))
          yield* sql`INSERT INTO interpret_jobs (node_id, status, updated_at)
            VALUES (${id}, 'pending', ${at})`;
        if (externalId !== null)
          yield* sql`INSERT INTO imported_nodes (source, external_id, node_id)
            VALUES (${source}, ${externalId}, ${id}) ON CONFLICT DO NOTHING`;
        written += 1;
        return id;
      });

      /**
       * The assistant turn a tool call belongs to. When the assistant called a tool without saying
       * anything, there is no statement to hang the call on, so an empty one stands in — the same
       * node the live recorder writes in that case, so both look alike to `trace_evidence`.
       */
      const assistantFor = Effect.fnUntraced(function* (at: string) {
        if (isTruthy(assistantNodeId)) return assistantNodeId;
        const id = yield* append("assistant", "", at, null, {});
        if (isTruthy(userNodeId)) yield* link(id, userNodeId, "reply", at);
        assistantNodeId = id;
        return id;
      });

      for (const item of migration.items) {
        if (TranscriptItem.$is("session")(item) || TranscriptItem.$is("ignored")(item)) continue;
        if (Option.isSome(yield* alreadyImported({ source, externalId: item.externalId }))) {
          repeated += 1;
          continue;
        }
        yield* Match.valueTags(item, {
          message: (item) =>
            Effect.gen(function* () {
              const id = yield* append(item.role, item.text, item.at, item.externalId, {});
              if (item.role === "user") {
                userNodeId = id;
                assistantNodeId = null;
                return;
              }
              if (isTruthy(userNodeId)) yield* link(id, userNodeId, "reply", item.at);
              assistantNodeId = id;
            }),
          tool_call: (item) =>
            Effect.gen(function* () {
              const calledBy = yield* assistantFor(item.at);
              const id = yield* append("tool_call", item.text, item.at, item.externalId, {
                toolName: item.toolName,
                toolCallId: item.toolCallId,
              });
              yield* link(calledBy, id, "calls", item.at);
              for (const ref of EffectArray.dedupe(item.refs)) {
                const earlier = yield* idOf(latestWithRef({ ref, projectId }));
                yield* sql`INSERT INTO node_refs VALUES (${id}, ${ref}) ON CONFLICT DO NOTHING`;
                if (isTruthy(earlier)) yield* link(id, earlier, "touches", item.at);
              }
            }),
          tool_result: (item) =>
            Effect.gen(function* () {
              const called = Option.getOrNull(
                yield* callNode({ sessionId, toolCallId: item.toolCallId }),
              );
              const id = yield* append("tool_result", item.text, item.at, item.externalId, {
                toolName: called?.tool_name ?? undefined,
                toolCallId: item.toolCallId,
                ok: item.ok,
              });
              if (isTruthy(called)) yield* link(called.id, id, "returns", item.at);
            }),
        });
      }
      return { written, repeated } satisfies MigrationCount;
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) => BulkWriteFailed.make({ cause })),
    );

  return { write };
});

/**
 * Writes a migrated conversation straight into the node tables. Nodes stay immutable evidence and
 * get the same structural edges live ones do; only the clock differs.
 */
export class BulkNodes extends Context.Service<BulkNodes, Effect.Success<typeof make>>()(
  "memory-agent/imports/bulk/BulkNodes",
) {
  static readonly layer = Layer.effect(BulkNodes, make).pipe(Layer.provide(NodeCrypto.layer));
}
