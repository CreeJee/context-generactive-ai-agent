import { layer } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { ModelDownloads } from "./downloads.ts";

const downloading = (loaded: number, total: number, secondsLeft: number | null) => ({
  _tag: "downloading",
  purpose: "embedding",
  model: "m",
  loaded,
  total,
  secondsLeft,
});

// One service for the tests: each ends with no download left.
layer(ModelDownloads.layer)("ModelDownloads", (it) => {
  it.effect("guesses the time left from the speed so far, once the download has run a while", () =>
    Effect.gen(function* () {
      const downloads = yield* ModelDownloads;
      const report = downloads.track("embedding", "m");
      yield* report.progress({ loaded: 0, total: 1000 });
      yield* TestClock.adjust(1_000);
      yield* report.progress({ loaded: 50, total: 1000 });
      expect(yield* downloads.current).toEqual([downloading(50, 1000, null)]);
      // 200 bytes in 10 seconds: 800 more take 40.
      yield* TestClock.adjust(9_000);
      yield* report.progress({ loaded: 200, total: 1000 });
      expect(yield* downloads.current).toEqual([downloading(200, 1000, 40)]);
      yield* report.ended(Exit.void);
    }),
  );

  it.effect("a load that fails mid-download leaves it failed until the next load ends", () =>
    Effect.gen(function* () {
      const downloads = yield* ModelDownloads;
      const report = downloads.track("embedding", "m");
      yield* report.progress({ loaded: 200, total: 1000 });
      yield* report.ended(Exit.fail("offline"));
      expect(yield* downloads.current).toEqual([
        { _tag: "failed", purpose: "embedding", model: "m" },
      ]);
      // Failing again before any byte keeps it failed; a load that ends well clears it.
      yield* report.ended(Exit.fail("offline"));
      expect(yield* downloads.current).toHaveLength(1);
      yield* report.ended(Exit.void);
      expect(yield* downloads.current).toEqual([]);
    }),
  );

  it.effect("a load that fails after its files are in, or is stopped, is no failed download", () =>
    Effect.gen(function* () {
      const downloads = yield* ModelDownloads;
      const report = downloads.track("rerank", "r");
      yield* report.progress({ loaded: 1000, total: 1000 });
      yield* report.ended(Exit.fail("no WebGPU"));
      expect(yield* downloads.current).toEqual([]);

      yield* report.progress({ loaded: 200, total: 1000 });
      const stopped = yield* Effect.forkChild(Effect.never);
      yield* report.ended(
        yield* Fiber.interrupt(stopped).pipe(Effect.andThen(Fiber.await(stopped))),
      );
      expect(yield* downloads.current).toEqual([]);
    }),
  );
});
