import { Effect, Schema } from "effect";
import {
  ReportBundle,
  ReportDeliveryResult,
  ReportDeliveryStatus,
  ReportDiagnosis,
  ReportDiagnosisInput,
} from "memory-agent/definitions";
import { appFetch } from "../shared/backend-restart";

export class ReportRequestFailed extends Schema.TaggedError<ReportRequestFailed>()(
  "ReportRequestFailed",
  {
    operation: Schema.Literals(["session", "evidence", "diagnosis", "delivery"]),
    phase: Schema.Literals(["transport", "status", "response"]),
    /** Only the status code is kept from a rejected response; its body is never read. */
    httpStatus: Schema.optional(Schema.Int),
  },
) {}

/** What `/api/reports/delivery` accepts: a reviewed report to send, or the defect-report switch. */
export const DeliveryCommand = Schema.TaggedUnion({
  send: {
    text: Schema.String,
    evidence: Schema.NullOr(ReportBundle),
    resend: Schema.Boolean,
  },
  defect_reports: { enabled: Schema.Boolean },
});
const encodeDeliveryCommand = Schema.encodeEffect(Schema.fromJsonString(DeliveryCommand));

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
      schema: ReportBundle,
      operation: "evidence",
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

  const deliver = <S extends Schema.Constraint>(schema: S, command: typeof DeliveryCommand.Type) =>
    Effect.flatMap(encodeDeliveryCommand(command), (body) =>
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
  /** Sends the reviewed draft, with the evidence bundle the user previewed as its attachment. */
  const sendReport = (
    report: { readonly text: string; readonly evidence: ReportBundle | null },
    resend: boolean,
  ) => deliver(ReportDeliveryResult, DeliveryCommand.cases.send.make({ ...report, resend }));

  /** Turns sending defects to the developer webhook on or off; answers the new status. */
  const setDefectReports = (enabled: boolean) =>
    deliver(ReportDeliveryStatus, DeliveryCommand.cases.defect_reports.make({ enabled }));

  return {
    setDefectReports,
    openReportSession,
    readReportEvidence,
    requestDiagnosis,
    readDeliveryStatus,
    sendReport,
  };
}
export const {
  openReportSession,
  readReportEvidence,
  requestDiagnosis,
  readDeliveryStatus,
  sendReport,
  setDefectReports,
} = makeReportClient(appFetch);
