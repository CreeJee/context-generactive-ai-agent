import { Array as EffectArray, Option, Predicate } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeCrypto } from "@effect/platform-node";
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Nodes } from "./nodes.ts";

import type { MemoryCandidateView, MemoryDisposition, MemoryUsageView } from "./contracts.ts";

export type { MemoryCandidateView, MemoryDisposition, MemoryUsageView } from "./contracts.ts";

export interface PromoteMemoryInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly authorizedByUserNodeId: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly proposedText: string;
  readonly resolvedText: string;
  readonly disposition: "save" | "conversation_only" | "reject";
}

const ClaimSourceRow = Schema.Struct({
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
});
const ExistingRow = Schema.Struct({ id: Schema.String });
const CandidateRow = Schema.Struct({
  id: Schema.String,
  decision_id: Schema.String,
  project_id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
  claim_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  authorized_by_user_node_id: Schema.String,
  proposed_text: Schema.String,
  resolved_text: Schema.String,
  disposition: Schema.Literals(["saved", "edited_saved", "conversation_only", "rejected"]),
  memory_node_id: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
});
const CandidateEvidenceRow = Schema.Struct({
  evidence_ref_id_snapshot: Schema.String,
  source_deleted_at: Schema.NullOr(Schema.Finite),
});
const CandidateIdentityRow = Schema.Struct({ id: Schema.String, memory_node_id: Schema.String });
const UsageRow = Schema.Struct({
  id: Schema.String,
  candidate_id: Schema.String,
  memory_node_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  parent_message_id: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["retrieved", "used"]),
  created_at: Schema.Finite,
});
const MemoryPromotionReason = Schema.Literals([
  "empty_proposed_text",
  "empty_resolved_text",
  "missing_user_authorization",
  "claim_not_adopted",
]);
type MemoryPromotionReason = typeof MemoryPromotionReason.Type;

/** The model reads `message`; it is fixed per reason and never carries the request's text. */
const promotionMessages: Readonly<Record<MemoryPromotionReason, string>> = {
  empty_proposed_text: "proposedText must not be empty",
  empty_resolved_text: "resolvedText must not be empty",
  missing_user_authorization: "Memory promotion requires the current user turn as authorization",
  claim_not_adopted: "Memory promotion source is not an adopted final-answer claim",
};

export class MemoryPromotionRejected extends Schema.TaggedError<
  MemoryPromotionRejected,
  { readonly brand: unique symbol }
>()("MemoryPromotionRejected", { reason: MemoryPromotionReason, message: Schema.String }) {}

const promotionRejected = (reason: MemoryPromotionReason) =>
  MemoryPromotionRejected.make({ reason, message: promotionMessages[reason] });

/** A knowledge store read or write failed; the cause stays for diagnosis. */
export class KnowledgeStoreFailed extends Schema.TaggedError<
  KnowledgeStoreFailed,
  { readonly brand: unique symbol }
>()("KnowledgeStoreFailed", { cause: Schema.Defect() }) {}

/** Storage and codec failures keep their cause; promotion refusals pass through. */
const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error: E): error is Exclude<E, MemoryPromotionRejected> =>
      !Predicate.isTagged(error, "MemoryPromotionRejected"),
    (cause) => Effect.fail(KnowledgeStoreFailed.make({ cause })),
  );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  const nowMillis = Clock.currentTimeMillis;

  const claimSource = SqlSchema.findOneOption({
    Request: Schema.Struct({
      claimId: Schema.String,
      projectId: Schema.String,
      taskId: Schema.String,
      attemptId: Schema.String,
    }),
    Result: ClaimSourceRow,
    execute: ({ claimId, projectId, taskId, attemptId }) => sql`
      SELECT c.project_id, c.origin_session_id FROM final_answer_claims c
      JOIN final_answer_sources s ON s.claim_id = c.id
      WHERE c.id = ${claimId} AND c.project_id = ${projectId} AND s.task_id = ${taskId}
        AND s.attempt_id = ${attemptId} LIMIT 1`,
  });
  const existing = SqlSchema.findOneOption({
    Request: Schema.Struct({
      claimId: Schema.String,
      userNodeId: Schema.String,
      text: Schema.String,
      status: Schema.String,
    }),
    Result: ExistingRow,
    execute: ({ claimId, userNodeId, text, status }) => sql`
      SELECT d.id FROM knowledge_decisions d
      WHERE d.claim_id = ${claimId} AND d.authorized_by_user_node_id = ${userNodeId}
        AND d.text = ${text} AND d.status = ${status}`,
  });
  const evidenceFor = SqlSchema.findAll({
    Request: Schema.String,
    Result: CandidateEvidenceRow,
    execute: (candidateId) => sql`
      SELECT ce.evidence_ref_id_snapshot, ce.source_deleted_at
      FROM memory_candidate_evidence ce
      WHERE ce.candidate_id = ${candidateId} ORDER BY ce.evidence_ref_id_snapshot`,
  });
  const candidateRows = (column: "d.id" | "d.task_id") =>
    SqlSchema.findAll({
      Request: Schema.String,
      Result: CandidateRow,
      execute: (value) => sql`
        SELECT c.id, c.decision_id, c.project_id, d.task_id, d.attempt_id, d.claim_id,
               d.origin_session_id,
               d.authorized_by_user_node_id_snapshot AS authorized_by_user_node_id,
               c.proposed_text, c.resolved_text, c.disposition, c.memory_node_id, c.created_at
        FROM memory_candidates c JOIN knowledge_decisions d ON d.id = c.decision_id
        WHERE ${sql.literal(column)} = ${value} ORDER BY c.created_at, c.id`,
    });
  const candidatesOfDecision = candidateRows("d.id");
  const candidatesOfTask = candidateRows("d.task_id");
  const retrievable = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.String,
      memoryNodeIds: Schema.Array(Schema.String),
    }),
    Result: CandidateIdentityRow,
    execute: ({ projectId, memoryNodeIds }) => sql`
      SELECT id, memory_node_id FROM memory_candidates
      WHERE project_id = ${projectId} AND memory_node_id IN ${sql.in(memoryNodeIds)}`,
  });
  const retrievedInRun = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.String,
      memoryNodeIds: Schema.Array(Schema.String),
      runId: Schema.String,
    }),
    Result: CandidateIdentityRow,
    execute: ({ projectId, memoryNodeIds, runId }) => sql`
      SELECT c.id, c.memory_node_id FROM memory_candidates c
      WHERE c.project_id = ${projectId} AND c.memory_node_id IN ${sql.in(memoryNodeIds)}
        AND EXISTS (SELECT 1 FROM memory_usage_events u
          WHERE u.candidate_id = c.id AND u.parent_run_id = ${runId} AND u.kind = 'retrieved')`,
  });
  const usageRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: UsageRow,
    execute: (taskId) => sql`
      SELECT u.id, u.candidate_id, u.memory_node_id, u.origin_session_id, u.parent_run_id,
             u.parent_message_id, u.kind, u.created_at
      FROM memory_usage_events u JOIN memory_candidates c ON c.id = u.candidate_id
      JOIN knowledge_decisions d ON d.id = c.decision_id WHERE d.task_id = ${taskId}
      ORDER BY u.created_at, CASE u.kind WHEN 'retrieved' THEN 0 ELSE 1 END, u.id`,
  });

  const presence = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      adopted_claims: Schema.Literals([0, 1]),
      promoted: Schema.Literals([0, 1]),
    }),
    execute: (projectId) => sql`SELECT
      EXISTS (SELECT 1 FROM final_answer_claims WHERE project_id = ${projectId}) AS adopted_claims,
      EXISTS (SELECT 1 FROM memory_candidates
        WHERE project_id = ${projectId} AND memory_node_id IS NOT NULL) AS promoted`,
  });

  const toView = (row: typeof CandidateRow.Type) =>
    Effect.map(evidenceFor(row.id), (evidence): MemoryCandidateView => ({
      id: row.id,
      decisionId: row.decision_id,
      projectId: row.project_id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      claimId: row.claim_id,
      originSessionId: row.origin_session_id,
      authorizedByUserNodeId: row.authorized_by_user_node_id,
      proposedText: row.proposed_text,
      resolvedText: row.resolved_text,
      disposition: row.disposition,
      memoryNodeId: row.memory_node_id,
      evidence: evidence.map((source) => ({
        evidenceRefId: source.evidence_ref_id_snapshot,
        sourceDeletedAt: source.source_deleted_at,
      })),
      createdAt: row.created_at,
    }));
  // A decision written in this transaction always has its candidate.
  const candidateByDecision = (decisionId: string) =>
    candidatesOfDecision(decisionId).pipe(
      Effect.map(EffectArray.head),
      Effect.flatMap(Effect.fromOption),
      Effect.flatMap(toView),
    );

  const promote = (input: PromoteMemoryInput) =>
    stored(
      Effect.gen(function* () {
        const proposedText = input.proposedText.trim();
        yield* Effect.when(
          Effect.fail(promotionRejected("empty_proposed_text")),
          Effect.succeed(!isTruthy(proposedText)),
        );
        const resolvedText = input.resolvedText.trim();
        yield* Effect.when(
          Effect.fail(promotionRejected("empty_resolved_text")),
          Effect.succeed(!isTruthy(resolvedText)),
        );
        const userNode = yield* nodes.get(input.authorizedByUserNodeId);
        if (
          !isTruthy(userNode) ||
          userNode.kind !== "user" ||
          userNode.projectId !== input.projectId ||
          userNode.sessionId !== input.sessionId
        )
          return yield* promotionRejected("missing_user_authorization");
        const claim = yield* claimSource(input).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.catchTag("NoSuchElementError", () =>
            Effect.fail(promotionRejected("claim_not_adopted")),
          ),
        );
        const status: MemoryDisposition =
          input.disposition === "reject"
            ? "rejected"
            : input.disposition === "conversation_only"
              ? "conversation_only"
              : proposedText === resolvedText
                ? "saved"
                : "edited_saved";

        return yield* Effect.gen(function* () {
          const found = yield* existing({
            claimId: input.claimId,
            userNodeId: input.authorizedByUserNodeId,
            text: resolvedText,
            status,
          });
          if (Option.isSome(found)) return yield* candidateByDecision(found.value.id);
          const decisionId = yield* crypto.randomUUIDv4();
          const candidateId = yield* crypto.randomUUIDv4();
          const createdAt = yield* nowMillis;
          const memoryNode =
            status === "saved" || status === "edited_saved"
              ? yield* nodes.append({
                  projectId: input.projectId,
                  sessionId: null,
                  kind: "topic",
                  text: resolvedText,
                  detail: { memoryCandidateId: candidateId, authorizedByUserNodeId: userNode.id },
                })
              : null;
          yield* sql`INSERT INTO knowledge_decisions ${sql.insert({
            id: decisionId,
            project_id: input.projectId,
            task_id: input.taskId,
            attempt_id: input.attemptId,
            claim_id: input.claimId,
            origin_session_id: claim.origin_session_id,
            authorized_by_user_node_id: userNode.id,
            authorized_by_user_node_id_snapshot: userNode.id,
            text: resolvedText,
            status,
            created_at: createdAt,
          })}`;
          yield* sql`INSERT INTO memory_candidates ${sql.insert({
            id: candidateId,
            decision_id: decisionId,
            project_id: input.projectId,
            proposed_text: proposedText,
            resolved_text: resolvedText,
            disposition: status,
            memory_node_id: memoryNode?.id ?? null,
            created_at: createdAt,
          })}`;
          return yield* candidateByDecision(decisionId);
        }).pipe(sql.withTransaction);
      }),
    );

  const recordUsage = (
    candidates: readonly (typeof CandidateIdentityRow.Type)[],
    input: { readonly projectId: string; readonly sessionId: string; readonly runId: string },
    parentMessageId: string | null,
    kind: "retrieved" | "used",
  ) =>
    Effect.forEach(
      candidates,
      Effect.fnUntraced(function* (candidate) {
        yield* sql`INSERT OR IGNORE INTO memory_usage_events ${sql.insert({
          id: yield* crypto.randomUUIDv4(),
          project_id: input.projectId,
          candidate_id: candidate.id,
          memory_node_id: candidate.memory_node_id,
          origin_session_id: input.sessionId,
          parent_run_id: input.runId,
          parent_message_id: parentMessageId,
          kind,
          created_at: yield* nowMillis,
        })}`;
      }),
      { discard: true },
    );

  const recordRetrieval = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly memoryNodeIds: readonly string[];
  }) =>
    input.memoryNodeIds.length === 0
      ? Effect.succeed([])
      : stored(
          Effect.gen(function* () {
            const candidates = yield* retrievable(input);
            yield* recordUsage(candidates, input, null, "retrieved");
            return candidates.map((candidate) => candidate.memory_node_id);
          }).pipe(sql.withTransaction),
        );

  const recordUsed = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly parentMessageId: string;
    readonly memoryNodeIds: readonly string[];
  }) =>
    input.memoryNodeIds.length === 0
      ? Effect.void
      : stored(
          retrievedInRun(input).pipe(
            Effect.flatMap((candidates) =>
              recordUsage(candidates, input, input.parentMessageId, "used"),
            ),
            sql.withTransaction,
          ),
        );

  const candidatesForTask = (taskId: string) =>
    stored(candidatesOfTask(taskId).pipe(Effect.flatMap((rows) => Effect.forEach(rows, toView))));
  const usageForTask = (taskId: string) =>
    stored(
      usageRows(taskId).pipe(
        Effect.map((rows) =>
          rows.map((row): MemoryUsageView => ({
            id: row.id,
            candidateId: row.candidate_id,
            memoryNodeId: row.memory_node_id,
            originSessionId: row.origin_session_id,
            parentRunId: row.parent_run_id,
            parentMessageId: row.parent_message_id,
            kind: row.kind,
            createdAt: row.created_at,
          })),
        ),
      ),
    );

  /**
   * Whether the project has anything the promotion tools act on: an adopted final-answer claim to
   * promote, or saved project memory whose use is declared.
   */
  const promotionState = (projectId: string) =>
    stored(
      Effect.map(presence(projectId), (row) => ({
        adoptedClaims: row.adopted_claims === 1,
        promotedMemory: row.promoted === 1,
      })),
    );

  return {
    promote,
    recordRetrieval,
    recordUsed,
    candidatesForTask,
    usageForTask,
    promotionState,
  };
});

/** User-governed bridge from adopted final-answer claims into durable project memory. */
export class KnowledgePromotions extends Context.Service<
  KnowledgePromotions,
  Effect.Success<typeof make>
>()("memory-agent/memory/knowledge/KnowledgePromotions") {
  static readonly layer = Layer.effect(KnowledgePromotions, make).pipe(
    Layer.provide(NodeCrypto.layer),
  );
}
