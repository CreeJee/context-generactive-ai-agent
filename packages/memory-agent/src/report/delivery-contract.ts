import { Schema } from "effect";

export const ReportDeliveryFailure = Schema.Literals([
  "not_configured",
  "invalid_webhook_url",
  "too_large",
  "in_progress",
  "rate_limited",
  "webhook_rejected",
  "payload_rejected",
  "discord_unavailable",
  "uncertain",
]);
export type ReportDeliveryFailure = typeof ReportDeliveryFailure.Type;

export const ReportDeliveryResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("delivered"),
    messageId: Schema.String,
    deliveredAt: Schema.String,
  }),
  /** The same text was already delivered by this server process; resend requires a confirmation. */
  Schema.Struct({ status: Schema.Literal("duplicate"), deliveredAt: Schema.String }),
  /** An earlier attempt may have reached Discord; the user checks the channel before resending. */
  Schema.Struct({ status: Schema.Literal("uncertain_duplicate"), attemptedAt: Schema.String }),
]);
export type ReportDeliveryResult = typeof ReportDeliveryResult.Type;

export const ReportDeliveryStatus = Schema.Struct({
  configured: Schema.Boolean,
  /** Last digits of the public webhook ID, to tell webhooks apart. Never the token. */
  webhookIdSuffix: Schema.NullOr(Schema.String),
});
export type ReportDeliveryStatus = typeof ReportDeliveryStatus.Type;
