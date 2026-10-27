import { it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import { makeAppEvents } from "../src/events/app-events.ts";

const readFrames = Effect.fnUntraced(function* (options: { response: Response; count: number }) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => options.response.body!.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const decoder = new TextDecoder();
        let text = "";
        while (text.split("\n\n").filter(Boolean).length < options.count) {
          const next = yield* Effect.promise(() => reader.read());
          if (next.done) break;
          text += decoder.decode(next.value, { stream: true });
        }
        return text;
      }),
    (reader) => Effect.promise(() => reader.cancel()),
  );
});

describe("AppEvents", () => {
  it.effect("closes a stream when its request aborts", () =>
    Effect.gen(function* () {
      const events = yield* makeAppEvents;
      const requestScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
      const signal = yield* Effect.provideService(Effect.abortSignal, Scope.Scope, requestScope);
      const response = yield* events.globalStream(new Request("http://local", { signal }));
      const reader = response.body!.getReader();
      expect((yield* Effect.promise(() => reader.read())).done).toBe(false);
      yield* Scope.close(requestScope, Exit.void);
      expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
    }),
  );

  it.effect("isolates subscribers and preserves immediately published events", () =>
    Effect.gen(function* () {
      const events = yield* makeAppEvents;
      const session = yield* events.sessionStream(new Request("http://local"), "s1");
      const project = yield* events.projectStream(new Request("http://local"), "p1");
      events.publish({ scope: "session", projectId: "p1", sessionId: "s2", topic: "queue" });
      events.publish({ scope: "session", projectId: "p1", sessionId: "s1", topic: "queue" });
      events.publish({ scope: "project", projectId: "p1", topic: "sessions" });
      const [sessionText, projectText] = yield* Effect.all(
        [readFrames({ response: session, count: 2 }), readFrames({ response: project, count: 2 })],
        { concurrency: "unbounded" },
      );
      expect(sessionText).toContain('"sessionId":"s1"');
      expect(sessionText).not.toContain('"sessionId":"s2"');
      expect(projectText).toContain('"scope":"project"');
    }),
  );

  it.effect(
    "emits heartbeats with the service clock and permits publication after cancellation",
    () =>
      Effect.gen(function* () {
        const events = yield* makeAppEvents;
        const reader = (yield* events.globalStream(new Request("http://local"))).body!.getReader();
        yield* Effect.promise(() => reader.read());
        yield* TestClock.adjust(15_000);
        const heartbeat = yield* Effect.promise(() => reader.read());
        expect(new TextDecoder().decode(heartbeat.value)).toContain(
          'event: heartbeat\ndata: {"at":15000}',
        );
        yield* Effect.promise(() => reader.cancel());
        events.publishGlobal("auth");
        const next = yield* events.globalStream(new Request("http://local"));
        expect(yield* readFrames({ response: next, count: 1 })).toContain('"revision":1');
      }),
  );

  it.effect("closes a response when its service owner closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Scope.Scope, "sequential");
      const events = yield* Effect.provideService(makeAppEvents, Scope.Scope, owner);
      const reader = (yield* events.globalStream(new Request("http://local"))).body!.getReader();
      yield* Effect.promise(() => reader.read());
      yield* Scope.close(owner, Exit.void);
      expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
    }),
  );
});
