import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Nodes, NodeRow, nodeOfRow } from "../memory/nodes.ts";
import type { NodeLink } from "../memory/edges.ts";
import { optionalProperty } from "../optional-property.ts";
import { BoardAuthor } from "./card.ts";

/** The Plan version's memory node could not be read or written; the cause stays with the error. */
export class PlanNodeFailed extends Schema.TaggedError<
  PlanNodeFailed,
  { readonly brand: unique symbol }
>()("PlanNodeFailed", {
  cause: Schema.Defect(),
}) {}

const decodeAuthor = Schema.decodeUnknownOption(Schema.fromJsonString(BoardAuthor));

const RevisionRow = Schema.Struct({
  id: Schema.Int,
  project_id: Schema.String,
  plan_json: Schema.String,
  author_json: Schema.NullOr(Schema.String),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  // Two cards of one version may start together; only one of them writes its node.
  const oneAtATime = yield* Semaphore.make(1);

  /**
   * The revision that first saved `version` of the session's current Goal's Plan. Later revisions
   * of the same version only move cards along; the first one is what its author wrote.
   */
  const firstRevision = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, version: Schema.Int }),
    Result: RevisionRow,
    execute: ({ sessionId, version }) => sql`
      SELECT r.id, s.project_id, r.plan_json, r.author_json
      FROM workflow_state_revisions r JOIN sessions s ON s.id = r.session_id
      WHERE r.session_id = ${sessionId} AND r.plan_version = ${version} AND r.plan_json IS NOT NULL
        AND r.goal_instance_id IS (SELECT goal_instance_id FROM workflow_goal_identities
          WHERE session_id = ${sessionId})
      ORDER BY r.id LIMIT 1`,
  });
  const recorded = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, revisionId: Schema.Int }),
    Result: NodeRow,
    execute: ({ sessionId, revisionId }) => sql`SELECT * FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'plan'
        AND json_extract(detail, '$.planRevisionId') = ${revisionId}
      ORDER BY seq LIMIT 1`,
  });

  /** The node of the call that saved the revision, when a run's workflow tool did. */
  const authoringCall = (
    sessionId: string,
    run: Option.Option<typeof BoardAuthor.cases.Orchestrator.Type>,
  ) =>
    Option.match(
      Option.flatMap(run, (orchestrator) => Option.fromUndefinedOr(orchestrator.toolCallId)),
      {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (toolCallId) =>
          Effect.map(nodes.toolNode(sessionId, "tool_call", toolCallId), (node) =>
            Option.map(Option.fromNullOr(node), (call) => call.id),
          ),
      },
    );

  const record = Effect.fnUntraced(function* (
    sessionId: string,
    version: number,
    revision: typeof RevisionRow.Type,
  ) {
    // The run that saved the revision; none when the user did, from the board.
    const run = Option.filter(decodeAuthor(revision.author_json), BoardAuthor.guards.Orchestrator);
    const call = yield* authoringCall(sessionId, run);
    return yield* nodes.append({
      projectId: revision.project_id,
      sessionId,
      ...optionalProperty("runId", Option.getOrUndefined(Option.map(run, (by) => by.runId))),
      kind: "plan",
      text: revision.plan_json,
      detail: { planVersion: version, planRevisionId: revision.id },
      links: Option.toArray(Option.map(call, (nodeId): NodeLink => ({ kind: "cites", nodeId }))),
      inFlow: false,
    });
  });

  return {
    /**
     * The memory node of `version` of the session's current Plan, written the first time it is
     * asked for: the Plan as its author saved it, citing the call that saved it when a run did.
     * None when no revision holds that version.
     */
    forVersion: (sessionId: string, version: number) =>
      Effect.gen(function* () {
        const revision = yield* firstRevision({ sessionId, version });
        if (Option.isNone(revision)) return Option.none();
        const existing = yield* recorded({ sessionId, revisionId: revision.value.id });
        if (Option.isSome(existing)) return Option.some(nodeOfRow(existing.value));
        return Option.some(yield* record(sessionId, version, revision.value));
      }).pipe(
        Effect.mapError((cause) => PlanNodeFailed.make({ cause })),
        oneAtATime.withPermits(1),
      ),
  };
});

/** The memory node of each Plan version, where a card session's instructions come from. */
export class PlanNodes extends Context.Service<PlanNodes, Effect.Success<typeof make>>()(
  "memory-agent/workflow/plan-nodes/PlanNodes",
) {
  static readonly layer = Layer.effect(PlanNodes, make);
}
