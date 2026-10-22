import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { nodePlatformLayer } from "../src/runtime/node-platform.ts";

// NodeServices' Terminal subscribed to stdin on every build; the platform layer must not.
it.effect("building the platform layer adds no stdin listener", () =>
  Effect.gen(function* () {
    const before = process.stdin.listenerCount("end");
    yield* Layer.build(nodePlatformLayer);
    yield* Layer.build(nodePlatformLayer);
    expect(process.stdin.listenerCount("end")).toBe(before);
  }).pipe(Effect.scoped),
);
