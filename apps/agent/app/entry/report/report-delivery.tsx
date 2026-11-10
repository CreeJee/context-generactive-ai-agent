import { Data, Effect, Fiber, Match, Option, Record, Schema } from "effect";
import { deliveryFailureStatus } from "memory-agent/app-api";
import type {
  ReportBundle,
  ReportDeliveryFailure,
  ReportDeliveryStatus,
} from "memory-agent/definitions";
import { useEffect, useRef, useState } from "react";
import { problemText } from "../shared/copy-templates";
import { koreanLocalTime } from "../shared/local-time";
import { reportCopy } from "./copy";
import {
  readDeliveryStatus,
  sendReport,
  setDefectReports,
  type ReportRequestFailed,
} from "./report-client";

/** The send so far: nothing yet, under way, the server's `ReportDeliveryResult`, or a failure. */
export type DeliveryOutcome = Data.TaggedEnum<{
  idle: {};
  sending: {};
  delivered: { readonly messageId: string; readonly deliveredAt: string };
  duplicate: { readonly deliveredAt: string };
  uncertain_duplicate: { readonly attemptedAt: string };
  failed: { readonly reason: ReportDeliveryFailure | "request_failed" };
}>;
export const DeliveryOutcome = Data.taggedEnum<DeliveryOutcome>();

export function deliveryFailure(
  error: ReportRequestFailed | Schema.SchemaError,
): ReportDeliveryFailure | "request_failed" {
  return Match.valueTags(error, {
    SchemaError: (): ReportDeliveryFailure | "request_failed" => "request_failed",
    // The contract answers each reason with its own status; the refused body is never read.
    ReportRequestFailed: ({ httpStatus }) =>
      Record.findFirst(deliveryFailureStatus, (status) => status === httpStatus).pipe(
        Option.match({ onNone: () => "request_failed" as const, onSome: ([reason]) => reason }),
      ),
  });
}

const copy = reportCopy.delivery;

export const deliveryOutcomeText: (outcome: DeliveryOutcome) => string | null =
  DeliveryOutcome.$match({
    idle: () => null,
    sending: () => copy.outcome.sending,
    delivered: ({ messageId }) => copy.outcome.delivered(messageId),
    duplicate: ({ deliveredAt }) => copy.outcome.duplicate(koreanLocalTime(deliveredAt)),
    uncertain_duplicate: ({ attemptedAt }) =>
      copy.outcome.uncertainDuplicate(koreanLocalTime(attemptedAt)),
    failed: ({ reason }) => copy.outcome.failed(copy.failure[reason]),
  });

/**
 * Explicit, reviewed send to the developer's webhook: the draft as the message, the evidence bundle
 * as its attachment. Copy/download stay available throughout.
 */
export function ReportDelivery({
  text,
  evidence,
}: {
  text: string;
  evidence: ReportBundle | null;
}) {
  const [config, setConfig] = useState<ReportDeliveryStatus | "unavailable" | null>(null);
  const [outcome, setOutcome] = useState<DeliveryOutcome>(DeliveryOutcome.idle());
  const task = useRef<Fiber.Fiber<void> | null>(null);
  const run = (program: Effect.Effect<void>) => {
    if (task.current !== null) Effect.runFork(Fiber.interrupt(task.current));
    task.current = Effect.runFork(program);
  };
  useEffect(() => {
    run(
      readDeliveryStatus.pipe(
        Effect.match({ onSuccess: setConfig, onFailure: () => setConfig("unavailable") }),
      ),
    );
    return () => {
      if (task.current !== null) Effect.runFork(Fiber.interrupt(task.current));
    };
  }, []);

  const send = (resend: boolean) => {
    setOutcome(DeliveryOutcome.sending());
    run(
      sendReport({ text, evidence }, resend).pipe(
        Effect.match({
          onSuccess: setOutcome,
          onFailure: (error) =>
            setOutcome(DeliveryOutcome.failed({ reason: deliveryFailure(error) })),
        }),
      ),
    );
  };

  const toggleDefectReports = (enabled: boolean) =>
    run(
      setDefectReports(enabled).pipe(
        Effect.match({ onSuccess: setConfig, onFailure: () => setConfig("unavailable") }),
      ),
    );

  const message = deliveryOutcomeText(outcome);
  return (
    <div className="space-y-2 text-sm">
      {config === null && <p className="text-muted-foreground">{copy.checking}</p>}
      {config === "unavailable" && <p>{problemText(copy.unavailable)}</p>}
      {config !== null && config !== "unavailable" && !config.configured && (
        <p>{problemText(copy.notConfigured)}</p>
      )}
      {config !== null && config !== "unavailable" && config.configured && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {copy.configured(config.webhookIdSuffix ?? "", evidence !== null)}
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.defectReports}
              onChange={(event) => toggleDefectReports(event.currentTarget.checked)}
            />
            {copy.defectReports}
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={DeliveryOutcome.$is("sending")(outcome)}
              onClick={() => send(false)}
              className="rounded-md border px-3 py-2 disabled:opacity-50"
            >
              {copy.send}
            </button>
            {(DeliveryOutcome.$is("duplicate")(outcome) ||
              DeliveryOutcome.$is("uncertain_duplicate")(outcome)) && (
              <button
                type="button"
                onClick={() => send(true)}
                className="rounded-md border px-3 py-2"
              >
                {copy.resend}
              </button>
            )}
          </div>
        </div>
      )}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}
