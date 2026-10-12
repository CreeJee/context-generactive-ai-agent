import { Effect, Fiber, type Schema } from "effect";
import type {
  ReportDeliveryFailure,
  ReportDeliveryResult,
  ReportDeliveryStatus,
} from "memory-agent/definitions";
import { useEffect, useRef, useState } from "react";
import { koreanLocalTime } from "../shared/local-time";
import {
  configureWebhook,
  readDeliveryStatus,
  removeWebhook,
  sendReport,
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
        case 400:
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
  not_configured: "개발자 웹훅이 설정되지 않았어요",
  invalid_webhook_url: "Discord 웹훅 주소 형식이 아니에요",
  too_large: "제보문이 너무 커요. 증거를 줄이세요",
  in_progress: "같은 제보문을 보내는 중이에요",
  rate_limited: "Discord가 잠시 요청을 막았어요. 잠시 후 다시 시도하세요",
  webhook_rejected:
    "Discord가 이 웹훅을 거부했어요(삭제·재발급됐을 수 있어요). 개발자에게 새 주소를 받으세요",
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

/** Explicit, reviewed send to the developer's webhook; copy/download stay available throughout. */
export function ReportDelivery({ text }: { text: string }) {
  const [config, setConfig] = useState<ReportDeliveryStatus | "unavailable" | null>(null);
  const [outcome, setOutcome] = useState<DeliveryOutcome>({ status: "idle" });
  const [url, setUrl] = useState("");
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
      sendReport(text, resend).pipe(
        Effect.match({
          onSuccess: setOutcome,
          onFailure: (error) => setOutcome({ status: "failed", reason: deliveryFailure(error) }),
        }),
      ),
    );
  };
  const changeWebhook = (
    change: Effect.Effect<ReportDeliveryStatus, ReportRequestFailed | Schema.SchemaError>,
  ) =>
    run(
      change.pipe(
        Effect.match({
          onSuccess: (next) => {
            setConfig(next);
            setUrl("");
            setOutcome({ status: "idle" });
          },
          onFailure: (error) => setOutcome({ status: "failed", reason: deliveryFailure(error) }),
        }),
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
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() !== "") changeWebhook(configureWebhook(url.trim()));
          }}
        >
          <label htmlFor="report-webhook" className="block font-medium">
            개발자 Discord 웹훅 주소
          </label>
          <div className="flex gap-2">
            <input
              id="report-webhook"
              type="password"
              autoComplete="off"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2"
            />
            <button type="submit" className="rounded-md border px-3 py-2">
              저장
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            개발자가 알려준 웹훅 주소만 입력하세요. 주소는 OS 키체인에만 저장되고 제보문·로그에 남지
            않습니다. 웹훅은 그 채널에 글을 쓰는 권한만 있고 Discord 로그인 정보는 쓰지 않습니다.
          </p>
        </form>
      )}
      {config !== null && config !== "unavailable" && config.configured && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            웹훅 …{config.webhookIdSuffix} 설정됨. 위 최종 문안이 그대로 전송됩니다.
          </p>
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
            <button
              type="button"
              onClick={() => changeWebhook(removeWebhook)}
              className="text-primary underline"
            >
              웹훅 제거
            </button>
          </div>
        </div>
      )}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}
