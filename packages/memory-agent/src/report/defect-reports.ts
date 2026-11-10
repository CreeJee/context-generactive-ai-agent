import {
  Clock,
  Config,
  Duration,
  Effect,
  Function as EffectFunction,
  HashMap,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { GlobalConfig } from "../config/global-config.ts";
import { hostPlatform } from "../runtime/host-system.ts";
import { DefectReporter, type DefectEvent, type RecentDefect } from "../runtime/defect-reporter.ts";
import { FailedSpans } from "../runtime/failed-spans.ts";
import { tagOfUnknown } from "../runtime/failure-tag.ts";
import { logFailure } from "../runtime/logged-failures.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { spanLine } from "./bundle-digest.ts";
import { msg } from "@lingui/core/runtime-macro";
import { i18n } from "../i18n.ts";
import { ReportDelivery } from "./discord-webhook.ts";

/** The same defect is sent at most once per this window; the next message counts the rest. */
export const fingerprintWindow = Duration.minutes(10);
/** At most this many defect messages leave the process per minute, whatever their fingerprint. */
export const messagesPerMinute = 5;
const stackLines = 5;
/** Failed spans of the defect's trace a message lists, the newest ones. */
const maxSpanLines = 6;
/** Distinct defects a user's report can list. */
const maxRecentDefects = 20;
const summaryLength = 300;
const contentLimit = 2_000;
/** Ids are sent as a short hash, enough to tell reports of one session apart. */
const hashLength = 12;
const hashedAnnotations = ["sessionId", "goalInstanceId"] as const;

const ErrorParts = Schema.Struct({
  name: Schema.String,
  message: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String),
});
const decodeErrorParts = Schema.decodeUnknownOption(ErrorParts);

/** One defect as the message describes it, before redaction. */
interface DefectFacts {
  readonly tag: string;
  readonly location: string;
  readonly summary: string;
  readonly stack: readonly string[];
}

const factsOf = (event: DefectEvent, span: Option.Option<string>): DefectFacts => {
  const defect = event.cause.reasons.flatMap(
    Match.valueTags({
      Die: ({ defect }): unknown[] => [defect],
      Fail: ({ error }) => [error],
      Interrupt: () => [],
    }),
  )[0];
  const parts = decodeErrorParts(defect);
  const tag = Option.getOrElse(tagOfUnknown(defect), () =>
    Option.match(parts, { onSome: ({ name }) => name, onNone: () => "Defect" }),
  );
  return {
    tag,
    location: Option.match(span, {
      onSome: (name) => `${event.message} (${name})`,
      onNone: () => event.message,
    }),
    summary: Option.match(parts, {
      onSome: ({ message }) => (message ?? "").slice(0, summaryLength),
      onNone: () => "",
    }),
    stack: Option.match(parts, {
      onSome: ({ stack }) =>
        (stack ?? "")
          .split("\n")
          .slice(1, 1 + stackLines)
          .map((line) => line.trim()),
      onNone: () => [],
    }),
  };
};

/** Per fingerprint: when its last message went out, and how many happened since. */
interface Seen {
  readonly sentAt: number | null;
  readonly unsent: number;
}

/** What the rate limit remembers: each fingerprint, and when recent messages went out. */
export interface AdmissionState {
  readonly seen: HashMap.HashMap<string, Seen>;
  readonly sentTimes: readonly number[];
}

export const noDefectsSent: AdmissionState = { seen: HashMap.empty(), sentTimes: [] };

interface Outgoing {
  readonly facts: DefectFacts;
  readonly count: number;
  readonly ids: readonly string[];
  /** The failed spans of the defect's trace, newest last. */
  readonly spans: readonly string[];
}

/** Whether a defect goes out now, counting what its fingerprint held back. */
export const admitDefect: {
  (fingerprint: string, now: number): (state: AdmissionState) => ReturnType<typeof admitDefectBody>;
} & typeof admitDefectBody = EffectFunction.dual(3, admitDefectBody);
function admitDefectBody(
  state: AdmissionState,
  fingerprint: string,
  now: number,
): { readonly count: Option.Option<number>; readonly state: AdmissionState } {
  const previous = Option.getOrElse(HashMap.get(state.seen, fingerprint), () => ({
    sentAt: null,
    unsent: 0,
  }));
  const unsent = previous.unsent + 1;
  const sentTimes = state.sentTimes.filter((at) => now - at < Duration.toMillis("1 minute"));
  const due =
    (previous.sentAt === null || now - previous.sentAt >= Duration.toMillis(fingerprintWindow)) &&
    sentTimes.length < messagesPerMinute;
  return due
    ? {
        count: Option.some(unsent),
        state: {
          seen: HashMap.set(state.seen, fingerprint, { sentAt: now, unsent: 0 }),
          sentTimes: [...sentTimes, now],
        },
      }
    : {
        count: Option.none<number>(),
        state: {
          seen: HashMap.set(state.seen, fingerprint, { sentAt: previous.sentAt, unsent }),
          sentTimes,
        },
      };
}

const make = Effect.gen(function* () {
  const delivery = yield* ReportDelivery;
  const config = yield* GlobalConfig;
  const redactor = yield* SecretRedactor;
  const crypto = yield* Digest.Digest;
  const release = yield* Config.String("CONTEXT_AGENT_RELEASE").pipe(
    Config.withDefault("0.0.0-dev"),
    Effect.catchTag("ConfigError", () => Effect.succeed("unknown")),
  );
  const platform = yield* hostPlatform;
  const failedSpans = yield* FailedSpans;
  const configured = (yield* delivery.status).configured;
  const state = yield* Ref.make(noDefectsSent);
  // Kept whether or not a webhook is set: a user's report carries them (newest first).
  const recent = yield* Ref.make<readonly RecentDefect[]>([]);
  // Sending never holds up the owner that hit the defect; a full queue drops the newest.
  const outgoing = yield* Queue.dropping<Outgoing>(64);

  const hash = (id: string) =>
    crypto
      .digest(Digest.sha256, new TextEncoder().encode(id))
      .pipe(Effect.map((digest) => Hex.encode(digest).slice(0, hashLength)));
  const redacted = (text: string) =>
    redactor.redactText(text).pipe(
      Effect.map((redaction) => redaction.text),
      Effect.catchTag("SecretRedactionFailed", () => Effect.succeed("(redaction failed)")),
    );

  const messageOf = Effect.fnUntraced(function* (item: Outgoing) {
    const { facts, count } = item;
    const summary = yield* redacted(facts.summary);
    const stack = yield* redacted(facts.stack.join("\n"));
    const lines = [
      i18n._(
        msg({
          message: msg`[결함] ${{ tag: facts.tag }} @ ${{ location: facts.location }} ×${{ count }}`,
          comment:
            "Heading of a defect message sent to the developer: error tag, source location, times it happened",
        }),
      ),
      i18n._(
        msg({
          message: msg`버전 ${{ release }} · ${{ platform }}`,
          comment: "Line of a defect message: the app's release and the platform it runs on",
        }),
      ),
      ...item.ids,
      summary === "" ? "" : i18n._(msg`요약: ${{ summary }}`),
      // Before the stack: the message is cut at its end, and these name what failed first.
      item.spans.length === 0
        ? ""
        : i18n._(
            msg({
              message: msg`실패 span:\n${{ spans: item.spans.map((line) => `- ${line}`).join("\n") }}`,
              comment: "Section of a defect message: the failed trace spans, one per line",
            }),
          ),
      stack === "" ? "" : `\`\`\`\n${stack}\n\`\`\``,
    ].filter((line) => line !== "");
    return lines.join("\n").slice(0, contentLimit);
  });

  const send = (item: Outgoing) =>
    Effect.when(
      Effect.flatMap(messageOf(item), delivery.sendNotice),
      Effect.map(config.read, (settings) => settings.defectReports !== false),
    ).pipe(
      // The defect itself is already in the log; a report that cannot go out is only noted.
      Effect.catch(logFailure("defect_report_failed")),
    );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.mapEffect(send, { concurrency: 2 }),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const remember = (facts: DefectFacts, now: number) =>
    Ref.update(recent, (current) => {
      const previous = current.find(
        (item) => item.tag === facts.tag && item.location === facts.location,
      );
      const others = current.filter((item) => item !== previous);
      return [
        {
          tag: facts.tag,
          location: facts.location,
          count: (previous?.count ?? 0) + 1,
          lastAt: now,
        },
        ...others,
      ].slice(0, maxRecentDefects);
    });

  const report = (event: DefectEvent) =>
    Effect.gen(function* () {
      const current = yield* Effect.option(Effect.currentSpan);
      const facts = factsOf(
        event,
        Option.map(current, (span) => span.name),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* remember(facts, now);
      if (!configured) return;
      const count = yield* Ref.modify(state, (current) => {
        const admitted = admitDefect(current, `${facts.tag}@${facts.location}`, now);
        return [admitted.count, admitted.state];
      });
      if (Option.isNone(count)) return;
      const ids = yield* Effect.forEach(
        hashedAnnotations.flatMap((key) => {
          const value = event.annotations[key];
          return value === undefined ? [] : [{ key, value }];
        }),
        ({ key, value }) => Effect.map(hash(value), (hashed) => `${key} #${hashed}`),
      );
      const spans = Option.isNone(current) ? [] : yield* failedSpans.ofTrace(current.value.traceId);
      yield* Queue.offer(outgoing, {
        facts,
        count: count.value,
        ids,
        // FailedSpan's fields are a BundleSpan's, with epoch milliseconds for `endedAt`.
        spans: spans
          .slice(-maxSpanLines)
          .map((span) => spanLine({ ...span, endedAt: String(span.endedAt) })),
      });
    }).pipe(Effect.asVoid);

  return { report, recent: Ref.get(recent) };
});

/**
 * Sends the defects `logDefect` records to the developer's Discord channel, like an error tracker
 * (decided 2026-10-18). It reuses the report webhook (`DISCORD_WEBHOOK_URL`); without one nothing
 * is sent. The user can turn it off (`defectReports` in the settings). A message names the defect's
 * tag and where it happened, the app version and platform, hashed session and Goal ids, how often
 * it happened, and a redacted summary with the top of the stack. Prompts, model answers and
 * credentials never go out. The same defect is sent once per `fingerprintWindow`, and at most
 * `messagesPerMinute` messages leave per minute.
 */
export const defectReportsLayer = Layer.effect(DefectReporter, make);
