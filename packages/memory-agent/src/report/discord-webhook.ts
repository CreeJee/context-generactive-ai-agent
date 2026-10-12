import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Function as EffectFunction,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SecretStore } from "../config/secrets.ts";
import { ReportDeliveryFailure, type ReportDeliveryResult } from "./delivery-contract.ts";

/**
 * Hosts an execute-webhook URL may point at. The URL's token is the only credential: anyone holding
 * it can post, edit or delete the webhook's messages and the webhook itself, so it is a secret.
 */
const discordHosts = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);
const webhookPath = /^\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([\w-]{20,100})\/?$/;

/** Discord limits message `content` to 2000 characters; longer reports go as a text attachment. */
const contentLimit = 2_000;
/** Far below Discord's default 20 MiB per-file limit; a reviewed report is never this large. */
export const maxReportBytes = 1_000_000;
/** Wait for a 429 only when Discord asks for a short pause; otherwise hand the choice to the user. */
const maxRetryAfterSeconds = 5;
const maxRateLimitRetries = 2;
const requestTimeout = Duration.seconds(30);

/** Carries only a reason and safe numbers: never the webhook URL, its token or a response body. */
export class ReportDeliveryError extends Schema.TaggedError<ReportDeliveryError>()(
  "ReportDeliveryError",
  {
    reason: ReportDeliveryFailure,
    httpStatus: Schema.optional(Schema.Int),
    retryAfterSeconds: Schema.optional(Schema.Finite),
  },
) {}

type Attempt =
  | { readonly status: "sending" }
  | { readonly status: "delivered"; readonly at: string }
  | { readonly status: "uncertain"; readonly at: string };

const RateLimitBody = Schema.Struct({ retry_after: Schema.Finite });
const MessageBody = Schema.Struct({ id: Schema.String });

interface WebhookUrl {
  readonly id: string;
  readonly url: string;
}

/** Accepts only an execute-webhook URL on Discord; loopback is allowed only for tests. */
export const parseWebhookUrl: {
  (allowLoopback: boolean): (input: string) => WebhookUrl | null;
} & typeof parseWebhookUrlBody = EffectFunction.dual(2, parseWebhookUrlBody);
function parseWebhookUrlBody(input: string, allowLoopback: boolean): WebhookUrl | null {
  const url = URL.parse(input.trim());
  if (url === null || url.username !== "" || url.password !== "") return null;
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback && (url.protocol !== "https:" || !discordHosts.has(url.hostname))) return null;
  const match = webhookPath.exec(url.pathname);
  if (match === null || match[1] === undefined) return null;
  return { id: match[1], url: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
}

/** Discord renders the first part inline; the full reviewed text always travels as the file. */
const messageBody = (text: string) => {
  const preview =
    text.length <= contentLimit
      ? text
      : `${text.slice(0, contentLimit - 40)}\n…(전체 내용은 첨부 파일)`;
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      content: preview,
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: "context-agent-report.txt" }],
    }),
  );
  form.append(
    "files[0]",
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    "context-agent-report.txt",
  );
  return form;
};

export interface ReportDeliveryOptions {
  /** Tests send to a local fake server instead of Discord. */
  readonly allowLoopback?: boolean;
}

const make = (options: ReportDeliveryOptions) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const secrets = yield* SecretStore;
    const crypto = yield* Crypto.Crypto;
    // Node's SHA-256 cannot fail for an in-memory buffer; a failure would be a defect.
    const reportHash = (text: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(text))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
    const allowLoopback = options.allowLoopback === true;
    // Per server process: repeated clicks and retries of the same text are recognised until restart.
    const attempts = yield* Ref.make<ReadonlyMap<string, Attempt>>(new Map());
    const now = Effect.map(DateTime.now, DateTime.formatIso);
    const setAttempt = (hash: string, attempt: Attempt | null) =>
      Ref.update(attempts, (current) => {
        const next = new Map(current);
        if (attempt === null) next.delete(hash);
        else next.set(hash, attempt);
        return next;
      });

    const webhook = Effect.gen(function* () {
      const stored = yield* secrets
        .get("report-discord-webhook")
        .pipe(Effect.mapError(() => ReportDeliveryError.make({ reason: "not_configured" })));
      const parsed = stored === null ? null : parseWebhookUrl(stored, allowLoopback);
      if (parsed === null) return yield* ReportDeliveryError.make({ reason: "not_configured" });
      return parsed;
    });

    const status = Effect.gen(function* () {
      const parsed = yield* Effect.option(webhook);
      return Option.match(parsed, {
        onNone: () => ({ configured: false, webhookIdSuffix: null }),
        onSome: ({ id }) => ({ configured: true, webhookIdSuffix: id.slice(-4) }),
      });
    });

    const post = (target: WebhookUrl, text: string) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.post(target.url).pipe(
              HttpClientRequest.setUrlParam("wait", "true"),
              HttpClientRequest.bodyFormData(messageBody(text)),
            ),
          )
          .pipe(
            // A redirect would forward the token-bearing request elsewhere.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
            // A span would record the token-bearing URL; this request is never traced.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.timeoutOrElse({
              duration: requestTimeout,
              orElse: () => Effect.fail(ReportDeliveryError.make({ reason: "uncertain" })),
            }),
            Effect.catchTag("HttpClientError", () =>
              Effect.fail(ReportDeliveryError.make({ reason: "uncertain" })),
            ),
          );
        const httpStatus = response.status;
        if (httpStatus >= 200 && httpStatus < 300) {
          const body = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(MessageBody)),
            Effect.mapError(() => ReportDeliveryError.make({ reason: "uncertain", httpStatus })),
          );
          return body.id;
        }
        if (httpStatus === 429) {
          const retryAfter = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RateLimitBody)),
            Effect.map((body) => body.retry_after),
            Effect.orElseSucceed(() => Number(response.headers["retry-after"] ?? Number.NaN)),
          );
          return yield* Number.isFinite(retryAfter)
            ? ReportDeliveryError.make({
                reason: "rate_limited",
                httpStatus,
                retryAfterSeconds: retryAfter,
              })
            : ReportDeliveryError.make({ reason: "rate_limited", httpStatus });
        }
        // Discord asks not to reuse a webhook that answered 404; 401/403 mean a revoked token.
        if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404)
          return yield* ReportDeliveryError.make({ reason: "webhook_rejected", httpStatus });
        if (httpStatus >= 500)
          return yield* ReportDeliveryError.make({ reason: "discord_unavailable", httpStatus });
        return yield* ReportDeliveryError.make({ reason: "payload_rejected", httpStatus });
      }).pipe(Effect.scoped);

    const postWithShortWaits = (target: WebhookUrl, text: string, retries: number) =>
      post(target, text).pipe(
        Effect.catchIf(
          (error): error is ReportDeliveryError =>
            error.reason === "rate_limited" &&
            retries < maxRateLimitRetries &&
            error.retryAfterSeconds !== undefined &&
            error.retryAfterSeconds <= maxRetryAfterSeconds,
          (error): Effect.Effect<string, ReportDeliveryError> =>
            Effect.sleep(Duration.seconds(error.retryAfterSeconds ?? 0)).pipe(
              Effect.andThen(postWithShortWaits(target, text, retries + 1)),
            ),
        ),
      );

    const send = Effect.fn("ReportDelivery.send")(function* (
      text: string,
      resend: boolean,
    ): Effect.fn.Return<ReportDeliveryResult, ReportDeliveryError> {
      if (new TextEncoder().encode(text).byteLength > maxReportBytes)
        return yield* ReportDeliveryError.make({ reason: "too_large" });
      const target = yield* webhook;
      const hash = yield* reportHash(text);
      // Claim the text atomically so two tabs or double clicks cannot post it twice.
      const claimed = yield* Ref.modify(
        attempts,
        (current): [Attempt | "claimed", ReadonlyMap<string, Attempt>] => {
          const previous = current.get(hash);
          if (previous?.status === "sending") return [previous, current];
          if (previous !== undefined && !resend) return [previous, current];
          return ["claimed", new Map(current).set(hash, { status: "sending" })];
        },
      );
      if (claimed !== "claimed")
        switch (claimed.status) {
          case "sending":
            return yield* ReportDeliveryError.make({ reason: "in_progress" });
          case "delivered":
            return { status: "duplicate", deliveredAt: claimed.at };
          case "uncertain":
            return { status: "uncertain_duplicate", attemptedAt: claimed.at };
        }
      const messageId = yield* postWithShortWaits(target, text, 0).pipe(
        Effect.tapError((error) =>
          Effect.flatMap(now, (at) =>
            setAttempt(hash, error.reason === "uncertain" ? { status: "uncertain", at } : null),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.flatMap(now, (at) => setAttempt(hash, { status: "uncertain", at })),
        ),
      );
      const deliveredAt = yield* now;
      yield* setAttempt(hash, { status: "delivered", at: deliveredAt });
      return { status: "delivered", messageId, deliveredAt };
    });

    const configure = Effect.fn("ReportDelivery.configure")(function* (url: string) {
      const parsed = parseWebhookUrl(url, allowLoopback);
      if (parsed === null)
        return yield* ReportDeliveryError.make({ reason: "invalid_webhook_url" });
      yield* secrets
        .set("report-discord-webhook", parsed.url)
        .pipe(Effect.mapError(() => ReportDeliveryError.make({ reason: "not_configured" })));
      return yield* status;
    });

    const remove = secrets.remove("report-discord-webhook").pipe(
      Effect.mapError(() => ReportDeliveryError.make({ reason: "not_configured" })),
      Effect.andThen(status),
    );

    return { status, send, configure, remove };
  });

/**
 * Sends a reviewed report to the developer's Discord channel through an incoming webhook the user
 * configured. The webhook URL lives only in the OS keychain and never reaches logs or reports.
 */
export class ReportDelivery extends Context.Service<
  ReportDelivery,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/report/discord-webhook/ReportDelivery") {
  static readonly layer = (options: ReportDeliveryOptions = {}) =>
    Layer.effect(ReportDelivery, make(options)).pipe(
      Layer.provide(Layer.merge(FetchHttpClient.layer, NodeCrypto.layer)),
    );
}
