import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeCrypto } from "@effect/platform-node";
import type { SQLOutputValue } from "node:sqlite";
import {
  DateTime,
  Clock,
  Crypto,
  Context,
  Effect,
  Layer,
  Schema,
  HashSet,
  Array as EffectArray,
} from "effect";
import { createResultPageReader } from "./result-pages.ts";
import { hasStatementText } from "./quality.ts";
import { createSupersededReads } from "./superseded-reads.ts";
import { firstMessageTitle } from "../sessions/title.ts";
import { Database } from "../db/database.ts";
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

const NodeRow = Schema.Struct({
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
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeNodeRow = EffectFunction.flow(Schema.decodeUnknownResult(NodeRow), Result.getOrThrow);

export function toNode(row: Record<string, SQLOutputValue>): Node {
  const decoded = decodeNodeRow(row);
  return {
    seq: decoded.seq,
    id: decoded.id,
    projectId: decoded.project_id,
    sessionId: decoded.session_id,
    runId: decoded.run_id,
    kind: decoded.kind,
    text: decoded.text,
    detail: decoded.detail,
    createdAt: decoded.created_at,
  };
}

const EdgeRow = Schema.Struct({
  from_id: Schema.String,
  to_id: Schema.String,
  kind: EdgeKind,
  origin: EdgeOrigin,
  weight: Schema.Finite,
  created_at: Schema.String,
});
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeEdgeRow = EffectFunction.flow(Schema.decodeUnknownResult(EdgeRow), Result.getOrThrow);

export function toEdge(row: Record<string, SQLOutputValue>): Edge {
  const decoded = decodeEdgeRow(row);
  return {
    fromId: decoded.from_id,
    toId: decoded.to_id,
    kind: decoded.kind,
    origin: decoded.origin,
    weight: decoded.weight,
    createdAt: decoded.created_at,
  };
}

/** Characters of original text returned per read_evidence page. */
export const evidencePageLength = 4000;

/**
 * Statements worth interpreting for topics and corrections. Only the user's words can correct or
 * retract a decision, so assistant answers and tool output stay evidence and candidates, not jobs.
 */
const interpretedKinds = HashSet.fromIterable<NodeKind>(["user"]);

const make = Effect.gen(function* () {
  const effectClock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());

  const { sqlite, atomic } = yield* Database;
  const resultPages = createResultPageReader(sqlite);
  const supersedeEarlierReads = createSupersededReads(sqlite);
  const insertNode = sqlite.prepare(
    "INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
  );
  const insertEdge = sqlite.prepare(
    "INSERT INTO edges VALUES (?, ?, ?, 'structure', ?, ?) ON CONFLICT DO NOTHING",
  );
  const lastInSession = sqlite.prepare(
    "SELECT id FROM nodes WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
  );
  const insertRef = sqlite.prepare("INSERT INTO node_refs VALUES (?, ?) ON CONFLICT DO NOTHING");
  const latestWithRef = sqlite.prepare(`
    SELECT r.node_id AS id FROM node_refs r JOIN nodes n ON n.id = r.node_id
    WHERE r.ref = ? AND n.project_id = ? ORDER BY n.seq DESC LIMIT 1`);
  const insertJob = sqlite.prepare(
    "INSERT INTO interpret_jobs (node_id, status, updated_at) VALUES (?, 'pending', ?)",
  );
  const selectNode = sqlite.prepare("SELECT * FROM nodes WHERE id = ?");
  const selectToolResultId = sqlite.prepare(
    `SELECT id FROM nodes
     WHERE session_id = ? AND kind = 'tool_result'
       AND json_extract(detail, '$.toolCallId') = ?
     ORDER BY seq LIMIT 1`,
  );

  const idOf = (row: Record<string, SQLOutputValue> | undefined) =>
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    isTruthy(row)
      ? EffectFunction.flow(
          Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String })),
          Result.getOrThrow,
        )(row).id
      : null;

  function link(fromId: string, toId: string, kind: EdgeKind, createdAt: string) {
    insertEdge.run(fromId, toId, kind, edgeWeights[kind], createdAt);
  }

  function append(input: NewNode): Node {
    return atomic(() => {
      const createdAt = DateTime.formatIso(
        DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
      );
      const previous = isTruthy(input.sessionId) ? idOf(lastInSession.get(input.sessionId)) : null;
      const row = insertNode.get(
        runSync(crypto.randomUUIDv4()),
        input.projectId,
        input.sessionId,
        input.runId ?? null,
        input.kind,
        input.text,
        JSON.stringify(input.detail ?? {}),
        createdAt,
      );
      if (!isTruthy(row)) throw new Error("Node insert returned no row");
      const node = toNode(row);
      if (node.kind === "tool_result") resultPages.remember(node.id, node.text);
      // Only the first accepted, redacted user message names a local conversation.
      if (
        input.kind === "user" &&
        isTruthy(input.sessionId) &&
        !isTruthy(input.detail?.importedFrom)
      ) {
        const label = firstMessageTitle(input.text);
        sqlite
          .prepare(`
          UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL AND imported_from IS NULL
          AND NOT EXISTS (SELECT 1 FROM nodes WHERE session_id = ? AND kind = 'user' AND seq < ?)
        `)
          .run(label || "이미지 대화", input.sessionId, input.sessionId, node.seq);
      }

      if (isTruthy(previous)) link(previous, node.id, "next", createdAt);
      for (const declared of input.links ?? []) {
        if (declared.kind === "reply") link(node.id, declared.nodeId, "reply", createdAt);
        else link(declared.nodeId, node.id, declared.kind, createdAt);
      }
      for (const ref of EffectArray.dedupe(input.refs ?? [])) {
        const earlier = idOf(latestWithRef.get(ref, input.projectId));
        insertRef.run(node.id, ref);
        if (isTruthy(earlier)) link(node.id, earlier, "touches", createdAt);
      }
      if (node.kind === "tool_result") supersedeEarlierReads(node.id);
      if (HashSet.has(interpretedKinds, node.kind) && hasStatementText(node.text))
        insertJob.run(node.id, createdAt);
      return node;
    });
  }

  function page(node: Node, offset = 0): EvidencePage {
    if (node.kind === "tool_result") resultPages.remember(node.id, node.text);
    return { id: node.id, kind: node.kind, ...textWindow(node.text, offset, evidencePageLength) };
  }

  return {
    append,
    readToolResultPage: resultPages.read,
    invalidateResultPages: resultPages.invalidate,

    get: (id: string): Node | null => {
      const row = selectNode.get(id);
      return isTruthy(row) ? toNode(row) : null;
    },

    /** The most recent node of a kind in a session, e.g. the user turn a continued run answers. */
    latestOfKind: (sessionId: string, kind: NodeKind): Node | null => {
      const row = sqlite
        .prepare("SELECT * FROM nodes WHERE session_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
        .get(sessionId, kind);
      return isTruthy(row) ? toNode(row) : null;
    },

    /** The latest `limit` nodes of a kind in a session, oldest first. */
    recentOfKind: (sessionId: string, kind: NodeKind, limit: number): Node[] =>
      sqlite
        .prepare("SELECT * FROM nodes WHERE session_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?")
        .all(sessionId, kind, limit)
        .map(toNode)
        .reverse(),

    /**
     * The tool_call or tool_result node for a tool call id in a session. A run resumed after an
     * approval sees the same call again, and must attach to the node recorded the first time.
     */
    toolNode: (sessionId: string, kind: "tool_call" | "tool_result", toolCallId: string) => {
      const row = sqlite
        .prepare(
          "SELECT * FROM nodes WHERE session_id = ? AND kind = ? AND json_extract(detail, '$.toolCallId') = ? ORDER BY seq LIMIT 1",
        )
        .get(sessionId, kind, toolCallId);
      return isTruthy(row) ? toNode(row) : null;
    },

    /** The first recorded result for this call, without loading every result in the session. */
    toolResultId: (sessionId: string, toolCallId: string): string | null =>
      idOf(selectToolResultId.get(sessionId, toolCallId)),

    session: (sessionId: string): Node[] =>
      sqlite
        .prepare("SELECT * FROM nodes WHERE session_id = ? ORDER BY seq")
        .all(sessionId)
        .map(toNode),

    edgesOf: (id: string): Edge[] =>
      sqlite
        .prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY created_at, kind")
        .all(id, id)
        .map(toEdge),

    /** Reads original text in pages without splitting a surrogate pair. */
    read: (id: string, offset = 0): EvidencePage | null => {
      const row = selectNode.get(id);
      return isTruthy(row) ? page(toNode(row), offset) : null;
    },

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
