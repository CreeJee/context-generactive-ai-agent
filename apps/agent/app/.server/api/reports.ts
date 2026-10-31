import { Effect, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  AppEvents,
  collectReportBundle,
  GlobalConfig,
  Projects,
  ReportBundle,
  ReportDelivery,
  ReportDiagnoser,
} from "memory-agent";
import { AppApi, ReportDeliveryCommand } from "memory-agent/app-api";
import { reportSession } from "../report-evidence.ts";
import { openReportSession } from "../report-sessions.ts";
import { refusalsOnly } from "./agent-chat-refusals.ts";

const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(ReportBundle));

const settingsUnavailable = () => Effect.fail({ error: "settings_unavailable" } as const);

/** The reports group of `AppApi` (`/api/reports/*`). */
export const ReportsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "reports",
  Effect.fn(function* (handlers) {
    const delivery = yield* ReportDelivery;
    const config = yield* GlobalConfig;
    const diagnoser = yield* ReportDiagnoser;
    const projects = yield* Projects;
    const events = yield* AppEvents;
    // The report session and its evidence read the database and what the bundle reports on.
    const reportServices = yield* Effect.context<
      | Effect.Services<ReturnType<typeof collectReportBundle>>
      | Effect.Services<ReturnType<typeof openReportSession>>
    >();

    /** The webhook's status and whether defects are sent to it. */
    const deliveryStatus = Effect.gen(function* () {
      const status = yield* delivery.status;
      const settings = yield* config.read;
      return { ...status, defectReports: settings.defectReports ?? true };
    });

    return handlers.handleAll({
      openSession: ({ payload: { projectId, sourceSessionId } }) =>
        openReportSession(projectId, sourceSessionId).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () => ({ error: "report_source_not_found" }) as const,
          ),
          Effect.tap(() => events.publishProject(projectId, "sessions")),
          Effect.provideContext(reportServices),
          refusalsOnly,
        ),
      evidence: ({ query: { project, session } }) =>
        Effect.gen(function* () {
          // The project the page names is no authority: the session must be in it.
          const found = yield* reportSession(project, session);
          if (Option.isNone(found))
            return yield* Effect.fail({ error: "session_not_found" } as const);
          return yield* collectReportBundle(
            yield* projects.get(found.value.projectId),
            found.value,
          );
        }).pipe(
          Effect.catchTags({
            ProjectNotFound: () => Effect.fail({ error: "session_not_found" } as const),
            SqlError: () => Effect.fail({ error: "evidence_unavailable" } as const),
            SchemaError: () => Effect.fail({ error: "evidence_unavailable" } as const),
          }),
          Effect.provideContext(reportServices),
          refusalsOnly,
        ),
      diagnose: ({ payload }) =>
        diagnoser.diagnose(payload).pipe(
          Effect.catchTag("ReportDiagnosisError", ({ reason }) =>
            Effect.fail({ error: "report_diagnosis_failed", reason } as const),
          ),
          refusalsOnly,
        ),
      deliveryStatus: () =>
        deliveryStatus.pipe(
          Effect.catchTag("GlobalConfigFailed", settingsUnavailable),
          refusalsOnly,
        ),
      deliver: ({ payload }) =>
        Effect.gen(function* () {
          if (ReportDeliveryCommand.guards.defect_reports(payload)) {
            yield* config.update({ defectReports: payload.enabled });
            return yield* deliveryStatus;
          }
          // The bundle the user previewed goes as the report's JSON attachment.
          const evidence =
            payload.evidence === null ? null : yield* encodeEvidence(payload.evidence);
          return yield* delivery.send({ text: payload.text, evidence }, payload.resend);
        }).pipe(
          Effect.catchTags({
            ReportDeliveryError: ({ reason }) =>
              Effect.fail({ error: "report_delivery_failed", reason } as const),
            GlobalConfigFailed: settingsUnavailable,
          }),
          refusalsOnly,
        ),
    });
  }),
);
