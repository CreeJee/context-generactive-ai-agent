import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Whom an owner workflow execution belongs to (decisions.md "엔진 실행의 주인은 앱 표에 둔다
 * (2026-11-04)"): its session, and for a Goal execution the bound run it drives. The payload is
 * the engine's; app queries find executions here. A start records its subject before the engine
 * stores the execution, or in the same transaction, so no execution is left without one.
 */
export interface ExecutionSubject {
  readonly sessionId: string;
  /** The bound run of a Goal execution; null for every other workflow. */
  readonly runId: string | null;
}

export const executionSubjects = Effect.map(SqlClient.SqlClient, (sql) => ({
  /** Records the subject of `executionId`; one already recorded stays. */
  record: (executionId: string, subject: ExecutionSubject) =>
    Effect.asVoid(sql`INSERT INTO workflow_execution_subjects (execution_id, session_id, run_id)
      VALUES (${executionId}, ${subject.sessionId}, ${subject.runId})
      ON CONFLICT (execution_id) DO NOTHING`),
}));
