import {
  Clock,
  Config,
  Crypto,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import { GlobalConfig } from "../config/global-config.ts";
import { hostPlatform } from "../runtime/host-system.ts";
import { DefectReporter, type DefectEvent, type RecentDefect } from "../runtime/defect-reporter.ts";
import { logFailure } from "../runtime/logged-failures.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { ReportDelivery } from "./discord-webhook.ts";

/** The same defect is sent at most once per this window; the next message counts the rest. */
export const fingerprintWindow = Duration.minutes(10);
/** At most this many defect messages leave the process per minute, whatever their fingerprint. */
export const messagesPerMinute = 5;
const stackLines = 5;
/** Distinct defects a user's report can list. */
const maxRecentDefects = 20;
const summaryLength = 300;
const contentLimit = 2_000;
/** Ids are sent as a short hash, enough to tell reports of one session apart. */
const hashLength = 12;
const hashedAnnotations = ["sessionId", "goalInstanceId"] as const;

const DefectName = Schema.Struct({ _tag: Schema.String });
const ErrorParts = Schema.Struct({
  name: Schema.String,
  message: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String),
});
const decodeDefectName = Schema.decodeUnknownOption(DefectName);
const decodeErrorParts = Schema.decodeUnknownOption(ErrorParts);

/** One defect as the message describes it, before redaction. */
interface DefectFacts {
  readonly tag: string;
  readonly location: string;
  readonly summary: string;
  readonly stack: readonly string[];
}

const factsOf = (event: DefectEvent, span: Option.Option<string>): DefectFacts => {
  const defect = event.cause.reasons.flatMap((reason) => {
    switch (reason._tag) {
      case "Die":
        return [reason.defect];
      case "Fail":
        return [reason.error];
      case "Interrupt":
        return [];
    }
  })[0];
  const parts = decodeErrorParts(defect);
  const tag = Option.match(decodeDefectName(defect), {
    onSome: ({ _tag }) => _tag,
    onNone: () => Option.match(parts, { onSome: ({ name }) => name, onNone: () => "Defect" }),
  });
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
  readonly seen: ReadonlyMap<string, Seen>;
  readonly sentTimes: readonly number[];
}

export const noDefectsSent: AdmissionState = { seen: new Map(), sentTimes: [] };

interface Outgoing {
  readonly facts: DefectFacts;
  readonly count: number;
  readonly ids: readonly string[];
}

/** Whether a defect goes out now, counting what its fingerprint held back. */
export const admitDefect = (
  state: AdmissionState,
  fingerprint: string,
  now: number,
): { readonly count: Option.Option<number>; readonly state: AdmissionState } => {
  const previous = state.seen.get(fingerprint) ?? { sentAt: null, unsent: 0 };
  const unsent = previous.unsent + 1;
  const sentTimes = state.sentTimes.filter((at) => now - at < Duration.toMillis("1 minute"));
  const due =
    (previous.sentAt === null || now - previous.sentAt >= Duration.toMillis(fingerprintWindow)) &&
    sentTimes.length < messagesPerMinute;
  return due
    ? {
        count: Option.some(unsent),
        state: {
          seen: new Map(state.seen).set(fingerprint, { sentAt: now, unsent: 0 }),
          sentTimes: [...sentTimes, now],
        },
      }
    : {
        count: Option.none<number>(),
        state: {
          seen: new Map(state.seen).set(fingerprint, { sentAt: previous.sentAt, unsent }),
          sentTimes,
        },
      };
};

const make = Effect.gen(function* () {
  const delivery = yield* ReportDelivery;
  const config = yield* GlobalConfig;
  const redactor = yield* SecretRedactor;
  const crypto = yield* Crypto.Crypto;
  const release = yield* Config.String("CONTEXT_AGENT_RELEASE").pipe(
    Config.withDefault("0.0.0-dev"),
    Effect.catchTag("ConfigError", () => Effect.succeed("unknown")),
  );
  const platform = yield* hostPlatform;
  const configured = (yield* delivery.status).configured;
  const state = yield* Ref.make(noDefectsSent);
  // Kept whether or not a webhook is set: a user's report carries them (newest first).
  const recent = yield* Ref.make<readonly RecentDefect[]>([]);
  // Sending never holds up the owner that hit the defect; a full queue drops the newest.
  const outgoing = yield* Queue.dropping<Outgoing>(64);

  const hash = (id: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(id)).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, hashLength)),
      Effect.catchTag("PlatformError", () => Effect.succeed("unhashed")),
    );
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
      `[결함] ${facts.tag} @ ${facts.location} ×${count}`,
      `버전 ${release} · ${platform}`,
      ...item.ids,
      summary === "" ? "" : `요약: ${summary}`,
      stack === "" ? "" : `\`\`\`\n${stack}\n\`\`\``,
    ].filter((line) => line !== "");
    return lines.join("\n").slice(0, contentLimit);
  });

  const send = (item: Outgoing) =>
    Effect.gen(function* () {
      const settings = yield* config.read;
      if (settings.defectReports === false) return;
      yield* delivery.sendNotice(yield* messageOf(item));
    }).pipe(
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
      const span = yield* Effect.currentSpan.pipe(
        Effect.map((current) => current.name),
        Effect.option,
      );
      const facts = factsOf(event, span);
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
      yield* Queue.offer(outgoing, { facts, count: count.value, ids });
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
