import {
  Array as Arr,
  type Cause,
  Clock,
  Context,
  Effect,
  Exit,
  HashMap,
  Layer,
  Match,
  MutableHashMap,
  MutableRef,
  Option,
  Order,
  Schema,
  Tracer,
} from "effect";
import { BroadcastChannel } from "node:worker_threads";
import { failureNameOfUnknown, tagOfUnknown, withErrorCodes } from "./failure-tag.ts";

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
  /**
   * The failure's tag with its tagged reason and the error codes down its cause chain, such as
   * `AiError:InvalidRequestError` or `AiError:NetworkError (UND_ERR_CONNECT_TIMEOUT)`.
   */
  readonly failure: string;
  /** Epoch milliseconds. */
  readonly endedAt: number;
  readonly durationMs: number;
  /** Only the numeric and boolean attributes: string ones can hold SQL, URLs or provider text. */
  readonly attributes: Readonly<Record<string, number | boolean>>;
}

/**
 * The time a run's trace spent under one span path: every span that ended there, failed or not
 * (decided 2026-11-04). Names and numbers only.
 */
export interface SpanTotal {
  /** Names of the spans it ran under, outermost first, ending with its own name. */
  readonly path: readonly string[];
  readonly count: number;
  /** How many of them ended with a failure. */
  readonly failed: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** Epoch milliseconds the first of them started. */
  readonly firstStartedAt: number;
}

/** A run's span totals, longest total first. */
export interface RunSpanTotals {
  readonly totals: readonly SpanTotal[];
  /** Spans left uncounted because the run already had `pathsPerRun` paths. */
  readonly dropped: number;
}

/** How much the recorder keeps (decided 2026-11-03). */
export const failedSpanLimits = {
  spans: 200,
  /** Runs whose trace the recorder remembers, with their span totals. */
  runs: 500,
  /** Spans still running that a failed child marked; parents that never end are dropped oldest first. */
  marks: 2_000,
  pathDepth: 8,
  attributes: 16,
  maxAgeMs: 30 * 60_000,
  /** Span paths summed per run; a span on a new path past this is only counted as dropped. */
  pathsPerRun: 64,
} as const;

/**
 * Failed spans of this process, kept in memory for defect notices and user reports, and where each
 * run's time went. Successful spans are never kept one by one: a run's trace only adds them to its
 * totals. Without the recorder layer (tests, workers) nothing is recorded.
 */
export const FailedSpans = Context.Reference<{
  /** Failed spans of one trace, oldest first. */
  readonly ofTrace: (traceId: string) => Effect.Effect<readonly FailedSpan[]>;
  /** Failed spans of each given run's trace, oldest first. */
  readonly ofRuns: (
    runIds: readonly string[],
  ) => Effect.Effect<HashMap.HashMap<string, readonly FailedSpan[]>>;
  /** Span totals of each given run's trace, from when the run named its trace. */
  readonly totalsOfRuns: (
    runIds: readonly string[],
  ) => Effect.Effect<HashMap.HashMap<string, RunSpanTotals>>;
}>("memory-agent/runtime/failed-spans/FailedSpans", {
  defaultValue: () => ({
    ofTrace: () => Effect.succeed([]),
    ofRuns: () => Effect.succeed(HashMap.empty()),
    totalsOfRuns: () => Effect.succeed(HashMap.empty()),
  }),
});

/**
 * The first failure of a cause by its tag, with the error codes that say how it failed; `None` when
 * it was only interrupted.
 */
const failureOf = (cause: Cause.Cause<unknown>) =>
  Arr.head(
    cause.reasons.flatMap(
      Match.valueTags({
        Fail: ({ error }) => [
          failureNameOfUnknown(error).pipe(
            Option.getOrElse(() => "UnknownError"),
            withErrorCodes(error),
          ),
        ],
        Die: ({ defect }) => [
          tagOfUnknown(defect).pipe(
            Option.getOrElse(() => "Defect"),
            withErrorCodes(defect),
          ),
        ],
        Interrupt: (): string[] => [],
      }),
    ),
  );

/** Names of the span and the spans it ran under, outermost first, at most `pathDepth` of them. */
const pathOf = (span: Tracer.Span) =>
  Arr.unfold(Option.some<Tracer.AnySpan>(span), (current) =>
    Option.flatMap(current, (each) =>
      each._tag === "Span" ? Option.some([each.name, each.parent] as const) : Option.none(),
    ),
  )
    .slice(0, failedSpanLimits.pathDepth)
    .toReversed();

/** A run's span totals while the recorder holds them: by path, with the spans left uncounted. */
interface TraceTotals {
  readonly paths: HashMap.HashMap<string, SpanTotal>;
  readonly dropped: number;
}
const noTotals: TraceTotals = { paths: HashMap.empty(), dropped: 0 };

/** One ended span as a total of its own. */
const spanTotalOf = (span: Tracer.Span, endTime: bigint, failed: boolean): SpanTotal => {
  const durationMs = Number(endTime - span.status.startTime) / 1_000_000;
  return {
    path: pathOf(span),
    count: 1,
    failed: failed ? 1 : 0,
    totalMs: durationMs,
    maxMs: durationMs,
    firstStartedAt: Number(span.status.startTime / 1_000_000n),
  };
};

const combinedTotal = (before: SpanTotal, next: SpanTotal): SpanTotal => ({
  path: before.path,
  count: before.count + next.count,
  failed: before.failed + next.failed,
  totalMs: before.totalMs + next.totalMs,
  maxMs: Math.max(before.maxMs, next.maxMs),
  firstStartedAt: Math.min(before.firstStartedAt, next.firstStartedAt),
});

/** The totals with one more span on its path; a new path past `pathsPerRun` is only counted. */
const withSpanTotal = (totals: TraceTotals, next: SpanTotal): TraceTotals => {
  const key = next.path.join("\n");
  return Option.match(HashMap.get(totals.paths, key), {
    onSome: (before) => ({
      ...totals,
      paths: HashMap.set(totals.paths, key, combinedTotal(before, next)),
    }),
    onNone: () =>
      HashMap.size(totals.paths) < failedSpanLimits.pathsPerRun
        ? { ...totals, paths: HashMap.set(totals.paths, key, next) }
        : { ...totals, dropped: totals.dropped + 1 },
  });
};

const longestFirst = Order.flip(Order.mapInput(Order.Number, (total: SpanTotal) => total.totalMs));

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
const bounded = <K, V>(map: MutableHashMap.MutableHashMap<K, V>, limit: number) =>
  Arr.take(Arr.fromIterable(MutableHashMap.keys(map)), MutableHashMap.size(map) - limit).forEach(
    (key) => MutableHashMap.remove(map, key),
  );

const make = (role: "owner" | "worker") =>
  Effect.gen(function* () {
    const inner = yield* Effect.tracer;
    // The tracer interface is synchronous, so the recorder's state is plain mutable data that never
    // leaves this closure; reads copy it.
    const spans = MutableRef.make<readonly FailedSpan[]>([]);
    const traceOfRun = MutableHashMap.empty<string, string>();
    /** Running spans below which a failure was already recorded, with that failure. */
    const failedBelow = MutableHashMap.empty<string, string>();
    /** Span totals of the traces runs named, from when they named them. */
    const totalsOfTrace = MutableHashMap.empty<string, TraceTotals>();
    const totalsOf = (traceId: string) => MutableHashMap.get(totalsOfTrace, traceId);

    const channel = new BroadcastChannel(failedSpanChannel);
    // The channel must never be the reason a thread stays alive.
    channel.unref();
    yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));

    const keep = (span: FailedSpan) =>
      MutableRef.update(spans, (kept) => [...kept.slice(-(failedSpanLimits.spans - 1)), span]);
    // Only the owner takes spans in; workers just send theirs, so nothing echoes back and forth.
    if (role === "owner")
      channel.onmessage = (event) => {
        Option.map(decodeMessage(event.data), keep);
      };

    const record = (span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      const below = Option.getOrUndefined(MutableHashMap.get(failedBelow, span.spanId));
      MutableHashMap.remove(failedBelow, span.spanId);
      const failure = Exit.match(exit, {
        onSuccess: () => Option.none<string>(),
        onFailure: failureOf,
      });
      Option.map(totalsOf(span.traceId), (totals) =>
        MutableHashMap.set(
          totalsOfTrace,
          span.traceId,
          withSpanTotal(totals, spanTotalOf(span, endTime, Option.isSome(failure))),
        ),
      );
      if (Option.isNone(failure)) return;
      const parent = Option.getOrUndefined(span.parent);
      if (parent !== undefined) {
        MutableHashMap.set(failedBelow, parent.spanId, failure.value);
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
            MutableHashMap.set(traceOfRun, runId, span.traceId);
            bounded(traceOfRun, failedSpanLimits.runs);
            // A trace named again keeps what it counted.
            MutableHashMap.set(
              totalsOfTrace,
              span.traceId,
              Option.getOrElse(totalsOf(span.traceId), () => noTotals),
            );
            bounded(totalsOfTrace, failedSpanLimits.runs);
          });
        };
        return span;
      },
      context: inner.context,
    });

    const recent = Effect.map(Clock.currentTimeMillis, (now) =>
      MutableRef.get(spans)
        .filter((span) => now - span.endedAt <= failedSpanLimits.maxAgeMs)
        // Worker spans arrive after the owner's own, so a trace reads in the order it happened.
        .toSorted((left, right) => left.endedAt - right.endedAt),
    );
    const store = {
      ofTrace: (traceId: string) =>
        Effect.map(recent, (kept) => kept.filter((span) => span.traceId === traceId)),
      ofRuns: (runIds: readonly string[]) =>
        Effect.map(recent, (kept): HashMap.HashMap<string, readonly FailedSpan[]> =>
          HashMap.fromIterable(
            runIds.flatMap((runId) => {
              const traceId = Option.getOrUndefined(MutableHashMap.get(traceOfRun, runId));
              const own = kept.filter((span) => span.traceId === traceId);
              return traceId === undefined || own.length === 0 ? [] : [[runId, own] as const];
            }),
          ),
        ),
      totalsOfRuns: (runIds: readonly string[]) =>
        Effect.sync((): HashMap.HashMap<string, RunSpanTotals> =>
          HashMap.fromIterable(
            Arr.getSomes(
              runIds.map((runId) =>
                MutableHashMap.get(traceOfRun, runId).pipe(
                  Option.flatMap(totalsOf),
                  Option.filter((totals) => HashMap.size(totals.paths) > 0),
                  Option.map(
                    (totals) =>
                      [
                        runId,
                        {
                          totals: Arr.sort(HashMap.toValues(totals.paths), longestFirst),
                          dropped: totals.dropped,
                        },
                      ] as const,
                  ),
                ),
              ),
            ),
          ),
        ),
    };
    return Context.make(Tracer.Tracer, tracer).pipe(Context.add(FailedSpans, store));
  });

/**
 * Wraps the tracer below it (OTLP or the default one) to keep the spans that failed, in memory
 * only (decided 2026-11-03). Spans that succeed are dropped as they end, after a run's trace adds
 * them to its totals (2026-11-04); a failure that passes up through its parents is kept once, at
 * the span it began in. Provide it above the exporters and below every service whose spans it
 * should see. A worker thread's spans are not in the totals; its failed ones still arrive.
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
