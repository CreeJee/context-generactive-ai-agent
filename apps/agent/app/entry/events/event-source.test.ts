import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import { AppChangedEvent } from "memory-agent/app-api";
import { appEvents, type EventConnection } from "./event-source";

const encodeChanged = Schema.encodeEffect(Schema.fromJsonString(AppChangedEvent));

class FakeSource extends EventTarget {
  readonly close = vi.fn();
  emit(type: string, data?: string) {
    this.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data }));
  }
}

class FakeDocument extends EventTarget {
  hidden = false;
}

/** Runs the stream against fake sources and page, keeping every source opened and status said. */
const connected = Effect.gen(function* () {
  const sources: FakeSource[] = [];
  const statuses: EventConnection[] = [];
  const changed = vi.fn();
  const page = { document: new FakeDocument(), window: new EventTarget() };
  const fiber = yield* Effect.forkChild(
    appEvents({
      url: "/events",
      createSource: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      page,
      onReady: vi.fn(),
      onChanged: changed,
      onStatus: (status) => statuses.push(status),
    }),
  );
  yield* settle;
  return {
    fiber,
    page,
    changed,
    sources,
    latest: () => sources.at(-1),
    status: () => statuses.at(-1),
  };
});

/** Lets the stream's fiber react to an event the test dispatched. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
const after = (seconds: number) =>
  TestClock.adjust(`${seconds} seconds`).pipe(Effect.andThen(settle));
const waiting = (seconds: number) => ({
  _tag: "unreachable",
  nextAttempt: { _tag: "waiting", seconds, reconnectNow: expect.any(Function) },
});

describe("appEvents", () => {
  it.effect("decodes events, survives malformed payloads, and closes the source", () =>
    Effect.gen(function* () {
      const { fiber, changed, latest } = yield* connected;
      latest()?.emit("changed", "not-json");
      const payload = yield* encodeChanged({
        scope: "session",
        projectId: "p1",
        sessionId: "s1",
        topic: "queue",
        revision: 1,
      });
      latest()?.emit("changed", payload);
      expect(changed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ topic: "queue" }));
      yield* Fiber.interrupt(fiber);
      expect(latest()?.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    "tries again after 1, 2, 5, 10, then 30 s, and says the server is out of reach from 30 s",
    () =>
      Effect.gen(function* () {
        const { sources, latest, status, page } = yield* connected;
        expect(status()).toEqual({ _tag: "connecting" });
        latest()?.emit("error");
        yield* settle;
        expect(latest()?.close).toHaveBeenCalledOnce();
        expect(status()).toEqual({ _tag: "reconnecting" });

        // Each try fails at once, as the dev proxy's 502 does; tries start at 1, 3, 8 and 18 s.
        yield* Effect.forEach([1, 2, 5, 10], (wait, index) =>
          Effect.gen(function* () {
            yield* after(wait - 0.5);
            expect(sources).toHaveLength(index + 1);
            yield* after(0.5);
            expect(sources).toHaveLength(index + 2);
            latest()?.emit("error");
            yield* settle;
          }),
        );
        expect(status()).toEqual({ _tag: "reconnecting" });
        // At 30 s the next try, at 48 s, is 18 s away.
        yield* after(12);
        expect(status()).toEqual(waiting(18));
        yield* after(1);
        expect(status()).toEqual(waiting(17));

        // The network coming back tries at once.
        page.window.dispatchEvent(new Event("online"));
        yield* settle;
        expect(sources).toHaveLength(6);
        expect(status()).toEqual({ _tag: "unreachable", nextAttempt: { _tag: "trying" } });
        latest()?.emit("error");
        yield* settle;
        expect(status()).toEqual(waiting(30));

        // So does the button, and a stream that opens is live.
        const now = status();
        if (now?._tag === "unreachable" && now.nextAttempt._tag === "waiting")
          now.nextAttempt.reconnectNow();
        yield* settle;
        expect(sources).toHaveLength(7);
        latest()?.emit("open");
        yield* settle;
        expect(status()).toEqual({ _tag: "live" });

        // A later loss starts over from 1 s.
        latest()?.emit("error");
        yield* settle;
        expect(status()).toEqual({ _tag: "reconnecting" });
        yield* after(1);
        expect(sources).toHaveLength(8);
      }),
  );

  it.effect("closes the stream while the tab is hidden and opens a new one once shown", () =>
    Effect.gen(function* () {
      const { sources, latest, status, page } = yield* connected;
      latest()?.emit("open");
      yield* settle;
      page.document.hidden = true;
      page.document.dispatchEvent(new Event("visibilitychange"));
      yield* settle;
      expect(latest()?.close).toHaveBeenCalledOnce();
      yield* after(60);
      expect(sources).toHaveLength(1);
      page.document.hidden = false;
      page.document.dispatchEvent(new Event("visibilitychange"));
      yield* settle;
      expect(sources).toHaveLength(2);
      expect(status()).toEqual({ _tag: "connecting" });
    }),
  );
});
