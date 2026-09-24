import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { createLiveRuns } from "../src/agent/live-runs.ts";

describe("createLiveRuns", () => {
  test("one session has one active stream and releases its claim on completion", async () => {
    const runs = Effect.runSync(createLiveRuns);
    const controller = new AbortController();
    const claim = await Effect.runPromise(runs.claim("session", "first", controller));
    if (!claim) throw new Error("first run was not claimed");
    expect(
      await Effect.runPromise(runs.claim("session", "second", new AbortController())),
    ).toBeNull();

    async function* empty() {}
    for await (const _ of claim.track(empty())) {
      // The empty stream still reaches its finalizer.
    }
    expect(runs.get("session")).toBeNull();
    expect(
      await Effect.runPromise(runs.claim("session", "second", new AbortController())),
    ).not.toBeNull();
  });

  test("a failing stream completes its Effect wait and frees the session", async () => {
    const runs = Effect.runSync(createLiveRuns);
    const claim = await Effect.runPromise(runs.claim("session", "first", new AbortController()));
    if (!claim) throw new Error("first run was not claimed");
    const active = runs.get("session");
    if (!active) throw new Error("claimed run was not registered");
    async function* failed() {
      yield* [];
      throw new Error("stream failed");
    }
    await expect(
      (async () => {
        for await (const _ of claim.track(failed())) {
          // The source fails before yielding a chunk.
        }
      })(),
    ).rejects.toThrow("stream failed");
    await Effect.runPromise(active.ended);
    expect(runs.get("session")).toBeNull();
  });
});
