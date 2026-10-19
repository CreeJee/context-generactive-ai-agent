import { Effect, Fiber, type Schema } from "effect";
import type {
  ReportBundle,
  ReportDeliveryFailure,
  ReportDeliveryResult,
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

export type DeliveryOutcome =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | ReportDeliveryResult
  | { readonly status: "failed"; readonly reason: ReportDeliveryFailure | "request_failed" };

/** The delivery route assigns one status code per reason; the rejected body is never read. */
export function deliveryFailure(
  error: ReportRequestFailed | Schema.SchemaError,
): ReportDeliveryFailure | "request_failed" {
  switch (error._tag) {
    case "SchemaError":
      return "request_failed";
    case "ReportRequestFailed":
      switch (error.httpStatus) {
        case 409:
          return "not_configured";
        case 503:
          return "invalid_webhook_url";
        case 413:
          return "too_large";
        case 423:
          return "in_progress";
        case 429:
          return "rate_limited";
        case 410:
          return "webhook_rejected";
        case 422:
          return "payload_rejected";
        case 502:
          return "discord_unavailable";
        case 504:
          return "uncertain";
        default:
          return "request_failed";
      }
  }
}

export const deliveryFailureText = {
  not_configured: "이 서버에 개발자 웹훅이 설정되지 않았어요",
  invalid_webhook_url: "서버에 설정된 웹훅 주소가 Discord 웹훅 형식이 아니에요",
  too_large: "제보문이나 증거 묶음이 너무 커요. 문안을 줄이거나 복사·저장으로 게시하세요",
  in_progress: "같은 제보문을 보내는 중이에요",
  rate_limited: "Discord가 잠시 요청을 막았어요. 잠시 후 다시 시도하세요",
  webhook_rejected:
    "Discord가 이 웹훅을 거부했어요(삭제·재발급됐을 수 있어요). 개발자에게 알려 주세요",
  payload_rejected: "Discord가 메시지 형식을 거부했어요",
  discord_unavailable: "Discord에 연결할 수 없어요",
  uncertain: "전송 확인을 받지 못했어요. 채널에 이미 올라갔을 수 있어요",
  request_failed: "로컬 서버 요청이 실패했어요",
} satisfies Record<ReportDeliveryFailure | "request_failed", string>;

export function deliveryOutcomeText(outcome: DeliveryOutcome): string | null {
  switch (outcome.status) {
    case "idle":
      return null;
    case "sending":
      return "Discord로 보내는 중입니다.";
    case "delivered":
      return `개발자 Discord 채널로 보냈습니다 (메시지 ${outcome.messageId}).`;
    case "duplicate":
      return `이 문안은 ${koreanLocalTime(outcome.deliveredAt)}에 이미 보냈습니다.`;
    case "uncertain_duplicate":
      return `이 문안의 이전 전송(${koreanLocalTime(outcome.attemptedAt)})은 확인되지 않았습니다. 채널을 확인한 뒤 필요하면 다시 보내세요.`;
    case "failed":
      return `보내지 못했습니다: ${deliveryFailureText[outcome.reason]}. 위의 복사·텍스트 파일 저장으로 직접 게시할 수 있습니다.`;
  }
}

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
  const [outcome, setOutcome] = useState<DeliveryOutcome>({ status: "idle" });
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
    setOutcome({ status: "sending" });
    run(
      sendReport({ text, evidence }, resend).pipe(
        Effect.match({
          onSuccess: setOutcome,
          onFailure: (error) => setOutcome({ status: "failed", reason: deliveryFailure(error) }),
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
      {config === null && <p className="text-muted-foreground">웹훅 설정을 확인하는 중입니다.</p>}
      {config === "unavailable" && (
        <p>웹훅 설정을 확인하지 못했습니다. 복사·저장으로 직접 게시하세요.</p>
      )}
      {config !== null && config !== "unavailable" && !config.configured && (
        <p>이 서버에는 개발자 Discord 웹훅이 설정되지 않았습니다. 복사·저장으로 직접 게시하세요.</p>
      )}
      {config !== null && config !== "unavailable" && config.configured && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            개발자 웹훅 …{config.webhookIdSuffix}. 위 최종 문안이 메시지로,
            {evidence === null ? " 증거 묶음 없이" : " 증거 묶음 전체가 JSON 첨부 파일로"}{" "}
            전송됩니다.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.defectReports}
              onChange={(event) => toggleDefectReports(event.currentTarget.checked)}
            />
            앱에서 결함이 생기면 요약을 이 웹훅으로 자동 전송 (대화·프롬프트·자격증명은 보내지 않음)
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={outcome.status === "sending"}
              onClick={() => send(false)}
              className="rounded-md border px-3 py-2 disabled:opacity-50"
            >
              Discord로 보내기
            </button>
            {(outcome.status === "duplicate" || outcome.status === "uncertain_duplicate") && (
              <button
                type="button"
                onClick={() => send(true)}
                className="rounded-md border px-3 py-2"
              >
                그래도 다시 보내기
              </button>
            )}
          </div>
        </div>
      )}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}
