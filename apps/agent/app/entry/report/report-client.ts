import { Effect, Function as EffectFunction, Schema } from "effect";
import {
  ReportDeliveryResult,
  ReportDeliveryStatus,
  ReportDiagnosis,
  ReportDiagnosisInput,
} from "memory-agent/definitions";
import { appFetch } from "../shared/backend-restart";
import { ReportEvidence } from "./report-contracts";

export class ReportRequestFailed extends Schema.TaggedError<ReportRequestFailed>()(
  "ReportRequestFailed",
  {
    operation: Schema.Literals(["session", "evidence", "detail", "diagnosis", "delivery"]),
    phase: Schema.Literals(["transport", "status", "response"]),
    /** Only the status code is kept from a rejected response; its body is never read. */
    httpStatus: Schema.optional(Schema.Int),
  },
) {}

export function makeReportClient(fetcher: typeof fetch) {
  const request = <S extends Schema.Constraint>(input: {
    readonly schema: S;
    readonly operation: ReportRequestFailed["operation"];
    readonly url: string;
    readonly init?: RequestInit;
  }) =>
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise({
        try: () => fetcher(input.url, { ...input.init, signal }),
        catch: () => ReportRequestFailed.make({ operation: input.operation, phase: "transport" }),
      });
      if (!response.ok)
        return yield* ReportRequestFailed.make({
          operation: input.operation,
          phase: "status",
          httpStatus: response.status,
        });
      const body: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => ReportRequestFailed.make({ operation: input.operation, phase: "response" }),
      });
      return yield* Schema.decodeUnknownEffect(input.schema)(body);
    }).pipe(Effect.scoped);

  const sessionInput = Schema.fromJsonString(
    Schema.Struct({ projectId: Schema.String, sourceSessionId: Schema.String }),
  );
  const openReportSession = Effect.fn("Report.openSession")(function* (
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

  const readReportEvidence = (input: { readonly project: string; readonly session: string }) =>
    request({
      schema: ReportEvidence,
      operation: "evidence",
      url: `/api/reports/evidence?${new URLSearchParams(input)}`,
      init: { cache: "no-store" },
    });

  const readReportDetail = (input: {
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

  const diagnosisInput = Schema.fromJsonString(ReportDiagnosisInput);
  const requestDiagnosis = Effect.fn("Report.requestDiagnosis")(function* (
    input: ReportDiagnosisInput,
  ) {
    const body = yield* Schema.encodeEffect(diagnosisInput)(input);
    return yield* request({
      schema: ReportDiagnosis,
      operation: "diagnosis",
      url: "/api/reports/diagnosis",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body },
    });
  });

  const DeliveryCommand = Schema.fromJsonString(
    Schema.Struct({
      action: Schema.Literal("send"),
      text: Schema.String,
      resend: Schema.Boolean,
    }),
  );
  const deliver = <S extends Schema.Constraint>(schema: S, command: typeof DeliveryCommand.Type) =>
    Effect.flatMap(Schema.encodeEffect(DeliveryCommand)(command), (body) =>
      request({
        schema,
        operation: "delivery",
        url: "/api/reports/delivery",
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body },
      }),
    );
  const readDeliveryStatus = request({
    schema: ReportDeliveryStatus,
    operation: "delivery",
    url: "/api/reports/delivery",
    init: { cache: "no-store" },
  });
  const sendReportBody = (text: string, resend: boolean) =>
    deliver(ReportDeliveryResult, { action: "send", text, resend });
  const sendReport: {
    (resend: boolean): (text: string) => ReturnType<typeof sendReportBody>;
  } & typeof sendReportBody = EffectFunction.dual(2, sendReportBody);

  return {
    openReportSession,
    readReportEvidence,
    readReportDetail,
    requestDiagnosis,
    readDeliveryStatus,
    sendReport,
  };
}
export const {
  openReportSession,
  readReportEvidence,
  readReportDetail,
  requestDiagnosis,
  readDeliveryStatus,
  sendReport,
} = makeReportClient(appFetch);
