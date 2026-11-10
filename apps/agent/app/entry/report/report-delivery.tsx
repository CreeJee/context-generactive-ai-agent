import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Data, Effect, Fiber, Match, Option, Record, Schema } from "effect";
import { deliveryFailureStatus } from "memory-agent/app-api";
import type {
  ReportBundle,
  ReportDeliveryFailure,
  ReportDeliveryStatus,
} from "memory-agent/definitions";
import { useEffect, useRef, useState } from "react";
import { koreanLocalTime } from "../shared/local-time";
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

/** Why the send failed, completing the failed outcome's sentence. */
const deliveryFailureReason = {
  not_configured: msg`이 서버에 개발자 웹훅이 설정되지 않았습니다`,
  invalid_webhook_url: msg`서버에 설정된 웹훅 주소가 Discord 웹훅 형식이 아닙니다`,
  too_large: msg`제보문이나 증거 묶음이 너무 큽니다. 문안을 줄이거나 복사·저장으로 게시해 주십시오`,
  in_progress: msg`같은 제보문을 보내는 중입니다`,
  rate_limited: msg`Discord가 잠시 요청을 막았습니다. 잠시 후 다시 시도해 주십시오`,
  webhook_rejected: msg`Discord가 이 웹훅을 거부했습니다(삭제되거나 재발급됐을 수 있습니다). 개발자에게 알려 주십시오`,
  payload_rejected: msg`Discord가 메시지 형식을 거부했습니다`,
  discord_unavailable: msg`Discord에 연결할 수 없습니다`,
  uncertain: msg`전송 확인을 받지 못했습니다. 채널에 이미 올라갔을 수 있습니다`,
  request_failed: msg`로컬 서버 요청이 실패했습니다`,
} satisfies { [Reason in ReportDeliveryFailure | "request_failed"]: MessageDescriptor };

export const deliveryOutcomeText: (outcome: DeliveryOutcome) => string | null =
  DeliveryOutcome.$match({
    idle: () => null,
    sending: () => t`Discord로 보내는 중입니다.`,
    delivered: ({ messageId }) => t`개발자 Discord 채널로 보냈습니다 (메시지 ${messageId}).`,
    duplicate: (outcome) => {
      const deliveredAt = koreanLocalTime(outcome.deliveredAt);
      return t`이 문안은 ${deliveredAt}에 이미 보냈습니다.`;
    },
    uncertain_duplicate: (outcome) => {
      const attemptedAt = koreanLocalTime(outcome.attemptedAt);
      return t`이 문안의 이전 전송(${attemptedAt})은 확인되지 않았습니다. 채널을 확인한 뒤 필요하면 다시 보내 주십시오.`;
    },
    failed: (outcome) => {
      const reason = i18n._(deliveryFailureReason[outcome.reason]);
      return t`보내지 못했습니다: ${reason}. 위의 복사·텍스트 파일 저장으로 직접 게시할 수 있습니다.`;
    },
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
      {config === null && (
        <p className="text-muted-foreground">
          <Trans>웹훅 설정을 확인하는 중입니다.</Trans>
        </p>
      )}
      {config === "unavailable" && (
        <p>
          <Trans>웹훅 설정을 확인하지 못했습니다. 복사·저장으로 직접 게시해 주십시오.</Trans>
        </p>
      )}
      {config !== null && config !== "unavailable" && !config.configured && (
        <p>
          <Trans>
            이 서버에는 개발자 Discord 웹훅이 설정되지 않았습니다. 복사·저장으로 직접 게시해
            주십시오.
          </Trans>
        </p>
      )}
      {config !== null && config !== "unavailable" && config.configured && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {evidence !== null ? (
              <Trans>
                개발자 웹훅 …{ph({ webhookIdSuffix: config.webhookIdSuffix ?? "" })}. 위 최종 문안이
                메시지로, 증거 묶음 전체가 JSON 첨부 파일로 전송됩니다.
              </Trans>
            ) : (
              <Trans>
                개발자 웹훅 …{ph({ webhookIdSuffix: config.webhookIdSuffix ?? "" })}. 위 최종 문안이
                메시지로, 증거 묶음 없이 전송됩니다.
              </Trans>
            )}
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.defectReports}
              onChange={(event) => toggleDefectReports(event.currentTarget.checked)}
            />
            <Trans>
              앱에서 결함이 생기면 요약을 이 웹훅으로 자동 전송 (대화·프롬프트·자격증명은 보내지
              않음)
            </Trans>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={DeliveryOutcome.$is("sending")(outcome)}
              onClick={() => send(false)}
              className="rounded-md border px-3 py-2 disabled:opacity-50"
            >
              <Trans comment="Button that sends the report to the developer's Discord webhook">
                Discord로 보내기
              </Trans>
            </button>
            {(DeliveryOutcome.$is("duplicate")(outcome) ||
              DeliveryOutcome.$is("uncertain_duplicate")(outcome)) && (
              <button
                type="button"
                onClick={() => send(true)}
                className="rounded-md border px-3 py-2"
              >
                <Trans comment="Button that sends the report again although it may already be sent">
                  그래도 다시 보내기
                </Trans>
              </button>
            )}
          </div>
        </div>
      )}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}
