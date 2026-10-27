import {
  Array as Arr,
  Chunk,
  Clock,
  Duration,
  Effect,
  HashMap,
  Match,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
  SynchronizedRef,
} from "effect";
import type { AgUiEvent } from "./chunks.ts";

/**
 * A run's log (docs/effect-ai-migration.md "SSE와 재접속"): the run fills it with its events whether
 * or not a page reads them, and pages read it from the start or after the offset they last read.
 */

/** One event of a run's log, with the offset a reader resumes after. */
export interface RunLogEntry {
  readonly offset: string;
  readonly event: AgUiEvent;
}

export class RunLogFailed extends Schema.TaggedError<RunLogFailed>()("RunLogFailed", {
  reason: Schema.Literals([
    "binding_denied",
    "invalid_offset",
    "unknown_offset",
    "unknown_run",
    "closed",
    "run_mismatch",
    "session_mismatch",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface RunLog {
  /** Keeps the event before any reader gets it. A closed log refuses it. */
  readonly append: (event: AgUiEvent) => Effect.Effect<void, RunLogFailed>;
  /** The events after `offset` (`-1`: all of them), then those to come until the log closes. */
  readonly read: (offset: string) => Stream.Stream<RunLogEntry, RunLogFailed>;
  /** Ends the log; its readers end once they have read it all. A second close does nothing. */
  readonly close: Effect.Effect<void, RunLogFailed>;
}

/** Opens every run's log, so a page that joins from the start finds an entry at once. */
export const runAcceptedEvent = "run.accepted";

/** How long a finished run's log stays readable, for a page that reconnects late. */
const finishedLogTtl = Duration.minutes(5);
/** At most this many logs are kept; the oldest finished ones go first. Running logs always stay. */
const maxLogs = 1024;

interface LogState {
  /** Appended only, so a reader slices what its last count left out. */
  readonly events: Chunk.Chunk<AgUiEvent>;
  /** When the log closed. A closed log refuses appends. */
  readonly closedAt: Option.Option<number>;
}

type MemoryLog = SubscriptionRef.SubscriptionRef<LogState>;

const memoryOffset = (runId: string, seq: number) =>
  `memory:v1:${encodeURIComponent(runId)}:${seq}`;

/** The entry an offset of the run's in-memory log names; `-1` and `now` name none. */
const memorySeq = (runId: string, offset: string): Option.Option<number> => {
  const prefix = memoryOffset(runId, 0).slice(0, -1);
  const seq = Number(offset.slice(prefix.length));
  return offset.startsWith(prefix) && Number.isSafeInteger(seq) && seq >= 1
    ? Option.some(seq)
    : Option.none();
};

/**
 * The logs of the runs this process produces, in memory. A run's log is gone with the process; a
 * page that rejoins after a restart reads the run's saved transcript instead.
 */
export const memoryRunLogs = Effect.gen(function* () {
  const logs = yield* SynchronizedRef.make(HashMap.empty<string, MemoryLog>());

  /** Drops finished logs past their time, then the oldest finished ones over the limit. */
  const sweep = Effect.fnUntraced(function* (all: HashMap.HashMap<string, MemoryLog>) {
    const now = yield* Clock.currentTimeMillis;
    const finished = Arr.getSomes(
      yield* Effect.forEach(all, ([runId, log]) =>
        Effect.map(SubscriptionRef.get(log), ({ closedAt }) =>
          Option.map(closedAt, (at) => ({ runId, closedAt: at })),
        ),
      ),
    );
    const expired = finished.filter(
      ({ closedAt }) => now - closedAt > Duration.toMillis(finishedLogTtl),
    );
    const kept = finished
      .filter((entry) => !expired.includes(entry))
      .toSorted((left, right) => left.closedAt - right.closedAt);
    const over = Math.max(0, HashMap.size(all) - expired.length - maxLogs);
    return HashMap.removeMany(
      all,
      [...expired, ...kept.slice(0, over)].map(({ runId }) => runId),
    );
  });

  // Looked up when it runs: a log's `close` is made before its first append makes the log.
  const logOf = (runId: string) =>
    SynchronizedRef.modifyEffect(logs, (all) =>
      Option.match(HashMap.get(all, runId), {
        onSome: (log) => Effect.succeed([log, all] as const),
        onNone: () =>
          Effect.gen(function* () {
            const log = yield* SubscriptionRef.make<LogState>({
              events: Chunk.empty(),
              closedAt: Option.none(),
            });
            return [log, HashMap.set(yield* sweep(all), runId, log)] as const;
          }),
      }),
    );

  /** How many entries a reader from `offset` skips. */
  const skipped = (runId: string, offset: string, count: number) =>
    Match.value(offset).pipe(
      Match.when("-1", () => Effect.succeed(0)),
      Match.when("now", () => Effect.succeed(count)),
      Match.orElse(() =>
        Option.match(memorySeq(runId, offset), {
          onNone: () => Effect.fail(RunLogFailed.make({ reason: "invalid_offset" })),
          onSome: (seq) =>
            seq <= count
              ? Effect.succeed(seq)
              : Effect.fail(RunLogFailed.make({ reason: "unknown_offset" })),
        }),
      ),
    );

  /** The run's log. Appending or closing makes it; reading a log this process never made fails. */
  const of = (runId: string): RunLog => ({
    append: (event) =>
      Effect.flatMap(logOf(runId), (log) =>
        SubscriptionRef.updateEffect(log, (state) =>
          Option.isSome(state.closedAt)
            ? Effect.fail(RunLogFailed.make({ reason: "closed" }))
            : Effect.succeed({ ...state, events: Chunk.append(state.events, event) }),
        ),
      ),
    read: (offset) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const log = yield* Effect.flatMap(SynchronizedRef.get(logs), (all) =>
            Effect.fromOption(HashMap.get(all, runId)),
          ).pipe(Effect.mapError(() => RunLogFailed.make({ reason: "unknown_run" })));
          const after = yield* skipped(
            runId,
            offset,
            Chunk.size((yield* SubscriptionRef.get(log)).events),
          );
          // The current state comes first, then each change; the closing one is read too.
          return SubscriptionRef.changes(log).pipe(
            Stream.takeUntil(({ closedAt }) => Option.isSome(closedAt)),
            Stream.mapAccum(
              () => after,
              (read, { events }) => [
                Math.max(read, Chunk.size(events)),
                Chunk.toReadonlyArray(Chunk.drop(events, read)).map((event, index) => ({
                  offset: memoryOffset(runId, read + index + 1),
                  event,
                })),
              ],
            ),
          );
        }),
      ),
    close: Effect.flatMap(logOf(runId), (log) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        SubscriptionRef.update(log, (state) => ({
          ...state,
          closedAt: Option.orElseSome(state.closedAt, () => now),
        })),
      ),
    ),
  });

  return {
    of,
    /** Makes the run's log as the run starts, so a page that joins at once finds it. */
    open: (runId: string) => Effect.as(logOf(runId), of(runId)),
    /** The run's log for a page that follows it after `offset`, once the offset can be the run's. */
    follow: (runId: string, offset: string) =>
      offset === "-1" || offset === "now" || Option.isSome(memorySeq(runId, offset))
        ? Effect.succeed(of(runId))
        : Effect.fail(RunLogFailed.make({ reason: "invalid_offset" })),
  };
});

export type MemoryRunLogs = Effect.Success<typeof memoryRunLogs>;
