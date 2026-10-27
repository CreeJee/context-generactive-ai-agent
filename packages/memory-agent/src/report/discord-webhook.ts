import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Config,
  Context,
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Function as EffectFunction,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ReportDeliveryFailure, ReportDeliveryResult } from "./delivery-contract.ts";

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
/**
 * The evidence bundle goes as a second file. Discord takes 10 MiB per message on a server without
 * boosts (since 2024); report and bundle together stay well under it.
 */
export const maxEvidenceBytes = 4_000_000;
const reportFile = "context-agent-report.txt";
const evidenceFile = "context-agent-evidence.json";

/** What a report send posts: the reviewed draft, and the evidence bundle as JSON when there is one. */
export interface ReportSend {
  readonly text: string;
  readonly evidence: string | null;
}
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

type Attempt = Data.TaggedEnum<{
  sending: {};
  delivered: { readonly at: string };
  uncertain: { readonly at: string };
}>;
const Attempt = Data.taggedEnum<Attempt>();

const RateLimitBody = Schema.Struct({ retry_after: Schema.Finite });
const MessageBody = Schema.Struct({ id: Schema.String });

interface WebhookUrl {
  readonly id: string;
  readonly url: Redacted.Redacted<string>;
}

/** Server configuration key holding the developer's execute-webhook URL. */
export const webhookConfigKey = "DISCORD_WEBHOOK_URL";

/** The webhook the server was started with; read once, never sent to the browser. */
type WebhookConfig = Data.TaggedEnum<{
  missing: {};
  invalid: {};
  ready: { readonly webhook: WebhookUrl };
}>;
const WebhookConfig = Data.taggedEnum<WebhookConfig>();

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
  return {
    id: match[1],
    url: Redacted.make(`${url.origin}${url.pathname.replace(/\/$/, "")}`, { label: "webhook" }),
  };
}

/**
 * Discord renders the first part of the draft inline; the full draft always travels as a file, and
 * the evidence bundle as a second one.
 */
const messageBody = ({ text, evidence }: ReportSend) => {
  const preview =
    text.length <= contentLimit
      ? text
      : `${text.slice(0, contentLimit - 40)}\n…(전체 내용은 첨부 파일)`;
  const files = [
    { filename: reportFile, body: new Blob([text], { type: "text/plain;charset=utf-8" }) },
    ...(evidence === null
      ? []
      : [
          {
            filename: evidenceFile,
            body: new Blob([evidence], { type: "application/json;charset=utf-8" }),
          },
        ]),
  ];
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      content: preview,
      allowed_mentions: { parse: [] },
      attachments: files.map((file, id) => ({ id, filename: file.filename })),
    }),
  );
  files.forEach((file, id) => form.append(`files[${id}]`, file.body, file.filename));
  return form;
};

/** A short notice the server sends on its own: inline only, with no mentions and no file. */
const noticeBody = (text: string) => {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: text.slice(0, contentLimit), allowed_mentions: { parse: [] } }),
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
      Ref.update(attempts, (current) =>
        Option.match(Option.fromNullishOr(attempt), {
          onNone: () => new Map([...current].filter(([key]) => key !== hash)),
          onSome: (recorded) => new Map(current).set(hash, recorded),
        }),
      );

    // A config read error (not a missing key) means the value is unusable, like a malformed URL.
    const config: WebhookConfig = yield* Config.option(Config.Redacted(webhookConfigKey)).pipe(
      Effect.map(
        Option.match({
          onNone: (): WebhookConfig => WebhookConfig.missing(),
          onSome: (value): WebhookConfig => {
            const webhook = parseWebhookUrl(Redacted.value(value), allowLoopback);
            return webhook === null ? WebhookConfig.invalid() : WebhookConfig.ready({ webhook });
          },
        }),
      ),
      Effect.catchTag("ConfigError", () => Effect.succeed(WebhookConfig.invalid())),
    );

    const webhook = Effect.suspend((): Effect.Effect<WebhookUrl, ReportDeliveryError> =>
      WebhookConfig.$match(config, {
        missing: () => Effect.fail(ReportDeliveryError.make({ reason: "not_configured" })),
        invalid: () => Effect.fail(ReportDeliveryError.make({ reason: "invalid_webhook_url" })),
        ready: ({ webhook }) => Effect.succeed(webhook),
      }),
    );

    const status = Effect.succeed(
      WebhookConfig.$match(config, {
        missing: () => ({ configured: false, webhookIdSuffix: null }),
        invalid: () => ({ configured: false, webhookIdSuffix: null }),
        ready: ({ webhook }) => ({ configured: true, webhookIdSuffix: webhook.id.slice(-4) }),
      }),
    );

    const post = (target: WebhookUrl, body: FormData) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.post(Redacted.value(target.url)).pipe(
              HttpClientRequest.setUrlParam("wait", "true"),
              HttpClientRequest.bodyFormData(body),
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
        const headerRetryAfter = () => Number(response.headers["retry-after"] ?? Number.NaN);
        return yield* Match.value(httpStatus).pipe(
          Match.withReturnType<Effect.Effect<string, ReportDeliveryError>>(),
          Match.when(
            (status) => status >= 200 && status < 300,
            () =>
              response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MessageBody)),
                Effect.map((body) => body.id),
                Effect.mapError(() =>
                  ReportDeliveryError.make({ reason: "uncertain", httpStatus }),
                ),
              ),
          ),
          Match.when(429, () =>
            response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(RateLimitBody)),
              Effect.map((body) => body.retry_after),
              // An unreadable body falls back to the header Discord also sends.
              Effect.catchTags({
                HttpClientError: () => Effect.succeed(headerRetryAfter()),
                SchemaError: () => Effect.succeed(headerRetryAfter()),
              }),
              Effect.flatMap((retryAfter) =>
                Effect.fail(
                  Number.isFinite(retryAfter)
                    ? ReportDeliveryError.make({
                        reason: "rate_limited",
                        httpStatus,
                        retryAfterSeconds: retryAfter,
                      })
                    : ReportDeliveryError.make({ reason: "rate_limited", httpStatus }),
                ),
              ),
            ),
          ),
          // Discord asks not to reuse a webhook that answered 404; 401/403 mean a revoked token.
          Match.whenOr(401, 403, 404, () =>
            Effect.fail(ReportDeliveryError.make({ reason: "webhook_rejected", httpStatus })),
          ),
          Match.when(
            (status) => status >= 500,
            () =>
              Effect.fail(ReportDeliveryError.make({ reason: "discord_unavailable", httpStatus })),
          ),
          Match.orElse(() =>
            Effect.fail(ReportDeliveryError.make({ reason: "payload_rejected", httpStatus })),
          ),
        );
      }).pipe(Effect.scoped);

    const postWithShortWaits = (target: WebhookUrl, report: ReportSend, retries: number) =>
      post(target, messageBody(report)).pipe(
        Effect.catchIf(
          (error): error is ReportDeliveryError =>
            error.reason === "rate_limited" &&
            retries < maxRateLimitRetries &&
            error.retryAfterSeconds !== undefined &&
            error.retryAfterSeconds <= maxRetryAfterSeconds,
          (error): Effect.Effect<string, ReportDeliveryError> =>
            Effect.sleep(Duration.seconds(error.retryAfterSeconds ?? 0)).pipe(
              Effect.andThen(postWithShortWaits(target, report, retries + 1)),
            ),
        ),
      );

    const send = Effect.fn("ReportDelivery.send")(function* (
      report: ReportSend,
      resend: boolean,
    ): Effect.fn.Return<ReportDeliveryResult, ReportDeliveryError> {
      const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
      if (
        bytes(report.text) > maxReportBytes ||
        (report.evidence !== null && bytes(report.evidence) > maxEvidenceBytes)
      )
        return yield* ReportDeliveryError.make({ reason: "too_large" });
      const target = yield* webhook;
      // The same draft with other evidence is another report.
      const hash = yield* reportHash(`${report.text}\u0000${report.evidence ?? ""}`);
      // Claim the text atomically so two tabs or double clicks cannot post it twice.
      const claimed = yield* Ref.modify(
        attempts,
        (current): [Attempt | "claimed", ReadonlyMap<string, Attempt>] => {
          const previous = current.get(hash);
          // A send still running is never joined by another; a settled one only when asked.
          return previous !== undefined && (Attempt.$is("sending")(previous) || !resend)
            ? [previous, current]
            : ["claimed", new Map(current).set(hash, Attempt.sending())];
        },
      );
      if (claimed !== "claimed")
        return yield* Attempt.$match(claimed, {
          sending: () => Effect.fail(ReportDeliveryError.make({ reason: "in_progress" })),
          delivered: ({ at }): Effect.Effect<ReportDeliveryResult> =>
            Effect.succeed(ReportDeliveryResult.cases.duplicate.make({ deliveredAt: at })),
          uncertain: ({ at }): Effect.Effect<ReportDeliveryResult> =>
            Effect.succeed(
              ReportDeliveryResult.cases.uncertain_duplicate.make({ attemptedAt: at }),
            ),
        });
      const messageId = yield* postWithShortWaits(target, report, 0).pipe(
        Effect.tapError((error) =>
          Effect.flatMap(now, (at) =>
            setAttempt(hash, error.reason === "uncertain" ? Attempt.uncertain({ at }) : null),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.flatMap(now, (at) => setAttempt(hash, Attempt.uncertain({ at }))),
        ),
      );
      const deliveredAt = yield* now;
      yield* setAttempt(hash, Attempt.delivered({ at: deliveredAt }));
      return ReportDeliveryResult.cases.delivered.make({ messageId, deliveredAt });
    });

    /**
     * Posts a notice the server composed itself, such as a defect report. It is not remembered: a
     * caller that must not repeat itself limits how often it sends.
     */
    const sendNotice = Effect.fn("ReportDelivery.sendNotice")(function* (text: string) {
      const target = yield* webhook;
      yield* post(target, noticeBody(text));
    });

    return { status, send, sendNotice };
  });

/**
 * Sends a reviewed report to the developer's Discord channel through the incoming webhook in the
 * server configuration (`DISCORD_WEBHOOK_URL`). The URL stays redacted on the server: it never
 * reaches the browser, logs, errors or reports.
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
