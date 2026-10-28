import { it } from "@effect/vitest";
import { Array as Arr, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { makeLeases } from "./leases.ts";

it.effect("one page holds a session until it lets go or stops renewing", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(1_000);
    const leases = yield* makeLeases(30_000);

    expect(yield* leases.claim("s", "tab-a")).toEqual({ claimed: true });
    expect(yield* leases.view("s", "tab-a")).toEqual({ state: "mine" });
    expect(yield* leases.view("s", "tab-b")).toEqual({ state: "other", since: 1_000 });
    // The second page asking loses and stays read-only.
    expect(yield* leases.claim("s", "tab-b")).toEqual({ claimed: false, heldSince: 1_000 });
    expect(yield* leases.permits("s", "tab-b")).toBe(false);
    expect(yield* leases.permits("s", null)).toBe(false);

    // Renewing keeps it; a page that stops renewing loses it.
    yield* TestClock.adjust(20_000);
    yield* leases.claim("s", "tab-a");
    yield* TestClock.adjust(20_000);
    expect((yield* leases.view("s", "tab-b")).state).toBe("other");
    yield* TestClock.adjust(30_000);
    expect(yield* leases.view("s", "tab-b")).toEqual({ state: "free" });
    expect(yield* leases.claim("s", "tab-b")).toEqual({ claimed: true });
    expect((yield* leases.view("s", "tab-a")).state).toBe("other");

    // Only the holder can release.
    yield* leases.release("s", "tab-a");
    expect(yield* leases.view("s", "tab-b")).toEqual({ state: "mine" });
    yield* leases.release("s", "tab-b");
    expect(yield* leases.view("s", "tab-a")).toEqual({ state: "free" });
  }),
);

it.effect("expired leases are reclaimed even when their sessions are not requested again", () =>
  Effect.gen(function* () {
    const leases = yield* makeLeases(100);
    yield* leases.claim("old", "tab-a");
    yield* TestClock.adjust(50);
    yield* leases.claim("fresh", "tab-b");
    yield* TestClock.adjust(60);
    const freed = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* leases.onExpired((sessionId) => Ref.update(freed, Arr.append(sessionId)));
    expect(yield* leases.sweepExpired).toEqual(["old"]);
    expect(yield* Ref.get(freed)).toEqual(["old"]);
    expect(yield* leases.view("old", "tab-a")).toEqual({ state: "free" });
    expect(yield* leases.view("fresh", "tab-b")).toEqual({ state: "mine" });
  }),
);
