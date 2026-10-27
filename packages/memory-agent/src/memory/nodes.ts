import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import {
  DateTime,
  Crypto,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  HashSet,
  Array as EffectArray,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { createResultPageReader } from "./result-pages.ts";
import { hasStatementText } from "./quality.ts";
import { createSupersededReads } from "./superseded-reads.ts";
import { firstMessageTitle } from "../sessions/title.ts";
import { EdgeKind, EdgeOrigin, edgeWeights, type Edge, type NodeLink } from "./edges.ts";

export const NodeKind = Schema.Literals([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "file_observation",
  "topic",
]);
export type NodeKind = typeof NodeKind.Type;

/** Facts about a node that are not its text. Every field is optional because kinds use different ones. */
export const NodeDetail = Schema.Struct({
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  /** tool_result: false when the tool threw or was rejected. */
  ok: Schema.optional(Schema.Boolean),
  /** assistant: the run ended (abort/error) before this text was complete. */
  partial: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  /** tool_result of an approval-gated call: who allowed or refused it, and why. */
  permission: Schema.optional(
    Schema.Struct({ decision: Schema.String, decidedBy: Schema.String, reason: Schema.String }),
  ),
  /** assistant: said by an external ACP agent in a direct conversation, not the app's model. */
  externalAgent: Schema.optional(Schema.String),
  /**
   * Migrated from another coding agent's local transcript ('claude-code', 'codex'), not said here.
   * Its approvals and permissions were that tool's, and do not carry over.
   */
  importedFrom: Schema.optional(Schema.String),
  /** Project-owned topic node created only after an explicit memory-promotion disposition. */
  memoryCandidateId: Schema.optional(Schema.String),
  /** User message whose turn authorized the promotion disposition. */
  authorizedByUserNodeId: Schema.optional(Schema.String),
});
export type NodeDetail = typeof NodeDetail.Type;

export const Node = Schema.Struct({
  seq: Schema.Finite,
  id: Schema.String,
  projectId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  kind: NodeKind,
  text: Schema.String,
  detail: NodeDetail,
  createdAt: Schema.String,
});
export type Node = typeof Node.Type;

export interface NewNode {
  readonly projectId: string;
  /** Required for every kind except topic. */
  readonly sessionId: string | null;
  readonly runId?: string;
  readonly kind: NodeKind;
  /** Stored verbatim; this is the evidence. */
  readonly text: string;
  readonly detail?: NodeDetail;
  readonly links?: readonly NodeLink[];
  /** Files or URLs this node refers to. */
  readonly refs?: readonly string[];
}

/** A window of a node's original text. Offsets are UTF-16 code units, like JavaScript strings. */
export interface EvidencePage {
  readonly id: string;
  readonly kind: NodeKind;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly length: number;
}

/** A UTF-16 window of `text` that never ends inside a surrogate pair. */
export const textWindow: {
  (offset: number, length: number): (text: string) => ReturnType<typeof textWindowBody>;
} & typeof textWindowBody = EffectFunction.dual(3, textWindowBody);
function textWindowBody(text: string, offset: number, length: number) {
  const start = Math.min(Math.max(0, Math.trunc(offset)), text.length);
  let end = Math.min(start + length, text.length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    text: text.slice(start, end),
    offset: start,
    nextOffset: end < text.length ? end : null,
    length: text.length,
  };
}

export const NodeRow = Schema.Struct({
  seq: Schema.Finite,
  id: Schema.String,
  project_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  run_id: Schema.NullOr(Schema.String),
  kind: NodeKind,
  text: Schema.String,
  detail: Schema.fromJsonString(NodeDetail),
  created_at: Schema.String,
});

/** A node from its decoded `nodes` row. */
export const nodeOfRow = (row: typeof NodeRow.Type): Node => ({
  seq: row.seq,
  id: row.id,
  projectId: row.project_id,
  sessionId: row.session_id,
  runId: row.run_id,
  kind: row.kind,
  text: row.text,
  detail: row.detail,
  createdAt: row.created_at,
});

export const EdgeRow = Schema.Struct({
  from_id: Schema.String,
  to_id: Schema.String,
  kind: EdgeKind,
  origin: EdgeOrigin,
  weight: Schema.Finite,
  created_at: Schema.String,
});

/** An edge from its decoded `edges` row. */
export const edgeOfRow = (row: typeof EdgeRow.Type): Edge => ({
  fromId: row.from_id,
  toId: row.to_id,
  kind: row.kind,
  origin: row.origin,
  weight: row.weight,
  createdAt: row.created_at,
});

/** The node store could not be read or written; the cause stays with the error. */
export class NodeStoreFailed extends Schema.TaggedError<NodeStoreFailed>()("NodeStoreFailed", {
  cause: Schema.Defect(),
}) {}
const stored = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, (cause) => NodeStoreFailed.make({ cause }));

/** Characters of original text returned per read_evidence page. */
export const evidencePageLength = 4000;

/**
 * Statements worth interpreting for topics and corrections. Only the user's words can correct or
 * retract a decision, so assistant answers and tool output stay evidence and candidates, not jobs.
 */
const interpretedKinds = HashSet.fromIterable<NodeKind>(["user"]);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const resultPages = yield* createResultPageReader;
  const supersedeEarlierReads = yield* createSupersededReads;
  const one = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: NodeRow,
    execute: (id) => sql`SELECT * FROM nodes WHERE id = ${id}`,
  });
  const latestOf = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, kind: NodeKind }),
    Result: NodeRow,
    execute: ({ sessionId, kind }) => sql`SELECT * FROM nodes
      WHERE session_id = ${sessionId} AND kind = ${kind} ORDER BY seq DESC LIMIT 1`,
  });
  const recentOf = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, kind: NodeKind, limit: Schema.Finite }),
    Result: NodeRow,
    execute: ({ sessionId, kind, limit }) => sql`SELECT * FROM nodes
      WHERE session_id = ${sessionId} AND kind = ${kind} ORDER BY seq DESC LIMIT ${limit}`,
  });
  const toolNodeOf = SqlSchema.findOneOption({
    Request: Schema.Struct({
      sessionId: Schema.String,
      kind: Schema.Literals(["tool_call", "tool_result"]),
      toolCallId: Schema.String,
    }),
    Result: NodeRow,
    execute: ({ sessionId, kind, toolCallId }) => sql`SELECT * FROM nodes
      WHERE session_id = ${sessionId} AND kind = ${kind}
        AND json_extract(detail, '$.toolCallId') = ${toolCallId} ORDER BY seq LIMIT 1`,
  });
  const sessionNodes = SqlSchema.findAll({
    Request: Schema.String,
    Result: NodeRow,
    execute: (sessionId) => sql`SELECT * FROM nodes WHERE session_id = ${sessionId} ORDER BY seq`,
  });
  const edgesOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: EdgeRow,
    execute: (id) => sql`SELECT * FROM edges WHERE from_id = ${id} OR to_id = ${id}
      ORDER BY created_at, kind`,
  });
  const IdRow = Schema.Struct({ id: Schema.String });
  const lastInSession = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IdRow,
    execute: (sessionId) =>
      sql`SELECT id FROM nodes WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1`,
  });
  const latestWithRef = SqlSchema.findOneOption({
    Request: Schema.Struct({ ref: Schema.String, projectId: Schema.String }),
    Result: IdRow,
    execute: ({ ref, projectId }) => sql`
      SELECT r.node_id AS id FROM node_refs r JOIN nodes n ON n.id = r.node_id
      WHERE r.ref = ${ref} AND n.project_id = ${projectId} ORDER BY n.seq DESC LIMIT 1`,
  });
  const toolResultIdOf = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, toolCallId: Schema.String }),
    Result: IdRow,
    execute: ({ sessionId, toolCallId }) => sql`SELECT id FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'tool_result'
        AND json_extract(detail, '$.toolCallId') = ${toolCallId}
      ORDER BY seq LIMIT 1`,
  });
  const encodeDetail = Schema.encodeEffect(Schema.fromJsonString(NodeDetail));
  const firstResults = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, toolCallIds: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ tool_call_id: Schema.String, id: Schema.String }),
    execute: ({ sessionId, toolCallIds }) => sql`
      SELECT json_extract(detail, '$.toolCallId') AS tool_call_id, id FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'tool_result'
        AND json_extract(detail, '$.toolCallId') IN ${sql.in(toolCallIds)}
      ORDER BY seq DESC`,
  });
  const textsOf = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: Schema.Struct({ id: Schema.String, text: Schema.String }),
    execute: (ids) => sql`SELECT id, text FROM nodes WHERE id IN ${sql.in(ids)}`,
  });
  const idOf = Option.map((row: typeof IdRow.Type) => row.id);
  /** Rows keyed by `key`; a later row replaces an earlier one with the same key. */
  const keyed = <A>(rows: readonly A[], key: (row: A) => string, value: (row: A) => string) =>
    new Map(rows.map((row) => [key(row), value(row)]));

  const link = (fromId: string, toId: string, kind: EdgeKind, createdAt: string) =>
    sql`INSERT INTO edges VALUES (${fromId}, ${toId}, ${kind}, 'structure', ${edgeWeights[kind]},
      ${createdAt}) ON CONFLICT DO NOTHING`;

  const append = (input: NewNode) =>
    stored(
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const previous = isTruthy(input.sessionId)
          ? idOf(yield* lastInSession(input.sessionId))
          : Option.none();
        const [inserted] = yield* sql`INSERT INTO nodes ${sql.insert({
          id: yield* crypto.randomUUIDv4(),
          project_id: input.projectId,
          session_id: input.sessionId,
          run_id: input.runId ?? null,
          kind: input.kind,
          text: input.text,
          detail: yield* encodeDetail(input.detail ?? {}),
          created_at: createdAt,
        })} RETURNING *`;
        const node = nodeOfRow(yield* Schema.decodeUnknownEffect(NodeRow)(inserted));
        if (node.kind === "tool_result") yield* resultPages.remember(node.id, node.text);
        // Only the first accepted, redacted user message names a local conversation.
        if (
          input.kind === "user" &&
          isTruthy(input.sessionId) &&
          !isTruthy(input.detail?.importedFrom)
        ) {
          const label = firstMessageTitle(input.text) || "이미지 대화";
          yield* sql`
            UPDATE sessions SET title = ${label}
            WHERE id = ${input.sessionId} AND title IS NULL AND imported_from IS NULL
              AND NOT EXISTS (SELECT 1 FROM nodes
                WHERE session_id = ${input.sessionId} AND kind = 'user' AND seq < ${node.seq})`;
        }

        yield* Effect.transposeOption(
          Option.map(previous, (id) => link(id, node.id, "next", createdAt)),
        );
        yield* Effect.forEach(
          input.links ?? [],
          (declared) =>
            declared.kind === "reply"
              ? link(node.id, declared.nodeId, "reply", createdAt)
              : link(declared.nodeId, node.id, declared.kind, createdAt),
          { discard: true },
        );
        yield* Effect.forEach(
          EffectArray.dedupe(input.refs ?? []),
          Effect.fnUntraced(function* (ref) {
            const earlier = idOf(yield* latestWithRef({ ref, projectId: input.projectId }));
            yield* sql`INSERT INTO node_refs VALUES (${node.id}, ${ref}) ON CONFLICT DO NOTHING`;
            yield* Effect.transposeOption(
              Option.map(earlier, (id) => link(node.id, id, "touches", createdAt)),
            );
          }),
          { discard: true },
        );
        yield* Effect.when(
          supersedeEarlierReads(node.id),
          Effect.succeed(node.kind === "tool_result"),
        );
        if (HashSet.has(interpretedKinds, node.kind) && hasStatementText(node.text))
          yield* sql`INSERT INTO interpret_jobs (node_id, status, updated_at)
            VALUES (${node.id}, 'pending', ${createdAt})`;
        return node;
      }).pipe(sql.withTransaction),
    );

  const page = (node: Node, offset = 0): Effect.Effect<EvidencePage> =>
    Effect.as(
      Effect.when(
        resultPages.remember(node.id, node.text),
        Effect.succeed(node.kind === "tool_result"),
      ),
      { id: node.id, kind: node.kind, ...textWindow(node.text, offset, evidencePageLength) },
    );
  const found = Effect.map(Option.match({ onNone: () => null, onSome: nodeOfRow }));

  return {
    append,
    readToolResultPage: resultPages.read,
    invalidateResultPages: resultPages.invalidate,

    get: (id: string) => one(id).pipe(found, stored),

    /** The most recent node of a kind in a session, e.g. the user turn a continued run answers. */
    latestOfKind: (sessionId: string, kind: NodeKind) =>
      latestOf({ sessionId, kind }).pipe(found, stored),

    /** The latest `limit` nodes of a kind in a session, oldest first. */
    recentOfKind: (sessionId: string, kind: NodeKind, limit: number) =>
      stored(
        recentOf({ sessionId, kind, limit }).pipe(
          Effect.map((rows) => rows.map(nodeOfRow).reverse()),
        ),
      ),

    /**
     * The tool_call or tool_result node for a tool call id in a session. A run resumed after an
     * approval sees the same call again, and must attach to the node recorded the first time.
     */
    toolNode: (sessionId: string, kind: "tool_call" | "tool_result", toolCallId: string) =>
      toolNodeOf({ sessionId, kind, toolCallId }).pipe(found, stored),

    /** The first recorded result for this call, without loading every result in the session. */
    toolResultId: (sessionId: string, toolCallId: string) =>
      stored(
        toolResultIdOf({ sessionId, toolCallId }).pipe(
          Effect.map((row) => Option.getOrNull(idOf(row))),
        ),
      ),

    /** {@link toolResultId} for several calls at once; calls without a result are absent. */
    toolResultIds: (sessionId: string, toolCallIds: readonly string[]) =>
      toolCallIds.length === 0
        ? Effect.succeed(new Map<string, string>())
        : stored(
            // Newest first, so the first recorded result is the one each key keeps.
            firstResults({ sessionId, toolCallIds }).pipe(
              Effect.map((rows) =>
                keyed(
                  rows,
                  (row) => row.tool_call_id,
                  (row) => row.id,
                ),
              ),
            ),
          ),

    /** The text of each of these nodes that exists. */
    texts: (ids: readonly string[]) =>
      ids.length === 0
        ? Effect.succeed(new Map<string, string>())
        : stored(
            textsOf(ids).pipe(
              Effect.map((rows) =>
                keyed(
                  rows,
                  (row) => row.id,
                  (row) => row.text,
                ),
              ),
            ),
          ),

    session: (sessionId: string) =>
      stored(sessionNodes(sessionId).pipe(Effect.map((rows) => rows.map(nodeOfRow)))),

    edgesOf: (id: string) => stored(edgesOf(id).pipe(Effect.map((rows) => rows.map(edgeOfRow)))),

    /** Reads original text in pages without splitting a surrogate pair. */
    read: (id: string, offset = 0) =>
      stored(
        one(id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (row) => page(nodeOfRow(row), offset),
            }),
          ),
        ),
      ),

    /** The same page for a node the caller already loaded, without reading its row again. */
    page,
  };
});

/** Append-only store of every message, with the structural edges derived at write time. */
export class Nodes extends Context.Service<Nodes, Effect.Success<typeof make>>()(
  "memory-agent/memory/nodes",
) {
  static readonly layer = Layer.effect(Nodes, make).pipe(Layer.provide(NodeCrypto.layer));
}
