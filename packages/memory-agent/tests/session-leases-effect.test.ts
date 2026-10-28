import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { SessionLeases } from "../src/sessions/leases.ts";

it.effect("session lease expiry follows the owning Effect clock", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(SessionLeases.layer(1_000));
    const leases = Context.get(context, SessionLeases);
    expect(yield* leases.claim("session", "first")).toEqual({ claimed: true });
    expect(yield* leases.view("session", "second")).toEqual({ state: "other", since: 0 });
    yield* TestClock.adjust("999 millis");
    expect((yield* leases.claim("session", "second")).claimed).toBe(false);
    yield* TestClock.adjust("1 millis");
    expect(yield* leases.view("session", "second")).toEqual({ state: "free" });
    expect(yield* leases.claim("session", "second")).toEqual({ claimed: true });
    expect(yield* leases.view("session", "first")).toEqual({ state: "other", since: 1_000 });
  }),
);
