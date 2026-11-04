import {
  Array as Arr,
  type Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Schema,
  Tracer,
} from "effect";
import { BroadcastChannel } from "node:worker_threads";
import { failureNameOfUnknown, tagOfUnknown } from "./failure-tag.ts";

/**
 * The span attribute a chat run puts its run id in. The recorder takes it to link the run's trace
 * to the run and does not pass it on to the exporters.
 */
export const runSpanAttribute = "context_agent.run_id";

/** A span that ended with a failure, as a report may carry it: no text the app did not write. */
export interface FailedSpan {
  readonly traceId: string;
  readonly spanId: string;
  /** Names of the spans it ran under, outermost first, ending with its own name. */
  readonly path: readonly string[];
  /** The failure's tag with its tagged reason, such as `AiError:InvalidRequestError`. */
  readonly failure: string;
  /** Epoch milliseconds. */
  readonly endedAt: number;
  readonly durationMs: number;
  /** Only the numeric and boolean attributes: string ones can hold SQL, URLs or provider text. */
  readonly attributes: Readonly<Record<string, number | boolean>>;
}

/** How much the recorder keeps (decided 2026-11-03). */
export const failedSpanLimits = {
  spans: 200,
  /** Runs whose trace the recorder remembers. */
  runs: 500,
  /** Spans still running that a failed child marked; parents that never end are dropped oldest first. */
  marks: 2_000,
  pathDepth: 8,
  attributes: 16,
  maxAgeMs: 30 * 60_000,
} as const;

/**
 * Failed spans of this process, kept in memory for defect notices and user reports. Successful
 * spans are never kept. Without the recorder layer (tests, workers) nothing is recorded.
 */
export const FailedSpans = Context.Reference<{
  /** Failed spans of one trace, oldest first. */
  readonly ofTrace: (traceId: string) => Effect.Effect<readonly FailedSpan[]>;
  /** Failed spans of each given run's trace, oldest first. */
  readonly ofRuns: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, readonly FailedSpan[]>>;
}>("memory-agent/runtime/failed-spans/FailedSpans", {
  defaultValue: () => ({
    ofTrace: () => Effect.succeed([]),
    ofRuns: () => Effect.succeed(new Map()),
  }),
});

/** The first failure of a cause by its tag; `None` when it was only interrupted. */
const failureOf = (cause: Cause.Cause<unknown>) =>
  Arr.head(
    cause.reasons.flatMap(
      Match.valueTags({
        Fail: ({ error }) => [Option.getOrElse(failureNameOfUnknown(error), () => "UnknownError")],
        Die: ({ defect }) => [Option.getOrElse(tagOfUnknown(defect), () => "Defect")],
        Interrupt: (): string[] => [],
      }),
    ),
  );

const pathOf = (span: Tracer.Span) => {
  const names = [span.name];
  let parent = Option.getOrUndefined(span.parent);
  while (parent?._tag === "Span" && names.length < failedSpanLimits.pathDepth) {
    names.push(parent.name);
    parent = Option.getOrUndefined(parent.parent);
  }
  return names.toReversed();
};

/**
 * The in-process channel worker threads put their failed spans on, for the owner thread to keep
 * with its own. Worker spans already share the owner's trace: the RPC client sends `traceId` and
 * `spanId` with every request and the worker's server span continues from them.
 */
const failedSpanChannel = "context-agent/failed-spans";

/** A failed span as it crosses threads: anything else on the channel is dropped. */
const FailedSpanMessage = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  path: Schema.Array(Schema.String),
  failure: Schema.String,
  endedAt: Schema.Finite,
  durationMs: Schema.Finite,
  attributes: Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.Boolean])),
});
const decodeMessage = Schema.decodeUnknownOption(FailedSpanMessage);

const decodeRunId = Schema.decodeUnknownOption(Schema.String);
const decodePlain = Schema.decodeUnknownOption(Schema.Union([Schema.Finite, Schema.Boolean]));

const plainAttributes = (attributes: ReadonlyMap<string, unknown>) =>
  Object.fromEntries(
    [...attributes]
      .flatMap(([key, value]) =>
        Option.match(decodePlain(value), {
          onNone: () => [],
          onSome: (plain) => [[key, plain] as const],
        }),
      )
      .slice(0, failedSpanLimits.attributes),
  );

/** Keeps a map within `limit` entries by dropping the oldest. */
const bounded = <K, V>(map: Map<K, V>, limit: number) => {
  for (const key of map.keys()) {
    if (map.size <= limit) return;
    map.delete(key);
  }
};

const make = (role: "owner" | "worker") =>
  Effect.gen(function* () {
    const inner = yield* Effect.tracer;
    // The tracer interface is synchronous, so the recorder's state is plain mutable data that never
    // leaves this closure; reads copy it.
    let spans: readonly FailedSpan[] = [];
    const traceOfRun = new Map<string, string>();
    /** Running spans below which a failure was already recorded, with that failure. */
    const failedBelow = new Map<string, string>();

    const channel = new BroadcastChannel(failedSpanChannel);
    // The channel must never be the reason a thread stays alive.
    channel.unref();
    yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));

    const keep = (span: FailedSpan) => {
      spans = [...spans.slice(-(failedSpanLimits.spans - 1)), span];
    };
    // Only the owner takes spans in; workers just send theirs, so nothing echoes back and forth.
    if (role === "owner")
      channel.onmessage = (event) => {
        Option.map(decodeMessage(event.data), keep);
      };

    const record = (span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      const below = failedBelow.get(span.spanId);
      failedBelow.delete(span.spanId);
      if (Exit.isSuccess(exit)) return;
      const failure = failureOf(exit.cause);
      if (Option.isNone(failure)) return;
      const parent = Option.getOrUndefined(span.parent);
      if (parent !== undefined) {
        failedBelow.set(parent.spanId, failure.value);
        bounded(failedBelow, failedSpanLimits.marks);
      }
      // The same failure passing up through the spans above it is recorded once, where it began.
      if (below === failure.value) return;
      const failed: FailedSpan = {
        traceId: span.traceId,
        spanId: span.spanId,
        path: pathOf(span),
        failure: failure.value,
        endedAt: Number(endTime / 1_000_000n),
        durationMs: Number(endTime - span.status.startTime) / 1_000_000,
        attributes: plainAttributes(span.attributes),
      };
      keep(failed);
      // A worker's own memory is thrown away when it exits: the owner keeps the report's copy.
      if (role === "worker") channel.postMessage(failed);
    };

    const tracer = Tracer.make({
      span: (options) => {
        const span = inner.span(options);
        const end = span.end.bind(span);
        const attribute = span.attribute.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          record(span, endTime, exit);
        };
        span.attribute = (key, value) => {
          if (key !== runSpanAttribute) return attribute(key, value);
          Option.map(decodeRunId(value), (runId) => {
            traceOfRun.set(runId, span.traceId);
            bounded(traceOfRun, failedSpanLimits.runs);
          });
        };
        return span;
      },
      context: inner.context,
    });

    const recent = Effect.map(Clock.currentTimeMillis, (now) =>
      spans
        .filter((span) => now - span.endedAt <= failedSpanLimits.maxAgeMs)
        // Worker spans arrive after the owner's own, so a trace reads in the order it happened.
        .toSorted((left, right) => left.endedAt - right.endedAt),
    );
    const store = {
      ofTrace: (traceId: string) =>
        Effect.map(recent, (kept) => kept.filter((span) => span.traceId === traceId)),
      ofRuns: (runIds: readonly string[]) =>
        Effect.map(
          recent,
          (kept): ReadonlyMap<string, readonly FailedSpan[]> =>
            new Map(
              runIds.flatMap((runId) => {
                const traceId = traceOfRun.get(runId);
                const own = kept.filter((span) => span.traceId === traceId);
                return traceId === undefined || own.length === 0 ? [] : [[runId, own] as const];
              }),
            ),
        ),
    };
    return Context.make(Tracer.Tracer, tracer).pipe(Context.add(FailedSpans, store));
  });

/**
 * Wraps the tracer below it (OTLP or the default one) to keep the spans that failed, in memory
 * only (decided 2026-11-03). Spans that succeed are dropped as they end; a failure that passes up
 * through its parents is kept once, at the span it began in. Provide it above the exporters and
 * below every service whose spans it should see.
 *
 * This is the owner thread's recorder: besides its own spans it keeps what the workers send.
 */
export const failedSpansLayer = Layer.effectContext(make("owner"));

/**
 * The same recorder for a worker thread, which sends every failed span to the owner instead of
 * keeping it to itself. Worker spans carry the owner's trace id, so a report shows them under the
 * run that caused them. Provide it to the worker's whole program, not only to its server layer.
 */
export const workerFailedSpansLayer = Layer.effectContext(make("worker"));
