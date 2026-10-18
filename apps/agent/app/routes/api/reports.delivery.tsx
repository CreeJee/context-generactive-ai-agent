import { Effect, Result, Schema } from "effect";
import { GlobalConfig, ReportDelivery, type ReportDeliveryFailure } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/reports.delivery";

const DeliveryAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("send"), text: Schema.String, resend: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("defect_reports"), enabled: Schema.Boolean }),
]);

/** One status code per reason, so the browser never needs to read a rejected body. */
const failureStatus = {
  not_configured: 409,
  invalid_webhook_url: 503,
  too_large: 413,
  in_progress: 423,
  rate_limited: 429,
  webhook_rejected: 410,
  payload_rejected: 422,
  discord_unavailable: 502,
  uncertain: 504,
} satisfies Record<ReportDeliveryFailure, number>;

const reply = <A,>(value: A, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** The webhook's status and whether defects are sent to it. */
const deliveryStatus = Effect.gen(function* () {
  const status = yield* (yield* ReportDelivery).status;
  const settings = yield* (yield* GlobalConfig).read;
  return { ...status, defectReports: settings.defectReports ?? true };
});

/**
 * GET: whether the server has a developer webhook (`DISCORD_WEBHOOK_URL`) and whether defects go to
 * it. The URL and its token are never returned.
 */
// Promise boundary for React Router; delivery runs in the agent runtime.
export function loader() {
  return agent.runPromise(
    deliveryStatus.pipe(
      Effect.map(reply),
      Effect.catchTag("GlobalConfigFailed", () =>
        Effect.succeed(reply({ error: "settings_unavailable" }, 503)),
      ),
    ),
  );
}

/**
 * POST, same-origin only. `send` posts the reviewed report once; `resend` confirms sending a text
 * that was already sent or may have been. The webhook comes only from server configuration.
 * `defect_reports` turns sending defects to the webhook on or off.
 */
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const decoded = yield* Effect.tryPromise(() => readJson(request, DeliveryAction));
      if (Result.isFailure(decoded)) return reply({ error: "invalid_report_delivery" }, 400);
      const command = decoded.success;
      switch (command.action) {
        case "send":
          return reply(yield* (yield* ReportDelivery).send(command.text, command.resend));
        case "defect_reports":
          yield* (yield* GlobalConfig).update({ defectReports: command.enabled });
          return reply(yield* deliveryStatus);
      }
    }).pipe(
      Effect.catchTags({
        ReportDeliveryError: (error) =>
          Effect.succeed(
            reply(
              { error: "report_delivery_failed", reason: error.reason },
              failureStatus[error.reason],
            ),
          ),
        UnknownError: () => Effect.succeed(reply({ error: "invalid_report_delivery" }, 400)),
        GlobalConfigFailed: () => Effect.succeed(reply({ error: "settings_unavailable" }, 503)),
      }),
    ),
  );
}
