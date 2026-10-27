import {
  Clock,
  Duration,
  Effect,
  Match,
  MutableHashMap,
  MutableRef,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
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
  readonly count: number;
  readonly closed: boolean;
}

interface MemoryLog {
  /** Appended only, so a reader slices what its last count left out. */
  readonly events: Array<AgUiEvent>;
  readonly state: SubscriptionRef.SubscriptionRef<LogState>;
  readonly closedAt: MutableRef.MutableRef<Option.Option<number>>;
}

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
export const memoryRunLogs = Effect.sync(() => {
  const logs = MutableHashMap.empty<string, MemoryLog>();

  /** Drops finished logs past their time, then the oldest finished ones over the limit. */
  const sweep = (now: number) => {
    const finished = Array.from(logs).flatMap(([runId, log]) =>
      Option.match(MutableRef.get(log.closedAt), {
        onNone: () => [],
        onSome: (closedAt) => [{ runId, closedAt }],
      }),
    );
    const expired = finished.filter(
      ({ closedAt }) => now - closedAt > Duration.toMillis(finishedLogTtl),
    );
    const kept = finished
      .filter((entry) => !expired.includes(entry))
      .toSorted((left, right) => left.closedAt - right.closedAt);
    const over = Math.max(0, MutableHashMap.size(logs) - expired.length - maxLogs);
    [...expired, ...kept.slice(0, over)].forEach(({ runId }) => MutableHashMap.remove(logs, runId));
  };

  // Looked up when it runs: a log's `close` is made before its first append makes the log.
  const logOf = (runId: string) =>
    Effect.suspend(() =>
      Option.match(MutableHashMap.get(logs, runId), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            sweep(yield* Clock.currentTimeMillis);
            const log: MemoryLog = {
              events: [],
              state: yield* SubscriptionRef.make<LogState>({ count: 0, closed: false }),
              closedAt: MutableRef.make(Option.none()),
            };
            MutableHashMap.set(logs, runId, log);
            return log;
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
        SubscriptionRef.modifyEffect(log.state, (state) =>
          state.closed
            ? Effect.fail(RunLogFailed.make({ reason: "closed" }))
            : Effect.sync(() => {
                log.events.push(event);
                return [undefined, { ...state, count: log.events.length }] as const;
              }),
        ),
      ),
    read: (offset) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const log = yield* Effect.fromOption(MutableHashMap.get(logs, runId)).pipe(
            Effect.mapError(() => RunLogFailed.make({ reason: "unknown_run" })),
          );
          const after = yield* skipped(
            runId,
            offset,
            (yield* SubscriptionRef.get(log.state)).count,
          );
          // The current state comes first, then each change; the closing one is read too.
          return SubscriptionRef.changes(log.state).pipe(
            Stream.takeUntil(({ closed }) => closed),
            Stream.mapAccum(
              () => after,
              (read, { count }) => [
                Math.max(read, count),
                log.events.slice(read, count).map((event, index) => ({
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
        SubscriptionRef.update(log.state, (state) => {
          MutableRef.update(
            log.closedAt,
            Option.orElseSome(() => now),
          );
          return { ...state, closed: true };
        }),
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
