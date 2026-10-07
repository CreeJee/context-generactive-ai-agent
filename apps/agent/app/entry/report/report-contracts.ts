import { Schema } from "effect";

export const EvidenceStatus = Schema.Literals(["available", "empty", "failed"]);
export type EvidenceStatus = typeof EvidenceStatus.Type;
export interface EvidenceSection<T> {
  readonly status: EvidenceStatus;
  readonly items: readonly T[];
  readonly truncated: boolean;
}
const section = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({
    status: EvidenceStatus,
    items: Schema.Array(item),
    truncated: Schema.Boolean,
  });
export const ReportEvidence = Schema.Struct({
  session: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    title: Schema.NullOr(Schema.String),
  }),
  runs: section(
    Schema.Struct({
      runId: Schema.String,
      status: Schema.String,
      startedAt: Schema.Finite,
      finishedAt: Schema.NullOr(Schema.Finite),
      error: Schema.NullOr(Schema.String),
      truncated: Schema.Boolean,
    }),
  ),
  approvals: section(
    Schema.Struct({
      runId: Schema.String,
      status: Schema.String,
      requestedAt: Schema.Finite,
      resolvedAt: Schema.NullOr(Schema.Finite),
    }),
  ),
  transcript: section(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      runId: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
  calls: section(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      runId: Schema.NullOr(Schema.String),
      toolCallId: Schema.NullOr(Schema.String),
      toolName: Schema.NullOr(Schema.String),
      ok: Schema.NullOr(Schema.Boolean),
      createdAt: Schema.String,
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
  trace: section(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      parentRunId: Schema.String,
      parentToolCallId: Schema.String,
      updatedAt: Schema.Finite,
    }),
  ),
});
export type ReportEvidence = typeof ReportEvidence.Type;
