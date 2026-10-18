import { nativeStream } from "../runtime/native-stream.ts";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { withTestPlatform } from "../../tests/support/platform.ts";
// SQLite and the TanStack SDK retain their native synchronous transaction and HTTP contracts.
import { isTruthy } from "../truthy.ts";
import { describe, expect } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import {
  resumeServerSentEventsResponse,
  toServerSentEventsResponse,
  type StreamChunk,
} from "@tanstack/ai";
import { sqliteStreamDurability } from "./durable-stream.ts";
import { connectionContext } from "../db/database.ts";
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
  return sqlite;
}
const binding = { sessionId: "session", runId: "run" };
/** The adapter over `sqlite` for `input`, as the owner composition root supplies it. */
const durability = (
  sqlite: DatabaseSync,
  input: Parameters<typeof sqliteStreamDurability>[0] = binding,
) =>
  Effect.flatMap(connectionContext(sqlite), (context) =>
    Effect.provideContext(sqliteStreamDurability(input), context),
  );
// SAFETY: both lifecycle fixtures provide required runId/threadId; literal tags match SDK enum wire values.
const chunk = (type: "RUN_STARTED" | "RUN_FINISHED", runId = "run"): StreamChunk =>
  ({ type, runId, threadId: "session", timestamp: 1 }) as StreamChunk;

describe("central SQLite SDK durability", () => {
  it.live("validates binding, minted offsets, atomic batches, snapshot and close", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => owner(":memory:")),
          (db) => Effect.sync(() => db.close()),
        );
        const adapter = yield* durability(db);
        expect(yield* sdkCall(() => adapter.snapshot())).toEqual([]);
        expect(
          yield* Effect.flip(durability(db, { ...binding, sessionId: "other" })),
        ).toMatchObject({ reason: "binding_denied" });
        yield* sdkCall(() =>
          expect(
            adapter.append([chunk("RUN_STARTED"), chunk("RUN_FINISHED", "other")]),
          ).rejects.toThrow(),
        );
        expect(yield* sdkCall(() => adapter.snapshot())).toEqual([]);
        const [offset] = yield* sdkCall(() => adapter.append([chunk("RUN_STARTED")]));
        for (const resumeOffset of ["1", "sdk-stream:v1:other:1"])
          expect(yield* Effect.flip(durability(db, { ...binding, resumeOffset }))).toMatchObject({
            reason: "invalid_offset",
          });
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
          (db) => Effect.sync(() => db.close()),
        );
        const reader = yield* durability(db);
        const iterator = reader.read("-1", abort.signal)[Symbol.asyncIterator]();
        const next = iterator.next();
        const writer = yield* durability(db);
        yield* sdkCall(() => writer.append([chunk("RUN_STARTED")]));
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
              if (db.isOpen) db.close();
            }),
          );
          let producerCalls = 0;
          const httpServices = yield* Layer.build(NodeHttpServer.layerTest);
          const server = yield* Effect.provideContext(HttpServer.HttpServer, httpServices);
          const http = yield* Effect.provideContext(HttpClient.HttpClient, httpServices);
          yield* server.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const adapter = yield* durability(db, {
                ...binding,
                resumeOffset: request.headers["last-event-id"] ?? null,
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
              return HttpServerResponse.stream(
                Stream.fromAsyncIterable(result.body!, (cause) => new Cause.UnknownError(cause)),
                { status: result.status, headers: Object.fromEntries(result.headers) },
              );
            }).pipe(
              Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
            ),
          );
          const liveResponse = yield* http.get("/");
          const live = yield* liveResponse.text;
          const ids = [...live.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
          expect(ids).toHaveLength(3); // SDK inserts a persisted RUN_ACCEPTED CUSTOM event.
          expect(ids.every((id) => id.startsWith("sdk-stream:v1:run:"))).toBe(true);
          db.close();
          db = owner(path);
          const replayResponse = yield* http.get("/resume", {
            headers: { "Last-Event-ID": ids[1]! },
          });
          const replay = yield* replayResponse.text;
          expect(replay).not.toContain("RUN_STARTED");
          expect(replay).toContain("RUN_FINISHED");
          expect(replay).toContain(`id: ${ids[2]}`);
          expect(producerCalls).toBe(1);
          expect(
            (yield* http.get("/resume", { headers: { "Last-Event-ID": "forged" } })).status,
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
