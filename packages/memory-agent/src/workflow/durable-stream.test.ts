import { nativeStream } from "../runtime/native-stream.ts";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { withTestPlatform } from "../../tests/support/platform.ts";
// SQLite and the TanStack SDK retain their native synchronous transaction and HTTP contracts.
import { isTruthy } from "../truthy.ts";
import { describe, expect } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import {
  resumeServerSentEventsResponse,
  toServerSentEventsResponse,
  type StreamChunk,
} from "@tanstack/ai";
import { sqliteStreamDurability } from "./durable-stream.ts";
import { migrations } from "../db/migrations.ts";

function owner(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (!isTruthy(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get())) {
    for (const migration of migrations) sqlite.exec(migration);
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
  return {
    sqlite,
    atomic: <T>(work: () => T): T => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    sessionId: "session",
    runId: "run",
  };
}
// SAFETY: both lifecycle fixtures provide required runId/threadId; literal tags match SDK enum wire values.
const chunk = (type: "RUN_STARTED" | "RUN_FINISHED", runId = "run"): StreamChunk =>
  ({ type, runId, threadId: "session", timestamp: 1 }) as StreamChunk;

describe("central SQLite SDK durability", () => {
  it.live("validates binding, minted offsets, atomic batches, snapshot and close", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => owner(":memory:")),
          (db) => Effect.sync(() => db.sqlite.close()),
        );
        const adapter = sqliteStreamDurability(db);
        expect(yield* sdkCall(() => adapter.snapshot())).toEqual([]);
        expect(() => sqliteStreamDurability({ ...db, sessionId: "other" })).toThrow();
        yield* sdkCall(() =>
          expect(
            adapter.append([chunk("RUN_STARTED"), chunk("RUN_FINISHED", "other")]),
          ).rejects.toThrow(),
        );
        expect(yield* sdkCall(() => adapter.snapshot())).toEqual([]);
        const [offset] = yield* sdkCall(() => adapter.append([chunk("RUN_STARTED")]));
        expect(() => sqliteStreamDurability({ ...db, resumeOffset: "1" })).toThrow();
        expect(() =>
          sqliteStreamDurability({ ...db, resumeOffset: "sdk-stream:v1:other:1" }),
        ).toThrow();
        const snapshot = yield* sdkCall(() => adapter.snapshot());
        snapshot[0]!.chunk.timestamp = 999;
        expect((yield* sdkCall(() => adapter.snapshot()))[0]!.chunk.timestamp).toBe(1);
        yield* sdkCall(() => adapter.close());
        yield* sdkCall(() => adapter.close());
        yield* sdkCall(() => expect(adapter.append([chunk("RUN_FINISHED")])).rejects.toThrow());
        const replay = yield* Stream.runCollect(
          Stream.fromAsyncIterable(adapter.read("-1"), (cause) => new Cause.UnknownError(cause)),
        );
        expect(replay.map((entry) => entry.offset)).toEqual([offset]);
      }),
    ),
  );

  it.live("tails across owner adapters and aborts open logs without terminalizing them", () => {
    const abort = new AbortController();
    return withTestPlatform(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => owner(":memory:")),
          (db) => Effect.sync(() => db.sqlite.close()),
        );
        const reader = sqliteStreamDurability(db);
        const iterator = reader.read("-1", abort.signal)[Symbol.asyncIterator]();
        const next = iterator.next();
        yield* sdkCall(() => sqliteStreamDurability(db).append([chunk("RUN_STARTED")]));
        expect((yield* sdkCall(() => next)).value?.chunk.type).toBe("RUN_STARTED");
        const pending = iterator.next();
        abort.abort();
        expect((yield* sdkCall(() => pending)).done).toBe(true);
        yield* sdkCall(() => reader.append([chunk("RUN_FINISHED")]));
      }),
    );
  });

  it.live(
    "serves real SDK SSE over HTTP and replays persisted offsets after owner DB restart without running a producer",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sdk-durable-" });
          const path = paths.join(directory, "owner.sqlite");
          let db = owner(path);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (db.sqlite.isOpen) db.sqlite.close();
            }),
          );
          const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
          let producerCalls = 0;
          const server = createServer((request, response) => {
            void runNative(
              Effect.gen(function* () {
                const offset = request.headers["last-event-id"];
                const adapter = sqliteStreamDurability({
                  ...db,
                  resumeOffset: Array.isArray(offset) ? (offset[0] ?? null) : (offset ?? null),
                });
                const produce = () =>
                  nativeStream(
                    Stream.suspend(() => {
                      producerCalls++;
                      return Stream.fromIterable([chunk("RUN_STARTED"), chunk("RUN_FINISHED")]);
                    }),
                  );
                const result =
                  request.url === "/resume"
                    ? resumeServerSentEventsResponse({ adapter })
                    : toServerSentEventsResponse(produce(), { durability: { adapter } });
                response.writeHead(result.status, Object.fromEntries(result.headers));
                yield* Stream.runForEach(
                  Stream.fromAsyncIterable(result.body!, (cause) => new Cause.UnknownError(cause)),
                  (bytes) =>
                    Effect.sync(() => {
                      response.write(bytes);
                    }),
                );
                response.end();
              }).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    response.writeHead(400);
                    response.end();
                  }),
                ),
              ),
            );
          });
          yield* Effect.acquireRelease(
            Effect.callback<void, Cause.UnknownError>((resume) => {
              const failed = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
              server.once("error", failed);
              server.listen(0, "127.0.0.1", () => resume(Effect.void));
              return Effect.sync(() => server.off("error", failed));
            }),
            () =>
              Effect.callback<void>((resume) => {
                server.closeAllConnections();
                server.close(() => resume(Effect.void));
              }),
          );
          const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
            server.address(),
          );
          const url = `http://127.0.0.1:${address.port}`;
          const liveResponse = yield* sdkCall(() => fetch(url));
          const live = yield* sdkCall(() => liveResponse.text());
          const ids = [...live.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
          expect(ids).toHaveLength(3); // SDK inserts a persisted RUN_ACCEPTED CUSTOM event.
          expect(ids.every((id) => id.startsWith("sdk-stream:v1:run:"))).toBe(true);
          db.sqlite.close();
          db = owner(path);
          const replayResponse = yield* sdkCall(() =>
            fetch(`${url}/resume`, { headers: { "Last-Event-ID": ids[1]! } }),
          );
          const replay = yield* sdkCall(() => replayResponse.text());
          expect(replay).not.toContain("RUN_STARTED");
          expect(replay).toContain("RUN_FINISHED");
          expect(replay).toContain(`id: ${ids[2]}`);
          expect(producerCalls).toBe(1);
          expect(
            (yield* sdkCall(() =>
              fetch(`${url}/resume`, { headers: { "Last-Event-ID": "forged" } }),
            )).status,
          ).toBe(400);
        }),
      ),
  );
});

const sdkCall = Effect.fn("DurableStreamTest.sdkCall")(<A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
