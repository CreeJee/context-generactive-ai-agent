import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vite-plus/test";
import { createLiveRuns } from "../../src/agent/live-runs.ts";

const claimOptions = (sessionId: string) => ({
  sessionId,
  runId: "run",
  controller: new AbortController(),
});

it.effect("a write holds the session against a run", () =>
  Effect.gen(function* () {
    const liveRuns = yield* createLiveRuns;

    const during = yield* liveRuns.writing("s", liveRuns.claim(claimOptions("s")));
    const after = yield* liveRuns.claim(claimOptions("s"));

    expect(during).toBeNull();
    expect(after).not.toBeNull();
  }),
);

it.effect("a run holds the session against a write", () =>
  Effect.gen(function* () {
    const liveRuns = yield* createLiveRuns;
    const wrote = yield* Ref.make(0);
    const write = Ref.updateAndGet(wrote, (count) => count + 1);

    const claim = yield* liveRuns.claim(claimOptions("s"));
    const during = yield* liveRuns.writing("s", write);
    expect(during).toBeNull();
    expect(yield* Ref.get(wrote)).toBe(0);

    yield* claim?.release ?? Effect.void;
    const after = yield* liveRuns.writing("s", write);
    expect(after).toBe(1);
  }),
);

it.effect("a write is not shown as a run", () =>
  Effect.gen(function* () {
    const liveRuns = yield* createLiveRuns;

    const seen = yield* liveRuns.writing(
      "s",
      Effect.all({ run: liveRuns.get("s"), sessionIds: liveRuns.sessionIds }),
    );

    expect(seen).toEqual({ run: null, sessionIds: [] });
  }),
);

it.effect("a failed write lets go of the session", () =>
  Effect.gen(function* () {
    const liveRuns = yield* createLiveRuns;

    const failed = yield* Effect.flip(liveRuns.writing("s", Effect.fail("boom")));
    const claimed = yield* liveRuns.claim(claimOptions("s"));

    expect(failed).toBe("boom");
    expect(claimed).not.toBeNull();
  }),
);
