import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect";
import { identity } from "effect/Function";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import { EventsGroup } from "../src/api/app-api/events.ts";
import { NoStore } from "../src/api/no-store.ts";
import { makeAppEvents } from "../src/events/app-events.ts";

class EventsApi extends HttpApi.make("events-test").add(EventsGroup) {}

// Reads until the response holds `count` frames or ends; the stream cancels its reader when done.
const readFrames = (response: Response, count: number) =>
  Stream.fromReadableStream({ evaluate: () => response.body!, onError: identity }).pipe(
    Stream.orDie,
    Stream.decodeText(),
    Stream.scan(
      () => "",
      (text, chunk) => text + chunk,
    ),
    Stream.takeUntil((text) => text.split("\n\n").filter(Boolean).length >= count),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => "")),
  );

describe("AppEvents", () => {
  it.effect("isolates subscribers and preserves immediately published events", () =>
    Effect.gen(function* () {
      const events = yield* makeAppEvents;
      const session = yield* events.sessionStream("s1");
      const project = yield* events.projectStream("p1");
      yield* events.publish({ scope: "session", projectId: "p1", sessionId: "s2", topic: "queue" });
      yield* events.publish({ scope: "session", projectId: "p1", sessionId: "s1", topic: "queue" });
      yield* events.publish({ scope: "project", projectId: "p1", topic: "sessions" });
      const [sessionFrames, projectFrames] = yield* Effect.all(
        [Stream.runCollect(Stream.take(session, 2)), Stream.runCollect(Stream.take(project, 2))],
        { concurrency: "unbounded" },
      );
      expect(sessionFrames).toEqual([
        { event: "ready", data: { revision: 0 } },
        {
          id: "2",
          event: "changed",
          data: { scope: "session", projectId: "p1", sessionId: "s1", topic: "queue", revision: 2 },
        },
      ]);
      expect(projectFrames[1]).toEqual({
        id: "3",
        event: "changed",
        data: { scope: "project", projectId: "p1", topic: "sessions", revision: 3 },
      });
    }),
  );

  it.effect(
    "emits heartbeats with the service clock and permits publication after a reader stops",
    () =>
      Effect.gen(function* () {
        const events = yield* makeAppEvents;
        const ready = yield* Deferred.make<void>();
        const reading = yield* Effect.forkChild(
          Stream.runCollect(
            (yield* events.globalStream).pipe(
              Stream.tap(() => Deferred.succeed(ready, undefined)),
              Stream.take(2),
            ),
          ),
        );
        yield* Deferred.await(ready);
        // The timer starts once the reader is past `ready`, which may be after the clock first moves.
        yield* TestClock.adjust(15_000);
        yield* TestClock.adjust(15_000);
        const heartbeat = (yield* Fiber.join(reading))[1];
        expect(heartbeat?.event).toBe("heartbeat");
        expect([{ at: 15_000 }, { at: 30_000 }]).toContainEqual(heartbeat?.data);
        yield* events.publishGlobal("auth");
        expect(yield* Stream.runHead(yield* events.globalStream)).toEqual(
          Option.some({ event: "ready", data: { revision: 1 } }),
        );
      }),
  );

  it.effect("answers the SSE events the page's EventSource listens for", () =>
    Effect.gen(function* () {
      const events = yield* makeAppEvents;
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(EventsApi).pipe(
          Layer.provide(
            HttpApiBuilder.group(EventsApi, "events", (handlers) =>
              handlers.handleAll({
                all: () => events.allStream,
                project: ({ params }) => events.projectStream(params.project),
                session: ({ params }) => events.sessionStream(params.session),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(NoStore, identity)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const response = yield* Effect.promise(() =>
        handler(new Request("http://local/api/sessions/s1/events")),
      );
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      yield* events.publish({ scope: "session", projectId: "p1", sessionId: "s1", topic: "queue" });
      expect(yield* readFrames(response, 2)).toBe(
        'event: ready\ndata: {"revision":0}\n\n' +
          'id: 1\nevent: changed\ndata: {"scope":"session","projectId":"p1","sessionId":"s1","topic":"queue","revision":1}\n\n',
      );
    }),
  );

  it.effect("ends a stream when its service owner closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Scope.Scope, "sequential");
      const events = yield* Effect.provideService(makeAppEvents, Scope.Scope, owner);
      const ready = yield* Deferred.make<void>();
      const reading = yield* Effect.forkChild(
        Stream.runCollect(
          (yield* events.globalStream).pipe(Stream.tap(() => Deferred.succeed(ready, undefined))),
        ),
      );
      yield* Deferred.await(ready);
      yield* Scope.close(owner, Exit.void);
      expect(yield* Fiber.join(reading)).toEqual([{ event: "ready", data: { revision: 0 } }]);
    }),
  );
});
