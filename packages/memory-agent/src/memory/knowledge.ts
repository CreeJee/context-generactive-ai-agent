import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { Nodes } from "./nodes.ts";

export type MemoryDisposition = "saved" | "edited_saved" | "conversation_only" | "rejected";

export interface PromoteMemoryInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly authorizedByUserNodeId: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly evidenceRefIds: readonly string[];
  readonly proposedText: string;
  readonly resolvedText: string;
  readonly disposition: "save" | "conversation_only" | "reject";
}

export interface MemoryCandidateView {
  readonly id: string;
  readonly decisionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly claimId: string;
  readonly originSessionId: string | null;
  readonly authorizedByUserNodeId: string;
  readonly proposedText: string;
  readonly resolvedText: string;
  readonly disposition: MemoryDisposition;
  readonly memoryNodeId: string | null;
  readonly evidence: readonly {
    readonly evidenceRefId: string;
    readonly sourceDeletedAt: number | null;
  }[];
  readonly createdAt: number;
}

export interface MemoryUsageView {
  readonly id: string;
  readonly candidateId: string;
  readonly memoryNodeId: string;
  readonly originSessionId: string | null;
  readonly parentRunId: string;
  readonly parentMessageId: string | null;
  readonly kind: "retrieved" | "used";
  readonly createdAt: number;
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
  disposition: Schema.Literal("saved", "edited_saved", "conversation_only", "rejected"),
  memory_node_id: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
});
const CandidateEvidenceRow = Schema.Struct({
  evidence_ref_id_snapshot: Schema.String,
  source_deleted_at: Schema.NullOr(Schema.Number),
});
const CandidateIdentityRow = Schema.Struct({ id: Schema.String, memory_node_id: Schema.String });
const UsageRow = Schema.Struct({
  id: Schema.String,
  candidate_id: Schema.String,
  memory_node_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  parent_message_id: Schema.NullOr(Schema.String),
  kind: Schema.Literal("retrieved", "used"),
  created_at: Schema.Number,
});
const decodeClaimSource = Schema.decodeUnknownSync(ClaimSourceRow);
const decodeExisting = Schema.decodeUnknownSync(ExistingRow);
const decodeCandidates = Schema.decodeUnknownSync(Schema.Array(CandidateRow));
const decodeCandidateEvidence = Schema.decodeUnknownSync(Schema.Array(CandidateEvidenceRow));
const decodeCandidateIdentities = Schema.decodeUnknownSync(Schema.Array(CandidateIdentityRow));
const decodeUsage = Schema.decodeUnknownSync(Schema.Array(UsageRow));

const cleanText = (text: string, field: string) => {
  const value = text.trim();
  if (!value) throw new Error(`${field} must not be empty`);
  return value;
};

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const nodes = yield* Nodes;
  const claimSource = sqlite.prepare(`
    SELECT c.project_id, c.origin_session_id FROM final_answer_claims c
    JOIN final_answer_sources s ON s.claim_id = c.id
    WHERE c.id = ? AND c.project_id = ? AND s.task_id = ? AND s.attempt_id = ? LIMIT 1`);
  const evidenceSource = sqlite.prepare(`
    SELECT e.id FROM final_answer_sources s JOIN evidence_refs e ON e.id = s.evidence_ref_id
    WHERE s.claim_id = ? AND s.task_id = ? AND s.attempt_id = ?
      AND s.evidence_ref_id = ? AND e.verification = 'verified'`);
  const existing = sqlite.prepare(`
    SELECT d.id FROM knowledge_decisions d
    WHERE d.claim_id = ? AND d.authorized_by_user_node_id = ? AND d.text = ? AND d.status = ?`);
  const evidenceFor = sqlite.prepare(`
    SELECT ce.evidence_ref_id_snapshot, coalesce(ce.source_deleted_at, e.source_deleted_at) AS source_deleted_at
    FROM memory_candidate_evidence ce LEFT JOIN evidence_refs e ON e.id = ce.evidence_ref_id
    WHERE ce.candidate_id = ? ORDER BY ce.evidence_ref_id_snapshot`);

  const candidateRows = (where: string, value: string) =>
    decodeCandidates(
      sqlite
        .prepare(`
    SELECT c.id, c.decision_id, c.project_id, d.task_id, d.attempt_id, d.claim_id,
           d.origin_session_id,
           d.authorized_by_user_node_id_snapshot AS authorized_by_user_node_id, c.proposed_text,
           c.resolved_text, c.disposition, c.memory_node_id, c.created_at
    FROM memory_candidates c JOIN knowledge_decisions d ON d.id = c.decision_id
    WHERE ${where} = ? ORDER BY c.created_at, c.id`)
        .all(value),
    );
  const toView = (row: typeof CandidateRow.Type): MemoryCandidateView => ({
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
    evidence: decodeCandidateEvidence(evidenceFor.all(row.id)).map((source) => ({
      evidenceRefId: source.evidence_ref_id_snapshot,
      sourceDeletedAt: source.source_deleted_at,
    })),
    createdAt: row.created_at,
  });
  const candidateByDecision = (decisionId: string): MemoryCandidateView => {
    const row = candidateRows("d.id", decisionId)[0];
    if (!row) throw new Error("Memory candidate was not persisted");
    return toView(row);
  };

  function promote(input: PromoteMemoryInput): MemoryCandidateView {
    const proposedText = cleanText(input.proposedText, "proposedText");
    const resolvedText = cleanText(input.resolvedText, "resolvedText");
    const userNode = nodes.get(input.authorizedByUserNodeId);
    if (
      !userNode ||
      userNode.kind !== "user" ||
      userNode.projectId !== input.projectId ||
      userNode.sessionId !== input.sessionId
    )
      throw new Error("Memory promotion requires the current user turn as authorization");
    const claimRow = claimSource.get(input.claimId, input.projectId, input.taskId, input.attemptId);
    if (!claimRow) throw new Error("Memory promotion source is not an adopted final-answer claim");
    const claim = decodeClaimSource(claimRow);
    for (const evidenceRefId of new Set(input.evidenceRefIds))
      if (!evidenceSource.get(input.claimId, input.taskId, input.attemptId, evidenceRefId))
        throw new Error("Memory promotion evidence must be verified and adopted by the claim");
    const status: MemoryDisposition =
      input.disposition === "reject"
        ? "rejected"
        : input.disposition === "conversation_only"
          ? "conversation_only"
          : proposedText === resolvedText
            ? "saved"
            : "edited_saved";

    return atomic(() => {
      const found = existing.get(input.claimId, input.authorizedByUserNodeId, resolvedText, status);
      if (found) return candidateByDecision(decodeExisting(found).id);
      const decisionId = randomUUID();
      const candidateId = randomUUID();
      const createdAt = Date.now();
      const memoryNode =
        status === "saved" || status === "edited_saved"
          ? nodes.append({
              projectId: input.projectId,
              sessionId: null,
              kind: "topic",
              text: resolvedText,
              detail: { memoryCandidateId: candidateId, authorizedByUserNodeId: userNode.id },
            })
          : null;
      sqlite
        .prepare(`INSERT INTO knowledge_decisions
        (id, project_id, task_id, attempt_id, claim_id, origin_session_id,
         authorized_by_user_node_id, authorized_by_user_node_id_snapshot, text, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          decisionId,
          input.projectId,
          input.taskId,
          input.attemptId,
          input.claimId,
          claim.origin_session_id,
          userNode.id,
          userNode.id,
          resolvedText,
          status,
          createdAt,
        );
      sqlite
        .prepare(`INSERT INTO memory_candidates
        (id, decision_id, project_id, proposed_text, resolved_text, disposition, memory_node_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          candidateId,
          decisionId,
          input.projectId,
          proposedText,
          resolvedText,
          status,
          memoryNode?.id ?? null,
          createdAt,
        );
      const addEvidence = sqlite.prepare(`INSERT INTO memory_candidate_evidence
        (candidate_id, evidence_ref_id, evidence_ref_id_snapshot, source_deleted_at)
        VALUES (?, ?, ?, NULL)`);
      for (const evidenceRefId of new Set(input.evidenceRefIds))
        addEvidence.run(candidateId, evidenceRefId, evidenceRefId);
      return candidateByDecision(decisionId);
    });
  }

  const recordRetrieval = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly memoryNodeIds: readonly string[];
  }) =>
    atomic(() => {
      const placeholders = input.memoryNodeIds.map(() => "?").join(", ");
      if (!placeholders) return [];
      const candidates = decodeCandidateIdentities(
        sqlite
          .prepare(`SELECT id, memory_node_id FROM memory_candidates
      WHERE project_id = ? AND memory_node_id IN (${placeholders})`)
          .all(input.projectId, ...input.memoryNodeIds),
      );
      const insert = sqlite.prepare(`INSERT OR IGNORE INTO memory_usage_events
      (id, project_id, candidate_id, memory_node_id, origin_session_id, parent_run_id, parent_message_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'retrieved', ?)`);
      for (const candidate of candidates)
        insert.run(
          randomUUID(),
          input.projectId,
          candidate.id,
          candidate.memory_node_id,
          input.sessionId,
          input.runId,
          Date.now(),
        );
      return candidates.map((candidate) => candidate.memory_node_id);
    });

  const recordUsed = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly parentMessageId: string;
    readonly memoryNodeIds: readonly string[];
  }) =>
    atomic(() => {
      const placeholders = input.memoryNodeIds.map(() => "?").join(", ");
      if (!placeholders) return;
      const candidates = decodeCandidateIdentities(
        sqlite
          .prepare(`SELECT c.id, c.memory_node_id FROM memory_candidates c
      WHERE c.project_id = ? AND c.memory_node_id IN (${placeholders})
        AND EXISTS (SELECT 1 FROM memory_usage_events u
          WHERE u.candidate_id = c.id AND u.parent_run_id = ? AND u.kind = 'retrieved')`)
          .all(input.projectId, ...input.memoryNodeIds, input.runId),
      );
      const insert = sqlite.prepare(`INSERT OR IGNORE INTO memory_usage_events
      (id, project_id, candidate_id, memory_node_id, origin_session_id, parent_run_id, parent_message_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'used', ?)`);
      for (const candidate of candidates)
        insert.run(
          randomUUID(),
          input.projectId,
          candidate.id,
          candidate.memory_node_id,
          input.sessionId,
          input.runId,
          input.parentMessageId,
          Date.now(),
        );
    });

  const candidatesForTask = (taskId: string) => candidateRows("d.task_id", taskId).map(toView);
  const usageForTask = (taskId: string): MemoryUsageView[] =>
    decodeUsage(
      sqlite
        .prepare(`SELECT u.id, u.candidate_id,
    u.memory_node_id, u.origin_session_id, u.parent_run_id, u.parent_message_id, u.kind, u.created_at
    FROM memory_usage_events u JOIN memory_candidates c ON c.id = u.candidate_id
    JOIN knowledge_decisions d ON d.id = c.decision_id WHERE d.task_id = ?
    ORDER BY u.created_at, CASE u.kind WHEN 'retrieved' THEN 0 ELSE 1 END, u.id`)
        .all(taskId),
    ).map((row) => ({
      id: row.id,
      candidateId: row.candidate_id,
      memoryNodeId: row.memory_node_id,
      originSessionId: row.origin_session_id,
      parentRunId: row.parent_run_id,
      parentMessageId: row.parent_message_id,
      kind: row.kind,
      createdAt: row.created_at,
    }));

  return { promote, recordRetrieval, recordUsed, candidatesForTask, usageForTask };
});

/** User-governed bridge from adopted Work Trace evidence into durable project memory. */
export class KnowledgePromotions extends Context.Tag("memory-agent/KnowledgePromotions")<
  KnowledgePromotions,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(KnowledgePromotions, make);
}
