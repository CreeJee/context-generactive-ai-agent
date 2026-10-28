import { Array as EffectArray, HashSet, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import { Context, Crypto, Effect, Layer, Match, Ref, Schema } from "effect";
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

  /** An edge between two nodes; none while an end is unknown (nothing before it, a call unseen). */
  const link = (fromId: string | null, toId: string | null, kind: EdgeKind, at: string) =>
    Option.match(Option.all([Option.fromNullishOr(fromId), Option.fromNullishOr(toId)]), {
      onNone: () => Effect.void,
      onSome: ([from, to]) =>
        Effect.asVoid(sql`INSERT INTO edges
          VALUES (${from}, ${to}, ${kind}, 'structure', ${edgeWeights[kind]}, ${at})
          ON CONFLICT DO NOTHING`),
    });

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
      const previousId = yield* Ref.make(yield* idOf(lastInSession(sessionId)));
      /** The user node of the open turn, and the answer it has so far. */
      const turn = yield* Ref.make({
        user: yield* idOf(lastUser(sessionId)),
        assistant: yield* idOf(answerInOpenTurn(sessionId)),
      });
      const written = yield* Ref.make(0);

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
        const runId =
          kind === "user"
            ? `imported:${id}`
            : `imported:${(yield* Ref.get(turn)).user ?? sessionId}`;
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
        yield* link(yield* Ref.getAndSet(previousId, id), id, "next", at);
        // An empty answer is not a statement; interpreting it would cost a model call for nothing.
        if (migration.interpret && HashSet.has(interpretedKinds, kind) && hasStatementText(text))
          yield* sql`INSERT INTO interpret_jobs (node_id, status, updated_at)
            VALUES (${id}, 'pending', ${at})`;
        yield* Effect.when(
          sql`INSERT INTO imported_nodes (source, external_id, node_id)
            VALUES (${source}, ${externalId}, ${id}) ON CONFLICT DO NOTHING`,
          Effect.succeed(externalId !== null),
        );
        yield* Ref.update(written, (count) => count + 1);
        return id;
      });

      /**
       * The assistant turn a tool call belongs to. When the assistant called a tool without saying
       * anything, there is no statement to hang the call on, so an empty one stands in — the same
       * node the live recorder writes in that case, so both look alike to `trace_evidence`.
       */
      const assistantFor = Effect.fnUntraced(function* (at: string) {
        const open = yield* Ref.get(turn);
        if (isTruthy(open.assistant)) return open.assistant;
        const id = yield* append("assistant", "", at, null, {});
        yield* link(id, open.user, "reply", at);
        yield* Ref.set(turn, { user: open.user, assistant: id });
        return id;
      });

      /** Writes an item unless its line already became a node; those only count as repeated. */
      const once = <E, R>(externalId: string, writeItem: Effect.Effect<void, E, R>) =>
        Effect.flatMap(
          alreadyImported({ source, externalId }),
          Option.match({
            onSome: () => Effect.succeed(true),
            onNone: () => Effect.as(writeItem, false),
          }),
        );

      const repeats = yield* Effect.forEach(migration.items, (item) =>
        Match.valueTags(item, {
          session: () => Effect.succeed(false),
          ignored: () => Effect.succeed(false),
          message: (item) =>
            once(
              item.externalId,
              Effect.gen(function* () {
                const id = yield* append(item.role, item.text, item.at, item.externalId, {});
                const { user } = yield* Ref.get(turn);
                // A user message opens a turn; an answer replies to the turn's user message.
                yield* item.role === "user"
                  ? Ref.set(turn, { user: id, assistant: null })
                  : Effect.andThen(
                      link(id, user, "reply", item.at),
                      Ref.set(turn, { user, assistant: id }),
                    );
              }),
            ),
          tool_call: (item) =>
            once(
              item.externalId,
              Effect.gen(function* () {
                const calledBy = yield* assistantFor(item.at);
                const id = yield* append("tool_call", item.text, item.at, item.externalId, {
                  toolName: item.toolName,
                  toolCallId: item.toolCallId,
                });
                yield* link(calledBy, id, "calls", item.at);
                yield* Effect.forEach(
                  EffectArray.dedupe(item.refs),
                  (ref) =>
                    Effect.gen(function* () {
                      const earlier = yield* idOf(latestWithRef({ ref, projectId }));
                      yield* sql`INSERT INTO node_refs VALUES (${id}, ${ref}) ON CONFLICT DO NOTHING`;
                      yield* link(id, earlier, "touches", item.at);
                    }),
                  { discard: true },
                );
              }),
            ),
          tool_result: (item) =>
            once(
              item.externalId,
              Effect.gen(function* () {
                const called = Option.getOrNull(
                  yield* callNode({ sessionId, toolCallId: item.toolCallId }),
                );
                const id = yield* append("tool_result", item.text, item.at, item.externalId, {
                  toolName: called?.tool_name ?? undefined,
                  toolCallId: item.toolCallId,
                  ok: item.ok,
                });
                yield* link(called?.id ?? null, id, "returns", item.at);
              }),
            ),
        }),
      );
      return {
        written: yield* Ref.get(written),
        repeated: repeats.filter((repeat) => repeat).length,
      } satisfies MigrationCount;
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
