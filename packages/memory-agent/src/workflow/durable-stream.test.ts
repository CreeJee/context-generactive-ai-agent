import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Stream, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { withTestPlatform } from "../../tests/support/platform.ts";
// SQLite retains its native synchronous transaction contract.
import { isTruthy } from "../truthy.ts";
import { describe, expect } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import type { AgUiEvent } from "../loop/chunks.ts";
import { RunLogSignals, sqliteRunLog } from "./durable-stream.ts";
import { connectionContext } from "../db/database.ts";
import { migrations } from "../db/migrations.ts";

function owner(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (!isTruthy(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get())) {
    migrations.forEach((migration) => sqlite.exec(migration));
    sqlite.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('project', '/test', 'test', 'now');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('session', 'project', 'now');
      INSERT INTO workflow_goal_identities VALUES ('session', 'goal', 'now');
      INSERT INTO workflow_state_revisions
        (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
        VALUES ('session', '{}', 1, NULL, 'recorded', 'now', 'goal');
      INSERT INTO workflow_run_bindings VALUES ('run', 'session', 'goal', 1, NULL, 1, 'now');
    `);
  }
  return sqlite;
}
const binding = { sessionId: "session", runId: "run" };
/** The log over `sqlite` for `input`, as the owner composition root supplies it. */
const runLog = (sqlite: DatabaseSync, input: Parameters<typeof sqliteRunLog>[0] = binding) =>
  Effect.flatMap(connectionContext(sqlite), (context) =>
    Effect.provideContext(sqliteRunLog(input), context),
  );
const lifecycle = (type: "RUN_STARTED" | "RUN_FINISHED", runId = "run"): AgUiEvent => ({
  type,
  runId,
  threadId: "session",
  timestamp: 1,
});
const scopedOwner = Effect.acquireRelease(
  Effect.sync(() => owner(":memory:")),
  (db) => Effect.sync(() => db.close()),
);
/** The test platform, with one `RunLogSignals` for every log a test opens, as `AgentChat` has. */
const withOwnerLogs = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  withTestPlatform(
    Effect.flatMap(Layer.build(RunLogSignals.layer), (context) =>
      Effect.provideContext(program, context),
    ),
  );
/** Lets the forked reader run up to its next wait on the test clock. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 });
/** A tracer over the reader, and how many pages it has read so far. */
const pageReads = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const count = () =>
    spans.filter((span) => String(span.attributes.get("db.query.text")).includes("cursor >"))
      .length;
  return { tracer, count };
};

describe("central SQLite run log", () => {
  it.live("validates binding, minted offsets, lifecycle runs and close", () =>
    withOwnerLogs(
      Effect.gen(function* () {
        const db = yield* scopedOwner;
        const log = yield* runLog(db);
        expect(yield* Effect.flip(runLog(db, { ...binding, sessionId: "other" }))).toMatchObject({
          reason: "binding_denied",
        });
        expect(yield* Effect.flip(log.append(lifecycle("RUN_FINISHED", "other")))).toMatchObject({
          reason: "run_mismatch",
        });
        yield* log.append(lifecycle("RUN_STARTED"));
        const [first] = yield* Stream.runCollect(Stream.take(log.read("-1"), 1));
        yield* Effect.forEach(
          ["1", "sdk-stream:v1:other:1"],
          Effect.fnUntraced(function* (resumeOffset) {
            expect(yield* Effect.flip(runLog(db, { ...binding, resumeOffset }))).toMatchObject({
              reason: "invalid_offset",
            });
          }),
          { discard: true },
        );
        yield* log.close;
        yield* log.close;
        expect(yield* Effect.flip(log.append(lifecycle("RUN_FINISHED")))).toMatchObject({
          reason: "closed",
        });
        const replay = yield* Stream.runCollect(log.read("-1"));
        expect(replay.map(({ offset }) => offset)).toEqual([first?.offset]);
      }),
    ),
  );

  it.live("tails across owner logs and interrupts open reads without closing them", () =>
    withOwnerLogs(
      Effect.gen(function* () {
        const db = yield* scopedOwner;
        const reader = yield* runLog(db);
        const tail = yield* Effect.forkChild(Stream.runCollect(Stream.take(reader.read("-1"), 1)));
        const writer = yield* runLog(db);
        yield* writer.append(lifecycle("RUN_STARTED"));
        const [read] = yield* Fiber.join(tail);
        expect(read?.event.type).toBe("RUN_STARTED");
        const waiting = yield* Effect.forkChild(Stream.runDrain(reader.read(read!.offset)));
        yield* Fiber.interrupt(waiting);
        yield* reader.append(lifecycle("RUN_FINISHED"));
      }),
    ),
  );

  it.effect(
    "wakes a reader when its run writes, and reads what follows in a frame as one page",
    () =>
      withOwnerLogs(
        Effect.gen(function* () {
          const db = yield* scopedOwner;
          const log = yield* runLog(db);
          const reads = pageReads();
          const tail = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(log.read("-1"), 2)).pipe(Effect.withTracer(reads.tracer)),
          );
          yield* settle;
          yield* log.append(lifecycle("RUN_STARTED"));
          yield* settle;
          yield* log.append({
            type: "TEXT_MESSAGE_START",
            messageId: "message",
            role: "assistant",
          });
          yield* TestClock.adjust("16 millis");
          yield* settle;
          // The clock moved a frame, not the fallback second, and both writes came in one page.
          expect(tail.pollUnsafe()?._tag).toBe("Success");
          expect(reads.count()).toBe(2);
        }),
      ),
  );

  it.effect("reads the end of an open log at most once a second while nothing is written", () =>
    withOwnerLogs(
      Effect.gen(function* () {
        const db = yield* scopedOwner;
        const log = yield* runLog(db);
        const reads = pageReads();
        yield* Effect.forkChild(
          Stream.runDrain(log.read("-1")).pipe(Effect.withTracer(reads.tracer)),
        );
        yield* settle;
        yield* Effect.forEach(
          Array.from({ length: 10 }),
          () => Effect.andThen(TestClock.adjust("1 second"), settle),
          { discard: true },
        );
        // The first read, then one per second.
        expect(reads.count()).toBe(11);
      }),
    ),
  );

  it.live("replays persisted offsets after an owner DB restart", () =>
    withOwnerLogs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "run-log-" });
        const path = paths.join(directory, "owner.sqlite");
        const before = owner(path);
        const written = yield* runLog(before);
        yield* written.append(lifecycle("RUN_STARTED"));
        yield* written.append(lifecycle("RUN_FINISHED"));
        yield* written.close;
        const offsets = (yield* Stream.runCollect(written.read("-1"))).map(({ offset }) => offset);
        expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:run:"))).toBe(true);
        before.close();
        const after = yield* Effect.acquireRelease(
          Effect.sync(() => owner(path)),
          (db) => Effect.sync(() => db.close()),
        );
        const reopened = yield* runLog(after, { ...binding, resumeOffset: offsets[0]! });
        const replay = yield* Stream.runCollect(reopened.read(offsets[0]!));
        expect(replay.map(({ event }) => event.type)).toEqual(["RUN_FINISHED"]);
        expect(replay.map(({ offset }) => offset)).toEqual([offsets[1]]);
        expect(
          yield* Effect.flip(runLog(after, { ...binding, resumeOffset: "forged" })),
        ).toMatchObject({ reason: "invalid_offset" });
      }),
    ),
  );
});
