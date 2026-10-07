import { Data, Effect, Schema } from "effect";
import { appFetch } from "../shared/backend-restart";
import { ReportEvidence } from "./report-contracts";

export class ReportRequestFailed extends Data.TaggedError("ReportRequestFailed")<{
  readonly operation: "session" | "evidence" | "detail";
  readonly phase: "transport" | "status" | "response";
}> {}

const request = <S extends Schema.Constraint>(input: {
  readonly schema: S;
  readonly operation: ReportRequestFailed["operation"];
  readonly url: string;
  readonly init?: RequestInit;
}) =>
  Effect.gen(function* () {
    const signal = yield* Effect.abortSignal;
    const response = yield* Effect.tryPromise({
      try: () => appFetch(input.url, { ...input.init, signal }),
      catch: () => new ReportRequestFailed({ operation: input.operation, phase: "transport" }),
    });
    if (!response.ok)
      return yield* new ReportRequestFailed({ operation: input.operation, phase: "status" });
    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new ReportRequestFailed({ operation: input.operation, phase: "response" }),
    });
    return yield* Schema.decodeUnknownEffect(input.schema)(body);
  }).pipe(Effect.scoped);

const sessionInput = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, sourceSessionId: Schema.String }),
);
export const openReportSession = Effect.fn("Report.openSession")(function* (
  input: typeof sessionInput.Type,
) {
  const body = yield* Schema.encodeEffect(sessionInput)(input);
  const page = yield* request({
    schema: Schema.Struct({ reportSessionId: Schema.String }),
    operation: "session",
    url: "/api/reports/sessions",
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body },
  });
  return page;
});

export const readReportEvidence = (input: { readonly project: string; readonly session: string }) =>
  request({
    schema: ReportEvidence,
    operation: "evidence",
    url: `/api/reports/evidence?${new URLSearchParams(input)}`,
    init: { cache: "no-store" },
  });

export const readReportDetail = (input: {
  readonly project: string;
  readonly session: string;
  readonly item: string;
}) =>
  request({
    schema: Schema.Struct({
      id: Schema.Literal(input.item),
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
    operation: "detail",
    url: `/api/reports/evidence?${new URLSearchParams(input)}`,
    init: { cache: "no-store" },
  });
